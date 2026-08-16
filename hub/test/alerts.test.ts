import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode, revokeDevice } from '../src/db/devices.js'
import {
  activeWireAlertsForDevice, dismissAlertById, getWireAlert, ingestNotify, listActiveAlerts,
  recordAck, recordAnswer, recordTap, sweepExpired,
} from '../src/db/alerts.js'

let db: DB, senderId: string, devA: string, devB: string
beforeEach(() => {
  db = openDb(':memory:')
  senderId = createSender(db, 'Netdata', []).sender.id
  devA = redeemPairingCode(db, createPairingCode(db, 'a', 0).code, 1)!.device.id
  devB = redeemPairingCode(db, createPairingCode(db, 'b', 0).code, 1)!.device.id
})

const base = () => ({ senderId, title: 'Disk 91%', severity: 'warn' as const, targetDevices: [devA, devB] })

describe('ingestNotify', () => {
  it('creates alert + delivery rows, resolves sound default', () => {
    const { alert, updated } = ingestNotify(db, base(), 1000)
    expect(updated).toBe(false)
    expect(alert.sound).toBe(1) // warn default = on
    const wires = activeWireAlertsForDevice(db, devA, 1001)
    expect(wires).toHaveLength(1)
    expect(wires[0].sender.name).toBe('Netdata')
  })
  /**
   * A sender cannot make an info alert audible. This keeps a routine integration from beeping
   * every panel in the house — whether a room wants to hear routine
   * traffic is the room's call (`sound_info` on the alert_feed widget), not the sender's.
   */
  it('never lets a sender put sound on an info alert', () => {
    expect(ingestNotify(db, { ...base(), severity: 'info' }, 1).alert.sound).toBe(0)
    expect(ingestNotify(db, { ...base(), severity: 'info', sound: true, dedup_key: 'k' }, 1).alert.sound).toBe(0)
  })

  it('lets warn and critical sound by default, and lets a sender opt out', () => {
    expect(ingestNotify(db, { ...base(), severity: 'warn', dedup_key: 'w' }, 1).alert.sound).toBe(1)
    expect(ingestNotify(db, { ...base(), severity: 'critical', dedup_key: 'c' }, 1).alert.sound).toBe(1)
    expect(ingestNotify(db, { ...base(), sound: false, dedup_key: 'j' }, 1).alert.sound).toBe(0)
  })

  /**
   * An alarm ends when somebody deals with it, not when a timer runs out. A critical that expired
   * on its own would go quiet in an empty house and leave nothing on the glass to find later.
   */
  it('gives a critical no expiry at all, whatever TTL the sender asked for', () => {
    const critical = ingestNotify(db, { ...base(), severity: 'critical', ttl_s: 60, dedup_key: 'x' }, 1000)
    expect(critical.alert.expires_at).toBeNull()

    const warn = ingestNotify(db, { ...base(), severity: 'warn', ttl_s: 60, dedup_key: 'y' }, 1000)
    expect(warn.alert.expires_at).toBe(61_000)
  })
  it('dedup updates in place and bumps update_count', () => {
    const first = ingestNotify(db, { ...base(), dedup_key: 'disk' }, 1000)
    const second = ingestNotify(db, { ...base(), dedup_key: 'disk', title: 'Disk 93%', severity: 'critical' }, 2000)
    expect(second.updated).toBe(true)
    expect(second.alert.id).toBe(first.alert.id)
    expect(second.alert.title).toBe('Disk 93%')
    expect(second.alert.update_count).toBe(1)
    expect(second.alert.created_at).toBe(1000)
    expect(second.alert.updated_at).toBe(2000)
    expect(activeWireAlertsForDevice(db, devA, 2001)).toHaveLength(1)
  })
  it('dedup update re-surfaces the alert on devices that had dismissed it, clearing silenced too', () => {
    const first = ingestNotify(db, { ...base(), dedup_key: 'disk' }, 1000)
    recordTap(db, first.alert.id, devA, 'silence', 1100)
    recordTap(db, first.alert.id, devA, 'dismiss', 1100)
    expect(activeWireAlertsForDevice(db, devA, 1101)).toHaveLength(0)

    ingestNotify(db, { ...base(), dedup_key: 'disk', title: 'Disk 93%' }, 2000)
    const wires = activeWireAlertsForDevice(db, devA, 2001)
    expect(wires).toHaveLength(1)
    expect(wires[0].title).toBe('Disk 93%')
    const d = db.prepare('SELECT * FROM deliveries WHERE alert_id = ? AND device_id = ?')
      .get(first.alert.id, devA) as any
    expect(d.silenced_at).toBeNull()
    expect(d.dismissed_at).toBeNull()
  })

  it('ttl sets expires_at from now', () => {
    const { alert } = ingestNotify(db, { ...base(), ttl_s: 60 }, 1000)
    expect(alert.expires_at).toBe(61_000)
  })
})

