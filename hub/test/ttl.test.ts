import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { ingestNotify } from '../src/db/alerts.js'
import { runSweep } from '../src/ttl.js'
import { DeviceRegistry } from '../src/ws/registry.js'

describe('runSweep', () => {
  /**
   * The sweep is for notifications. A critical is an alarm — it holds the screen and keeps
   * sounding until a person dismisses it, so there is nothing for a timer to reclaim. It carries
   * no expiry at all, which is why the sweep needs no special case to leave it alone.
   */
  it('never reclaims a critical, however long it has been up', () => {
    const db = openDb(':memory:')
    const dev = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
    const snd = createSender(db, 's', []).sender.id
    const { alert } = ingestNotify(db, {
      senderId: snd, title: 'Smoke detected', severity: 'critical', ttl_s: 10, targetDevices: [dev],
    }, 1000)

    const registry = new DeviceRegistry()
    const sendMany = vi.spyOn(registry, 'sendMany')

    // A week later, with the TTL the sender asked for long past.
    runSweep(db, registry, 1000 + 7 * 24 * 60 * 60 * 1000)

    expect(sendMany).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status FROM alerts WHERE id = ?').get(alert.id)).toEqual({ status: 'active' })
  })

  it('pushes ALERT_REMOVE expired to target devices and audits', () => {
    const db = openDb(':memory:')
    const dev = redeemPairingCode(db, createPairingCode(db, 'a', 0).code, 1)!.device.id
    const snd = createSender(db, 's', []).sender.id
    const { alert } = ingestNotify(db, { senderId: snd, title: 'x', severity: 'info', ttl_s: 10, targetDevices: [dev] }, 1000)

    const registry = new DeviceRegistry()
    const sendMany = vi.spyOn(registry, 'sendMany')

    runSweep(db, registry, 5000)
    expect(sendMany).not.toHaveBeenCalled()

    runSweep(db, registry, 11_001)
    expect(sendMany).toHaveBeenCalledWith([dev], { type: 'ALERT_REMOVE', id: alert.id, reason: 'expired' })
    expect(db.prepare("SELECT * FROM audit_log WHERE event = 'alert_expired'").get()).toBeDefined()
  })
})
