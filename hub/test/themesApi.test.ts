import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/migrate.js'
import { buildServer } from '../src/server.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import type { FastifyInstance } from 'fastify'

const CONFIG = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null }

describe('GET /api/themes/:id', () => {
  let app: FastifyInstance, token: string

  /** Whatever rev the migrations have left this seeded theme on — see the ETag test below. */
  const cypherpunkRev = () =>
    (app.db.prepare("SELECT rev FROM themes WHERE id = 'thm_cypherpunk'").get() as { rev: number }).rev

  beforeEach(async () => {
    const db = new Database(':memory:')
    migrate(db as never)
    app = await buildServer({ config: CONFIG as any, db })
    const code = createPairingCode(db as never, 'dev', Date.now())
    token = redeemPairingCode(db as never, code.code, Date.now())!.token
  })

  it('401s without a device token, and audits the rejection', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/themes/thm_default' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid token' })
    const row = app.db.prepare(
      "SELECT * FROM audit_log WHERE event = 'auth_rejected' AND details LIKE '%/api/themes/:id%'",
    ).get()
    expect(row).toBeDefined()
  })

  it('401s with an invalid device token, and audits the rejection', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/themes/thm_default',
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid token' })
    const row = app.db.prepare(
      "SELECT * FROM audit_log WHERE event = 'auth_rejected' AND details LIKE '%/api/themes/:id%'",
    ).get()
    expect(row).toBeDefined()
  })

  it('serves the theme document with rev as the ETag', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/themes/thm_cypherpunk',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // Read from the row rather than hardcoding: `rev` is owned by whichever migration last touched
    // this theme (v7 seeded it at 1, v13 converted it to the palette-only model and bumped it), so
    // a literal here asserts a migration's history rather than the ETag convention it is testing.
    expect(res.headers.etag).toBe(String(cypherpunkRev())) // unquoted: matches feeds' image_rev convention
    const body = res.json()
    expect(body.board.bg).toBe('#0a0a0a')
    // A widget entry is the bare design id now (v11) — colour comes from the board, which is why
    // `board.bg` above is the interesting assertion and there is no per-widget colour map at all.
    expect(body.widgets.clock).toBe('segment')
  })

  it('304s when the ETag matches', async () => {
    const rev = String(cypherpunkRev())
    const res = await app.inject({
      method: 'GET', url: '/api/themes/thm_cypherpunk',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': rev },
    })
    expect(res.statusCode).toBe(304)
    expect(res.headers.etag).toBe(rev)
  })

  it('404s an unknown theme rather than throwing', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/themes/thm_nope',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})
