import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createSender, findSenderByToken } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { createAgentToken } from '../src/db/agents.js'

/**
 * A sender is edited where it was created: the same name and default devices, through PATCH, and
 * a lost or leaked token is replaced by rotating it rather than by delete-and-recreate (which
 * breaks every place the sender id is referenced, such as a feed's allowed senders).
 */
describe('/admin/api/senders edit and rotate', () => {
  let app: FastifyInstance, db: DB, cookie: string, deviceId: string

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any, db })
    cookie = (await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })).headers['set-cookie'] as string
    deviceId = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
  })
  afterEach(async () => { await app.close() })

  const call = (method: 'PATCH' | 'POST', url: string, payload?: object, headers: Record<string, string> = { cookie }) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) })

  it('creating a sender with default devices works, and unknown devices are refused', async () => {
    const ok = await call('POST', '/admin/api/senders', { name: 'greenhouse', default_devices: [deviceId] })
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.json().sender.default_devices)).toEqual([deviceId])
    const bad = await call('POST', '/admin/api/senders', { name: 'x', default_devices: ['dev_gone'] })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'unknown devices: dev_gone' })
  })

  it('PATCH renames and sets default devices, keeping the token', async () => {
    const { sender, token } = createSender(db, 'old', [])
    const res = await call('PATCH', `/admin/api/senders/${sender.id}`, { name: 'greenhouse', default_devices: [deviceId] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: sender.id, name: 'greenhouse' })
    const row = findSenderByToken(db, token)!
    expect(row.name).toBe('greenhouse')
    expect(JSON.parse(row.default_devices)).toEqual([deviceId])
    expect(db.prepare("SELECT 1 FROM audit_log WHERE event = 'sender_updated'").get()).toBeDefined()
  })

  it('PATCH refuses unknown devices, unknown senders, and the built-in hub sender', async () => {
    const { sender } = createSender(db, 'a', [])
    expect((await call('PATCH', `/admin/api/senders/${sender.id}`, { default_devices: ['dev_gone'] })).json())
      .toEqual({ error: 'unknown devices: dev_gone' })
    expect((await call('PATCH', '/admin/api/senders/snd_nope', { name: 'x' })).statusCode).toBe(404)
    expect((await call('PATCH', '/admin/api/senders/snd_hub', { name: 'x' })).statusCode).toBe(400)
  })

  it('rotate returns a new token once; the old one stops working at once', async () => {
    const { sender, token } = createSender(db, 'a', [deviceId])
    const res = await call('POST', `/admin/api/senders/${sender.id}/rotate`)
    expect(res.statusCode).toBe(200)
    const fresh = res.json().token as string
    expect(fresh).toMatch(/^dbz_s_/)
    const push = (t: string) => app.inject({ method: 'POST', url: '/api/notify', headers: { authorization: `Bearer ${t}` }, payload: { title: 'hi', severity: 'info' } })
    expect((await push(token)).statusCode).toBe(401)
    expect((await push(fresh)).statusCode).toBe(200)
    expect(db.prepare("SELECT 1 FROM audit_log WHERE event = 'sender_token_rotated'").get()).toBeDefined()
    expect((await call('POST', '/admin/api/senders/snd_hub/rotate')).statusCode).toBe(400)
    expect((await call('POST', '/admin/api/senders/snd_nope/rotate')).statusCode).toBe(404)
  })

  /** An agent may create senders, but swapping a credential other integrations depend on is the owner's call. */
  it('only the signed-in owner can rotate; an agent token cannot', async () => {
    const { sender } = createSender(db, 'a', [])
    const { token } = createAgentToken(db, 'worker')
    const res = await call('POST', `/admin/api/senders/${sender.id}/rotate`, undefined, { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(401)
  })
})
