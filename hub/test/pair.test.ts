import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createPairingCode } from '../src/db/devices.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

describe('POST /api/pair', () => {
  it('exchanges a valid code exactly once', async () => {
    const db = openDb(':memory:')
    const { code } = createPairingCode(db, 'bedside', Date.now())
    const app = await buildServer({ config, db })
    const ok = await app.inject({ method: 'POST', url: '/api/pair', payload: { code } })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.device_id).toMatch(/^dev_/)
    expect(body.device_token).toMatch(/^dbz_c_/)
    expect(body.hub_name).toBe('Dashboardz')
    const again = await app.inject({ method: 'POST', url: '/api/pair', payload: { code } })
    expect(again.statusCode).toBe(400)
    await app.close()
  })
  it('rejects garbage codes', async () => {
    const app = await buildServer({ config, db: openDb(':memory:') })
    expect((await app.inject({ method: 'POST', url: '/api/pair', payload: { code: 'AAAAAA' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/pair', payload: {} })).statusCode).toBe(400)
    await app.close()
  })
})
