import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/migrate.js'
import {
  createFeed, listFeeds, getFeed, updateFeed, deleteFeed,
  senderMayPush, pushValue, pushStreamRow, recentRows, staleCandidates,
  recordFeedRejection, bumpImageRev, touchFeed,
} from '../src/db/feeds.js'

describe('db/feeds', () => {
  let db: any
  beforeEach(() => { db = new Database(':memory:'); migrate(db) })

  it('creates with defaults and lists', () => {
    const f = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
    expect(f.id).toMatch(/^feed_/)
    expect(f.cap).toBe(50)
    expect(f.stale_after_s).toBeNull()
    expect(f.alert_on_stale).toBe(0)
    expect(f.allowed_senders).toBeNull()
    expect(f.payload).toBeNull()
    expect(listFeeds(db).map((x: any) => x.name)).toEqual(['cpu'])
  })

  /**
   * The last rejected push lives on the feed row, like pushed_at: one overwrite per rejection, so
   * a broken sender is visible without digging through a log it would bury.
   */
  it('records the last rejection and counts rejections since the last accepted push', () => {
    const f = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
    expect(getFeed(db, f.id)!.rejected_at).toBeNull()
    expect(getFeed(db, f.id)!.rejected_count).toBe(0)

    recordFeedRejection(db, f.id, { status: 400, reason: 'invalid_json', by: 'snd_a', via: 'http' }, 2000)
    recordFeedRejection(db, f.id, { status: 413, reason: 'too_large', by: 'snd_b', via: 'relay' }, 3000)
    let row = getFeed(db, f.id)!
    expect(row).toMatchObject({
      rejected_at: 3000, rejected_status: 413, rejected_reason: 'too_large',
      rejected_by: 'snd_b', rejected_via: 'relay', rejected_count: 2,
    })

    // An accepted push zeroes the count but keeps the last rejection: one healthy sender must
    // not hide a failing one sharing the feed.
    pushValue(db, f.id, 1, 'snd_c', 4000)
    row = getFeed(db, f.id)!
    expect(row.rejected_count).toBe(0)
    expect(row.rejected_at).toBe(3000)
    expect(row.rejected_reason).toBe('too_large')
  })

  it('every accepted-push path zeroes the rejection count', () => {
    const stream = createFeed(db, { name: 'log', mode: 'stream' }, 1000)
    const image = createFeed(db, { name: 'pic', mode: 'image' }, 1000)
    const sourced = createFeed(db, { name: 'news', mode: 'stream' }, 1000)
    for (const f of [stream, image, sourced]) {
      recordFeedRejection(db, f.id, { status: 400, reason: 'empty_body', by: 'snd_a', via: 'http' }, 2000)
    }
    pushStreamRow(db, stream.id, { n: 1 }, 'snd_a', 3000)
    bumpImageRev(db, image.id, 'snd_a', 3000)
    touchFeed(db, sourced.id, 'src_x', 3000)
    for (const f of [stream, image, sourced]) expect(getFeed(db, f.id)!.rejected_count).toBe(0)
  })

  it('value push overwrites payload and stamps pushed_at/by', () => {
    const f = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
    pushValue(db, f.id, { load: 1.5 }, 'snd_a', 2000)
    pushValue(db, f.id, { load: 2.5 }, 'snd_b', 3000)
    const row = getFeed(db, f.id)!
    expect(JSON.parse(row.payload!)).toEqual({ load: 2.5 })
    expect(row.pushed_at).toBe(3000)
    expect(row.pushed_by).toBe('snd_b')
  })

  it('stream push appends newest-first and trims beyond cap in one transaction', () => {
    const f = createFeed(db, { name: 'log', mode: 'stream', cap: 3 }, 1000)
    for (let i = 1; i <= 5; i++) pushStreamRow(db, f.id, { n: i }, 'snd_a', 1000 + i)
    const rows = recentRows(db, f.id, 10)
    expect(rows.map((r) => JSON.parse(r.payload).n)).toEqual([5, 4, 3])   // newest first, capped at 3
    // feed-level pushed_at tracks the latest stream push too (staleness reads one place)
    expect(getFeed(db, f.id)!.pushed_at).toBe(1005)
  })

  it('updateFeed patches everything except mode; audit rows written', () => {
    const f = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
    expect(updateFeed(db, f.id, { name: 'cpu2', stale_after_s: 120, alert_on_stale: true })).toBe(true)
    const row = getFeed(db, f.id)!
    expect(row.name).toBe('cpu2')
    expect(row.stale_after_s).toBe(120)
    expect(row.alert_on_stale).toBe(1)
    expect(row.mode).toBe('value')
    const events = db.prepare('SELECT event FROM audit_log ORDER BY id').all().map((r: any) => r.event)
    expect(events).toContain('feed_created')
    expect(events).toContain('feed_updated')
  })

  it('delete removes rows in the same transaction', () => {
    const f = createFeed(db, { name: 'log', mode: 'stream' }, 1000)
    pushStreamRow(db, f.id, { n: 1 }, 'snd_a', 2000)
    expect(deleteFeed(db, f.id)).toBe(true)
    expect(getFeed(db, f.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS c FROM feed_rows').get().c).toBe(0)
  })

  it('senderMayPush: NULL allows all; list restricts; corrupt list fails closed', () => {
    const open = createFeed(db, { name: 'a', mode: 'value' }, 1000)
    const restricted = createFeed(db, { name: 'b', mode: 'value', allowed_senders: ['snd_x'] }, 1000)
    expect(senderMayPush(open, 'snd_anything')).toBe(true)
    expect(senderMayPush(restricted, 'snd_x')).toBe(true)
    expect(senderMayPush(restricted, 'snd_y')).toBe(false)
    expect(senderMayPush({ ...restricted, allowed_senders: '{not json' } as any, 'snd_x')).toBe(false)
  })

  it('staleCandidates filters to alertable, configured, pushed feeds', () => {
    createFeed(db, { name: 'no-alert', mode: 'value', stale_after_s: 60 }, 1000)
    const alertable = createFeed(db, { name: 'alertable', mode: 'value', stale_after_s: 60, alert_on_stale: true }, 1000)
    createFeed(db, { name: 'never-pushed', mode: 'value', stale_after_s: 60, alert_on_stale: true }, 1000)
    pushValue(db, alertable.id, 1, 'snd_a', 2000)
    expect(staleCandidates(db).map((f) => f.name)).toEqual(['alertable'])
  })
})
