import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const mkScreen = async (orientation: 'landscape' | 'portrait') => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/api/screens',
    headers: { cookie },
    payload: {
      name: `screen-${Math.random()}`,
      orientation,
      grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] },
    },
  })
  return res.json()
}

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
  return { id: device_id }
}

const assign = async (deviceId: string, screenId: string) => {
  return app.inject({
    method: 'PATCH',
    url: `/admin/api/devices/${deviceId}`,
    headers: { cookie },
    payload: { screen_id: screenId },
  })
}

const patchDevice = async (deviceId: string, patch: object) => {
  return app.inject({
    method: 'PATCH',
    url: `/admin/api/devices/${deviceId}`,
    headers: { cookie },
    payload: patch,
  })
}

describe('device assignment', () => {
  /**
   * v15: orientation belongs to the screen, so ANY screen goes on ANY device. The old pair of
   * tests here asserted the two guards that made a mismatch a 400 — there is nothing left to
   * reject, because a mismatch is no longer representable.
   */
  it('assigns any screen to any device, whatever shape it is', async () => {
    const d = await mkDevice()
    expect((await assign(d.id, (await mkScreen('landscape')).id)).statusCode).toBe(204)
    expect((await assign(d.id, (await mkScreen('portrait')).id)).statusCode).toBe(204)
  })

  it('refuses to store an orientation on a device at all', async () => {
    const d = await mkDevice()
    const res = await patchDevice(d.id, { orientation: 'portrait' })
    expect(res.statusCode).toBe(400)
  })

  it('unknown screen id is 400; devices list exposes screen_id and rendering', async () => {
    const d = await mkDevice()
    // Pairing seeds a starter screen, so the device is born assigned; the rejected patch must
    // leave that assignment exactly as it was.
    const [starter] = (await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })).json()
    expect((await patchDevice(d.id, { screen_id: 'lay_nope' })).statusCode).toBe(400)
    const list = (await app.inject({ method: 'GET', url: '/admin/api/devices', headers: { cookie } })).json()
    expect(list[0]).toMatchObject({ screen_id: starter.id, rendering: null })
    expect(list[0].orientation).toBeUndefined()
  })

  /** `device_orientation_changed` retired with v15 — a device has no orientation to change. */
  it('audits each assignment, including the one back to the default layout', async () => {
    const s = await mkScreen('landscape')
    const d = await mkDevice()
    await patchDevice(d.id, { screen_id: s.id })
    await patchDevice(d.id, { screen_id: null })
    const events = (db.prepare(
      "SELECT event FROM audit_log WHERE event IN ('device_orientation_changed','device_screen_assigned') ORDER BY id",
    ).all() as any[]).map((r) => r.event)
    expect(events).toEqual(['device_screen_assigned', 'device_screen_assigned'])
  })

  it('cannot delete the hub sender', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/senders/snd_hub', headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('cannot delete the hub sender')
  })

  it('repeated same screen_id PATCH audits only once', async () => {
    const s = await mkScreen('landscape')
    const d = await mkDevice()
    await patchDevice(d.id, { screen_id: s.id })
    await patchDevice(d.id, { screen_id: s.id })
    const allEvents = (db.prepare(
      "SELECT event FROM audit_log ORDER BY id",
    ).all() as any[]).filter((r) => r.event === 'device_screen_assigned')
    expect(allEvents).toHaveLength(1)
  })

  it('PATCH with current name creates no audit and no push', async () => {
    const d = await mkDevice()
    // Set to a known name first
    await patchDevice(d.id, { name: 'test-device' })
    const spy = vi.spyOn(app.statePusher, 'push')
    const res = await patchDevice(d.id, { name: 'test-device' })
    expect(res.statusCode).toBe(204)
    expect(spy).not.toHaveBeenCalled()
    const allRenames = (db.prepare(
      "SELECT event FROM audit_log ORDER BY id",
    ).all() as any[]).filter((r) => r.event === 'device_renamed')
    expect(allRenames).toHaveLength(1) // only the first rename, not the second no-op
  })
})

/**
 * The system bars belong to the DEVICE (v17) — v16 put them on the screen, and the
 * difference only becomes obvious with both in front of you: a layout is authored FOR a shape and
 * will not fit the other one, but the same board is correct on a wall panel with no bars and on a
 * handheld that still needs its back gesture.
 */
describe('nav bars are a device property', () => {
  it('defaults to respected, which is what an unconfigured device already did', async () => {
    const d = await mkDevice()
    const list = (await app.inject({ method: 'GET', url: '/admin/api/devices', headers: { cookie } })).json()
    expect(list.find((x: { id: string }) => x.id === d.id).nav_bars).toBe('respected')
  })

  it('stores the mode it is given, audits it, and rides to the glass in STATE', async () => {
    const d = await mkDevice()
    expect((await patchDevice(d.id, { nav_bars: 'hidden' })).statusCode).toBe(204)

    const { buildState } = await import('../src/ws/stateBuilder.js')
    const { getDevice } = await import('../src/db/devices.js')
    expect(buildState(db, getDevice(db, d.id)!, Date.now(), 1).device.nav_bars).toBe('hidden')

    const events = (db.prepare("SELECT event FROM audit_log WHERE event = 'device_nav_bars_changed'").all() as any[])
    expect(events).toHaveLength(1)
  })

  it('refuses a mode no device knows how to obey', async () => {
    const d = await mkDevice()
    expect((await patchDevice(d.id, { nav_bars: 'invisible' })).statusCode).toBe(400)
  })
})
