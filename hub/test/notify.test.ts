import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, token: string, devA: string

beforeEach(async () => {
  const db = openDb(':memory:')
  devA = redeemPairingCode(db, createPairingCode(db, 'a', 0).code, 1)!.device.id
  const s = createSender(db, 'CI', [devA])
  token = s.token
  app = await buildServer({ config, db })
})

const post = (body: object, auth = `Bearer ${token}`) =>
  app.inject({ method: 'POST', url: '/api/notify', headers: { authorization: auth }, payload: body })

describe('POST /api/notify', () => {
  it('rejects missing/bad token with 401 and audits it', async () => {
    expect((await post({ title: 'x', severity: 'info' }, 'Bearer nope')).statusCode).toBe(401)
    const row = app.db.prepare("SELECT * FROM audit_log WHERE event = 'auth_rejected'").get()
    expect(row).toBeDefined()
  })
  it('rejects unknown fields with 400', async () => {
    const res = await post({ title: 'x', severity: 'info', image: 'nope.png' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('additional properties')
  })
  it('rejects unknown target device with 400 listing valid ids', async () => {
    const res = await post({ title: 'x', severity: 'info', devices: ['dev_nope'] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('dev_nope')
  })
  it('rejects when sender has no default devices and none given', async () => {
    const { token: t2 } = createSender(app.db, 'lonely', [])
    const res = await post({ title: 'x', severity: 'info' }, `Bearer ${t2}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('no target devices')
  })
  it('accepts a valid notify, returns id, uses default devices, audits', async () => {
    const res = await post({ title: 'Build done', severity: 'info' })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toMatch(/^alr_/)
    const alert = app.db.prepare('SELECT * FROM alerts').get() as any
    expect(JSON.parse(alert.target_devices)).toEqual([devA])
    expect(app.db.prepare("SELECT * FROM audit_log WHERE event = 'notify'").get()).toBeDefined()
  })
  it('dedup returns the same id', async () => {
    const a = (await post({ title: 'v1', severity: 'warn', dedup_key: 'k' })).json()
    const b = (await post({ title: 'v2', severity: 'warn', dedup_key: 'k' })).json()
    expect(b.id).toBe(a.id)
  })
  it('enforces length caps', async () => {
    const res1 = await post({ title: 'x'.repeat(201), severity: 'info' })
    expect(res1.statusCode).toBe(400)
    expect(res1.json().error).toContain('200')
    const res2 = await post({ title: 'x', body: 'y'.repeat(1501), severity: 'info' })
    expect(res2.statusCode).toBe(400)
  })
})

describe('POST /api/notify resolve', () => {
  it('resolves an active dedup alert: flips status, sends ALERT_REMOVE, audits', async () => {
    const sendMany = vi.spyOn(app.registry, 'sendMany')
    const created = await post({ title: 'RAID degraded', severity: 'critical', dedup_key: 'raid-nas01' })
    const alertId = created.json().id

    const res = await post({ resolve: true, dedup_key: 'raid-nas01' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, resolved: true, alert_id: alertId })
    expect(sendMany).toHaveBeenCalledWith([devA], { type: 'ALERT_REMOVE', id: alertId, reason: 'resolved' })

    const row = app.db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId) as any
    expect(row.status).toBe('dismissed')
    expect(app.db.prepare("SELECT * FROM audit_log WHERE event = 'notify_resolved'").get()).toBeDefined()
  })

  it('resolve of an unknown dedup_key is idempotent: ok true, resolved false, no ALERT_REMOVE', async () => {
    const sendMany = vi.spyOn(app.registry, 'sendMany')
    const res = await post({ resolve: true, dedup_key: 'never-seen' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, resolved: false })
    expect(sendMany).not.toHaveBeenCalled()
  })

  it('rejects resolve without dedup_key with 400', async () => {
    const res = await post({ resolve: true })
    expect(res.statusCode).toBe(400)
  })

  it('leaves the create path untouched: title/severity still required when not resolving', async () => {
    const res = await post({ resolve: false })
    expect(res.statusCode).toBe(400)
  })

  it('resolving an already-resolved dedup_key a second time is idempotent: resolved false', async () => {
    const created = await post({ title: 'RAID degraded', severity: 'critical', dedup_key: 'raid-nas01' })
    const alertId = created.json().id

    const first = await post({ resolve: true, dedup_key: 'raid-nas01' })
    expect(first.json()).toEqual({ ok: true, resolved: true, alert_id: alertId })

    const sendMany = vi.spyOn(app.registry, 'sendMany')
    const second = await post({ resolve: true, dedup_key: 'raid-nas01' })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ ok: true, resolved: false })
    expect(sendMany).not.toHaveBeenCalled()
  })

  it('cannot resolve another sender\'s alert: resolved false, and the owner\'s alert stays active', async () => {
    const created = await post({ title: 'RAID degraded', severity: 'critical', dedup_key: 'raid-nas01' })
    const alertId = created.json().id
    const { token: otherToken } = createSender(app.db, 'other', [devA])

    const sendMany = vi.spyOn(app.registry, 'sendMany')
    const res = await post({ resolve: true, dedup_key: 'raid-nas01' }, `Bearer ${otherToken}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, resolved: false })
    expect(sendMany).not.toHaveBeenCalled()

    const row = app.db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId) as any
    expect(row.status).toBe('active')
  })
})
