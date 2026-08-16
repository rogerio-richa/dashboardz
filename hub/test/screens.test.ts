import { describe, expect, it, beforeEach } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { createScreen, listScreens, getScreen, updateScreen, deleteScreen, assignedDeviceIds, referencedFeedIds, screensReferencingFeed } from '../src/db/screens.js'
import { assignScreen, getDevice, redeemPairingCode, createPairingCode, listDeviceTabs } from '../src/db/devices.js'

const GRID = { cells: [
  { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} },
  { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'alert_feed', config: { min_severity: 'warn' } },
] }

describe('screens db', () => {
  let db: DB
  beforeEach(() => { db = openDb(':memory:') })

  const device = () => {
    const { code } = createPairingCode(db, 'kitchen', 1000)
    return redeemPairingCode(db, code, 1000)!.device
  }

  it('creates with lay_ id, lists, gets, round-trips grid JSON', () => {
    const s = createScreen(db, { name: 'Kitchen board', orientation: 'landscape', grid: GRID }, 1000)
    expect(s.id).toMatch(/^lay_/)
    expect(getScreen(db, s.id)?.name).toBe('Kitchen board')
    expect(JSON.parse(getScreen(db, s.id)!.grid)).toEqual(GRID)
    expect(listScreens(db)).toHaveLength(1)
  })

  it('updateScreen patches only given fields, bumps rev, and reports a missing id', () => {
    const s = createScreen(db, { name: 'a', orientation: 'landscape', grid: GRID }, 1000)
    expect(updateScreen(db, s.id, { name: 'b' })).toEqual({ status: 'updated', rev: 2 })
    expect(getScreen(db, s.id)!.orientation).toBe('landscape')
    expect(getScreen(db, s.id)!.name).toBe('b')
    expect(updateScreen(db, 'lay_nope', { name: 'x' })).toEqual({ status: 'missing' })
  })

  it('deleteScreen resets assigned devices to NULL in one transaction and reports them', () => {
    const s = createScreen(db, { name: 'a', orientation: 'landscape', grid: GRID }, 1000)
    const d = device()
    expect(assignScreen(db, d.id, s.id)).toBe(true)
    expect(assignedDeviceIds(db, s.id)).toEqual([d.id])
    const res = deleteScreen(db, s.id)
    expect(res).toEqual({ deleted: true, resetDeviceIds: [d.id] })
    expect(getDevice(db, d.id)).toBeDefined()
    expect(listDeviceTabs(db, d.id)).toEqual([])
    expect(getScreen(db, s.id)).toBeUndefined()
    // Assert audit trail: each device reset is logged with reason, then the screen deletion
    const resetAudit = db.prepare("SELECT * FROM audit_log WHERE event = 'device_screen_assigned'").get() as any
    expect(resetAudit).toBeDefined()
    expect(JSON.parse(resetAudit.details)).toEqual({ device_id: d.id, screen_id: null, reason: 'screen_deleted' })
    const deleteAudit = db.prepare("SELECT * FROM audit_log WHERE event = 'screen_deleted'").get() as any
    expect(deleteAudit).toBeDefined()
    expect(JSON.parse(deleteAudit.details)).toEqual({ screen_id: s.id, reset_devices: 1 })
  })

  /** v15: a pairing code no longer carries a shape, because a device no longer has one. */
  it('device rows come out unassigned, with no orientation of their own', () => {
    const { code } = createPairingCode(db, 'hall', 1000)
    const d = redeemPairingCode(db, code, 1000)!.device
    expect(listDeviceTabs(db, d.id)).toEqual([])
    expect((d as unknown as Record<string, unknown>).orientation).toBeUndefined()
  })

  it('referencedFeedIds walks cell configs, dedupes, and never throws on garbage', () => {
    expect(referencedFeedIds({
      cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'value_tile', config: { feed: 'feed_a', path: 'x' } },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'stream_list', config: { feed: 'feed_a' } },
      ],
    })).toEqual(['feed_a'])
    expect(referencedFeedIds({ cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] })).toEqual([])
    expect(referencedFeedIds(null)).toEqual([])
    expect(referencedFeedIds({ cells: [{ config: { feed: 42 } }] })).toEqual([])
  })

  it('referencedFeedIds also walks chart series[].feed (chart behavior), deduping against config.feed cells too', () => {
    expect(referencedFeedIds({
      cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, widget: 'chart', config: { series: [{ feed: 'feed_cpu', y_path: 'v', icon: 'circle' }, { feed: 'feed_ram', y_path: 'v', icon: 'square' }], style: 'line' } },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, widget: 'value_tile', config: { feed: 'feed_cpu', path: 'v' } },
        { rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, widget: 'image', config: { feed: 'feed_img', fit: 'contain' } },
        { rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, widget: 'chart', config: { series: [{ feed: 'feed_ram', y_path: 'v', icon: 'star' }], style: 'line' } },
      ],
    })).toEqual(['feed_cpu', 'feed_ram', 'feed_img'])
  })

  it('referencedFeedIds tolerates a chart cell with a garbage/missing series array', () => {
    const full = { x: 0, y: 0, w: 1, h: 1 }
    expect(referencedFeedIds({ cells: [{ rect: full, widget: 'chart', config: { style: 'line' } }] })).toEqual([])
    expect(referencedFeedIds({ cells: [{ rect: full, widget: 'chart', config: { series: 'nope' } }] })).toEqual([])
    expect(referencedFeedIds({ cells: [{ rect: full, widget: 'chart', config: { series: [null, 42, { feed: 7 }, { feed: 'ok' }] } }] })).toEqual(['ok'])
  })

  it('screensReferencingFeed finds screens by grid reference', () => {
    const s = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: 'feed_a', path: 'x' } }],
    } }, 1000)
    expect(screensReferencingFeed(db, 'feed_a')).toEqual([{ id: s.id, name: 'board' }])
    expect(screensReferencingFeed(db, 'feed_b')).toEqual([])
  })
})
