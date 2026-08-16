import { describe, expect, it, beforeEach } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { startFeedStaleSweep } from '../src/ws/feedStale.js'
import { createFeed, pushValue, deleteFeed } from '../src/db/feeds.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'

/** Registry stand-in: records sends (dataPush.test.ts / statePush.test.ts's pattern). */
class FakeRegistry {
  sent: Array<{ deviceId: string; msg: any }> = []
  online = new Set<string>()
  isOnline(id: string) { return this.online.has(id) }
  send(id: string, msg: object) { this.sent.push({ deviceId: id, msg }) }
  sendMany(ids: string[], msg: object) { for (const id of ids) this.send(id, msg) }
}

describe('startFeedStaleSweep', () => {
  let db: DB
  let reg: FakeRegistry
  beforeEach(() => { db = openDb(':memory:'); reg = new FakeRegistry() })

  const device = (name = 'kitchen') => {
    const { code } = createPairingCode(db, name, 1000)
    const d = redeemPairingCode(db, code, 1000)!.device
    reg.online.add(d.id)
    return d
  }

  it('crossing stale raises one deduped warn via snd_hub, sound off, targeting all devices', () => {
    const d1 = device('kitchen')
    const d2 = device('hall')
    const feed = createFeed(db, { name: 'cpu', mode: 'value', stale_after_s: 60, alert_on_stale: true }, 1000)
    pushValue(db, feed.id, { load: 1 }, 'snd_hub', 0)

    const sweep = startFeedStaleSweep(db, reg as any, {})
    sweep.run(61_000)

    const audits = db.prepare("SELECT * FROM audit_log WHERE event = 'feed_stale'").all() as any[]
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0].details)).toEqual({ feed_id: feed.id })

    const alerts = db.prepare('SELECT * FROM alerts').all() as any[]
    expect(alerts).toHaveLength(1)
    expect(alerts[0].sender_id).toBe('snd_hub')
    expect(alerts[0].severity).toBe('warn')
    expect(alerts[0].sound).toBe(0)
    expect(alerts[0].dedup_key).toBe(`feed_stale:${feed.id}`)
    expect(JSON.parse(alerts[0].target_devices).sort()).toEqual([d1.id, d2.id].sort())

    const added = reg.sent.filter((s) => s.msg.type === 'ALERT_ADD')
    expect(added.map((s) => s.deviceId).sort()).toEqual([d1.id, d2.id].sort())
    sweep.stop()
  })

  it('re-running while still stale does not create a second alert', () => {
    device('kitchen')
    const feed = createFeed(db, { name: 'cpu', mode: 'value', stale_after_s: 60, alert_on_stale: true }, 1000)
    pushValue(db, feed.id, { load: 1 }, 'snd_hub', 0)

    const sweep = startFeedStaleSweep(db, reg as any, {})
    sweep.run(61_000)
    sweep.run(70_000)
    sweep.run(80_000)

    const alerts = db.prepare('SELECT * FROM alerts').all() as any[]
    expect(alerts).toHaveLength(1)
    expect(reg.sent.filter((s) => s.msg.type === 'ALERT_ADD')).toHaveLength(1)
    sweep.stop()
  })

  it('recovery is silent and re-staling alerts again', () => {
    device('kitchen')
    const feed = createFeed(db, { name: 'cpu', mode: 'value', stale_after_s: 60, alert_on_stale: true }, 1000)
    pushValue(db, feed.id, { load: 1 }, 'snd_hub', 0)

    const sweep = startFeedStaleSweep(db, reg as any, {})
    sweep.run(61_000)
    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 1 })

    // Fresh push recovers — silent, no new alert.
    pushValue(db, feed.id, { load: 2 }, 'snd_hub', 62_000)
    sweep.run(63_000)
    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 1 })

    // Ages out again — alerts again (dedup_key updates the same row, update_count increments).
    sweep.run(62_000 + 61_000)
    const alerts = db.prepare('SELECT * FROM alerts').all() as any[]
    expect(alerts).toHaveLength(1)
    expect(alerts[0].update_count).toBe(1)
    sweep.stop()
  })

  it('feeds without alert_on_stale never alert', () => {
    device('kitchen')
    const feed = createFeed(db, { name: 'cpu', mode: 'value', stale_after_s: 60, alert_on_stale: false }, 1000)
    pushValue(db, feed.id, { load: 1 }, 'snd_hub', 0)

    const sweep = startFeedStaleSweep(db, reg as any, {})
    sweep.run(1_000_000)

    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 0 })
    expect(reg.sent).toHaveLength(0)
    sweep.stop()
  })

  it('a deleted feed clears from the flag map without throwing', () => {
    device('kitchen')
    const feed = createFeed(db, { name: 'cpu', mode: 'value', stale_after_s: 60, alert_on_stale: true }, 1000)
    pushValue(db, feed.id, { load: 1 }, 'snd_hub', 0)

    const sweep = startFeedStaleSweep(db, reg as any, {})
    sweep.run(61_000)
    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 1 })

    deleteFeed(db, feed.id)
    expect(() => sweep.run(200_000)).not.toThrow()
    // No second alert for a feed that no longer exists.
    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 1 })
    sweep.stop()
  })
})