describe('taps and acks', () => {
  it('dismiss removes for that device only; all dismissals close the alert', () => {
    const { alert } = ingestNotify(db, base(), 1000)
    expect(recordTap(db, alert.id, devA, 'dismiss', 1100).fullyDismissed).toBe(false)
    expect(activeWireAlertsForDevice(db, devA, 1101)).toHaveLength(0)
    expect(activeWireAlertsForDevice(db, devB, 1101)).toHaveLength(1)
    expect(recordTap(db, alert.id, devB, 'dismiss', 1200).fullyDismissed).toBe(true)
    expect(getWireAlert(db, alert.id)).toBeUndefined() // no longer active
  })
  it('silence and acks stamp the delivery row without removing', () => {
    const { alert } = ingestNotify(db, base(), 1000)
    recordAck(db, alert.id, devA, 'delivered', 1001)
    recordAck(db, alert.id, devA, 'displayed', 1002)
    recordTap(db, alert.id, devA, 'silence', 1003)
    const d = db.prepare('SELECT * FROM deliveries WHERE alert_id = ? AND device_id = ?').get(alert.id, devA) as any
    expect([d.delivered_at, d.displayed_at, d.silenced_at]).toEqual([1001, 1002, 1003])
    expect(activeWireAlertsForDevice(db, devA, 1004)).toHaveLength(1)
  })
})

describe('sweepExpired', () => {
  it('expires due alerts and reports their targets', () => {
    const { alert } = ingestNotify(db, { ...base(), ttl_s: 10 }, 1000)
    expect(sweepExpired(db, 5000)).toEqual([])
    const swept = sweepExpired(db, 11_001)
    // A plain local alert: no reply channel, nothing asked, nobody answered — so runSweep has
    // no timeout outcome to report for it.
    expect(swept).toEqual([{
      id: alert.id, target_devices: [devA, devB], reply_to: null, options: null, answered: false,
    }])
    expect(activeWireAlertsForDevice(db, devA, 11_002)).toHaveLength(0)
    expect(sweepExpired(db, 12_000)).toEqual([]) // idempotent
  })

  it('reports the reply channel, the options, and whether anyone answered', () => {
    const options = [{ id: 'taken', label: 'Taken' }]
    const asked = ingestNotify(db, {
      ...base(), ttl_s: 10, options, replyTo: { conn_id: 'conn_a', req_id: 'r_a' },
    }, 1000).alert
    expect(sweepExpired(db, 11_001)).toEqual([{
      id: asked.id, target_devices: [devA, devB],
      reply_to: { conn_id: 'conn_a', req_id: 'r_a' }, options, answered: false,
    }])

    // One of two devices answers: the alert stays active (the other never concluded it) and
    // still expires later — but its single outcome has already been reported, so `answered`
    // must say so rather than letting a timeout follow the answer.
    const partly = ingestNotify(db, {
      ...base(), ttl_s: 10, dedup_key: 'other', options,
      replyTo: { conn_id: 'conn_b', req_id: 'r_b' },
    }, 12_000).alert
    expect(recordAnswer(db, partly.id, devA, 'taken', 12_100)).toEqual({ ok: true })
    const swept = sweepExpired(db, 22_001)
    expect(swept).toHaveLength(1)
    expect(swept[0]).toMatchObject({ id: partly.id, answered: true })
  })
})

