import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import {
  createSender, deleteSender, findSenderByToken, listRelaySenders, listSenders, relayKeyForAlert,
  touchSender,
} from '../src/db/senders.js'
import { deriveKey } from '../src/relay/envelope.js'
import { ingestNotify } from '../src/db/alerts.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'

describe('senders', () => {
  it('creates and finds by raw token', () => {
    const db = openDb(':memory:')
    const { sender, token } = createSender(db, 'Netdata', ['dev_a'])
    expect(sender.id).toMatch(/^snd_/)
    expect(token).toMatch(/^dbz_s_/)
    expect(findSenderByToken(db, token)?.id).toBe(sender.id)
    expect(findSenderByToken(db, 'dbz_s_wrong')).toBeUndefined()
  })
  it('lists, touches, deletes', () => {
    const db = openDb(':memory:')
    const { sender } = createSender(db, 'A', [])
    touchSender(db, sender.id, 123)
    // Find the created sender by id (snd_hub is always present post-v4)
    const senders = listSenders(db)
    const created = senders.find(s => s.id === sender.id)
    expect(created?.last_used_at).toBe(123)
    expect(deleteSender(db, sender.id)).toEqual({ deleted: true, retracted: [] })
    // After deletion, only snd_hub remains (system-reserved sender, never deleted)
    expect(listSenders(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'snd_hub', name: 'Hub' }),
    ]))
  })

  /**
   * `alerts.sender_id` is a NOT NULL foreign key, so deleting a sender must remove its alert rows
   * as well. A sender is a credential, not an archive: deleting one takes what it sent
   * with it, and hands back whatever was still live so the caller can retract it from devices.
   */
  it('takes its alerts and their deliveries with it, and reports what was still live', () => {
    const db = openDb(':memory:')
    const { sender } = createSender(db, 'noisy', [])
    const device = redeemPairingCode(db, createPairingCode(db, 'panel', 1).code, 2)!.device
    const live = ingestNotify(db, {
      senderId: sender.id, title: 'On screen now', severity: 'warn', targetDevices: [device.id],
    }, 10).alert
    const old = ingestNotify(db, {
      senderId: sender.id, title: 'Long gone', severity: 'info', targetDevices: [device.id],
    }, 11).alert
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(old.id)

    const removed = deleteSender(db, sender.id)

    expect(removed.deleted).toBe(true)
    // Only the live one is reported back: a dismissed alert is not on any screen to retract.
    expect(removed.retracted).toEqual([{ id: live.id, target_devices: [device.id] }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE sender_id = ?').get(sender.id)).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE alert_id IN (?, ?)').get(live.id, old.id))
      .toEqual({ n: 0 })
    expect(listSenders(db).some((s) => s.id === sender.id)).toBe(false)
  })

  it('reports a sender that was never there without touching anything', () => {
    const db = openDb(':memory:')
    expect(deleteSender(db, 'snd_missing')).toEqual({ deleted: false, retracted: [] })
  })

  it('stores the derived relay key, never the raw token', () => {
    const db = openDb(':memory:')
    const { sender, token } = createSender(db, 'remote', [])
    const row = db.prepare('SELECT token_hash, relay_key FROM senders WHERE id = ?')
      .get(sender.id) as { token_hash: string; relay_key: Buffer }
    expect(row.relay_key).toBeInstanceOf(Buffer)
    // Exactly the key the sender itself derives, so both sides seal and open the same envelopes.
    expect(row.relay_key.equals(deriveKey(token))).toBe(true)
    // ...and nothing that works as a bearer credential against /api/notify.
    expect(row.relay_key.toString('utf8')).not.toContain(token)
    expect(row.relay_key.toString('base64')).not.toBe(row.token_hash)
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(token)
    }
  })

  it('never leaks the relay key through listSenders — that response is the admin API body', () => {
    const db = openDb(':memory:')
    createSender(db, 'remote', [])
    expect(Object.keys(listSenders(db)[0]).sort())
      .toEqual(['created_at', 'default_devices', 'id', 'last_used_at', 'name'])
  })

  it('listRelaySenders skips senders with no relay key', () => {
    const db = openDb(':memory:')
    const keyed = createSender(db, 'keyed', [])
    const legacy = createSender(db, 'legacy', [])
    db.prepare('UPDATE senders SET relay_key = NULL WHERE id = ?').run(legacy.sender.id)
    expect(listRelaySenders(db).map((s) => s.id)).toEqual([keyed.sender.id])
  })

  it('relayKeyForAlert finds the key of the sender behind an alert, and null when it has none', () => {
    const db = openDb(':memory:')
    const { sender, token } = createSender(db, 'remote', [])
    const { alert } = ingestNotify(db, {
      senderId: sender.id, title: 'x', severity: 'info', targetDevices: [],
    }, 1000)
    expect(relayKeyForAlert(db, alert.id)?.equals(deriveKey(token))).toBe(true)
    expect(relayKeyForAlert(db, 'alr_missing')).toBeNull()
    db.prepare('UPDATE senders SET relay_key = NULL').run()
    expect(relayKeyForAlert(db, alert.id)).toBeNull()
  })
})
