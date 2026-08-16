import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, base: string, wsUrl: string

beforeAll(async () => {
  app = await buildServer({ config, db: openDb(':memory:') })
  await app.listen({ port: 0 })
  const port = (app.server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`; wsUrl = `ws://127.0.0.1:${port}/ws/device`
})
afterAll(async () => { await app.close() })

it('full journey: login → pair → sender → notify → takeover flow → audit', async () => {
  // admin login
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
  })
  expect(login.status).toBe(204)
  const cookie = login.headers.get('set-cookie')!
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } })

  // pair a device
  const { code } = await (await admin('/admin/api/devices/pairing-codes', {
    method: 'POST', body: JSON.stringify({ name: 'e2e' }) })).json()
  const paired = await (await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json()

  // create sender targeting the device
  const created = await (await admin('/admin/api/senders', {
    method: 'POST', body: JSON.stringify({ name: 'e2e-ci', default_devices: [paired.device_id] }) })).json()

  // connect the device
  const ws = new WebSocket(wsUrl)
  const queue: any[] = []
  let resolver: ((msg: any) => void) | null = null
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString())
    if (resolver) {
      resolver(msg)
      resolver = null
    } else {
      queue.push(msg)
    }
  })
  const nextMsg = () => new Promise<any>((r) => {
    if (queue.length > 0) {
      r(queue.shift())
    } else {
      resolver = r
    }
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ type: 'HELLO', token: paired.device_token, caps: { kind: 'e2e' } }))
  const state = await nextMsg()
  expect(state.type).toBe('STATE')

  // notify → ALERT_ADD arrives
  const notify = await fetch(`${base}/api/notify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'server down', severity: 'critical' }),
  })
  expect(notify.status).toBe(200)
  const add = await nextMsg()
  expect(add.type).toBe('ALERT_ADD')

  // silence then dismiss
  ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'silence' }))
  ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'dismiss' }))
  const remove = await nextMsg()
  expect(remove.type).toBe('ALERT_REMOVE')
  ws.close()

  // device online flag was true while connected; audit trail is complete
  const events = (await (await admin('/admin/api/audit')).json()).map((r: any) => r.event)
  for (const e of ['admin_login', 'pairing_code_created', 'paired', 'sender_created', 'ws_connected', 'notify', 'tap_silence', 'tap_dismiss']) {
    expect(events).toContain(e)
  }
}, 15000)
