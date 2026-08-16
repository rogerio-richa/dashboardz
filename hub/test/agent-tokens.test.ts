import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/db/index.js'
import { createAgentToken, findAgentByToken, listAgentTokens, revokeAgentToken, touchAgentToken } from '../src/db/agents.js'
import { generateToken } from '../src/auth/tokens.js'
import { audit } from '../src/db/audit.js'
import { buildServer } from '../src/server.js'

describe('agent token rows', () => {
  it('mints a dbz_a_ token, stores only its hash, and finds the row by token', () => {
    const db = openDb(':memory:')
    const { agent, token } = createAgentToken(db, 'kitchen-builder')
    expect(token.startsWith('dbz_a_')).toBe(true)
    expect(agent.name).toBe('kitchen-builder')
    expect(agent.revoked_at).toBeNull()
    // stored hashed: the raw token appears nowhere in the row
    const raw = db.prepare('SELECT token_hash FROM agent_tokens WHERE id = ?').get(agent.id) as { token_hash: string }
    expect(raw.token_hash).not.toContain(token)
    expect(findAgentByToken(db, token)?.id).toBe(agent.id)
    expect(findAgentByToken(db, 'dbz_a_nope')).toBeUndefined()
  })

  it('revoke is soft — the row survives for audit attribution, and find still returns it', () => {
    const db = openDb(':memory:')
    const { agent, token } = createAgentToken(db, 'x')
    expect(revokeAgentToken(db, agent.id, 1000)).toBe(true)
    expect(revokeAgentToken(db, 'agt_missing', 1000)).toBe(false)
    const found = findAgentByToken(db, token)
    expect(found?.revoked_at).toBe(1000)
    expect(listAgentTokens(db).map((a) => a.id)).toContain(agent.id)
  })

  it('touch advances last_used_at', () => {
    const db = openDb(':memory:')
    const { agent } = createAgentToken(db, 'x')
    touchAgentToken(db, agent.id, 4242)
    expect(listAgentTokens(db).find((a) => a.id === agent.id)?.last_used_at).toBe(4242)
  })

  it('generateToken kinds keep distinct prefixes', () => {
    expect(generateToken('sender').startsWith('dbz_s_')).toBe(true)
    expect(generateToken('device').startsWith('dbz_c_')).toBe(true)
    expect(generateToken('agent').startsWith('dbz_a_')).toBe(true)
  })
})

const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

