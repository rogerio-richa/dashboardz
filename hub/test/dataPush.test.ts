import { describe, expect, it, beforeEach } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { wireFeed, buildData, DataPusher } from '../src/ws/dataPush.js'
import { createPairingCode, redeemPairingCode, assignScreen, setDeviceTabs } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'
import { createFeed, getFeed, pushValue, pushStreamRow, deleteFeed } from '../src/db/feeds.js'

/** Registry stand-in: records sends, reports every device online (statePush.test.ts's pattern). */
class FakeRegistry {
  sent: Array<{ deviceId: string; msg: any }> = []
  online = new Set<string>()
  isOnline(id: string) { return this.online.has(id) }
  send(id: string, msg: object) { this.sent.push({ deviceId: id, msg }) }
  sendMany(ids: string[], msg: object) { for (const id of ids) this.send(id, msg) }
  all() { return new Map([...this.online].map((id) => [id, {} as any])) }
}

describe('dataPush', () => {
  let db: DB
  let reg: FakeRegistry
  beforeEach(() => { db = openDb(':memory:'); reg = new FakeRegistry() })

  const device = (name = 'kitchen') => {
    const { code } = createPairingCode(db, name, 1000)
    const d = redeemPairingCode(db, code, 1000)!.device
    reg.online.add(d.id)
    return d
  }

  describe('wireFeed', () => {
    it('value feed carries parsed payload; never-pushed carries null', () => {
      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      pushValue(db, feed.id, { load: 1.5 }, 'snd_hub', 2000)
      const pushed = getFeed(db, feed.id)!
      expect(wireFeed(db, pushed)).toEqual({
        mode: 'value', payload: { load: 1.5 }, pushed_at: 2000, stale_after_s: null,
      })

      const fresh = createFeed(db, { name: 'mem', mode: 'value' }, 1000)
      expect(wireFeed(db, fresh)).toEqual({
        mode: 'value', payload: null, pushed_at: null, stale_after_s: null,
      })
    })

    it('stream feed carries rows newest-first up to cap', () => {
      const feed = createFeed(db, { name: 'log', mode: 'stream', cap: 2 }, 1000)
      pushStreamRow(db, feed.id, { n: 1 }, 'snd_hub', 1001)
      pushStreamRow(db, feed.id, { n: 2 }, 'snd_hub', 1002)
      pushStreamRow(db, feed.id, { n: 3 }, 'snd_hub', 1003)
      const row = getFeed(db, feed.id)!
      expect(wireFeed(db, row)).toEqual({
        mode: 'stream',
        rows: [{ payload: { n: 3 }, pushed_at: 1003 }, { payload: { n: 2 }, pushed_at: 1002 }],
        pushed_at: 1003, stale_after_s: null,
      })
    })

    it('unparseable stored payload degrades to null, never throws', () => {
      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      pushValue(db, feed.id, { ok: true }, 'snd_hub', 2000)
      db.prepare("UPDATE feeds SET payload = '{broken' WHERE id = ?").run(feed.id)
      const row = getFeed(db, feed.id)!
      expect(() => wireFeed(db, row)).not.toThrow()
      expect(wireFeed(db, row).payload).toBeNull()
    })
  })

  describe('buildData', () => {
    it('skips deleted feeds and returns null when nothing resolves', () => {
      expect(buildData(db, ['feed_gone'], 5000)).toBeNull()

      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      const msg = buildData(db, ['feed_gone', feed.id], 5000)
      expect(msg).toEqual({
        type: 'DATA', server_time: 5000,
        feeds: { [feed.id]: { mode: 'value', payload: null, pushed_at: null, stale_after_s: null } },
      })
    })
  })

  describe('DataPusher', () => {
    it('snapshot sends one DATA with every referenced feed after assignment', () => {
      const p = new DataPusher(db, reg as any)
      const d = device()
      const f1 = createFeed(db, { name: 'a', mode: 'value' }, 1000)
      const f2 = createFeed(db, { name: 'b', mode: 'value' }, 1000)
      const screen = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
        cells: [
          { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'value_tile', config: { feed: f1.id, path: 'x' } },
          { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'value_tile', config: { feed: f2.id, path: 'x' } },
        ],
      } }, 1000)
      assignScreen(db, d.id, screen.id)

      p.snapshot(d.id)

      const dataMsgs = reg.sent.filter((s) => s.msg.type === 'DATA')
      expect(dataMsgs).toHaveLength(1)
      expect(Object.keys(dataMsgs[0].msg.feeds).sort()).toEqual([f1.id, f2.id].sort())
    })

    it('snapshot unions feeds referenced across every tab, not just tab 0', () => {
      const p = new DataPusher(db, reg as any)
      const d = device()
      const f1 = createFeed(db, { name: 'a', mode: 'value' }, 1000)
      const f2 = createFeed(db, { name: 'b', mode: 'value' }, 1000)
      const tab1 = createScreen(db, { name: 'cc', orientation: 'landscape', grid: {
        cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: f1.id, path: 'x' } }],
      } }, 1000)
      const tab2 = createScreen(db, { name: 'io', orientation: 'landscape', grid: {
        cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: f2.id, path: 'x' } }],
      } }, 1000)
      setDeviceTabs(db, d.id, [{ screen_id: tab1.id }, { screen_id: tab2.id }])

      p.snapshot(d.id)

      const dataMsgs = reg.sent.filter((s) => s.msg.type === 'DATA')
      expect(dataMsgs).toHaveLength(1)
      expect(Object.keys(dataMsgs[0].msg.feeds).sort()).toEqual([f1.id, f2.id].sort())
    })

    it('snapshot is a no-op for devices with no data widgets', () => {
      const p = new DataPusher(db, reg as any)
      const d = device()
      p.snapshot(d.id)
      expect(reg.sent).toHaveLength(0)
    })

    it('onFeedPush targets only connected referencing devices', () => {
      const p = new DataPusher(db, reg as any)
      const d1 = device('kitchen')
      device('hall') // second device: does not reference the feed
      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      const screen = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
        cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'x' } }],
      } }, 1000)
      assignScreen(db, d1.id, screen.id)

      p.onFeedPush(feed.id)

      expect(reg.sent).toHaveLength(1)
      expect(reg.sent[0].deviceId).toBe(d1.id)
      expect(Object.keys(reg.sent[0].msg.feeds)).toEqual([feed.id])
    })

    it('snapshot messages carry snapshot: true; onFeedPush messages do not', () => {
      const p = new DataPusher(db, reg as any)
      const d = device()
      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      const screen = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
        cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'x' } }],
      } }, 1000)
      assignScreen(db, d.id, screen.id)

      p.snapshot(d.id)
      expect(reg.sent).toHaveLength(1)
      expect(reg.sent[0].msg.snapshot).toBe(true)

      reg.sent = []
      p.onFeedPush(feed.id)
      expect(reg.sent).toHaveLength(1)
      expect(reg.sent[0].msg.snapshot).toBeUndefined()
    })

    // Controller rule: deleting a referenced feed while a device is connected must
    // not leave it rendering stale data forever. The reference set is grid-derived and untouched
    // by a feed delete, so the device's next snapshot still has a non-empty reference set — it
    // must therefore still be SENT, carrying an empty `feeds: {}`, so the renderer's "replace on
    // snapshot" semantics can actually drop the dead feed (a bare merge could only ever add keys).
    it('snapshot after deleting the sole referenced feed sends a snapshot-marked DATA with empty feeds', () => {
      const p = new DataPusher(db, reg as any)
      const d = device()
      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      const screen = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
        cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'x' } }],
      } }, 1000)
      assignScreen(db, d.id, screen.id)
      deleteFeed(db, feed.id)

      p.snapshot(d.id)

      expect(reg.sent).toHaveLength(1)
      expect(reg.sent[0].msg).toEqual({ type: 'DATA', server_time: expect.any(Number), snapshot: true, feeds: {} })
    })

    it('snapshotReferencing sends a snapshot to every connected device that references the feed', () => {
      const p = new DataPusher(db, reg as any)
      const d1 = device('kitchen')
      device('hall') // second device: does not reference the feed
      const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
      const screen = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
        cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'x' } }],
      } }, 1000)
      assignScreen(db, d1.id, screen.id) // only d1 references the feed
      deleteFeed(db, feed.id) // simulates the admin DELETE route calling this AFTER deleteFeed

      p.snapshotReferencing(feed.id)

      expect(reg.sent).toHaveLength(1)
      expect(reg.sent[0].deviceId).toBe(d1.id)
      expect(reg.sent[0].msg).toEqual({ type: 'DATA', server_time: expect.any(Number), snapshot: true, feeds: {} })
    })
  })
})
