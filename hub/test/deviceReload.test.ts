import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'

/**
 * POST /admin/api/devices/:id/reload — the remote unstick (Meshtastic paper
 * redesign). A device page can hold stale JS for weeks: its own catalogue-staleness
 * ladder caps at 4 attempts per design id, and before this route existed the only fix was a
 * hand on the glass. The frame is one type field; the PAGE reloads itself (device.js), the
 * Android shell forwards raw frames verbatim and its own decoder null-skips unknown types, and
 * a page too old to know RELOAD ignores it — the same degradation rule every other frame follows.
 */
const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, db: any, cookie: string

beforeEach(async () => {
  db = openDb(':memory:')
  app = await buildServer({ config, db })
  const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  cookie = login.headers['set-cookie'] as string
})

const mkDevice = async () => {
  const pairingRes = await app.inject({
    method: 'POST',
    url: '/admin/api/devices/pairing-codes',
    headers: { cookie },
    payload: { name: `device-${Math.random()}` },
  })
  const { code } = pairingRes.json()
  const pairRes = await app.inject({ method: 'POST', url: '/api/pair', payload: { code } })
  const { device_id } = pairRes.json()
  return { id: device_id as string }
}

const fakeSocket = (sent: unknown[]) => ({ readyState: 1, OPEN: 1, send: (t: string) => sent.push(JSON.parse(t)) }) as never

describe('POST /admin/api/devices/:id/reload', () => {
  it('pushes RELOAD to an online device and audits', async () => {
    const { id: deviceId } = await mkDevice()
    const sent: unknown[] = []
    app.registry.attach(deviceId, fakeSocket(sent))
    const res = await app.inject({ method: 'POST', url: `/admin/api/devices/${deviceId}/reload`, headers: { cookie } })
    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ type: 'RELOAD' }])

    const events = (db.prepare("SELECT details FROM audit_log WHERE event = 'device_reload'").all() as { details: string }[])
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].details)).toEqual({ device_id: deviceId })
  })

  it('404 on unknown device', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/devices/dev_nope/reload', headers: { cookie } })
    expect(res.statusCode).toBe(404)
  })

  it('409 when the device is offline — a reload cannot be queued, and the next connect loads fresh anyway', async () => {
    const { id: deviceId } = await mkDevice()
    const res = await app.inject({ method: 'POST', url: `/admin/api/devices/${deviceId}/reload`, headers: { cookie } })
    expect(res.statusCode).toBe(409)
  })

  it('401 without an admin session', async () => {
    const { id: deviceId } = await mkDevice()
    const res = await app.inject({ method: 'POST', url: `/admin/api/devices/${deviceId}/reload` })
    expect(res.statusCode).toBe(401)
  })
})