describe('Bearer auth on admin routes', () => {
  let app: FastifyInstance, db: ReturnType<typeof openDb>, cookie: string

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
    cookie = login.headers['set-cookie'] as string
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  it('a live agent token reads an admin route; garbage and cookieless requests do not', async () => {
    const { token } = createAgentToken(db, 'reader')
    expect((await app.inject({ url: '/admin/api/screens', headers: bearer(token) })).statusCode).toBe(200)
    expect((await app.inject({ url: '/admin/api/screens', headers: bearer('dbz_a_garbage') })).statusCode).toBe(401)
    expect((await app.inject({ url: '/admin/api/screens' })).statusCode).toBe(401)
    // the cookie path is untouched
    expect((await app.inject({ url: '/admin/api/screens', headers: { cookie } })).statusCode).toBe(200)
  })

  it('use advances last_used_at; revocation shuts the door and audits the attempt', async () => {
    const { agent, token } = createAgentToken(db, 'worker')
    await app.inject({ url: '/admin/api/screens', headers: bearer(token) })
    const used = listAgentTokens(db).find((a) => a.id === agent.id)!.last_used_at
    expect(used).not.toBeNull()

    revokeAgentToken(db, agent.id, Date.now())
    expect((await app.inject({ url: '/admin/api/screens', headers: bearer(token) })).statusCode).toBe(401)
    const rejected = db.prepare("SELECT details FROM audit_log WHERE event = 'agent_auth_rejected'").all()
    expect(rejected.length).toBe(1)
  })

  it('mints via cookie (201, token shown once), lists without the hash, revokes via cookie', async () => {
    const mint = await app.inject({ method: 'POST', url: '/admin/api/agent-tokens', headers: { cookie }, payload: { name: 'builder' } })
    expect(mint.statusCode).toBe(201)
    const minted = mint.json()
    expect(minted.token.startsWith('dbz_a_')).toBe(true)

    const list = await app.inject({ url: '/admin/api/agent-tokens', headers: { cookie } })
    const rows = list.json()
    expect(rows.map((r: { id: string }) => r.id)).toContain(minted.id)
    expect(JSON.stringify(rows)).not.toContain('token_hash')

    const del = await app.inject({ method: 'DELETE', url: `/admin/api/agent-tokens/${minted.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/admin/api/agent-tokens/${minted.id}`, headers: { cookie } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/admin/api/screens', headers: bearer(minted.token) })).statusCode).toBe(401)
  })

  // Every sibling name schema in admin.ts caps at 100 (senders, devices, screens, themes); the
  // mint body was missing the same cap.
  it('rejects a name over 100 chars', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/api/agent-tokens', headers: { cookie }, payload: { name: 'x'.repeat(101) },
    })
    expect(res.statusCode).toBe(400)
  })

  /**
   * The human-only set is exactly {mint, revoke}. A token may
   * SEE the token list (metadata only) but may not grow or shrink it — otherwise revocation is
   * theater. A route joining or leaving this set must change this test deliberately.
   */
  it('Bearer cannot mint or revoke, but can list', async () => {
    const { agent, token } = createAgentToken(db, 'held-by-agent')
    expect((await app.inject({ method: 'POST', url: '/admin/api/agent-tokens', headers: bearer(token), payload: { name: 'sneaky' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: `/admin/api/agent-tokens/${agent.id}`, headers: bearer(token) })).statusCode).toBe(401)
    expect((await app.inject({ url: '/admin/api/agent-tokens', headers: bearer(token) })).statusCode).toBe(200)
  })

  it('mint and revoke are audited', async () => {
    const mint = await app.inject({ method: 'POST', url: '/admin/api/agent-tokens', headers: { cookie }, payload: { name: 'a' } })
    await app.inject({ method: 'DELETE', url: `/admin/api/agent-tokens/${mint.json().id}`, headers: { cookie } })
    const events = (db.prepare('SELECT event FROM audit_log ORDER BY id').all() as Array<{ event: string }>).map((r) => r.event)
    expect(events).toContain('agent_token_created')
    expect(events).toContain('agent_token_revoked')
  })

  it('an agent-authored write lands in the audit log under the agent id', async () => {
    const { agent, token } = createAgentToken(db, 'writer')
    const res = await app.inject({
      method: 'POST', url: '/admin/api/screens', headers: bearer(token),
      payload: { name: 'agent-made', orientation: 'landscape', grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] } },
    })
    expect(res.statusCode).toBe(200)
    const row = db.prepare("SELECT actor_type, actor_id FROM audit_log WHERE event = 'screen_created'").get() as { actor_type: string; actor_id: string }
    expect(row.actor_type).toBe('agent')
    expect(row.actor_id).toBe(agent.id)
  })

  it('an agent-authenticated screen delete is audited under the agent id', async () => {
    const { agent, token } = createAgentToken(db, 'deleter')
    const create = await app.inject({
      method: 'POST', url: '/admin/api/screens', headers: bearer(token),
      payload: { name: 'to-delete', orientation: 'landscape', grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] } },
    })
    const screenId = create.json().id
    const res = await app.inject({ method: 'DELETE', url: `/admin/api/screens/${screenId}`, headers: bearer(token) })
    expect(res.statusCode).toBe(204)
    const row = db.prepare("SELECT actor_type, actor_id FROM audit_log WHERE event = 'screen_deleted'").get() as { actor_type: string; actor_id: string }
    expect(row.actor_type).toBe('agent')
    expect(row.actor_id).toBe(agent.id)
  })

  /**
   * Logout is meaningless without a cookie session — there is nothing for a Bearer request to
   * destroy — so it must sit behind requireHumanAdmin, not the ordinary requireAdmin scope. Before
   * the fix, a Bearer POST reached `app.sessions.destroy(req.cookies[ADMIN_COOKIE]!)` (the `!` lying
   * about a cookie that was never there) and wrote an `admin_logout` audit row stamped `'admin'`
   * even though no human was involved — any live agent token could mint audit rows misattributed to
   * the human admin.
   */
  it('Bearer cannot log out, and no admin_logout row is written for the attempt', async () => {
    const { token } = createAgentToken(db, 'logout-attacker')
    const res = await app.inject({ method: 'POST', url: '/admin/api/logout', headers: bearer(token) })
    expect(res.statusCode).toBe(401)
    const rows = db.prepare("SELECT * FROM audit_log WHERE event = 'admin_logout'").all()
    expect(rows.length).toBe(0)
  })

  // The Agents admin page needs its own slice of the audit trail; without a server-side filter it
  // was pulling the whole log and filtering client-side, which doesn't scale past `limit`.
  it('audit route filters by actor_type when given, and returns everything without it', async () => {
    audit(db, 'agent', 'agt_x', 'screen_created')
    audit(db, 'admin', null, 'theme_updated')

    const filtered = await app.inject({ url: '/admin/api/audit?actor_type=agent', headers: { cookie } })
    const filteredEvents = (filtered.json() as Array<{ event: string }>).map((r) => r.event)
    expect(filteredEvents).toEqual(['screen_created'])

    const all = await app.inject({ url: '/admin/api/audit', headers: { cookie } })
    const allEvents = (all.json() as Array<{ event: string }>).map((r) => r.event)
    expect(allEvents).toEqual(expect.arrayContaining(['screen_created', 'theme_updated']))
  })
})
