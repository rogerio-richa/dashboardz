import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createAgentToken } from '../src/db/agents.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { createFeed } from '../src/db/feeds.js'
import { createScreen } from '../src/db/screens.js'
import { ingestNotify, recordTap } from '../src/db/alerts.js'

/**
 * The operator's escape hatch from a lit tab.
 *
 * A critical silenced on the panel but never held-to-dismiss stays `active` forever and keeps the
 * tab's severity dot coloured. Until these routes existed the only two ways out were physically
 * holding Dismiss on the panel, or a curl to `/api/notify {resolve}` carrying the RAISING sender's
 * own token — neither of which is available to someone looking at a red dot from another room.
 */
const config = {
  port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x',
  relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180,
}

let app: FastifyInstance, db: DB, cookie: string, senderId: string, devA: string, devB: string

beforeEach(async () => {
  db = openDb(':memory:')
  devA = redeemPairingCode(db, createPairingCode(db, 'Painel', 0).code, 1)!.device.id
  devB = redeemPairingCode(db, createPairingCode(db, 'Bedside', 0).code, 1)!.device.id
  senderId = createSender(db, 'meshtastic-monitor', [devA, devB]).sender.id
  app = await buildServer({ config, db })
  const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
  cookie = login.headers['set-cookie'] as string
})

const active = () => app.inject({ url: '/admin/api/alerts/active', headers: { cookie } })
const dismiss = (id: string, headers: Record<string, string> = { cookie }) =>
  app.inject({ method: 'POST', url: `/admin/api/alerts/${id}/dismiss`, headers })

/** An alert that lights a tab: a screen bound to a feed this sender pushes to. */
function screenFedBySender(name: string): { id: string } {
  const feed = createFeed(db, { name: `feed-${name}`, mode: 'value' }, 0)
  db.prepare('UPDATE feeds SET pushed_by = ? WHERE id = ?').run(senderId, feed.id)
  return createScreen(db, {
    name,
    orientation: 'landscape',
    grid: { cells: [{ widget: 'value', config: { feed: feed.id }, rect: { x: 0, y: 0, w: 1, h: 1 } }] },
  }, 0)
}

describe('GET /admin/api/alerts/active', () => {
  it('reports what is still lit: the alert, who raised it, and where it stands', async () => {
    const screen = screenFedBySender('Casa')
    const { alert } = ingestNotify(db, {
      senderId, title: 'No ACK from floripa 2', body: 'last heard 17:31',
      severity: 'critical', targetDevices: [devA, devB],
    }, 1000)
    recordTap(db, alert.id, devA, 'silence', 1100)

    const res = await active()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{
      id: alert.id,
      title: 'No ACK from floripa 2',
      body: 'last heard 17:31',
      severity: 'critical',
      sender: { id: senderId, name: 'meshtastic-monitor' },
      created_at: 1000,
      updated_at: 1000,
      update_count: 0,
      expires_at: null,
      dedup_key: null,
      devices: [
        { id: devA, name: 'Painel', delivered: false, silenced: true, dismissed: false },
        { id: devB, name: 'Bedside', delivered: false, silenced: false, dismissed: false },
      ],
      screens: [{ id: screen.id, name: 'Casa' }],
    }])
  })

  it('lists nothing once the alert is concluded', async () => {
    const { alert } = ingestNotify(db, {
      senderId, title: 'transient', severity: 'warn', targetDevices: [devA],
    }, 1000)
    recordTap(db, alert.id, devA, 'dismiss', 1100)

    expect((await active()).json()).toEqual([])
  })

  it('needs an admin: no cookie, no list', async () => {
    expect((await app.inject({ url: '/admin/api/alerts/active' })).statusCode).toBe(401)
  })
})

describe('POST /admin/api/alerts/:id/dismiss', () => {
  it('clears the alert, tells its devices, and records who did it', async () => {
    const sendMany = vi.spyOn(app.registry, 'sendMany')
    const { alert } = ingestNotify(db, {
      senderId, title: 'No ACK from floripa 2', severity: 'critical', targetDevices: [devA, devB],
    }, 1000)

    const res = await dismiss(alert.id)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ dismissed: true })
    expect(sendMany).toHaveBeenCalledWith(
      [devA, devB], { type: 'ALERT_REMOVE', id: alert.id, reason: 'dismissed' },
    )
    expect((db.prepare('SELECT status FROM alerts WHERE id = ?').get(alert.id) as { status: string }).status)
      .toBe('dismissed')
    expect((await active()).json()).toEqual([])
    expect(db.prepare("SELECT actor_type, details FROM audit_log WHERE event = 'alert_dismissed'").get())
      .toMatchObject({ actor_type: 'admin', details: JSON.stringify({ alert_id: alert.id }) })
  })

  /**
   * Absence is not an error — the same rule the sender-side resolve follows. An operator clearing a
   * row that a panel concluded a second earlier has got what they wanted, and an unknown id must
   * not be distinguishable from an already-concluded one by anything other than the 404.
   */
  it('is a no-op on an alert somebody already concluded', async () => {
    const sendMany = vi.spyOn(app.registry, 'sendMany')
    const { alert } = ingestNotify(db, {
      senderId, title: 'gone', severity: 'warn', targetDevices: [devA],
    }, 1000)
    recordTap(db, alert.id, devA, 'dismiss', 1100)
    sendMany.mockClear()

    const res = await dismiss(alert.id)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ dismissed: false })
    expect(sendMany).not.toHaveBeenCalled()
  })

  it('404s an id that was never here', async () => {
    expect((await dismiss('alr_nope')).statusCode).toBe(404)
  })

  /**
   * Human-only, deliberately. An agent token that could clear alarms could bury its own failures —
   * the same reasoning that keeps token mint/revoke off the Bearer path. Reading the list is fine;
   * silencing the house is not.
   */
  it('refuses an agent token even though that token can read the list', async () => {
    const { token } = createAgentToken(db, 'worker')
    const { alert } = ingestNotify(db, {
      senderId, title: 'still ringing', severity: 'critical', targetDevices: [devA],
    }, 1000)

    const read = await app.inject({ url: '/admin/api/alerts/active', headers: { authorization: `Bearer ${token}` } })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toHaveLength(1)

    const blocked = await dismiss(alert.id, { authorization: `Bearer ${token}` })
    expect(blocked.statusCode).toBe(401)
    expect((db.prepare('SELECT status FROM alerts WHERE id = ?').get(alert.id) as { status: string }).status)
      .toBe('active')
  })
})
