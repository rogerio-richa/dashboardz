import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode, assignScreen, setDeviceTabs } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'
import type { RelayClient } from '../src/relay/client.js'
import type { RelayManager } from '../src/relay/manager.js'
import { open, seal } from '../src/relay/envelope.js'
import { handleRelayDeliver } from '../src/relay/handler.js'
import { activeWireAlertsForDevice, getReplyTo } from '../src/db/alerts.js'
import { runSweep } from '../src/ttl.js'
import { createFeed, getFeed, recentRows } from '../src/db/feeds.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

let app: FastifyInstance
let token: string
let senderId: string
let dev: string
let devOther: string
let deviceToken: string
let otherToken: string
let wsUrl: string
let client: { sendReply: ReturnType<typeof vi.fn> }

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws)); ws.on('error', reject)
  })
}
function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
}
// HELLO triggers STATE then the initial DATA snapshot synchronously, back to back — if both land
// in the same underlying TCP read, chaining two `nextMessage` calls can race (see hub/test/ws.test.ts).
// Collecting both `n` messages off ONE listener sidesteps that entirely.
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
function noMessageWithin(ws: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    ws.once('message', () => { clearTimeout(timer); resolve(false) })
  })
}
async function helloed(tok: string): Promise<WebSocket> {
  const ws = await connect()
  ws.send(JSON.stringify({ type: 'HELLO', token: tok }))
  await nextMessage(ws) // STATE
  return ws
}

