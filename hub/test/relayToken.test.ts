import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { startRelay } from '../src/relay/bootstrap.js'
import { setSetting } from '../src/db/settings.js'
import { CLOSE_TOKEN_REQUIRED } from '../src/relay/client.js'
import { RELAY_TOKEN_SETTING, RelayManager, testRelayUrl } from '../src/relay/manager.js'

/** Same fake-relay idiom as relayStatusApi.test.ts / admin.test.ts. */
class FakeSocket {
  sent: string[] = []
  closed = false
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; this.onClose?.() }
}

const base = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

const login = async (app: FastifyInstance) => {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  return res.headers['set-cookie'] as string
}

describe('relay account token', () => {
  it('PUT stores url and token; GET reports token_set true and never the token value', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    startRelay({ config, db, app, schedule: () => {}, connect: () => new FakeSocket() })
    const cookie = await login(app)

    const put = await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay.example/ws', token: 'dzr_supersecret' },
    })
    expect(put.statusCode).toBe(200)
    expect(put.body).not.toContain('dzr_supersecret')
    expect(put.json().token_set).toBe(true)

    const get = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    expect(get.body).not.toContain('dzr_supersecret')
    expect(get.json().token_set).toBe(true)
  })

  it('PUT with token: "" clears a previously stored token', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    startRelay({ config, db, app, schedule: () => {}, connect: () => new FakeSocket() })
    const cookie = await login(app)

    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay.example/ws', token: 'dzr_supersecret' },
    })
    const cleared = await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay.example/ws', token: '' },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().token_set).toBe(false)

    const get = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    expect(get.json().token_set).toBe(false)
  })

  it('HELLO_HUB includes account_token when the setting is set, and omits the field when not', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: 'wss://relay.example/ws' }
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    startRelay({
      config, db, app, schedule: () => {},
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    })
    sockets[0].onOpen?.()
    expect(JSON.parse(sockets[0].sent[0])).not.toHaveProperty('account_token')

    const cookie = await login(app)
    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay.example/ws', token: 'dzr_supersecret' },
    })
    // Same-URL saves still tear down and redial (RelayManager.setUrl's documented contract),
    // so the fresh token rides on a NEW socket's HELLO_HUB.
    expect(sockets.length).toBe(2)
    sockets[1].onOpen?.()
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({ account_token: 'dzr_supersecret' })
  })

  it('a 4403 close is terminal, names the fix, and the client does not reconnect (same as bad_secret)', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: 'wss://relay.example/ws' }
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    const schedule = vi.fn()
    startRelay({
      config, db, app, schedule,
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    })
    sockets[0].onClose?.(4403)

    const cookie = await login(app)
    const res = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    const body = res.json()
    expect(body.terminal).toBe(true)
    expect(body.state).toBe('offline')
    expect(body.last_error.code).toBe('token_required')
    expect(body.last_error.message).toMatch(/account token/i)
    expect(sockets.length).toBe(1)   // no reconnect attempt was scheduled
    // `schedule` is a vi.fn() that never invokes its callback, so the assertion above would hold
    // even if a reconnect HAD been scheduled — it just wouldn't have fired yet. Assert directly
    // that nothing was scheduled at all, so this test actually fails if the terminal treatment
    // regresses to "still schedules a retry, just doesn't run it in this test".
    expect(schedule).not.toHaveBeenCalled()
  })

  it('the audit log for relay_configured never contains the token value', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    startRelay({ config, db, app, schedule: () => {}, connect: () => new FakeSocket() })
    const cookie = await login(app)

    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay.example/ws', token: 'dzr_supersecret' },
    })

    const rows = db.prepare("SELECT event, details FROM audit_log WHERE event = 'relay_configured'").all() as
      Array<{ event: string; details: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].details).not.toContain('dzr_supersecret')
    expect(JSON.parse(rows[0].details)).toEqual({ url: 'wss://relay.example/ws', token_set: true })
  })
})

