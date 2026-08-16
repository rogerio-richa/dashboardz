import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'

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

describe('POST /admin/api/devices/:id/play-sound', () => {
  it('pushes PLAY_SOUND to an online device and audits', async () => {
    const { id: deviceId } = await mkDevice()
    const sent: unknown[] = []
    app.registry.attach(deviceId, fakeSocket(sent))
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/devices/${deviceId}/play-sound`,
      headers: { cookie },
      payload: { family: 'bells', event: 'critical' },
    })
    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ type: 'PLAY_SOUND', family: 'bells', event: 'critical' }])

    const events = (db.prepare("SELECT event, details FROM audit_log WHERE event = 'device_play_sound'").all() as any[])
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].details)).toEqual({ device_id: deviceId, family: 'bells', event: 'critical' })
  })

  it('pushes PLAY_SOUND for the activity event', async () => {
    const { id: deviceId } = await mkDevice()
    const sent: unknown[] = []
    app.registry.attach(deviceId, fakeSocket(sent))
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/devices/${deviceId}/play-sound`,
      headers: { cookie },
      payload: { family: 'bells', event: 'activity' },
    })
    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ type: 'PLAY_SOUND', family: 'bells', event: 'activity' }])
  })

  it('404 on unknown device', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/devices/dev_nope/play-sound',
      headers: { cookie },
      payload: { family: 'bells', event: 'critical' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('409 when offline, 400 on unknown family or event', async () => {
    const { id: deviceId } = await mkDevice()

    expect((await app.inject({
      method: 'POST',
      url: `/admin/api/devices/${deviceId}/play-sound`,
      headers: { cookie },
      payload: { family: 'bells', event: 'critical' },
    })).statusCode).toBe(409)

    app.registry.attach(deviceId, fakeSocket([]))

    expect((await app.inject({
      method: 'POST',
      url: `/admin/api/devices/${deviceId}/play-sound`,
      headers: { cookie },
      payload: { family: 'nope', event: 'critical' },
    })).statusCode).toBe(400)

    expect((await app.inject({
      method: 'POST',
      url: `/admin/api/devices/${deviceId}/play-sound`,
      headers: { cookie },
      payload: { family: 'bells', event: 'later' },
    })).statusCode).toBe(400)
  })
})
