import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode, assignScreen } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'
import { createFeed, pushValue } from '../src/db/feeds.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, url: string, deviceToken: string, deviceId: string, senderToken: string

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(url)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws)); ws.on('error', reject)
  })
}
function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
}
// HELLO triggers STATE then DATA synchronously, back to back — if both land in the same
// underlying TCP read, chaining two `nextMessage` calls can race: the second frame can fire (and
// be lost, since nothing is listening yet) before the `await` on the first has a chance to attach
// the next listener. Collecting all `n` messages off ONE listener sidesteps that entirely.
function nextMessages(ws: WebSocket, n: number): Promise<any[]> {
  return new Promise((resolve) => {
    const out: any[] = []
    const onMsg = (d: any) => {
      out.push(JSON.parse(d.toString()))
      if (out.length === n) { ws.off('message', onMsg); resolve(out) }
    }
    ws.on('message', onMsg)
  })
}
// Attaches a persistent 'message' listener BEFORE the action under test and records every frame
// that arrives from that point on, in order. Same non-racy shape as `nextMessages` (one listener,
// no once-chaining) but for proving a negative: "at most/exactly N frames arrived, and they were
// X" — where `nextMessages`'s fixed count doesn't fit because the point IS that nothing further
// should show up.
function collectMessages(ws: WebSocket): { messages: any[] } {
  const collector = { messages: [] as any[] }
  ws.on('message', (d) => collector.messages.push(JSON.parse(d.toString())))
  return collector
}
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
}
// Proves a negative: resolves true if nothing arrives within `ms`, false if a message does.
// Assert that malformed input produces no ALERT_REMOVE (or anything else) — a return-value check
// alone cannot show that, since the handler does not reply to malformed input.
function noMessageWithin(ws: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    ws.once('message', () => { clearTimeout(timer); resolve(false) })
  })
}
const hello = (ws: WebSocket, token: string) =>
  ws.send(JSON.stringify({ type: 'HELLO', token, caps: { kind: 'test', app_version: '0' } }))
// Posts an alert with two options to `deviceToken`'s device and returns the live ALERT_ADD.
// Assumes `ws` has already HELLO'd and consumed its initial STATE.
async function meds(ws: WebSocket): Promise<any> {
  await app.inject({ method: 'POST', url: '/api/notify',
    headers: { authorization: `Bearer ${senderToken}` },
    payload: { title: 'Meds', severity: 'warn',
      options: [{ id: 'taken', label: 'Taken' }, { id: 'later', label: 'Later' }] } })
  return nextMessage(ws)
}