// clear() must delete both settings. Deleting only RELAY_URL_SETTING would leave the
// token row behind; setUrl(url) with no token argument means "leave the stored token alone", so
// reconfiguring to a DIFFERENT relay after a bare Disconnect would silently carry the old relay's
// plaintext token onto the new one's HELLO_HUB. clear() must delete both settings together.
describe('disconnect clears the stored token', () => {
  it('DELETE (clear) removes the token too — a later relay never inherits it', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    startRelay({
      config, db, app, schedule: () => {},
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    })
    const cookie = await login(app)

    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-a.example/ws', token: 'dzr_relay_a_secret' },
    })
    expect(sockets.length).toBe(1)

    const del = await app.inject({ method: 'DELETE', url: '/admin/api/relay', headers: { cookie } })
    expect(del.statusCode).toBe(204)

    // Nothing left to report at all — both rows are gone, not just the URL.
    const afterClear = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    expect(afterClear.json()).toBeNull()

    // Reconnect to a DIFFERENT relay, deliberately without a token.
    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-b.example/ws' },
    })
    expect(sockets.length).toBe(2)
    sockets[1].onOpen?.()
    const hello = JSON.parse(sockets[1].sent[0])
    expect(hello).not.toHaveProperty('account_token')
    // Belt and suspenders: relay A's token string must not appear anywhere on the wire to B.
    expect(sockets[1].sent[0]).not.toContain('dzr_relay_a_secret')
  })

  it('the off-state status reports token_set truthfully even with no client running ' +
    '(defense in depth against the same leak shape)', () => {
    // Reproduces the invariant violation directly against the setting store, rather than via
    // clear() (already covered above) — this guards status() itself against ever hiding a
    // token row just because nothing is currently connected, whatever the cause.
    const db = openDb(':memory:')
    setSetting(db, RELAY_TOKEN_SETTING, 'dzr_stale_token', Date.now())
    const manager = new RelayManager({ db, envUrl: null, makeClient: vi.fn() })

    const status = manager.status()
    expect(status).not.toBeNull()
    expect(status).toMatchObject({ token_set: true, configured: false, state: 'offline', url: '', hub_uid: '' })
    // Never the value itself, even in this fallback path.
    expect(JSON.stringify(status)).not.toContain('dzr_stale_token')
    // And still never touches relay_identity while unconfigured — same invariant
    // relayManager.test.ts pins for the ordinary no-url-no-token case.
    expect(db.prepare('SELECT * FROM relay_identity').all()).toEqual([])
  })
})

// A Test dial must preserve a 4403 (token_required), rather than folding it into the generic
// 'unreachable' result, so the feature's own primary failure mode ("your token is wrong") told
// the operator to go chase network problems — and since Save is gated on a passing Test, they had
// no way forward. Constraint: testRelayUrl must use ONLY the token passed to it for this dial,
// never fall back to a stored setting (that would recreate the leak against an
// arbitrary Test URL) — testRelayUrl takes no `db` at all, so there is nothing to fall back to.
describe('test-dial 4403 handling', () => {
  const identity = { hubUid: 'hub_test', hubSecret: 's3cret' }

  it('a 4403 close resolves token_required, not unreachable', async () => {
    const sockets: FakeSocket[] = []
    const p = testRelayUrl({
      url: 'wss://relay.example/ws', identity,
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
      schedule: () => {},
    })
    sockets[0].onClose?.(CLOSE_TOKEN_REQUIRED)
    expect(await p).toEqual({ ok: false, code: 'token_required' })
  })

  it('sends the caller-supplied token, and only that — no fallback to any stored value', async () => {
    const sockets: FakeSocket[] = []
    testRelayUrl({
      url: 'wss://relay.example/ws', identity, token: 'dzr_typed_for_this_dial',
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
      schedule: () => {},
    })
    sockets[0].onOpen?.()
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ account_token: 'dzr_typed_for_this_dial' })
  })

  it('omits account_token entirely when no token is supplied for the dial', async () => {
    const sockets: FakeSocket[] = []
    testRelayUrl({
      url: 'wss://relay.example/ws', identity,
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
      schedule: () => {},
    })
    sockets[0].onOpen?.()
    expect(JSON.parse(sockets[0].sent[0])).not.toHaveProperty('account_token')
  })
})

