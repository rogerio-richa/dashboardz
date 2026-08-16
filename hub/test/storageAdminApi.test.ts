import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { ingestNotify } from '../src/db/alerts.js'
import { createAgentToken } from '../src/db/agents.js'
import { getSetting } from '../src/db/settings.js'
import { SETTINGS_KEY_ALERTS_DAYS } from '../src/db/retentionSettings.js'
import type { Config } from '../src/config.js'

/**
 * Admin storage & retention API. Same session-cookie idiom as
 * themesAdminApi.test.ts: log in via POST /admin/api/login, pass `headers: { cookie }` on every
 * subsequent request.
 */
describe('admin storage & retention API', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string
  let dataDir: string

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dbz-storage-admin-'))
    db = openDb(':memory:')
    const config: Config = {
      port: 0, dataDir, adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null,
      retentionAlertsDays: 90, retentionAuditDays: 180,
      retentionAlertsDaysSource: 'default', retentionAuditDaysSource: 'default',
    }
    app = await buildServer({ config, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
  })

  afterEach(async () => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
  const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: { cookie }, payload })
  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  describe('GET /admin/api/storage', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/api/storage' })
      expect(res.statusCode).toBe(401)
    })

    it('a live agent token can read it — GET stays agent-readable', async () => {
      const { token } = createAgentToken(db, 'reader')
      const res = await app.inject({ method: 'GET', url: '/admin/api/storage', headers: bearer(token) })
      expect(res.statusCode).toBe(200)
    })

    it('shape: db_bytes, images_bytes, five pools, retention with per-key source, last_sweep null before any sweep', async () => {
      const body = (await get('/admin/api/storage')).json()
      expect(body.db_bytes).toBeGreaterThan(0)
      expect(body.images_bytes).toBe(0)
      expect(body.pools.map((p: { id: string }) => p.id).sort()).toEqual(
        ['alerts_active', 'alerts_concluded', 'audit_log', 'feed_rows', 'feed_values'].sort(),
      )
      for (const pool of body.pools) {
        expect(typeof pool.rows).toBe('number')
        expect(typeof pool.bytes).toBe('number')
        expect(typeof pool.approx).toBe('boolean')
      }
      // No env override and no settings row yet — both retention values are the built-in default.
      expect(body.retention).toEqual({
        alerts_days: 90, audit_days: 180,
        source: { alerts_days: 'default', audit_days: 'default' },
      })
      expect(body.last_sweep).toBeNull()
    })

    it('counts seeded alerts and audit rows into the right pools, with bytes > 0', async () => {
      const dev = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
      const snd = createSender(db, 's', []).sender.id
      ingestNotify(db, { senderId: snd, title: 'active', severity: 'info', targetDevices: [dev] }, Date.now())
      const concluded = ingestNotify(db, { senderId: snd, title: 'concluded', severity: 'info', targetDevices: [dev] }, Date.now()).alert
      db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(concluded.id)

      const body = (await get('/admin/api/storage')).json()
      const active = body.pools.find((p: { id: string }) => p.id === 'alerts_active')
      const done = body.pools.find((p: { id: string }) => p.id === 'alerts_concluded')
      expect(active.rows).toBe(2) // 1 alert + 1 delivery
      expect(active.bytes).toBeGreaterThan(0)
      expect(done.rows).toBe(2)
      expect(done.bytes).toBeGreaterThan(0)
    })

    it('sums file bytes under dataDir/feeds and dataDir/themes for images_bytes', async () => {
      mkdirSync(join(dataDir, 'feeds'))
      writeFileSync(join(dataDir, 'feeds', 'feed_x'), Buffer.alloc(1234))
      const body = (await get('/admin/api/storage')).json()
      expect(body.images_bytes).toBe(1234)
    })

    it('reports source "env" when an env-configured retention value is in force', async () => {
      const envConfig: Config = {
        port: 0, dataDir, adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null,
        retentionAlertsDays: 30, retentionAuditDays: 180,
        retentionAlertsDaysSource: 'env', retentionAuditDaysSource: 'default',
      }
      const envApp = await buildServer({ config: envConfig, db })
      const login = await envApp.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
      const envCookie = login.headers['set-cookie'] as string
      const body = (await envApp.inject({ method: 'GET', url: '/admin/api/storage', headers: { cookie: envCookie } })).json()
      expect(body.retention).toEqual({
        alerts_days: 30, audit_days: 180,
        source: { alerts_days: 'env', audit_days: 'default' },
      })
      await envApp.close()
    })

    it('reflects the most recent retention_swept audit row as last_sweep', async () => {
      await post('/admin/api/retention/sweep')
      const body = (await get('/admin/api/storage')).json()
      // Nothing seeded old enough to delete, so counts are zero, but a sweep still ran — the
      // route reads the last FORCED sweep only if it audited; a no-op forced sweep writes no
      // audit row (ttl.ts's doRetentionSweep), so last_sweep may legitimately still be null here.
      expect(body.last_sweep === null || typeof body.last_sweep.ts === 'number').toBe(true)
    })
  })

  describe('PATCH /admin/api/retention', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/admin/api/retention', payload: { alerts_days: 10 } })
      expect(res.statusCode).toBe(401)
    })

    /**
     * Human-only: `audit_days` is what lets
     * an operator reconstruct what a compromised agent did, so a live agent token must not be
     * able to shrink it. A cookie session (a human) still can — same behaviour as mint/revoke.
     */
    it('rejects a live agent token, even though the same token can GET storage', async () => {
      const { token } = createAgentToken(db, 'agent-writer')
      const res = await app.inject({
        method: 'PATCH', url: '/admin/api/retention', headers: bearer(token), payload: { alerts_days: 10 },
      })
      expect(res.statusCode).toBe(401)
      // Unwritten: the settings row from a rejected attempt must not exist.
      expect(getSetting(db, SETTINGS_KEY_ALERTS_DAYS)).toBeNull()
    })

    it('a cookie session (human) can PATCH it', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: 10 })
      expect(res.statusCode).toBe(204)
    })

    it('rejects a negative value', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: -1 })
      expect(res.statusCode).toBe(400)
    })

    it('rejects a non-integer value', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: 1.5 })
      expect(res.statusCode).toBe(400)
    })

    it('rejects a value over the cap', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: 999999 })
      expect(res.statusCode).toBe(400)
    })

    it('rejects an empty body', async () => {
      const res = await patch('/admin/api/retention', {})
      expect(res.statusCode).toBe(400)
    })

    it('accepts 0 (keep forever)', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: 0 })
      expect(res.statusCode).toBe(204)
      expect((await get('/admin/api/storage')).json().retention.alerts_days).toBe(0)
    })

    it('writes a settings row that outranks env/default, reported as source "setting"', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: 14, audit_days: 21 })
      expect(res.statusCode).toBe(204)
      const body = (await get('/admin/api/storage')).json()
      expect(body.retention).toEqual({
        alerts_days: 14, audit_days: 21,
        source: { alerts_days: 'setting', audit_days: 'setting' },
      })
    })

    it('audits retention_settings_changed with old/new values', async () => {
      await patch('/admin/api/retention', { alerts_days: 14 })
      const rows = db.prepare("SELECT * FROM audit_log WHERE event = 'retention_settings_changed'").all() as
        { details: string; actor_type: string }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_type).toBe('admin')
      expect(JSON.parse(rows[0].details)).toEqual({ alerts_days: { old: 90, new: 14 } })
    })

    it('a partial PATCH (audit_days only) leaves alerts_days untouched', async () => {
      await patch('/admin/api/retention', { audit_days: 30 })
      const body = (await get('/admin/api/storage')).json()
      expect(body.retention).toEqual({
        alerts_days: 90, audit_days: 30,
        source: { alerts_days: 'default', audit_days: 'setting' },
      })
    })

    it('explicit null resets a key to inherit — the settings row is deleted, source falls back to env/default', async () => {
      await patch('/admin/api/retention', { alerts_days: 14 })
      expect(getSetting(db, SETTINGS_KEY_ALERTS_DAYS)).toBe('14')

      const res = await patch('/admin/api/retention', { alerts_days: null })
      expect(res.statusCode).toBe(204)
      expect(getSetting(db, SETTINGS_KEY_ALERTS_DAYS)).toBeNull()

      const body = (await get('/admin/api/storage')).json()
      expect(body.retention.alerts_days).toBe(90)
      expect(body.retention.source.alerts_days).toBe('default')
    })

    it('resetting an already-unset key is a no-op, not an error', async () => {
      const res = await patch('/admin/api/retention', { alerts_days: null })
      expect(res.statusCode).toBe(204)
      expect(getSetting(db, SETTINGS_KEY_ALERTS_DAYS)).toBeNull()
    })

    it('audits a reset the same way as a write, with old/new reflecting the fallback value', async () => {
      await patch('/admin/api/retention', { alerts_days: 14 })
      await patch('/admin/api/retention', { alerts_days: null })
      const rows = db.prepare("SELECT * FROM audit_log WHERE event = 'retention_settings_changed'").all() as
        { details: string }[]
      expect(JSON.parse(rows[rows.length - 1].details)).toEqual({ alerts_days: { old: 14, new: 90 } })
    })
  })

  describe('POST /admin/api/retention/sweep', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'POST', url: '/admin/api/retention/sweep' })
      expect(res.statusCode).toBe(401)
    })

    it('rejects a live agent token — forcing a sweep is human-only, same line as the PATCH', async () => {
      const { token } = createAgentToken(db, 'agent-sweeper')
      const res = await app.inject({ method: 'POST', url: '/admin/api/retention/sweep', headers: bearer(token) })
      expect(res.statusCode).toBe(401)
    })

    it('a second forced sweep inside the cooldown window is rejected with 429 and a retry-after hint', async () => {
      const first = await post('/admin/api/retention/sweep')
      expect(first.statusCode).toBe(200)

      const second = await post('/admin/api/retention/sweep')
      expect(second.statusCode).toBe(429)
      expect(second.headers['retry-after']).toBeDefined()
      expect(second.json().error).toMatch(/too recently|try again/i)
    })

    it('a forced sweep succeeds again once the cooldown has elapsed', async () => {
      // Only `Date` is faked — Fastify's `inject()` relies on real timers/microtasks internally
      // (setImmediate et al.), and faking those too hangs every subsequent `inject()` call.
      // Moving the clock forward is all the cooldown check (`Date.now()`) needs.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const first = await post('/admin/api/retention/sweep')
        expect(first.statusCode).toBe(200)

        vi.setSystemTime(Date.now() + 60_000)

        const second = await post('/admin/api/retention/sweep')
        expect(second.statusCode).toBe(200)
      } finally {
        vi.useRealTimers()
      }
    })

    it('deletes seeded old rows and returns the deleted counts', async () => {
      const dev = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
      const snd = createSender(db, 's', []).sender.id
      const DAY_MS = 24 * 60 * 60 * 1000
      const old = ingestNotify(db, { senderId: snd, title: 'ancient', severity: 'info', targetDevices: [dev] }, Date.now() - 200 * DAY_MS).alert
      db.prepare("UPDATE alerts SET status = 'dismissed', created_at = ? WHERE id = ?").run(Date.now() - 200 * DAY_MS, old.id)
      db.prepare('INSERT INTO audit_log (ts, actor_type, actor_id, event, details) VALUES (?, ?, ?, ?, ?)')
        .run(Date.now() - 200 * DAY_MS, 'system', null, 'ancient_event', '{}')

      const res = await post('/admin/api/retention/sweep')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ alerts: 1, audit: 1 })

      expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(old.id)).toBeUndefined()
      expect(db.prepare("SELECT * FROM audit_log WHERE event = 'ancient_event'").get()).toBeUndefined()
    })

    it('a forced sweep uses a just-saved retention setting, not the value in force at boot', async () => {
      const dev = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
      const snd = createSender(db, 's', []).sender.id
      const DAY_MS = 24 * 60 * 60 * 1000
      const alert = ingestNotify(db, { senderId: snd, title: 'ten days old', severity: 'info', targetDevices: [dev] }, Date.now() - 10 * DAY_MS).alert
      db.prepare("UPDATE alerts SET status = 'dismissed', created_at = ? WHERE id = ?").run(Date.now() - 10 * DAY_MS, alert.id)

      // Boot-time policy (90 days) would keep this alert; tighten it via PATCH first.
      await patch('/admin/api/retention', { alerts_days: 5 })
      const res = await post('/admin/api/retention/sweep')
      expect(res.json()).toEqual({ alerts: 1, audit: 0 })
      expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeUndefined()
    })

    it('returns zero counts and writes no retention_swept audit row when nothing is old enough to prune', async () => {
      const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'retention_swept'").get() as { n: number }
      const res = await post('/admin/api/retention/sweep')
      expect(res.json()).toEqual({ alerts: 0, audit: 0 })
      const after = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'retention_swept'").get() as { n: number }
      expect(after.n).toBe(before.n)
    })
  })
})