/**
 * Undeliverable alerts — an alert whose every target device is gone.
 *
 * A renamed device can leave alerts `active` and targeting an id with a stale `scr_` prefix when
 * no migration rewrites `alerts.target_devices`. With `expires_at` NULL they have no TTL, and with
 * no reachable device they cannot be acked or dismissed — permanently active, including a
 * `critical`, with nothing in the admin surfacing them.
 *
 * "No TTL" has always meant "lives until a device concludes it". That is a promise the system can
 * only keep while a device exists to do the concluding; once the last target is gone the alert is
 * not long-lived, it is stranded. Sweeping it finishes the existing contract rather than inventing
 * a new one.
 *
 * Marked `expired`, never deleted: the row is history, and an operator asking "what happened to
 * that disk alert" deserves an answer.
 */
const statusOf = (id: string) =>
  (db.prepare('SELECT status FROM alerts WHERE id = ?').get(id) as { status: string } | undefined)?.status

describe('sweepExpired: alerts nobody can ever receive', () => {
  it('concludes an alert whose only target device no longer exists', () => {
    const { alert } = ingestNotify(db, { ...base(), targetDevices: [devA] }, 0)
    revokeDevice(db, devA)

    expect(sweepExpired(db, 1000).map((a) => a.id)).toContain(alert.id)
    expect(statusOf(alert.id)).toBe('expired')
  })

  it('leaves it alone while even ONE target still exists', () => {
    const { alert } = ingestNotify(db, { ...base(), targetDevices: [devA, devB] }, 0)
    revokeDevice(db, devA)

    expect(sweepExpired(db, 1000).map((a) => a.id)).not.toContain(alert.id)
    expect(statusOf(alert.id)).toBe('active')
  })

  it('does not touch a live alert whose devices all exist — the everyday case', () => {
    const { alert } = ingestNotify(db, base(), 0)
    expect(sweepExpired(db, 1000).map((a) => a.id)).not.toContain(alert.id)
    expect(statusOf(alert.id)).toBe('active')
  })

  it('sweeps a no-TTL alert, which the expiry pass alone can never reach', () => {
    // expires_at NULL is the exact shape of the four found in the wild: the TTL pass selects on
    // `expires_at <= now`, so a NULL one is invisible to it forever.
    const { alert } = ingestNotify(db, { ...base(), targetDevices: [devA] }, 0)
    expect((db.prepare('SELECT expires_at e FROM alerts WHERE id = ?').get(alert.id) as { e: number | null }).e).toBeNull()
    revokeDevice(db, devA)

    expect(sweepExpired(db, 1000).map((a) => a.id)).toContain(alert.id)
  })

  it('reports it once and then stops — a swept alert is off active for good', () => {
    ingestNotify(db, { ...base(), targetDevices: [devA] }, 0)
    revokeDevice(db, devA)

    expect(sweepExpired(db, 1000)).toHaveLength(1)
    expect(sweepExpired(db, 2000)).toHaveLength(0)
  })
})

/**
 * The operator's view of what is still holding a tab lit, and the lever to let go of it.
 *
 * A critical can be silenced on the panel without being held-to-dismiss, leaving it `active`,
 * keeping the tab's severity dot red, and offering no UI escape from another room. These routes
 * expose the active alert and provide that escape.
 */
