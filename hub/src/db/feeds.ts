import type { DB } from './index.js'
import { newId } from '../ids.js'
import { audit, type AdminActor } from './audit.js'

export type FeedMode = 'value' | 'stream' | 'image'

export interface FeedRow {
  id: string
  name: string
  mode: FeedMode
  cap: number
  stale_after_s: number | null
  alert_on_stale: number
  allowed_senders: string | null
  payload: string | null
  pushed_at: number | null
  pushed_by: string | null
  image_rev: number
  created_at: number
}

export interface FeedStreamRow {
  id: number
  feed_id: string
  payload: string
  pushed_at: number
  pushed_by: string
}

const COLS =
  'id, name, mode, cap, stale_after_s, alert_on_stale, allowed_senders, payload, pushed_at, pushed_by, image_rev, created_at'

export function createFeed(
  db: DB,
  input: {
    name: string
    mode: FeedMode
    cap?: number
    stale_after_s?: number | null
    alert_on_stale?: boolean
    allowed_senders?: string[] | null
  },
  now: number,
  actor: AdminActor = { type: 'admin', id: null },
): FeedRow {
  const row: FeedRow = {
    id: newId('feed'),
    name: input.name,
    mode: input.mode,
    cap: input.cap ?? 50,
    stale_after_s: input.stale_after_s ?? null,
    alert_on_stale: input.alert_on_stale ? 1 : 0,
    allowed_senders: input.allowed_senders ? JSON.stringify(input.allowed_senders) : null,
    payload: null,
    pushed_at: null,
    pushed_by: null,
    image_rev: 0,
    created_at: now,
  }
  db.prepare(
    `INSERT INTO feeds (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.name, row.mode, row.cap, row.stale_after_s, row.alert_on_stale,
    row.allowed_senders, row.payload, row.pushed_at, row.pushed_by, row.image_rev, row.created_at,
  )
  audit(db, actor.type, actor.id, 'feed_created', { feed_id: row.id, mode: row.mode })
  return row
}

export function listFeeds(db: DB): FeedRow[] {
  return db.prepare(`SELECT ${COLS} FROM feeds ORDER BY created_at`).all() as FeedRow[]
}

export function getFeed(db: DB, id: string): FeedRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM feeds WHERE id = ?`).get(id) as FeedRow | undefined
}

/** mode is immutable after creation (conversion = delete + recreate). */
export function updateFeed(
  db: DB,
  id: string,
  patch: {
    name?: string
    cap?: number
    stale_after_s?: number | null
    alert_on_stale?: boolean
    allowed_senders?: string[] | null
  },
  actor: AdminActor = { type: 'admin', id: null },
): boolean {
  const existing = getFeed(db, id)
  if (!existing) return false
  const res = db.prepare(
    'UPDATE feeds SET name = ?, cap = ?, stale_after_s = ?, alert_on_stale = ?, allowed_senders = ? WHERE id = ?',
  ).run(
    patch.name ?? existing.name,
    patch.cap ?? existing.cap,
    patch.stale_after_s !== undefined ? patch.stale_after_s : existing.stale_after_s,
    patch.alert_on_stale !== undefined ? (patch.alert_on_stale ? 1 : 0) : existing.alert_on_stale,
    patch.allowed_senders !== undefined
      ? (patch.allowed_senders ? JSON.stringify(patch.allowed_senders) : null)
      : existing.allowed_senders,
    id,
  )
  if (res.changes > 0) audit(db, actor.type, actor.id, 'feed_updated', { feed_id: id })
  return res.changes > 0
}

/**
 * Rows go before a feed, so a feed id never dangles. The source repository calls this inside its
 * own transaction after deleting the source row, so it intentionally has no transaction wrapper:
 * callers that own the larger operation compose it.
 *
 * The retired v18 `connectors` table is deliberately NOT swept here. It is legacy migration data
 * now — nothing reads it at runtime and nothing writes it — and pruning rows out of a frozen table
 * as a side effect of an unrelated delete is how append-only history stops being history.
 */
export function deleteFeedForSource(
  db: DB, id: string, actor: AdminActor = { type: 'admin', id: null },
): boolean {
  db.prepare('DELETE FROM feed_rows WHERE feed_id = ?').run(id)
  const res = db.prepare('DELETE FROM feeds WHERE id = ?').run(id)
  if (res.changes > 0) audit(db, actor.type, actor.id, 'feed_deleted', { feed_id: id, reason: 'source_deleted' })
  return res.changes > 0
}

