import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { activeWireAlertsForDevice } from '../src/db/alerts.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, token: string, dev: string

beforeEach(async () => {
  const db = openDb(':memory:')
  dev = redeemPairingCode(db, createPairingCode(db, 'a', 0).code, 1)!.device.id
  token = createSender(db, 'CI', [dev]).token
  app = await buildServer({ config, db })
})

const post = (body: object) =>
  app.inject({ method: 'POST', url: '/api/notify',
    headers: { authorization: `Bearer ${token}` }, payload: body })

const OK = [{ id: 'taken', label: 'Taken' }, { id: 'later', label: 'Remind me later' }]

describe('options on notify', () => {
  it('accepts options and surfaces them on the wire', async () => {
    expect((await post({ title: 'Meds', severity: 'warn', options: OK })).statusCode).toBe(200)
    const wire = activeWireAlertsForDevice(app.db, dev, Date.now())
    expect(wire[0].options).toEqual(OK)
  })

  it('an alert without options has options: null, not []', async () => {
    await post({ title: 'plain', severity: 'info' })
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())[0].options).toBeNull()
  })

  it('rejects more than four options', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }))
    expect((await post({ title: 'x', severity: 'info', options: five })).statusCode).toBe(400)
  })

  it('rejects an over-long label and a malformed id', async () => {
    expect((await post({ title: 'x', severity: 'info',
      options: [{ id: 'ok', label: 'y'.repeat(25) }] })).statusCode).toBe(400)
    expect((await post({ title: 'x', severity: 'info',
      options: [{ id: 'Not Valid!', label: 'y' }] })).statusCode).toBe(400)
  })

  it('rejects an explicitly-empty options array', async () => {
    expect((await post({ title: 'x', severity: 'info', options: [] })).statusCode).toBe(400)
  })

  it('rejects duplicate option ids — an answer must identify exactly one option', async () => {
    const dupes = [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }]
    expect((await post({ title: 'x', severity: 'info', options: dupes })).statusCode).toBe(400)
    // A 400 alone doesn't prove nothing was written — assert the side effect, not just the
    // status code: a rejected request must leave no orphaned alert row behind.
    const count = app.db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('a dedup update can change the options', async () => {
    await post({ title: 'v1', severity: 'warn', dedup_key: 'k', options: OK })
    await post({ title: 'v2', severity: 'warn', dedup_key: 'k',
      options: [{ id: 'yes', label: 'Yes' }] })
    const wire = activeWireAlertsForDevice(app.db, dev, Date.now())
    expect(wire).toHaveLength(1)
    expect(wire[0].options).toEqual([{ id: 'yes', label: 'Yes' }])
  })

  it('a dedup update omitting options clears a previously-set set (full-replace semantics)', async () => {
    await post({ title: 'v1', severity: 'warn', dedup_key: 'k', options: OK })
    await post({ title: 'v2', severity: 'warn', dedup_key: 'k' })
    const wire = activeWireAlertsForDevice(app.db, dev, Date.now())
    expect(wire).toHaveLength(1)
    expect(wire[0].options).toBeNull()
  })
})
