import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { BRAND } from '../src/brand.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance

beforeEach(async () => {
  app = await buildServer({ config, db: openDb(':memory:') })
})

describe('landing page', () => {
  it('answers / with an HTML page pointing at the admin, the device view and the project', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('href="/admin"')
    expect(res.body).toContain('href="/device"')
    expect(res.body).toContain(BRAND.url)
    expect(res.body).not.toContain('No page here')
  })

  it('answers an unknown path with the same links and a 404 that says so', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { accept: 'text/html' } })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('href="/admin"')
    expect(res.body).toContain('No page here')
  })

  it('keeps JSON 404s for clients that do not ask for HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: { accept: 'application/json' } })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toMatchObject({ statusCode: 404 })
  })
})
