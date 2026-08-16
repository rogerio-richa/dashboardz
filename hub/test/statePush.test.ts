import { describe, expect, it, beforeEach, vi } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { StatePusher } from '../src/ws/statePush.js'
import { createPairingCode, redeemPairingCode, getDevice, assignScreen } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'

/** Registry stand-in: records sends, reports every device online. */
class FakeRegistry {
  sent: Array<{ deviceId: string; msg: any }> = []
  online = new Set<string>()
  isOnline(id: string) { return this.online.has(id) }
  send(id: string, msg: object) { this.sent.push({ deviceId: id, msg }) }
  sendMany(ids: string[], msg: object) { for (const id of ids) this.send(id, msg) }
}

const GRID = { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] }

describe('StatePusher', () => {
  let db: DB
  let reg: FakeRegistry
  beforeEach(() => { db = openDb(':memory:'); reg = new FakeRegistry() })

  const device = (name = 'kitchen') => {
    const { code } = createPairingCode(db, name, 1000)
    const d = redeemPairingCode(db, code, 1000)!.device
    reg.online.add(d.id)
    return d
  }

  it('mints monotonically increasing revs per device and skips offline devices', () => {
    const p = new StatePusher(db, reg as any)
    const d = device()
    p.push(d.id); p.push(d.id)
    expect(reg.sent.map((s) => s.msg.rev)).toEqual([1, 2])
    reg.online.delete(d.id)
    p.push(d.id)
    expect(reg.sent).toHaveLength(2)
  })

  it('ack of the latest rev settles rendering to ok; stale ack keeps pending', () => {
    const p = new StatePusher(db, reg as any, { ackTimeoutMs: 60_000 })
    const d = device()
    p.push(d.id); p.push(d.id)
    p.onAck(d.id, 1, [], true)
    expect(p.rendering(d.id)!.state).toBe('pending')
    p.onAck(d.id, 2, [], true)
    expect(p.rendering(d.id)).toEqual({ state: 'ok', acked_screen_id: null, active_screen_id: null })
  })

  it('ack timeout raises ONE deduped warn alert targeting the other devices, sound off', async () => {
    vi.useFakeTimers()
    const p = new StatePusher(db, reg as any, { ackTimeoutMs: 50 })
    const offender = device('kitchen')
    const other = device('hall')
    p.push(offender.id)
    vi.advanceTimersByTime(60)
    const alerts = db.prepare('SELECT * FROM alerts').all() as any[]
    expect(alerts).toHaveLength(1)
    expect(alerts[0].sender_id).toBe('snd_hub')
    expect(alerts[0].severity).toBe('warn')
    expect(alerts[0].sound).toBe(0)
    expect(alerts[0].dedup_key).toBe(`state_ack:${offender.id}`)
    expect(JSON.parse(alerts[0].target_devices)).toEqual([other.id])
    // The offender also got an ALERT_ADD? No — only targets get the push:
    expect(reg.sent.filter((s) => s.msg.type === 'ALERT_ADD').map((s) => s.deviceId)).toEqual([other.id])
    expect(p.rendering(offender.id)!.state).toBe('warning')
    vi.useRealTimers()
  })

  it('mismatched acked screen_id raises the warn immediately', () => {
    const p = new StatePusher(db, reg as any, { ackTimeoutMs: 60_000 })
    const d = device('kitchen'); device('hall')
    const s = createScreen(db, { name: 'B', orientation: 'landscape', grid: GRID }, 1000)
    assignScreen(db, d.id, s.id)
    p.push(d.id)
    p.onAck(d.id, 1, ['lay_wrong'], true)
    expect(p.rendering(d.id)!.state).toBe('warning')
    expect((db.prepare('SELECT dedup_key FROM alerts').get() as any).dedup_key).toBe(`state_ack:${d.id}`)
  })

  it('with no other devices to notify, it still audits and marks warning (never throws)', () => {
    vi.useFakeTimers()
    const p = new StatePusher(db, reg as any, { ackTimeoutMs: 50 })
    const only = device()
    p.push(only.id)
    vi.advanceTimersByTime(60)
    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 0 })
    expect(p.rendering(only.id)!.state).toBe('warning')
    const events = db.prepare("SELECT event FROM audit_log WHERE event LIKE 'state_ack%'").all() as any[]
    expect(events).toEqual([{ event: 'state_ack_timeout' }])
    vi.useRealTimers()
  })

  it('a corrupt stored grid degrades the push to no screen; ack of null matches WHAT WAS PUSHED, not the device\'s assigned tab', () => {
    const p = new StatePusher(db, reg as any, { ackTimeoutMs: 60_000 })
    const d = device('kitchen')
    device('hall') // second device: if the mismatch path wrongly fires, raiseWarn has a target to alert
    const s = createScreen(db, { name: 'B', orientation: 'landscape', grid: GRID }, 1000)
    assignScreen(db, d.id, s.id)
    // Corrupt the stored grid directly (bypasses AJV, simulating bad data already in the DB).
    // buildState degrades this to "no screen" (house rule: bad data never crashes a read), so
    // the client honestly acks screen_id: null — that must NOT be flagged as a mismatch against
    // the device's assigned tab (still s.id in device_screens), only against what was actually
    // pushed.
    db.prepare('UPDATE screens SET grid = ? WHERE id = ?').run('{not json', s.id)
    p.push(d.id)
    p.onAck(d.id, 1, [], true)
    expect(p.rendering(d.id)).toEqual({ state: 'ok', acked_screen_id: null, active_screen_id: null })
    expect(db.prepare('SELECT COUNT(*) c FROM alerts').get()).toEqual({ c: 0 })
  })

  it('a broken self-alert path (missing snd_hub sender) never crashes the timeout callback', () => {
    vi.useFakeTimers()
    const p = new StatePusher(db, reg as any, { ackTimeoutMs: 50 })
    const offender = device('kitchen')
    device('hall')
    // Simulate a corrupted senders table: ingestNotify's INSERT INTO alerts has a NOT NULL FK
    // to senders(id), so with foreign_keys ON this makes raiseWarn throw a constraint error.
    db.prepare("DELETE FROM senders WHERE id = 'snd_hub'").run()
    p.push(offender.id)
    expect(() => vi.advanceTimersByTime(60)).not.toThrow()
    expect(p.rendering(offender.id)!.state).toBe('warning')
    const events = db.prepare("SELECT event FROM audit_log WHERE event LIKE 'state_ack%'").all() as any[]
    expect(events).toEqual([{ event: 'state_ack_timeout' }])
    vi.useRealTimers()
  })
})
