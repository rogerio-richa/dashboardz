import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { activeWireAlertsForDevice, ingestNotify, recordAnswer, recordTap } from '../src/db/alerts.js'

let db: DB, senderId: string, devA: string, devB: string

beforeEach(() => {
  db = openDb(':memory:')
  senderId = createSender(db, 'S', []).sender.id
  devA = redeemPairingCode(db, createPairingCode(db, 'a', 0).code, 1)!.device.id
  devB = redeemPairingCode(db, createPairingCode(db, 'b', 0).code, 1)!.device.id
})

const withOptions = () => ingestNotify(db, {
  senderId, title: 'Meds', severity: 'warn', targetDevices: [devA, devB],
  options: [{ id: 'taken', label: 'Taken' }, { id: 'later', label: 'Later' }],
}, 1000).alert

const delivery = (alertId: string, deviceId: string) =>
  db.prepare('SELECT * FROM deliveries WHERE alert_id = ? AND device_id = ?')
    .get(alertId, deviceId) as any

const alertStatus = (alertId: string) =>
  (db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId) as { status: string }).status

describe('recordAnswer', () => {
  it('stamps the answer and the time for that device only, and concludes it there like a dismiss', () => {
    const a = withOptions()
    expect(recordAnswer(db, a.id, devA, 'taken', 1100)).toEqual({ ok: true })
    expect(delivery(a.id, devA).answer).toBe('taken')
    expect(delivery(a.id, devA).answered_at).toBe(1100)
    // Answering must also conclude the alert for this device the same way an explicit dismiss
    // does, or a reconnect's STATE rebuild (which filters on dismissed_at, not answered_at)
    // resurrects an alert this device already answered.
    expect(delivery(a.id, devA).dismissed_at).toBe(1100)
    expect(delivery(a.id, devB).answer).toBeNull()
    expect(delivery(a.id, devB).dismissed_at).toBeNull()
  })

  it('an answered alert does not resurface in that device\'s STATE rebuild', () => {
    const a = withOptions()
    recordAnswer(db, a.id, devA, 'taken', 1100)
    const wire = activeWireAlertsForDevice(db, devA, 2000)
    expect(wire.find((w) => w.id === a.id)).toBeUndefined()
  })

  it('an alert stays active until every target device has concluded, then transitions to dismissed', () => {
    const a = withOptions()
    recordAnswer(db, a.id, devA, 'taken', 1100)
    expect(alertStatus(a.id)).toBe('active') // devB has not concluded yet
    recordAnswer(db, a.id, devB, 'later', 1150)
    expect(alertStatus(a.id)).toBe('dismissed')
  })

  it('a mix of an explicit dismiss and an answer both count toward full conclusion', () => {
    const a = withOptions()
    recordTap(db, a.id, devA, 'dismiss', 1050)
    expect(alertStatus(a.id)).toBe('active')
    recordAnswer(db, a.id, devB, 'later', 1150)
    expect(alertStatus(a.id)).toBe('dismissed')
  })

  it('refuses an answer for a device the alert was never delivered to', () => {
    const a = withOptions()
    const devC = redeemPairingCode(db, createPairingCode(db, 'c', 0).code, 1)!.device.id
    expect(recordAnswer(db, a.id, devC, 'taken', 1100))
      .toEqual({ ok: false, reason: 'not_delivered' })
    expect(db.prepare('SELECT * FROM deliveries WHERE alert_id = ? AND device_id = ?')
      .get(a.id, devC)).toBeUndefined()
  })

  it('refuses an option the alert never offered', () => {
    const a = withOptions()
    expect(recordAnswer(db, a.id, devA, 'invented', 1100))
      .toEqual({ ok: false, reason: 'unknown_option' })
    expect(delivery(a.id, devA).answer).toBeNull()
  })

  it('refuses any answer on an alert with no options', () => {
    const a = ingestNotify(db, { senderId, title: 'plain', severity: 'info', targetDevices: [devA] }, 1000).alert
    expect(recordAnswer(db, a.id, devA, 'taken', 1100))
      .toEqual({ ok: false, reason: 'unknown_option' })
  })

  it('first answer wins — a second is refused and does not overwrite', () => {
    const a = withOptions()
    recordAnswer(db, a.id, devA, 'taken', 1100)
    expect(recordAnswer(db, a.id, devA, 'later', 1200))
      .toEqual({ ok: false, reason: 'already_answered' })
    expect(delivery(a.id, devA).answer).toBe('taken')
    expect(delivery(a.id, devA).answered_at).toBe(1100)
  })

  it('two devices can answer the same alert independently', () => {
    const a = withOptions()
    expect(recordAnswer(db, a.id, devA, 'taken', 1100)).toEqual({ ok: true })
    expect(recordAnswer(db, a.id, devB, 'later', 1150)).toEqual({ ok: true })
    expect(delivery(a.id, devA).answer).toBe('taken')
    expect(delivery(a.id, devB).answer).toBe('later')
  })
})