beforeEach(async () => {
  const db = openDb(':memory:')
  const paired = redeemPairingCode(db, createPairingCode(db, 'bedside', 0).code, 1)!
  deviceToken = paired.token; deviceId = paired.device.id
  senderToken = createSender(db, 'CI', [deviceId]).token
  app = await buildServer({ config, db })
  await app.listen({ port: 0 })
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws/device`
})
afterEach(async () => { await app.close() })

describe('/ws/device', () => {
  it('closes 4001 on bad token', async () => {
    const ws = await connect()
    hello(ws, 'dbz_c_bad')
    expect(await closed(ws)).toBe(4001)
  })
  it('sends STATE with active alerts on HELLO', async () => {
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { title: 'hi', severity: 'warn' } })
    const ws = await connect()
    hello(ws, deviceToken)
    const state = await nextMessage(ws)
    expect(state.type).toBe('STATE')
    expect(state.device).toEqual({ id: deviceId, name: 'bedside', orientation: 'landscape', nav_bars: 'respected' })
    expect(state.rev).toBe(1)
    expect(typeof state.server_time).toBe('number')
    expect(state.alerts).toHaveLength(1)
    expect(state.alerts[0].title).toBe('hi')
    ws.close()
  })
  it('pushes ALERT_ADD live and handles ACK + TAP dismiss', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { title: 'live', severity: 'critical' } })
    const add = await nextMessage(ws)
    expect(add.type).toBe('ALERT_ADD')
    expect(add.alert.severity).toBe('critical')

    ws.send(JSON.stringify({ type: 'ACK', id: add.alert.id, stage: 'delivered' }))
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'silence' }))
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'dismiss' }))
    const remove = await nextMessage(ws)
    expect(remove).toEqual({ type: 'ALERT_REMOVE', id: add.alert.id, reason: 'dismissed' })

    await new Promise((r) => setTimeout(r, 20)) // let writes land
    const d = app.db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(add.alert.id) as any
    expect(d.delivered_at).not.toBeNull()
    expect(d.silenced_at).not.toBeNull()
    expect(d.dismissed_at).not.toBeNull()
    ws.close()
  })
  it('reconnect gets fresh STATE (state-sync, no replay)', async () => {
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { title: 'missed me', severity: 'info' } })
    const ws = await connect()
    hello(ws, deviceToken)
    const state = await nextMessage(ws)
    expect(state.alerts.map((a: any) => a.title)).toEqual(['missed me'])
    ws.close()
  })
  it('silence survives a reconnect: STATE re-marks the alert as silenced', async () => {
    const ws1 = await connect()
    hello(ws1, deviceToken)
    await nextMessage(ws1) // STATE
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { title: 'overnight critical', severity: 'critical' } })
    const add = await nextMessage(ws1)
    ws1.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'silence' }))
    await new Promise((r) => setTimeout(r, 20)) // let the silence write land
    ws1.close()

    const ws2 = await connect()
    hello(ws2, deviceToken)
    const state = await nextMessage(ws2)
    expect(state.type).toBe('STATE')
    expect(state.alerts).toHaveLength(1)
    expect(state.alerts[0].id).toBe(add.alert.id)
    expect(state.alerts[0].silenced).toBe(true)
    ws2.close()
  })
  it('HEALTH updates the device row', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws)
    ws.send(JSON.stringify({ type: 'HEALTH', battery: 42, charging: true }))
    await new Promise((r) => setTimeout(r, 20))
    const row = app.db.prepare('SELECT battery, charging FROM devices WHERE id = ?').get(deviceId) as any
    expect(row).toEqual({ battery: 42, charging: 1 })
    ws.close()
  })
  it('ignores a bare JSON null payload without crashing the server', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    ws.send('null')
    ws.send(JSON.stringify({ type: 'HEALTH', battery: 55, charging: false }))
    await new Promise((r) => setTimeout(r, 20))
    const row = app.db.prepare('SELECT battery, charging FROM devices WHERE id = ?').get(deviceId) as any
    expect(row).toEqual({ battery: 55, charging: 0 })
    ws.close()
  })
  it('ignores malformed ACK/TAP (missing fields) without crashing; valid TAP dismiss still round-trips', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { title: 'live2', severity: 'critical' } })
    const add = await nextMessage(ws)

    ws.send(JSON.stringify({ type: 'ACK' })) // missing id/stage
    ws.send(JSON.stringify({ type: 'TAP', id: 'x' })) // missing action
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'dismiss' }))
    const remove = await nextMessage(ws)
    expect(remove).toEqual({ type: 'ALERT_REMOVE', id: add.alert.id, reason: 'dismissed' })
    ws.close()
  })
  it('TAP answer records the answer, sends ALERT_REMOVE, and audits tap_answer', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    const add = await meds(ws)

    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'taken' }))
    const remove = await nextMessage(ws)
    expect(remove).toEqual({ type: 'ALERT_REMOVE', id: add.alert.id, reason: 'dismissed' })

    const d = app.db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(add.alert.id) as any
    expect(d.answer).toBe('taken')
    expect(d.answered_at).not.toBeNull()
    const auditRow = app.db.prepare("SELECT * FROM audit_log WHERE event = 'tap_answer'").get() as any
    expect(auditRow).toBeDefined()
    expect(JSON.parse(auditRow.details)).toEqual({ alert_id: add.alert.id, option_id: 'taken' })
    ws.close()
  })
  it('TAP answer with a missing option_id is ignored: socket stays open, no ALERT_REMOVE, delivery untouched', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    const add = await meds(ws)

    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer' })) // missing option_id
    expect(await noMessageWithin(ws, 50)).toBe(true)
    expect(ws.readyState).toBe(ws.OPEN)
    const d = app.db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(add.alert.id) as any
    expect(d.answer).toBeNull()
    expect(d.answered_at).toBeNull()
    ws.close()
  })
  it('TAP answer with a non-string option_id is ignored: socket stays open, no ALERT_REMOVE, delivery untouched', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    const add = await meds(ws)

    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 42 }))
    expect(await noMessageWithin(ws, 50)).toBe(true)
    expect(ws.readyState).toBe(ws.OPEN)
    const d = app.db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(add.alert.id) as any
    expect(d.answer).toBeNull()
    expect(d.answered_at).toBeNull()
    ws.close()
  })
  it('TAP answer with an option the alert never offered is ignored: socket stays open, no ALERT_REMOVE, delivery untouched', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    const add = await meds(ws)

    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'invented' }))
    expect(await noMessageWithin(ws, 50)).toBe(true)
    expect(ws.readyState).toBe(ws.OPEN)
    const d = app.db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(add.alert.id) as any
    expect(d.answer).toBeNull()
    expect(d.answered_at).toBeNull()
    ws.close()
  })
  it('ignores a repeat HELLO on an already-authenticated socket; connection stays open', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessage(ws) // STATE
    hello(ws, deviceToken) // second HELLO on the same open socket
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.readyState).toBe(ws.OPEN)
    ws.send(JSON.stringify({ type: 'HEALTH', battery: 10, charging: false }))
    await new Promise((r) => setTimeout(r, 20))
    const row = app.db.prepare('SELECT battery, charging FROM devices WHERE id = ?').get(deviceId) as any
    expect(row).toEqual({ battery: 10, charging: 0 })
    ws.close()
  })
  it('STATE_ACK from the device settles rendering state on the pusher', async () => {
    const ws = await connect()
    hello(ws, deviceToken)
    const state = await nextMessage(ws)
    ws.send(JSON.stringify({ type: 'STATE_ACK', rev: state.rev }))
    await new Promise((r) => setTimeout(r, 50))
    expect(app.statePusher.rendering(deviceId)).toEqual({ state: 'ok', acked_screen_id: null, active_screen_id: null })
    ws.close()
  })
  it('a stale socket replaced on reconnect (registry.attach close 4000) does not wipe the new connection ack entry', async () => {
    const ws1 = await connect()
    hello(ws1, deviceToken)
    await nextMessage(ws1) // STATE rev 1

    const ws2 = await connect()
    hello(ws2, deviceToken) // hub replaces ws1's socket; ws1 gets closed 4000 by DeviceRegistry.attach
    const state2 = await nextMessage(ws2) // fresh STATE, rev 2

    // Let the stale socket's own close handler run before we ack — this is the ordering the bug
    // depends on: drop() must not fire for the device just because *a* socket closed.
    expect(await closed(ws1)).toBe(4000)

    ws2.send(JSON.stringify({ type: 'STATE_ACK', rev: state2.rev }))
    await new Promise((r) => setTimeout(r, 50))
    expect(app.statePusher.rendering(deviceId)).toEqual({ state: 'ok', acked_screen_id: null, active_screen_id: null })
    ws2.close()
  })
  it('connect: STATE arrives first, then the DATA snapshot', async () => {
    const feed = createFeed(app.db, { name: 'cpu', mode: 'value' }, Date.now())
    pushValue(app.db, feed.id, { load: 42 }, 'snd_hub', Date.now())
    const screen = createScreen(app.db, { name: 'board', orientation: 'landscape', grid: {
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'load' } }],
    } }, Date.now())
    assignScreen(app.db, deviceId, screen.id)

    const ws = await connect()
    hello(ws, deviceToken)
    const [msg1, msg2] = await nextMessages(ws, 2)
    expect(msg1.type).toBe('STATE')
    expect(msg2.type).toBe('DATA')
    expect(msg2.snapshot).toBe(true)
    expect(msg2.feeds[feed.id].payload).toEqual({ load: 42 })
    ws.close()
  })
  it('a feed push while connected delivers a single-feed DATA', async () => {
    const feed = createFeed(app.db, { name: 'cpu', mode: 'value' }, Date.now())
    const screen = createScreen(app.db, { name: 'board', orientation: 'landscape', grid: {
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'load' } }],
    } }, Date.now())
    assignScreen(app.db, deviceId, screen.id)

    const ws = await connect()
    hello(ws, deviceToken)
    const [state, initialData] = await nextMessages(ws, 2) // STATE, then initial DATA snapshot
    expect(state.type).toBe('STATE')
    expect(initialData.type).toBe('DATA') // never-pushed feed, payload null
    expect(initialData.snapshot).toBe(true)

    await app.inject({ method: 'POST', url: `/api/feeds/${feed.id}`,
      headers: { authorization: `Bearer ${senderToken}` }, payload: { load: 99 } })
    const data = await nextMessage(ws)
    expect(data.type).toBe('DATA')
    expect(data.snapshot).toBeUndefined() // single-feed onFeedPush, not a full snapshot
    expect(Object.keys(data.feeds)).toEqual([feed.id])
    expect(data.feeds[feed.id].payload).toEqual({ load: 99 })
    ws.close()
  })
  it('no DATA ever arrives for a device on the default layout', async () => {
    const ws = await connect()
    // Attached BEFORE hello (unlike the once-chained nextMessage pattern): if production
    // regressed and sent DATA right after STATE, both frames could land in the same TCP read and
    // a once()-per-await reader would lose the second one silently — this collector can't, since
    // it's already listening for whatever comes.
    const collector = collectMessages(ws)
    hello(ws, deviceToken)
    await new Promise((r) => setTimeout(r, 50))
    expect(collector.messages).toHaveLength(1)
    expect(collector.messages[0].type).toBe('STATE')
    ws.close()
  })
  it('deleting a referenced feed while the device is connected sends an empty snapshot (feed missing)', async () => {
    const feed = createFeed(app.db, { name: 'cpu', mode: 'value' }, Date.now())
    pushValue(app.db, feed.id, { load: 1 }, 'snd_hub', Date.now())
    const screen = createScreen(app.db, { name: 'board', orientation: 'landscape', grid: {
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'load' } }],
    } }, Date.now())
    assignScreen(app.db, deviceId, screen.id)

    const ws = await connect()
    hello(ws, deviceToken)
    await nextMessages(ws, 2) // STATE, then the initial DATA snapshot

    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    const cookie = login.headers['set-cookie'] as string
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/feeds/${feed.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)

    const data = await nextMessage(ws)
    expect(data.type).toBe('DATA')
    expect(data.snapshot).toBe(true)
    expect(data.feeds).toEqual({})
    ws.close()
  })
})