// CRITICAL: clear() closed the clear()-then-reconfigure path, but the
// SAME leak was reachable the more common way — an operator who just edits the relay address
// (Change -> new URL -> Save) without ever touching Disconnect. setUrl(url, undefined) means
// "leave the stored token alone" only when the URL is unchanged; changing the address clears it
// so relay A's token cannot ride onto relay B's HELLO_HUB. The token
// actually changes and no explicit token instruction came with the save; it survives only a
// same-url resave (the operator's "retry" idiom — see RelayManager.setUrl's docstring).
describe('an address change clears the old relay\'s token', () => {
  const setup = async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    startRelay({
      config, db, app, schedule: () => {},
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    })
    const cookie = await login(app)
    return { app, db, sockets, cookie }
  }

  it('(a) editing the address to a DIFFERENT relay with no token field clears the old token', async () => {
    const { app, sockets, cookie } = await setup()
    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-a.example/ws', token: 'dzr_relay_a_secret' },
    })
    expect(sockets.length).toBe(1)

    const put = await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-b.example/ws' },   // no token field at all
    })
    expect(put.json().token_set).toBe(false)

    const get = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    expect(get.json().token_set).toBe(false)

    expect(sockets.length).toBe(2)
    sockets[1].onOpen?.()
    const hello = JSON.parse(sockets[1].sent[0])
    expect(hello).not.toHaveProperty('account_token')
    expect(sockets[1].sent[0]).not.toContain('dzr_relay_a_secret')
  })

  it('(b) re-saving the SAME url with no token field keeps the token, still sent', async () => {
    const { app, sockets, cookie } = await setup()
    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-a.example/ws', token: 'dzr_relay_a_secret' },
    })
    expect(sockets.length).toBe(1)

    const put = await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-a.example/ws' },   // SAME url, no token field — "try again"
    })
    expect(put.json().token_set).toBe(true)

    const get = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    expect(get.json().token_set).toBe(true)

    // setUrl always tears down and redials, even for a same-url save — the fresh socket must
    // still carry the surviving token.
    expect(sockets.length).toBe(2)
    sockets[1].onOpen?.()
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({ account_token: 'dzr_relay_a_secret' })
  })

  it('(c) editing the address WITH a new token stores and sends only the new one', async () => {
    const { app, sockets, cookie } = await setup()
    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-a.example/ws', token: 'dzr_relay_a_secret' },
    })
    expect(sockets.length).toBe(1)

    const put = await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay-b.example/ws', token: 'dzr_relay_b_secret' },
    })
    expect(put.json().token_set).toBe(true)

    expect(sockets.length).toBe(2)
    sockets[1].onOpen?.()
    const hello = JSON.parse(sockets[1].sent[0])
    expect(hello).toMatchObject({ account_token: 'dzr_relay_b_secret' })
    expect(sockets[1].sent[0]).not.toContain('dzr_relay_a_secret')
  })
})

// GET /admin/api/relay must serialize its configured and token_set fields. Its route registration
// the earlier implementation and carries no Fastify response schema at all — so there is nothing to strip
// `configured`/`token_set` via `additionalProperties: false` (Fastify only filters a response
// when a response schema is declared; this route declares none, confirmed by reading
// hub/src/routes/admin.ts). Pinned here at the ROUTE level (an HTTP round trip through the real
// app), not just the manager-level route already covered, since that's what the requirement calls for
// to confirm and what the admin UI's stale-token logic actually depends on.
describe('GET /admin/api/relay serializes configured and token_set', () => {
  it('a connected relay\'s response carries configured: true and token_set: true over HTTP', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    startRelay({ config, db, app, schedule: () => {}, connect: () => new FakeSocket() })
    const cookie = await login(app)

    await app.inject({
      method: 'PUT', url: '/admin/api/relay', headers: { cookie },
      payload: { url: 'wss://relay.example/ws', token: 'dzr_supersecret' },
    })
    const res = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    const body = res.json()
    expect(body).toHaveProperty('configured', true)
    expect(body).toHaveProperty('token_set', true)
  })

  it('the off-with-stale-token defense-in-depth status also survives the route, over HTTP', async () => {
    const db = openDb(':memory:')
    const config = { ...base, relayUrl: null }
    const app = await buildServer({ config, db })
    // No startRelay() at all here — reproduces "no client" the same way the manager-level test
    // does, but this time reads it back out through the real HTTP route, not manager.status()
    // directly, to confirm the field survives Fastify's response serialization end to end.
    setSetting(db, RELAY_TOKEN_SETTING, 'dzr_stale_token', Date.now())
    startRelay({ config: { relayUrl: null }, db, app, connect: () => { throw new Error('must not dial') } })
    const cookie = await login(app)

    const res = await app.inject({ method: 'GET', url: '/admin/api/relay', headers: { cookie } })
    const body = res.json()
    expect(body).toHaveProperty('configured', false)
    expect(body).toHaveProperty('token_set', true)
    expect(res.body).not.toContain('dzr_stale_token')
  })
})
