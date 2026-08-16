import { describe, expect, it, beforeEach } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { StatePusher } from '../src/ws/statePush.js'
import { createPairingCode, redeemPairingCode, setDeviceTabs } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'

const GRID = { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] }

describe('StatePusher set-based acks + TAB', () => {
  let db: DB
  let sent: any[]
  let registry: any

  beforeEach(() => {
    db = openDb(':memory:')
    sent = []
    registry = {
      isOnline: () => true,
      send: (_id: string, msg: object) => sent.push(msg),
      sendMany: () => {},
      all: () => new Map(),
    }
  })

  /** Two-tab device: tabs [a, b], in that order. */
  const twoTabDevice = () => {
    const { code } = createPairingCode(db, 'kitchen', 1000)
    const d = redeemPairingCode(db, code, 1000)!.device
    const a = createScreen(db, { name: 'A', orientation: 'landscape', grid: GRID }, 1000)
    const b = createScreen(db, { name: 'B', orientation: 'landscape', grid: GRID }, 1000)
    setDeviceTabs(db, d.id, [{ screen_id: a.id }, { screen_id: b.id }])
    return { device: d, a, b }
  }

  it('multi-tab push acks clean with the full id set', () => {
    const p = new StatePusher(db, registry, { ackTimeoutMs: 60_000 })
    const { device: d, a, b } = twoTabDevice()
    p.push(d.id)
    p.onAck(d.id, 1, [a.id, b.id], false)
    expect(p.rendering(d.id)!.state).toBe('ok')
  })

  it('legacy single ack against multi-tab push compares tab 0 only', () => {
    const p = new StatePusher(db, registry, { ackTimeoutMs: 60_000 })
    const { device: d, a } = twoTabDevice()
    p.push(d.id)
    p.onAck(d.id, 1, [a.id], true)
    expect(p.rendering(d.id)!.state).toBe('ok')
    const events = db.prepare("SELECT event FROM audit_log WHERE event LIKE 'state_ack%'").all()
    expect(events).toEqual([])
  })

  it('legacy ack naming the wrong screen still warns', () => {
    const p = new StatePusher(db, registry, { ackTimeoutMs: 60_000 })
    const { device: d, b } = twoTabDevice()
    p.push(d.id)
    p.onAck(d.id, 1, [b.id], true)
    expect(p.rendering(d.id)!.state).toBe('warning')
  })

  it('set ack missing a tab warns', () => {
    const p = new StatePusher(db, registry, { ackTimeoutMs: 60_000 })
    const { device: d, a } = twoTabDevice()
    p.push(d.id)
    p.onAck(d.id, 1, [a.id], false)
    expect(p.rendering(d.id)!.state).toBe('warning')
  })

  it('onTab records active tab in rendering()', () => {
    const p = new StatePusher(db, registry, { ackTimeoutMs: 60_000 })
    const { device: d, a, b } = twoTabDevice()
    p.push(d.id)
    p.onAck(d.id, 1, [a.id, b.id], false)
    p.onTab(d.id, b.id)
    expect(p.rendering(d.id)!.active_screen_id).toBe(b.id)
  })
})