beforeEach(async () => {
  const db = openDb(':memory:')
  const paired = redeemPairingCode(db, createPairingCode(db, 'bedside', 0).code, 1)!
  dev = paired.device.id; deviceToken = paired.token
  const other = redeemPairingCode(db, createPairingCode(db, 'kitchen', 0).code, 1)!
  devOther = other.device.id; otherToken = other.token
  const snd = createSender(db, 'remote', [dev])
  token = snd.token; senderId = snd.sender.id
  app = await buildServer({ config, db })
  client = { sendReply: vi.fn() }
  // The hub decorates this in startRelay(); a fake stands in so the tests never need a relay.
  app.decorate('relayManager', client as unknown as RelayManager)
  await app.listen({ port: 0 })
  wsUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws/device`
})
afterEach(async () => { await app.close() })

const replyFor = (call: number) => open<any>(token, client.sendReply.mock.calls[call][1])

describe('handleRelayDeliver', () => {
  it('ingests a relayed notify and acknowledges it', () => {
    const payload = seal(token, {
      req_id: 'r_1', op: 'notify',
      title: 'From afar', severity: 'warn', options: [{ id: 'ok', label: 'OK' }],
    })
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', payload)

    const wire = activeWireAlertsForDevice(app.db, dev, Date.now())
    expect(wire[0].title).toBe('From afar')
    expect(wire[0].options).toEqual([{ id: 'ok', label: 'OK' }])

    expect(client.sendReply).toHaveBeenCalledWith('conn_1', expect.any(String))
    expect(replyFor(0)).toMatchObject({ req_id: 'r_1', ok: true, alert_id: wire[0].id })
    // The relay only ever carries ciphertext — the ack must not leak the alert id in the clear
    // either, since the relay would otherwise learn a stable per-alert correlator.
    expect(client.sendReply.mock.calls[0][1]).not.toContain(wire[0].id)
  })

  it('records reply_to so the answer can find its way home', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_9',
      seal(token, { req_id: 'r_2', op: 'notify', title: 'x', severity: 'info' }))
    const id = activeWireAlertsForDevice(app.db, dev, Date.now())[0].id
    expect(getReplyTo(app.db, id)).toEqual({ conn_id: 'conn_9', req_id: 'r_2' })
  })

  it('a locally-posted alert has no reply_to and emits nothing to the relay', async () => {
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${token}` }, payload: { title: 'local', severity: 'info' } })
    const id = activeWireAlertsForDevice(app.db, dev, Date.now())[0].id
    expect(getReplyTo(app.db, id)).toBeNull()
    expect(client.sendReply).not.toHaveBeenCalled()
  })

  it('a locally-posted answerable alert emits nothing to the relay when answered or expired', async () => {
    const ws = await helloed(deviceToken)
    await app.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'local ask', severity: 'warn', ttl_s: 10, options: [{ id: 'yes', label: 'Yes' }] } })
    const add = await nextMessage(ws)
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'yes' }))
    await nextMessage(ws) // ALERT_REMOVE
    expect(client.sendReply).not.toHaveBeenCalled()

    runSweep(app.db, app.registry, Date.now() + 11_000, client as unknown as RelayClient)
    expect(client.sendReply).not.toHaveBeenCalled()
    ws.close()
  })

  it('an unknown sender token is rejected without creating an alert', () => {
    const bogus = 'dbz_s_nobody'
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
      seal(bogus, { req_id: 'r_3', op: 'notify', title: 'x', severity: 'info' }))
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
    // Silent on the wire: replying would let a stranger probe which tokens are valid.
    expect(client.sendReply).not.toHaveBeenCalled()
  })

  it('a validation failure replies with an error rather than staying silent', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_4', op: 'notify',
      title: 'x', severity: 'info', devices: ['dev_nope'],
    }))
    expect(replyFor(0)).toMatchObject({ req_id: 'r_4', ok: false })
    expect(replyFor(0).error).toContain('dev_nope')
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
  })

  it('undecryptable or malformed payloads are dropped without throwing and never answered', () => {
    expect(() => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', 'not-base64!!')
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, { nonsense: true }))
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, [1, 2, 3] as never))
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', '')
    }).not.toThrow()
    expect(client.sendReply).not.toHaveBeenCalled()
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
  })

  it('never logs alert content, on the happy path or the dropped path', () => {
    const seen: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(' ')) }))
    try {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_log', op: 'notify',
        title: 'SECRETTITLE', body: 'SECRETBODY', severity: 'critical',
        options: [{ id: 'ack', label: 'SECRETLABEL' }],
      }))
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal('dbz_s_nobody', {
        req_id: 'r_log2', op: 'notify', title: 'SECRETSTRANGER', severity: 'info',
      }))
    } finally {
      for (const s of spies) s.mockRestore()
    }
    const all = seen.join('\n')
    for (const secret of ['SECRETTITLE', 'SECRETBODY', 'SECRETLABEL', 'SECRETSTRANGER', token]) {
      expect(all).not.toContain(secret)
    }
  })

  it('routes a relayed ask end to end: sealed in, ALERT_ADD out, human taps, sealed answer back', async () => {
    const ws = await helloed(deviceToken)
    const wsOther = await helloed(otherToken)

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_home', seal(token, {
      req_id: 'r_trip', op: 'notify',
      title: 'Meds', severity: 'warn',
      options: [{ id: 'taken', label: 'Taken' }, { id: 'later', label: 'Later' }],
    }))

    const add = await nextMessage(ws)
    expect(add.type).toBe('ALERT_ADD')
    expect(add.alert.title).toBe('Meds')
    expect(add.alert.options).toEqual([{ id: 'taken', label: 'Taken' }, { id: 'later', label: 'Later' }])
    // ...and only to the devices the sender actually targets.
    expect(await noMessageWithin(wsOther, 60)).toBe(true)

    client.sendReply.mockClear()
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'later' }))
    const remove = await nextMessage(ws)
    expect(remove).toEqual({ type: 'ALERT_REMOVE', id: add.alert.id, reason: 'dismissed' })

    expect(client.sendReply).toHaveBeenCalledTimes(1)
    expect(client.sendReply.mock.calls[0][0]).toBe('conn_home')
    const answer = replyFor(0)
    expect(answer).toMatchObject({ req_id: 'r_trip', event: 'answer', option_id: 'later', device_id: dev })
    expect(typeof answer.at).toBe('number')

    ws.close(); wsOther.close()
  })

  it('the first requester owns the reply channel — a dedup update does not steal reply_to', async () => {
    const ws = await helloed(deviceToken)
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_first', seal(token, {
      req_id: 'r_first', op: 'notify', title: 'Disk 91%', severity: 'warn',
      dedup_key: 'disk', options: [{ id: 'ack', label: 'Ack' }],
    }))
    const first = await nextMessage(ws)

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_second', seal(token, {
      req_id: 'r_second', op: 'notify', title: 'Disk 97%', severity: 'critical',
      dedup_key: 'disk', options: [{ id: 'ack', label: 'Ack' }],
    }))
    const second = await nextMessage(ws)
    expect(second.alert.id).toBe(first.alert.id)          // same alert, updated
    expect(second.alert.title).toBe('Disk 97%')

    expect(getReplyTo(app.db, first.alert.id)).toEqual({ conn_id: 'conn_first', req_id: 'r_first' })

    client.sendReply.mockClear()
    ws.send(JSON.stringify({ type: 'TAP', id: first.alert.id, action: 'answer', option_id: 'ack' }))
    await nextMessage(ws) // ALERT_REMOVE
    expect(client.sendReply).toHaveBeenCalledTimes(1)
    expect(client.sendReply.mock.calls[0][0]).toBe('conn_first')
    expect(replyFor(0)).toMatchObject({ req_id: 'r_first', event: 'answer', option_id: 'ack' })
    ws.close()
  })

  it('emits exactly one timeout for an expired answerable alert, and none for one without options', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_ask', seal(token, {
      req_id: 'r_ask', op: 'notify', title: 'Meds', severity: 'warn',
      ttl_s: 10, options: [{ id: 'taken', label: 'Taken' }],
    }))
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_tell', seal(token, {
      req_id: 'r_tell', op: 'notify', title: 'FYI', severity: 'info', ttl_s: 10,
    }))
    client.sendReply.mockClear()

    const later = Date.now() + 11_000
    runSweep(app.db, app.registry, later, client as unknown as RelayClient)
    expect(client.sendReply).toHaveBeenCalledTimes(1)
    expect(client.sendReply.mock.calls[0][0]).toBe('conn_ask')
    expect(replyFor(0)).toEqual({ req_id: 'r_ask', event: 'timeout', at: later })

    // A second sweep must not re-fire it: sweepExpired already moved the alert off 'active'.
    runSweep(app.db, app.registry, later + 1000, client as unknown as RelayClient)
    expect(client.sendReply).toHaveBeenCalledTimes(1)
  })

  it('does not emit a timeout for an already-answered alert', async () => {
    const ws = await helloed(deviceToken)
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_ask', seal(token, {
      req_id: 'r_ask', op: 'notify', title: 'Meds', severity: 'warn',
      ttl_s: 10, options: [{ id: 'taken', label: 'Taken' }],
    }))
    const add = await nextMessage(ws)
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'taken' }))
    await nextMessage(ws) // ALERT_REMOVE
    client.sendReply.mockClear()

    runSweep(app.db, app.registry, Date.now() + 11_000, client as unknown as RelayClient)
    expect(client.sendReply).not.toHaveBeenCalled()
    ws.close()
  })

  it('does not follow an answer with a timeout when a second device never concluded the alert', async () => {
    // Two targets, one answers. The alert stays 'active' (the other device never dismissed it)
    // and still expires — but the sender was promised exactly one outcome, and it already got
    // the answer.
    // devOther is deliberately left offline: an undelivered target still holds the alert open.
    const ws = await helloed(deviceToken)
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_two', seal(token, {
      req_id: 'r_two', op: 'notify', title: 'Meds', severity: 'warn',
      devices: [dev, devOther], ttl_s: 10, options: [{ id: 'taken', label: 'Taken' }],
    }))
    const add = await nextMessage(ws)

    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'taken' }))
    await nextMessage(ws) // ALERT_REMOVE
    expect(client.sendReply).toHaveBeenCalledTimes(2)              // ack + answer
    expect(replyFor(1)).toMatchObject({ req_id: 'r_two', event: 'answer', option_id: 'taken' })
    expect(app.db.prepare("SELECT status FROM alerts WHERE id = ?").get(add.alert.id))
      .toEqual({ status: 'active' })                               // genuinely still sweepable

    client.sendReply.mockClear()
    runSweep(app.db, app.registry, Date.now() + 11_000, client as unknown as RelayClient)
    expect(client.sendReply).not.toHaveBeenCalled()
    ws.close()
  })

  it('the relay reply is ciphertext — no plaintext ever reaches the relay socket', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_secret', op: 'notify',
      title: 'PLAINTITLE', body: 'PLAINBODY', severity: 'info',
    }))
    const wire = client.sendReply.mock.calls[0][1] as string
    for (const secret of ['PLAINTITLE', 'PLAINBODY', 'r_secret', token]) {
      expect(wire).not.toContain(secret)
    }
    expect(replyFor(0)).toMatchObject({ req_id: 'r_secret', ok: true })
  })

  it('rejects an unsupported op and a missing title without ingesting', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
      seal(token, { req_id: 'r_op', op: 'launch_missiles', title: 'x', severity: 'info' }))
    expect(replyFor(0)).toMatchObject({ req_id: 'r_op', ok: false })

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
      seal(token, { req_id: 'r_no_title', op: 'notify', severity: 'info' }))
    expect(replyFor(1)).toMatchObject({ req_id: 'r_no_title', ok: false })

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
      seal(token, { req_id: 'r_sev', op: 'notify', title: 'x', severity: 'apocalyptic' }))
    expect(replyFor(2)).toMatchObject({ req_id: 'r_sev', ok: false })

    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
  })

  it('applies the same field limits POST /api/notify does — the relay path skips that schema', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['r_title', { title: 'x'.repeat(201) }],
      ['r_body', { title: 'x', body: 'y'.repeat(1501) }],
      ['r_dedup', { title: 'x', dedup_key: 'd'.repeat(101) }],
      ['r_optid', { title: 'x', options: [{ id: 'Not Lowercase!', label: 'ok' }] }],
      ['r_optidlen', { title: 'x', options: [{ id: 'a'.repeat(33), label: 'ok' }] }],
      ['r_optlabel', { title: 'x', options: [{ id: 'ok', label: 'l'.repeat(25) }] }],
      ['r_optmany', { title: 'x', options: [1, 2, 3, 4, 5].map((n) => ({ id: `o${n}`, label: 'x' })) }],
      ['r_optdupe', { title: 'x', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
      ['r_sound', { title: 'x', sound: 'yes' }],
      ['r_ttl', { title: 'x', ttl_s: 0 }],
      ['r_ttlfrac', { title: 'x', ttl_s: 1.5 }],
      ['r_devices', { title: 'x', devices: [1, 2] }],
    ]
    cases.forEach(([reqId, extra], i) => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
        seal(token, { req_id: reqId, op: 'notify', severity: 'info', ...extra }))
      expect(replyFor(i)).toMatchObject({ req_id: reqId, ok: false })
    })
    expect(client.sendReply).toHaveBeenCalledTimes(cases.length)
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
  })

  it('drops a frame with no usable req_id without replying', () => {
    for (const req_id of [undefined, 42, '', 'r'.repeat(129)]) {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
        seal(token, { req_id, op: 'notify', title: 'x', severity: 'info' }))
    }
    expect(client.sendReply).not.toHaveBeenCalled()
    // ...and nothing gets written, so an oversized correlator cannot be persisted in reply_to.
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)

    // The boundary itself is still accepted.
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1',
      seal(token, { req_id: 'r'.repeat(128), op: 'notify', title: 'x', severity: 'info' }))
    expect(replyFor(0)).toMatchObject({ req_id: 'r'.repeat(128), ok: true })
  })

  it('drops a frame with an unusable conn_id without replying, logging it, or persisting it', () => {
    // conn_id is chosen by the RELAY, the one party the design does not trust, and needs no key:
    // replaying one captured valid ciphertext with a chosen conn_id is the whole attack.
    const seen: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(' ')) }))
    const huge = 'c'.repeat(2_000_000)
    try {
      for (const connId of [huge, 'c'.repeat(129), '', undefined, 42]) {
        handleRelayDeliver(app, client as unknown as RelayClient, connId as string,
          seal(token, { req_id: 'r_conn', op: 'notify', title: 'x', severity: 'info' }))
      }
      // Not even the undecryptable-drop log may interpolate it — that is a flooding vector too.
      handleRelayDeliver(app, client as unknown as RelayClient, huge, 'not-base64!!')
    } finally {
      for (const s of spies) s.mockRestore()
    }
    expect(client.sendReply).not.toHaveBeenCalled()
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
    expect(seen.join('\n')).not.toContain('cccc')
    // Nothing at all was written, so alerts.reply_to cannot be holding a 2 MB blob.
    expect(app.db.prepare('SELECT COUNT(*) n FROM alerts').get()).toEqual({ n: 0 })

    // The boundary itself is still accepted, and stored whole.
    const ok = 'c'.repeat(128)
    handleRelayDeliver(app, client as unknown as RelayClient, ok,
      seal(token, { req_id: 'r_conn', op: 'notify', title: 'x', severity: 'info' }))
    expect(client.sendReply).toHaveBeenCalledWith(ok, expect.any(String))
    const id = activeWireAlertsForDevice(app.db, dev, Date.now())[0].id
    expect(getReplyTo(app.db, id)).toEqual({ conn_id: ok, req_id: 'r_conn' })
  })

  it('attributes a frame by the key that opened it, ignoring any identity claimed inside it', () => {
    // design rationale envelope authentication removed `sender_token` from the plaintext because the AEAD open already
    // authenticates. This pins the property that made it removable: a frame sealed with sender
    // A's key is sender A's, whatever the plaintext says — so the field could never have been
    // load-bearing, and re-adding it could never change attribution.
    const victim = createSender(app.db, 'victim', [devOther])
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_claim', op: 'notify', title: 'x', severity: 'info',
      sender_token: victim.token, sender_id: victim.sender.id,   // both ignored
    }))
    const wire = activeWireAlertsForDevice(app.db, dev, Date.now())
    expect(wire).toHaveLength(1)
    expect(wire[0].sender).toEqual({ id: senderId, name: 'remote' })
    // ...and specifically NOT routed to the victim's devices under the victim's identity.
    expect(activeWireAlertsForDevice(app.db, devOther, Date.now())).toHaveLength(0)
    expect(open<any>(victim.token, client.sendReply.mock.calls[0][1])).toBeNull()
  })

  it('a sender with no relay_key (created before the migration) cannot be impersonated and does not crash ingest', () => {
    // Simulate a pre-relay-key migration row: token_hash present, relay_key NULL. Trial decryption must skip it.
    app.db.prepare('UPDATE senders SET relay_key = NULL').run()
    expect(() => handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_legacy', op: 'notify', title: 'x', severity: 'info',
    }))).not.toThrow()
    expect(client.sendReply).not.toHaveBeenCalled()
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
  })

  it('trial decryption picks the sender that actually owns the key, not merely the first one', () => {
    // Two senders with different default devices: attributing the message to the wrong one would
    // both mis-target the alert and stamp the wrong sender on it.
    const second = createSender(app.db, 'second', [devOther])
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(second.token, {
      req_id: 'r_who', op: 'notify', title: 'mine', severity: 'info',
    }))
    expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
    const wire = activeWireAlertsForDevice(app.db, devOther, Date.now())
    expect(wire).toHaveLength(1)
    expect(wire[0].sender).toEqual({ id: second.sender.id, name: 'second' })
    expect(open<any>(second.token, client.sendReply.mock.calls[0][1]))
      .toMatchObject({ req_id: 'r_who', ok: true, alert_id: wire[0].id })
  })

  it('audits the relayed notify and stamps last_used_at, with no alert content in the audit row', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_audit', op: 'notify', title: 'AUDITTITLE', severity: 'info',
    }))
    const row = app.db.prepare("SELECT * FROM audit_log WHERE event = 'notify'").get() as any
    expect(row).toBeDefined()
    expect(row.actor_type).toBe('sender')
    expect(JSON.parse(row.details).via).toBe('relay')
    expect(row.details).not.toContain('AUDITTITLE')
    const snd = app.db.prepare('SELECT last_used_at FROM senders WHERE id = ?')
      .get(row.actor_id) as { last_used_at: number | null }
    expect(snd.last_used_at).not.toBeNull()
  })

  it('data op pushes a value feed and replies ok with pushed_at', () => {
    const feed = createFeed(app.db, { name: 'cpu', mode: 'value' }, Date.now())
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_data1', op: 'data', feed_id: feed.id, payload: { cpu: 42 },
    }))
    expect(replyFor(0)).toMatchObject({ req_id: 'r_data1', ok: true })
    expect(typeof replyFor(0).pushed_at).toBe('number')
    expect(JSON.parse(getFeed(app.db, feed.id)!.payload!)).toEqual({ cpu: 42 })
  })

  it('data op appends to a stream feed', () => {
    const feed = createFeed(app.db, { name: 'log', mode: 'stream', cap: 3 }, Date.now())
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_data2', op: 'data', feed_id: feed.id, payload: { n: 1 },
    }))
    expect(replyFor(0)).toMatchObject({ req_id: 'r_data2', ok: true })
    const rows = recentRows(app.db, feed.id, 10)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toEqual({ n: 1 })
  })

  it('touches the sender and fans the push out live via dataPusher.onFeedPush, same as the HTTP route', async () => {
    const feed = createFeed(app.db, { name: 'cpu', mode: 'value' }, Date.now())
    const screen = createScreen(app.db, { name: 'board', orientation: 'landscape', grid: {
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: feed.id, path: 'cpu' } }],
    } }, Date.now())
    assignScreen(app.db, dev, screen.id)

    const ws = await connect()
    ws.send(JSON.stringify({ type: 'HELLO', token: deviceToken }))
    const [state, initialData] = await nextMessages(ws, 2) // STATE, then the initial DATA snapshot
    expect(state.type).toBe('STATE')
    expect(initialData.type).toBe('DATA')

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_touch', op: 'data', feed_id: feed.id, payload: { cpu: 1 },
    }))
    const data = await nextMessage(ws)
    expect(data.type).toBe('DATA')
    expect(data.snapshot).toBeUndefined() // single-feed onFeedPush, not a full snapshot
    expect(data.feeds[feed.id].payload).toEqual({ cpu: 1 })

    const snd = app.db.prepare('SELECT last_used_at FROM senders WHERE id = ?').get(senderId) as { last_used_at: number | null }
    expect(snd.last_used_at).not.toBeNull()
    ws.close()
  })

  it('data op rejects unknown feed / disallowed sender / oversized payload / image feed', () => {
    const restricted = createFeed(app.db, { name: 'locked', mode: 'value', allowed_senders: ['someone_else'] }, Date.now())
    const img = createFeed(app.db, { name: 'pic', mode: 'image' }, Date.now())
    const valueFeed = createFeed(app.db, { name: 'cpu', mode: 'value' }, Date.now())

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_unknown', op: 'data', feed_id: 'feed_nope', payload: { a: 1 },
    }))
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_denied', op: 'data', feed_id: restricted.id, payload: { a: 1 },
    }))
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_big', op: 'data', feed_id: valueFeed.id, payload: { blob: 'x'.repeat(17_000) },
    }))
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_image', op: 'data', feed_id: img.id, payload: { a: 1 },
    }))

    expect(replyFor(0)).toMatchObject({ req_id: 'r_unknown', ok: false, error: 'unknown feed' })
    expect(replyFor(1)).toMatchObject({ req_id: 'r_denied', ok: false, error: 'sender not allowed' })
    expect(replyFor(2)).toMatchObject({ req_id: 'r_big', ok: false, error: 'payload too large' })
    expect(replyFor(3)).toMatchObject({ req_id: 'r_image', ok: false, error: 'image push not supported over relay' })
    // None of the rejected attempts wrote anything.
    expect(getFeed(app.db, valueFeed.id)!.payload).toBeNull()

    // Same audit choice as POST /api/feeds/:id (hub/src/routes/feeds.ts): a push itself is
    // deliberately unaudited, but a denial is an authenticated-but-unauthorized sender doing a
    // real thing, and must leave the same trail over the relay as it does over LAN HTTP.
    const row = app.db.prepare("SELECT * FROM audit_log WHERE event = 'feed_push_denied'").get() as any
    expect(row).toBeDefined()
    expect(row.actor_type).toBe('system')
    expect(row.actor_id).toBe(senderId)
    expect(JSON.parse(row.details)).toEqual({ feed_id: restricted.id })
  })

  it('data op requires a feed_id and a payload key, and caps feed_id length', () => {
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_nofeed', op: 'data', payload: { a: 1 },
    }))
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_nopayload', op: 'data', feed_id: 'feed_x',
    }))
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_toolong', op: 'data', feed_id: 'f'.repeat(65), payload: { a: 1 },
    }))
    expect(replyFor(0)).toMatchObject({ req_id: 'r_nofeed', ok: false, error: 'feed_id is required' })
    expect(replyFor(1)).toMatchObject({ req_id: 'r_nopayload', ok: false, error: 'payload is required' })
    expect(replyFor(2)).toMatchObject({ req_id: 'r_toolong', ok: false, error: 'feed_id must be at most 64 chars' })

    // The boundary itself clears the length check and falls through to the next validation stage
    // (no feed with that id exists) rather than being rejected for its length.
    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_boundary', op: 'data', feed_id: 'f'.repeat(64), payload: { a: 1 },
    }))
    expect(replyFor(3)).toMatchObject({ req_id: 'r_boundary', ok: false, error: 'unknown feed' })
  })

  it('data op still requires a decryptable envelope (garbage stays silent)', () => {
    expect(() => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', 'not-base64!!')
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, { op: 'data' }))
    }).not.toThrow()
    expect(client.sendReply).not.toHaveBeenCalled()
  })

  it('a relayed notify broadcasts TAB_STATUS to online multi-tab devices, same as the HTTP route', () => {
    // The screen the sender's feed lights sits alongside a second tab, and the device is "online"
    // via a spied registry — pushTabStatus only speaks to online multi-tab devices.
    const first = createScreen(app.db, { name: 'first-tab', orientation: 'landscape', grid: { cells: [] } }, Date.now())
    const second = createScreen(app.db, { name: 'second-tab', orientation: 'landscape', grid: { cells: [] } }, Date.now())
    setDeviceTabs(app.db, dev, [{ screen_id: first.id }, { screen_id: second.id }])
    vi.spyOn(app.registry, 'isOnline').mockReturnValue(true)
    const sent: { type?: string }[] = []
    vi.spyOn(app.registry, 'send').mockImplementation(((_id: string, msg: unknown) => {
      sent.push(msg as { type?: string })
    }) as never)

    handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
      req_id: 'r_dot', op: 'notify', title: 'disk filling', severity: 'warn', dedup_key: 'tabs-dot',
    }))

    expect(replyFor(0)).toMatchObject({ req_id: 'r_dot', ok: true })
    expect(sent.some((m) => m.type === 'TAB_STATUS')).toBe(true)
  })

  describe('resolve over the relay', () => {
    it('resolves an active dedup alert: flips status, sends ALERT_REMOVE, acks, audits', () => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_create', op: 'notify', title: 'RAID degraded', severity: 'critical', dedup_key: 'raid-nas01',
      }))
      const alertId = activeWireAlertsForDevice(app.db, dev, Date.now())[0].id
      client.sendReply.mockClear()

      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_2', seal(token, {
        req_id: 'r_resolve', op: 'notify', resolve: true, dedup_key: 'raid-nas01',
      }))

      expect(replyFor(0)).toEqual({ req_id: 'r_resolve', ok: true, resolved: true, alert_id: alertId })
      expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
      expect(app.db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId)).toEqual({ status: 'dismissed' })

      const row = app.db.prepare("SELECT * FROM audit_log WHERE event = 'notify_resolved'").get() as any
      expect(row).toBeDefined()
      expect(JSON.parse(row.details)).toEqual({ alert_id: alertId, dedup_key: 'raid-nas01', via: 'relay' })
    })

    it('resolve of an unknown dedup_key is idempotent: acks resolved false, no ALERT_REMOVE', () => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_never', op: 'notify', resolve: true, dedup_key: 'never-seen',
      }))
      expect(replyFor(0)).toEqual({ req_id: 'r_never', ok: true, resolved: false })
      expect(app.db.prepare("SELECT * FROM audit_log WHERE event = 'notify_resolved'").get()).toBeUndefined()
    })

    it('rejects a resolve with no dedup_key rather than staying silent', () => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_missing', op: 'notify', resolve: true,
      }))
      expect(replyFor(0)).toMatchObject({ req_id: 'r_missing', ok: false })
      expect(activeWireAlertsForDevice(app.db, dev, Date.now())).toHaveLength(0)
    })

    it('rejects a non-boolean resolve', () => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_bad_resolve', op: 'notify', resolve: 'yes', dedup_key: 'k',
      }))
      expect(replyFor(0)).toMatchObject({ req_id: 'r_bad_resolve', ok: false })
    })

    it('resolving the same dedup_key twice is idempotent: the second ack is resolved false', () => {
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_create', op: 'notify', title: 'RAID degraded', severity: 'critical', dedup_key: 'raid-nas01',
      }))
      const alertId = activeWireAlertsForDevice(app.db, dev, Date.now())[0].id
      client.sendReply.mockClear()

      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_2', seal(token, {
        req_id: 'r_first', op: 'notify', resolve: true, dedup_key: 'raid-nas01',
      }))
      expect(replyFor(0)).toEqual({ req_id: 'r_first', ok: true, resolved: true, alert_id: alertId })
      client.sendReply.mockClear()

      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_3', seal(token, {
        req_id: 'r_second', op: 'notify', resolve: true, dedup_key: 'raid-nas01',
      }))
      expect(replyFor(0)).toEqual({ req_id: 'r_second', ok: true, resolved: false })
    })

    it('cannot resolve another sender\'s alert: acks resolved false, and the owner\'s alert stays active', () => {
      // Same shape as "attributes a frame by the key that opened it" above: a resolve is scoped
      // to `sender_id = ?` in resolveAlertByDedupKey, so a second sender's own dedup_key namespace
      // can never collide with — or retract — the first sender's alert, however the caller frames
      // the request.
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_1', seal(token, {
        req_id: 'r_create', op: 'notify', title: 'RAID degraded', severity: 'critical', dedup_key: 'raid-nas01',
      }))
      const alertId = activeWireAlertsForDevice(app.db, dev, Date.now())[0].id
      client.sendReply.mockClear()

      const other = createSender(app.db, 'other', [devOther])
      handleRelayDeliver(app, client as unknown as RelayClient, 'conn_2', seal(other.token, {
        req_id: 'r_steal', op: 'notify', resolve: true, dedup_key: 'raid-nas01',
      }))

      expect(open<any>(other.token, client.sendReply.mock.calls[0][1]))
        .toEqual({ req_id: 'r_steal', ok: true, resolved: false })
      expect(app.db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId)).toEqual({ status: 'active' })
    })
  })
})