describe('listActiveAlerts', () => {
  it('lists only active alerts, newest first, with the sender that raised each', () => {
    const older = ingestNotify(db, { ...base(), title: 'Older', dedup_key: 'a' }, 1000).alert
    const newer = ingestNotify(db, { ...base(), title: 'Newer', dedup_key: 'b' }, 2000).alert
    const gone = ingestNotify(db, { ...base(), title: 'Gone', dedup_key: 'c' }, 1500).alert
    dismissAlertById(db, gone.id, 3000)

    const rows = listActiveAlerts(db)

    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id])
    expect(rows[0].title).toBe('Newer')
    expect(rows[0].sender).toEqual({ id: senderId, name: 'Netdata' })
    expect(rows[0].severity).toBe('warn')
  })

  /**
   * The exact state that trapped the operator: silenced here, never dismissed anywhere. A list
   * that only said "active" would leave them looking at the same mystery the tab dot already was.
   */
  it('reports each target device by name, and whether it silenced or dismissed', () => {
    const { alert } = ingestNotify(db, base(), 1000)
    recordAck(db, alert.id, devA, 'delivered', 1100)
    recordTap(db, alert.id, devA, 'silence', 1200)
    recordTap(db, alert.id, devB, 'dismiss', 1300)

    const [row] = listActiveAlerts(db)

    expect(row.devices).toEqual([
      { id: devA, name: 'a', delivered: true, silenced: true, dismissed: false },
      { id: devB, name: 'b', delivered: false, silenced: false, dismissed: true },
    ])
  })

  /**
   * A stranded alert — every target device deleted — is the one shape nothing on a panel can ever
   * conclude. It must still be listed, and it must be
   * visibly targetless rather than quietly looking like a normal alert nobody has touched.
   */
  it('still lists an alert whose target devices are all gone, with no devices', () => {
    const { alert } = ingestNotify(db, { ...base(), targetDevices: [devA] }, 1000)
    revokeDevice(db, devA)

    const [row] = listActiveAlerts(db)

    expect(row.id).toBe(alert.id)
    expect(row.devices).toEqual([])
  })
})

describe('dismissAlertById', () => {
  it('concludes the alert and hands back the devices that must be told', () => {
    const { alert } = ingestNotify(db, base(), 1000)

    expect(dismissAlertById(db, alert.id, 2000)).toEqual({
      dismissed: true, id: alert.id, target_devices: [devA, devB],
    })
    expect(statusOf(alert.id)).toBe('dismissed')
  })

  /**
   * Stamping every delivery, not just the alert's status, is what makes this stick: a reconnect
   * rebuilds a device's alerts from `status = 'active' AND dismissed_at IS NULL`, and leaving the
   * per-device half unstamped would leave a half-concluded row for any future query that reads
   * only one of the two.
   */
  it('clears the alert off every target device, including one that reconnects later', () => {
    const { alert } = ingestNotify(db, base(), 1000)
    recordTap(db, alert.id, devA, 'silence', 1100)

    dismissAlertById(db, alert.id, 2000)

    expect(activeWireAlertsForDevice(db, devA, 3000)).toEqual([])
    expect(activeWireAlertsForDevice(db, devB, 3000)).toEqual([])
    const stamped = db.prepare(
      'SELECT COUNT(*) n FROM deliveries WHERE alert_id = ? AND dismissed_at IS NOT NULL',
    ).get(alert.id) as { n: number }
    expect(stamped.n).toBe(2)
  })

  it('preserves the timestamp of a device that had already dismissed it', () => {
    const { alert } = ingestNotify(db, base(), 1000)
    recordTap(db, alert.id, devA, 'dismiss', 1100)

    dismissAlertById(db, alert.id, 2000)

    const row = db.prepare('SELECT dismissed_at d FROM deliveries WHERE alert_id = ? AND device_id = ?')
      .get(alert.id, devA) as { d: number }
    expect(row.d).toBe(1100)
  })

  /**
   * Absence is not an error, for the same reason a sender's resolve-by-dedup-key isn't: an
   * operator clearing a row that a panel concluded a second earlier is expected traffic, not a
   * failure, and an unknown id must be indistinguishable from an already-concluded one.
   */
  it('is a no-op on an alert that is already concluded, or was never there', () => {
    const { alert } = ingestNotify(db, base(), 1000)
    dismissAlertById(db, alert.id, 2000)

    expect(dismissAlertById(db, alert.id, 3000)).toEqual({ dismissed: false })
    expect(dismissAlertById(db, 'alr_nope', 3000)).toEqual({ dismissed: false })
  })

  it('leaves every other active alert alone', () => {
    const one = ingestNotify(db, { ...base(), dedup_key: 'one' }, 1000).alert
    const two = ingestNotify(db, { ...base(), dedup_key: 'two' }, 1000).alert

    dismissAlertById(db, one.id, 2000)

    expect(statusOf(two.id)).toBe('active')
    expect(activeWireAlertsForDevice(db, devA, 3000).map((a) => a.id)).toEqual([two.id])
  })
})