export function deleteFeed(db: DB, id: string, actor: AdminActor = { type: 'admin', id: null }): boolean {
  const output = db.prepare('SELECT source_id FROM source_outputs WHERE feed_id = ?').get(id) as { source_id: string | null } | undefined
  if (output?.source_id !== undefined && output.source_id !== null) throw new Error('delete the connection instead')
  return db.transaction(() => {
    // A nullable-source row is the semantic shadow of a raw/push feed. It is safe to remove
    // with that feed, unlike a provider-owned row which only deleteSource may remove.
    if (output?.source_id === null) db.prepare('DELETE FROM source_outputs WHERE feed_id = ?').run(id)
    return deleteFeedForSource(db, id, actor)
  })()
}

/** NULL allowlist = any valid sender. A corrupt allowlist fails CLOSED (push denied, not open). */
export function senderMayPush(feed: FeedRow, senderId: string): boolean {
  if (feed.allowed_senders === null) return true
  try {
    const list = JSON.parse(feed.allowed_senders)
    return Array.isArray(list) && list.includes(senderId)
  } catch {
    return false
  }
}

export function pushValue(db: DB, feedId: string, payload: unknown, senderId: string, now: number): void {
  db.prepare('UPDATE feeds SET payload = ?, pushed_at = ?, pushed_by = ? WHERE id = ?')
    .run(JSON.stringify(payload), now, senderId, feedId)
}

/**
 * Image mode has no JSON payload column to write — the bytes live on disk in the route layer;
 * this just bumps the revision counter devices use as an etag/cache-buster and updates
 * pushed_at/by like the other two push paths, so staleness reads one place regardless of mode.
 * Returns the new rev so the route can echo it in the push response.
 */
export function bumpImageRev(db: DB, feedId: string, senderId: string, now: number): number {
  db.prepare('UPDATE feeds SET image_rev = image_rev + 1, pushed_at = ?, pushed_by = ? WHERE id = ?')
    .run(now, senderId, feedId)
  return (db.prepare('SELECT image_rev FROM feeds WHERE id = ?').get(feedId) as { image_rev: number }).image_rev
}

/**
 * Append + trim in ONE transaction (data model). The feed row's pushed_at/by also update
 * so staleness always reads one place regardless of mode.
 */
export function pushStreamRow(db: DB, feedId: string, payload: unknown, senderId: string, now: number): void {
  const feed = getFeed(db, feedId)
  if (!feed) return
  db.transaction(() => {
    db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
      .run(feedId, JSON.stringify(payload), now, senderId)
    db.prepare(
      'DELETE FROM feed_rows WHERE feed_id = ? AND id NOT IN (SELECT id FROM feed_rows WHERE feed_id = ? ORDER BY id DESC LIMIT ?)',
    ).run(feedId, feedId, feed.cap)
    db.prepare('UPDATE feeds SET pushed_at = ?, pushed_by = ? WHERE id = ?').run(now, senderId, feedId)
  })()
}

/**
 * "This feed was refreshed, there was just nothing new." Only a connector needs it: a news source
 * that publishes nothing for an hour is WORKING, but a connector-fed feed alerts as stale at three
 * intervals, so without this every quiet RSS source would raise "feed has gone stale" on a
 * schedule — the alarm reporting the source's own editorial calendar back at the operator.
 *
 * Deliberately does NOT append a row or bump image_rev: nothing about the feed's contents changed,
 * and the boards are not woken for it either (connectors/loop.ts).
 */
export function touchFeed(db: DB, feedId: string, senderId: string, now: number): void {
  db.prepare('UPDATE feeds SET pushed_at = ?, pushed_by = ? WHERE id = ?').run(now, senderId, feedId)
}

export function recentRows(db: DB, feedId: string, limit: number): FeedStreamRow[] {
  return db.prepare(
    'SELECT id, feed_id, payload, pushed_at, pushed_by FROM feed_rows WHERE feed_id = ? ORDER BY id DESC LIMIT ?',
  ).all(feedId, limit) as FeedStreamRow[]
}

/** The stale sweep's working set: alertable, configured, and pushed at least once. */
export function staleCandidates(db: DB): FeedRow[] {
  return db.prepare(
    `SELECT ${COLS} FROM feeds WHERE alert_on_stale = 1 AND stale_after_s IS NOT NULL AND pushed_at IS NOT NULL ORDER BY created_at`,
  ).all() as FeedRow[]
}
