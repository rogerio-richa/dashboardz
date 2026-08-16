import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { startRelay } from '../src/relay/bootstrap.js'
import type { RelaySocket } from '../src/relay/client.js'
import { getSetting } from '../src/db/settings.js'
import { createAgentToken } from '../src/db/agents.js'

class FakeSocket {
  sent: string[] = []
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
  send(d: string) { this.sent.push(d) }
  close() { this.onClose?.() }
}

const base = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

const login = async (app: FastifyInstance) => {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  return res.headers['set-cookie'] as string
}

/** App + manager with recordable sockets; testTimers lets a test fire the 5s timeout by hand. */
const make = async (envUrl: string | null = null) => {
  const db: DB = openDb(':memory:')
  const app = await buildServer({ config: { ...base, relayUrl: envUrl }, db })
  const sockets: FakeSocket[] = []
  const testSockets: FakeSocket[] = []
  const testTimers: (() => void)[] = []
  startRelay({
    config: { relayUrl: envUrl }, db, app,
    schedule: () => {},
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    testConnect: (): RelaySocket => { const s = new FakeSocket(); testSockets.push(s); return s },
    testSchedule: (_ms, fn) => { testTimers.push(fn) },
  })
  const cookie = await login(app)
  const auditRows = () => db.prepare(
    "SELECT event, actor_type, details FROM audit_log WHERE event LIKE 'relay_%' ORDER BY id",
  ).all() as Array<{ event: string; actor_type: string; details: string }>
  return { app, db, cookie, sockets, testSockets, testTimers, auditRows }
}

describe('relay write routes are human-only', () => {
  it.each([
    ['PUT', '/admin/api/relay', { url: 'wss://relay.example/ws' }],
    ['DELETE', '/admin/api/relay', undefined],
    ['POST', '/admin/api/relay/test', { url: 'wss://relay.example/ws' }],
  ] as const)('%s %s refuses a live agent Bearer with 401', async (method, url, payload) => {
    const { app, db } = await make()
    const { token } = createAgentToken(db, 'assistant')
    const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(401)
  })
})

describe('PUT /admin/api/relay', () => {
  it('persists, connects, audits, and returns the new status', async () => {
    const { app, db, cookie, sockets, auditRows } = await make()
    const res = await app.inject({ method: 'PUT', url: '/admin/api/relay', payload: { url: 'wss://relay.example/ws' }, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'connecting', url: 'wss://relay.example/ws' })
    expect(getSetting(db, 'relay_url')).toBe('wss://relay.example/ws')
    expect(sockets).toHaveLength(1)
    expect(auditRows()).toEqual([expect.objectContaining({ event: 'relay_configured', actor_type: 'admin' })])
    expect(JSON.parse(auditRows()[0].details).url).toBe('wss://relay.example/ws')
  })

  it('rejects a non-ws URL with the exact error body', async () => {
    const { app, cookie, sockets } = await make()
    const res = await app.inject({ method: 'PUT', url: '/admin/api/relay', payload: { url: 'https://relay.example' }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'url must be a ws:// or wss:// URL' })
    expect(sockets).toHaveLength(0)
  })

  // edge case: `ws` throws synchronously on a fragment URL. This must be rejected at validation, before
  // it is ever persisted or dialed — the same 400 as any other malformed URL, not a 500.
  it('rejects a URL with a fragment with the exact error body, and does not persist it', async () => {
    const { app, db, cookie, sockets } = await make()
    const res = await app.inject({ method: 'PUT', url: '/admin/api/relay', payload: { url: 'wss://relay.example/ws#frag' }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'url must be a ws:// or wss:// URL' })
    expect(sockets).toHaveLength(0)
    expect(getSetting(db, 'relay_url')).toBeNull()
  })
})

describe('DELETE /admin/api/relay', () => {
  it('disconnects, forgets the setting, audits; GET goes null', async () => {
    const { app, db, cookie, auditRows } = await make('wss://relay.example/ws')
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/relay', headers: { cookie } })
    expect(res.statusCode).toBe(204)
    expect(getSetting(db, 'relay_url')).toBeNull()
    expect((await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })).json()).toBeNull()
    expect(auditRows().map((r) => r.event)).toContain('relay_removed')
  })

  it('is idempotent — deleting an unconfigured relay is still 204', async () => {
    const { app, cookie } = await make()
    expect((await app.inject({ method: 'DELETE', url: '/admin/api/relay', headers: { cookie } })).statusCode).toBe(204)
  })
})

describe('POST /admin/api/relay/test', () => {
  it('READY from the relay reports ok and audits the attempt', async () => {
    const { app, cookie, testSockets, auditRows } = await make()
    const pending = app.inject({ method: 'POST', url: '/admin/api/relay/test', payload: { url: 'wss://relay.example/ws' }, headers: { cookie } })
    await vi.waitFor(() => expect(testSockets).toHaveLength(1))
    testSockets[0].onOpen?.()
    testSockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    const res = await pending
    expect(res.json()).toEqual({ ok: true })
    expect(auditRows().at(-1)).toMatchObject({ event: 'relay_test' })
    expect(JSON.parse(auditRows().at(-1)!.details)).toEqual({ url: 'wss://relay.example/ws', ok: true })
  })

  it('a 4401 close reports bad_secret', async () => {
    const { app, cookie, testSockets } = await make()
    const pending = app.inject({ method: 'POST', url: '/admin/api/relay/test', payload: { url: 'wss://relay.example/ws' }, headers: { cookie } })
    await vi.waitFor(() => expect(testSockets).toHaveLength(1))
    testSockets[0].onClose?.(4401)
    expect((await pending).json()).toEqual({ ok: false, code: 'bad_secret' })
  })

  it('the timer reports timeout', async () => {
    const { app, cookie, testSockets, testTimers } = await make()
    const pending = app.inject({ method: 'POST', url: '/admin/api/relay/test', payload: { url: 'wss://relay.example/ws' }, headers: { cookie } })
    await vi.waitFor(() => expect(testSockets).toHaveLength(1))
    testTimers[0]()
    expect((await pending).json()).toEqual({ ok: false, code: 'timeout' })
  })

  it('a test does not change the stored configuration', async () => {
    const { app, db, cookie, testSockets } = await make()
    const pending = app.inject({ method: 'POST', url: '/admin/api/relay/test', payload: { url: 'wss://relay.example/ws' }, headers: { cookie } })
    await vi.waitFor(() => expect(testSockets).toHaveLength(1))
    testSockets[0].onClose?.(1006)
    await pending
    expect(getSetting(db, 'relay_url')).toBeNull()
    expect((await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })).json()).toBeNull()
  })
})
