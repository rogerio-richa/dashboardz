import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { recordAnswer, recordTap, sweepExpired } from '../src/db/alerts.js'

// GET /api/alerts/:id/answer — the read half of ask/answer for LOCAL senders. The push
// half (relay senders getting the answer on their socket) is covered by the relay suites; this
// route is how a sender that only ever held `{id}` from POST /api/notify learns the outcome.

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, token: string, devA: string

beforeEach(async () => {
  const db = openDb(':memory:')
  devA = redeemPairingCode(db, createPairingCode(db, 'a', 0).code, 1)!.device.id
  const s = createSender(db, 'asker', [devA])
  token = s.token
  app = await buildServer({ config, db })
})

const OPTS = { options: [{ id: 'ship', label: 'Ship it' }, { id: 'hold', label: 'Hold' }] }

const ask = async (extra: object = {}, auth = `Bearer ${token}`) => {
  const res = await app.inject({
    method: 'POST', url: '/api/notify', headers: { authorization: auth },
    payload: { title: 'Deploy?', severity: 'warn', ...OPTS, ...extra },
  })
  expect(res.statusCode).toBe(200)
  return res.json().id as string
}

const answerOf = (id: string, auth = `Bearer ${token}`) =>
  app.inject({ method: 'GET', url: `/api/alerts/${id}/answer`, headers: { authorization: auth } })

describe('GET /api/alerts/:id/answer', () => {
  it('rejects a missing/bad token with 401 and audits it', async () => {
    const id = await ask()
    expect((await answerOf(id, 'Bearer nope')).statusCode).toBe(401)
    const row = app.db.prepare(
      "SELECT details FROM audit_log WHERE event = 'auth_rejected' ORDER BY id DESC",
    ).get() as { details: string }
    expect(row.details).toContain('/api/alerts/:id/answer')
  })

  it('404s an unknown alert id', async () => {
    expect((await answerOf('alr_never')).statusCode).toBe(404)
  })

  it("404s another sender's alert identically to a nonexistent one", async () => {
    const id = await ask()
    const { token: other } = createSender(app.db, 'nosy', [devA])
    const res = await answerOf(id, `Bearer ${other}`)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'unknown alert' })
  })

  it('reports pending while nobody has answered', async () => {
    const id = await ask()
    const res = await answerOf(id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ state: 'pending' })
  })

  it('reports the answer with its label, device and time once a tap lands', async () => {
    const id = await ask()
    expect(recordAnswer(app.db, id, devA, 'ship', 1234).ok).toBe(true)
    const body = answerOf(id).then((r) => r.json())
    await expect(body).resolves.toEqual({
      state: 'answered', option_id: 'ship', option_label: 'Ship it',
      answered_at: 1234, device_id: devA,
    })
  })

  it('still reports answered after the answer concluded the alert', async () => {
    // recordAnswer also concludes a single-device alert (status becomes 'dismissed'); the view
    // must keep reporting the answer, not the conclusion that followed it.
    const id = await ask()
    recordAnswer(app.db, id, devA, 'hold', 99)
    const status = (app.db.prepare('SELECT status FROM alerts WHERE id = ?').get(id) as { status: string }).status
    expect(status).toBe('dismissed')
    expect((await answerOf(id)).json().state).toBe('answered')
  })

  it('reports dismissed when a human cleared the question without choosing', async () => {
    const id = await ask()
    recordTap(app.db, id, devA, 'dismiss', 50)
    expect((await answerOf(id)).json()).toEqual({ state: 'dismissed' })
  })

  it('reports expired when the ttl ran out unanswered', async () => {
    const id = await ask({ ttl_s: 1 })
    sweepExpired(app.db, Date.now() + 5000)
    expect((await answerOf(id)).json()).toEqual({ state: 'expired' })
  })

  it('reports the EARLIEST answer on a multi-device alert', async () => {
    const devB = redeemPairingCode(app.db, createPairingCode(app.db, 'b', 0).code, 1)!.device.id
    const id = await ask({ devices: [devA, devB] })
    recordAnswer(app.db, id, devB, 'hold', 2000)
    recordAnswer(app.db, id, devA, 'ship', 1000)
    const body = (await answerOf(id)).json()
    expect(body.option_id).toBe('ship')
    expect(body.device_id).toBe(devA)
  })
})
