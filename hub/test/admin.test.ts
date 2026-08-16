import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { startRelay } from '../src/relay/bootstrap.js'
import type { RelaySocket } from '../src/relay/client.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, cookie: string

beforeEach(async () => {
  app = await buildServer({ config, db: openDb(':memory:') })
  const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  cookie = login.headers['set-cookie'] as string
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload })

const expectAdminCookiePolicy = (setCookie: string, secure: boolean): void => {
  const attributes = new Set(setCookie.split('; ').slice(1))
  expect(attributes).toContain('Path=/')
  expect(attributes).toContain('HttpOnly')
  expect(attributes).toContain('SameSite=Strict')
  expect(attributes.has('Secure')).toBe(secure)
}

describe('admin auth', () => {
  it('rejects wrong password and missing cookie', async () => {
    const bad = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'nope' } })
    expect(bad.statusCode).toBe(401)
    const noCookie = await app.inject({ method: 'GET', url: '/admin/api/senders' })
    expect(noCookie.statusCode).toBe(401)
  })
  it('login sets a usable session cookie', async () => {
    expect((await get('/admin/api/config')).json())
      .toEqual({ public_url: 'http://pi:8484', brand: 'Dashboardz', relay: null })
  })
  it('logout audits the action', async () => {
    const res = await post('/admin/api/logout', {})
    expect(res.statusCode).toBe(204)
    const auditLog = app.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 10').all() as Array<{ event: string; actor_type: string }>
    expect(auditLog[0]).toMatchObject({ event: 'admin_logout', actor_type: 'admin' })
    expect(auditLog[1]).toMatchObject({ event: 'admin_login', actor_type: 'admin' })
  })

  it.each([
    ['HTTP', 'http://pi:8484', false],
    ['HTTPS', 'https://dashboard.example', true],
  ] as const)('login cookie follows the configured %s transport policy', async (_label, publicUrl, secure) => {
    const policyApp = await buildServer({ config: { ...config, publicUrl }, db: openDb(':memory:') })
    const login = await policyApp.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })

    expect(login.statusCode).toBe(204)
    expectAdminCookiePolicy(login.headers['set-cookie'] as string, secure)
    await policyApp.close()
  })

  it.each([
    ['HTTP', 'http://pi:8484', false],
    ['HTTPS', 'https://dashboard.example', true],
  ] as const)('logout clears the configured %s cookie with matching scope and flags', async (_label, publicUrl, secure) => {
    const policyApp = await buildServer({ config: { ...config, publicUrl }, db: openDb(':memory:') })
    const login = await policyApp.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
    const loginCookie = login.headers['set-cookie'] as string
    const sessionCookie = loginCookie.split(';', 1)[0]
    const logout = await policyApp.inject({
      method: 'POST', url: '/admin/api/logout', headers: { cookie: sessionCookie },
    })

    expect(logout.statusCode).toBe(204)
    expect((await policyApp.inject({
      method: 'GET', url: '/admin/api/config', headers: { cookie: sessionCookie },
    })).statusCode).toBe(401)
    const clearCookie = logout.headers['set-cookie'] as string
    expect(clearCookie.split(';', 1)[0]).toBe('dbz_admin=')
    expectAdminCookiePolicy(clearCookie, secure)
    await policyApp.close()
  })
})

describe('admin resources', () => {
  it('sender lifecycle: create (token once), list, delete', async () => {
    const created = (await post('/admin/api/senders', { name: 'CI' })).json()
    expect(created.token).toMatch(/^dbz_s_/)
    // v4 migration seeds snd_hub; created sender should exist alongside it
    const senders = (await get('/admin/api/senders')).json()
    expect(senders).toContainEqual(expect.objectContaining({ name: 'CI', id: created.sender.id }))
    expect(senders).toContainEqual(expect.objectContaining({ id: 'snd_hub', name: 'Hub' }))
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/senders/${created.sender.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    // After deletion, only snd_hub remains
    expect((await get('/admin/api/senders')).json()).toEqual([
      expect.objectContaining({ id: 'snd_hub', name: 'Hub' }),
    ])
  })
  it('device lifecycle: pairing code, list with online flag, rename, revoke', async () => {
    const { code } = (await post('/admin/api/devices/pairing-codes', { name: 'bedside' })).json()
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    await app.inject({ method: 'POST', url: '/api/pair', payload: { code } })
    const devices = (await get('/admin/api/devices')).json()
    expect(devices).toHaveLength(1)
    expect(devices[0].online).toBe(false)
    const patch = await app.inject({ method: 'PATCH', url: `/admin/api/devices/${devices[0].id}`, headers: { cookie }, payload: { name: 'hall' } })
    expect(patch.statusCode).toBe(204)
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/devices/${devices[0].id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    expect((await get('/admin/api/devices')).json()).toHaveLength(0)
  })
  it('alerts and audit listing', async () => {
    expect((await get('/admin/api/alerts')).json()).toEqual([])
    const audit = (await get('/admin/api/audit')).json()
    expect(Array.isArray(audit)).toBe(true)
  })
})

// The relay's bad-secret stop is visible through the config payload, the status-like endpoint the
// SPA already polls, so relay state rides on it.
describe('admin relay state', () => {
  it('reports relay: null when RELAY_URL is unset (the beforeEach app has no relay)', async () => {
    expect((await get('/admin/api/config')).json().relay).toBeNull()
  })

  it('reports the live client state when the relay is configured — not a hardcoded value', async () => {
    const db = openDb(':memory:')
    const relayApp = await buildServer({ config, db })
    // Drivable socket, same seam relayBootstrap.test.ts uses: state changes are driven by hand.
    const socket: RelaySocket = { send: vi.fn(), close: vi.fn() }
    startRelay({
      config: { relayUrl: 'wss://relay.example/ws' }, db, app: relayApp,
      connect: () => socket, schedule: vi.fn(),
    })

    const login = await relayApp.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
    const relayCookie = login.headers['set-cookie'] as string
    const config1 = await relayApp.inject({ method: 'GET', url: '/admin/api/config', headers: { cookie: relayCookie } })
    expect(config1.json().relay).toEqual({ state: 'connecting' })

    // READY flips the client to 'ready' — the payload must track it, which a hardcoded
    // null (or a hardcoded { state: 'connecting' }) cannot.
    socket.onOpen?.()
    socket.onMessage?.(JSON.stringify({ type: 'READY' }))
    const config2 = await relayApp.inject({ method: 'GET', url: '/admin/api/config', headers: { cookie: relayCookie } })
    expect(config2.json().relay).toEqual({ state: 'ready' })

    await relayApp.close()
  })
})