/**
 * RELAY_URL unset is a hard global constraint: nothing added by relay ingest may run, and the
 * local LAN answer path must behave exactly as it did before. This block deliberately builds an
 * app with NO relayManager decoration at all — the shape a hub without a relay actually has.
 */
describe('with no relay client attached (RELAY_URL unset)', () => {
  let bare: FastifyInstance
  let bareUrl: string
  let bareDeviceToken: string
  let bareSenderToken: string

  beforeEach(async () => {
    const db = openDb(':memory:')
    const paired = redeemPairingCode(db, createPairingCode(db, 'bedside', 0).code, 1)!
    bareDeviceToken = paired.token
    bareSenderToken = createSender(db, 'local', [paired.device.id]).token
    bare = await buildServer({ config, db })
    await bare.listen({ port: 0 })
    bareUrl = `ws://127.0.0.1:${(bare.server.address() as AddressInfo).port}/ws/device`
  })
  afterEach(async () => { await bare.close() })

  it('answers and TTL sweeps still work, and nothing reaches a relay', async () => {
    expect(bare.relayManager).toBeUndefined()

    const ws = new WebSocket(bareUrl)
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ type: 'HELLO', token: bareDeviceToken }))
    await nextMessage(ws) // STATE

    await bare.inject({ method: 'POST', url: '/api/notify',
      headers: { authorization: `Bearer ${bareSenderToken}` },
      payload: { title: 'local ask', severity: 'warn', ttl_s: 10, options: [{ id: 'yes', label: 'Yes' }] } })
    const add = await nextMessage(ws)
    ws.send(JSON.stringify({ type: 'TAP', id: add.alert.id, action: 'answer', option_id: 'yes' }))
    expect(await nextMessage(ws)).toEqual({ type: 'ALERT_REMOVE', id: add.alert.id, reason: 'dismissed' })

    const d = bare.db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(add.alert.id) as any
    expect(d.answer).toBe('yes')

    // And a sweep with no relay client must not throw.
    expect(() => runSweep(bare.db, bare.registry, Date.now() + 11_000)).not.toThrow()
    ws.close()
  })
})
