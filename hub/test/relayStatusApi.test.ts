import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { startRelay } from '../src/relay/bootstrap.js'

class FakeSocket {
  sent: string[] = []
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
  send(d: string) { this.sent.push(d) }
  close() { this.onClose?.() }
}

const base = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

const login = async (app: FastifyInstance) => {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  return res.headers['set-cookie'] as string
}

describe('GET /admin/api/relay', () => {
  it('requires the admin session', async () => {
    const db = openDb(':memory:')
    const app = await buildServer({ config: { ...base, relayUrl: null }, db })
    startRelay({ config: { relayUrl: null }, db, app, connect: () => { throw new Error('must not dial') } })
    expect((await app.inject({ method: 'GET', url: '/admin/api/relay' })).statusCode).toBe(401)
  })

  it('is null when RELAY_URL is unset', async () => {
    const db = openDb(':memory:')
    const app = await buildServer({ config: { ...base, relayUrl: null }, db })
    startRelay({ config: { relayUrl: null }, db, app, connect: () => { throw new Error('must not dial') } })
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('serializes live state when connected — and never the secret', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: 'wss://relay.example/ws' }
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    startRelay({ config, db, app, now: () => 7777, schedule: () => {}, connect: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    const body = res.json()
    expect(body).toMatchObject({ state: 'ready', terminal: false, url: 'wss://relay.example/ws', connected_since: 7777, last_error: null })
    expect(body.hub_uid).toMatch(/^hub_/)
    const secret = (db.prepare('SELECT hub_secret FROM relay_identity WHERE id = 1').get() as { hub_secret: string }).hub_secret
    expect(res.body).not.toContain(secret)
    expect(res.body).not.toContain('hub_secret')
  })

  it('exposes the terminal bad_secret refusal', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: 'wss://relay.example/ws' }
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    startRelay({ config, db, app, now: () => 8888, schedule: () => {}, connect: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    sockets[0].onClose?.(4401)
    const cookie = await login(app)
    const body = (await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })).json()
    expect(body).toMatchObject({ state: 'offline', terminal: true })
    expect(body.last_error).toMatchObject({ code: 'bad_secret', at: 8888 })
  })
})
