import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { format } from 'node:util'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { buildRelay } from '../src/server.js'
// Cross-package imports: relay, hub and the sender client are separate npm packages that share
// this repo but not a dependency graph. The test reaches into their src/ directly; each
// package's own node_modules still resolves its dependencies (bare imports resolve relative to
// the importing file, so hub/src pulls fastify and better-sqlite3 from hub/node_modules). No
// code is copied between packages — the relay stays UNLICENSED, the hub stays AGPL.
import { boot } from '../../hub/src/boot.js'
import { createSecretBox } from '../../hub/src/secrets/box.js'
import { openDb } from '../../hub/src/db/index.js'
import { SenderClient, type AnswerEvent } from '../../clients/sender/src/client.js'

/**
 * End-to-end acceptance for relay v0's five criteria, all in one process:
 *
 *   real relay (ephemeral port)  <—ws—  real hub (real boot() path, :memory: db)
 *              ^                                     ^
 *              |—ws— real SenderClient               |—ws— fake device on /ws/device
 *
 * The sender talks ONLY to the relay URL; every payload that crosses the relay is sealed
 * end-to-end to the hub. What this deliberately does NOT prove: NAT traversal. Everything here
 * shares one loopback interface, so NAT traversal and public-host deployment are outside this test.
 */

// ---------------------------------------------------------------------------------------------
// Criterion 5 needs stdout/stderr captured across the WHOLE run — including boot — so the tap
// is installed at module scope, before anything can log. Both channels are tapped:
//  - process.{stdout,stderr}.write, for anything writing to the streams directly, and
//  - the console methods, because vitest replaces console with an interceptor that bypasses the
//    worker's process streams entirely — a sabotage console.log(title) would otherwise never
//    reach the stream tap and the assertion would be vacuous.
// Everything still passes through to the original sinks, so real output is unaffected.
// ---------------------------------------------------------------------------------------------
const captured: string[] = []
const origStdoutWrite = process.stdout.write.bind(process.stdout)
const origStderrWrite = process.stderr.write.bind(process.stderr)
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  captured.push(String(chunk))
  return (origStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stdout.write
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  captured.push(String(chunk))
  return (origStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stderr.write

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
const origConsole: Partial<Record<(typeof CONSOLE_METHODS)[number], (...a: unknown[]) => void>> = {}
for (const m of CONSOLE_METHODS) {
  const orig = console[m].bind(console)
  origConsole[m] = orig
  console[m] = (...args: unknown[]) => {
    captured.push(format(...args))
    orig(...args)
  }
}

const restoreCapture = () => {
  process.stdout.write = origStdoutWrite
  process.stderr.write = origStderrWrite
  for (const m of CONSOLE_METHODS) console[m] = origConsole[m]!
}

// Sentinel content. Distinctive enough that a match in the captured output can only mean the
// content itself leaked (they appear nowhere else — not in test names, not in ids the hub logs).
const TITLE_ASK = 'e2e-title-zugzwang-carousel-91'
const BODY_ASK = 'e2e-body-heliograph-obsidian-44'
const OPTIONS = [
  { id: 'opt_alpha_e2e', label: 'e2e-lbl-akkordeon' },
  { id: 'opt_bravo_e2e', label: 'e2e-lbl-brotzeit' },
  { id: 'opt_charlie_e2e', label: 'e2e-lbl-cellophan' },
]
const ANSWERED = OPTIONS[1] // the fake device taps the middle option — asserted by exact id
const TITLE_TTL = 'e2e-title-timeout-quintessenz-77'
const TITLE_OFFLINE = 'e2e-title-offline-palimpsest-23'
const FORBIDDEN = [
  TITLE_ASK, BODY_ASK, TITLE_TTL, TITLE_OFFLINE,
  ...OPTIONS.map((o) => o.label),
  ...OPTIONS.map((o) => o.id),
]

describe('relay v0 end-to-end acceptance', () => {
  let relayApp: Awaited<ReturnType<typeof buildRelay>>
  let hubApp: Awaited<ReturnType<typeof boot>>
  let db: ReturnType<typeof openDb>
  let sender: SenderClient
  let device: WebSocket
  let hubUid: string
  let deviceId: string

  // Fake device inbox: resolve-or-queue, so a message can never be lost between awaits.
  const deviceQueue: Record<string, unknown>[] = []
  let deviceResolver: ((msg: Record<string, unknown>) => void) | null = null
  const nextDeviceMsg = () => new Promise<Record<string, unknown>>((r) => {
    const queued = deviceQueue.shift()
    if (queued) r(queued)
    else deviceResolver = r
  })

  // Same pattern for answer/timeout events arriving at the sender.
  const answerQueue: AnswerEvent[] = []
  let answerResolver: ((evt: AnswerEvent) => void) | null = null
  const nextAnswer = () => new Promise<AnswerEvent>((r) => {
    const queued = answerQueue.shift()
    if (queued) r(queued)
    else answerResolver = r
  })

  beforeAll(async () => {
    // Real relay on an ephemeral port — the same buildRelay() src/index.ts boots.
    relayApp = await buildRelay({
      config: { port: 0, trustProxy: false, statePath: null, tokensPath: null, requireToken: false, adminToken: null },
    })
    await relayApp.listen({ port: 0, host: '127.0.0.1' })
    const relayPort = (relayApp.server.address() as AddressInfo).port
    const relayUrl = `ws://127.0.0.1:${relayPort}/ws`

    // Real hub through the REAL boot path (boot() is the literal function index.ts calls; a
    // hand-wired app skipped exactly the ordering bug this branch shipped once). Real sockets,
    // real timers — only the TTL sweep interval is shortened, via boot's own seam.
    db = openDb(':memory:')
    hubApp = await boot(
      { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 },
      db,
      createSecretBox(new Uint8Array(32).fill(41)),
      // FOURTH argument. Until the typecheck gate reached this file, `{ ttlIntervalMs: 25 }` sat in
      // the THIRD slot — the secretBox — so the sweep ran at its 15s default and the seam this
      // comment describes was never engaged. It compiled, and it ran, and it did not do this.
      { ttlIntervalMs: 25 },
    )
    const relayManager = hubApp.relayManager!
    await vi.waitFor(() => { expect(relayManager.status()?.state).toBe('ready') }, { timeout: 5000, interval: 5 })
    hubUid = (db.prepare('SELECT hub_uid FROM relay_identity WHERE id = 1').get() as { hub_uid: string }).hub_uid

    // Provision a device and a sender the way an operator does: through the admin HTTP API.
    const hubPort = (hubApp.server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${hubPort}`
    const login = await fetch(`${base}/admin/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
    })
    expect(login.status).toBe(204)
    const cookie = login.headers.get('set-cookie')!
    const admin = (path: string, body: object) => fetch(`${base}${path}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const { code } = await (await admin('/admin/api/devices/pairing-codes', { name: 'e2e-device' })).json()
    const paired = await (await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    })).json()
    deviceId = paired.device_id
    const created = await (await admin('/admin/api/senders', { name: 'e2e-remote', default_devices: [deviceId] })).json()

    // Fake device: a real websocket on the hub's own /ws/device, authenticated like any device.
    device = new WebSocket(`ws://127.0.0.1:${hubPort}/ws/device`)
    device.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      if (deviceResolver) { const r = deviceResolver; deviceResolver = null; r(msg) }
      else deviceQueue.push(msg)
    })
    await new Promise((r) => device.on('open', r))
    device.send(JSON.stringify({ type: 'HELLO', token: paired.device_token, caps: { kind: 'e2e' } }))
    expect((await nextDeviceMsg()).type).toBe('STATE')

    // The real SenderClient, dialing ONLY the relay — it never learns the hub's address.
    sender = new SenderClient({ relayUrl, hubUid, senderToken: created.token, ackTimeoutMs: 5000 })
    sender.onAnswer((evt) => {
      if (answerResolver) { const r = answerResolver; answerResolver = null; r(evt) }
      else answerQueue.push(evt)
    })
    await sender.connect()
  }, 15000)

  afterAll(async () => {
    sender?.close()
    device?.close()
    await hubApp?.close()
    await relayApp?.close()
    restoreCapture()
  })

  // Shared across criteria 1 and 2: the ack ties the answer back to this exact request.
  let ask: { req_id: string; alert_id: string }

  it('criterion 1: a sender with no route to the hub delivers a notification that reaches the device', async () => {
    const ack = await sender.notify({ title: TITLE_ASK, body: BODY_ASK, severity: 'critical', options: OPTIONS })
    if (!ack.alert_id) throw new Error('notify acked without an alert_id')
    ask = { req_id: ack.req_id, alert_id: ack.alert_id }
    expect(ask.alert_id).toMatch(/^alr_/)

    const add = await nextDeviceMsg() as { type: string; alert: Record<string, unknown> }
    expect(add.type).toBe('ALERT_ADD')
    expect(add.alert.id).toBe(ask.alert_id)
    expect(add.alert.title).toBe(TITLE_ASK)
    expect(add.alert.body).toBe(BODY_ASK)
    expect(add.alert.severity).toBe('critical')
  })

  it('criterion 2: the three options arrive, the device answers one, and the sender gets that exact option_id', async () => {
    // The device saw all three options, verbatim...
    const wire = db.prepare('SELECT options FROM alerts WHERE id = ?').get(ask.alert_id) as { options: string }
    expect(JSON.parse(wire.options)).toEqual(OPTIONS)

    // ...and taps exactly one. (Discrimination: answering any other option must fail below.)
    device.send(JSON.stringify({ type: 'TAP', id: ask.alert_id, action: 'answer', option_id: ANSWERED.id }))

    const evt = await nextAnswer()
    expect(evt).toEqual({
      req_id: ask.req_id, event: 'answer', option_id: ANSWERED.id, device_id: deviceId, at: expect.any(Number),
    })
    // The literal value, so a tandem edit of ANSWERED and the TAP above cannot silently agree.
    expect(evt.option_id).toBe('opt_bravo_e2e')

    // The answered alert leaves the device, like a dismissal.
    expect(await nextDeviceMsg()).toMatchObject({ type: 'ALERT_REMOVE', id: ask.alert_id, reason: 'dismissed' })
  })

  it('criterion 3: a short-TTL alert nobody answers produces a timeout event at the sender', async () => {
    // ttl_s is integer seconds, 1 is its floor — the ~1s wait below is the alert's real TTL
    // elapsing, awaited via the sender's own event, not slept through. The sweep interval is the
    // injected 25ms from boot's seam.
    const ackTtl = await sender.notify({ title: TITLE_TTL, severity: 'warn', ttl_s: 1, options: OPTIONS })
    expect((await nextDeviceMsg()).type).toBe('ALERT_ADD') // it reached the device; nobody answers

    const evt = await nextAnswer()
    expect(evt).toEqual({ req_id: ackTtl.req_id, event: 'timeout', at: expect.any(Number) })

    expect(await nextDeviceMsg()).toMatchObject({ type: 'ALERT_REMOVE', id: ackTtl.alert_id, reason: 'expired' })
  }, 10000)

  it('criterion 4: with the hub relay client stopped, a send fails immediately with hub_offline', async () => {
    // Await the relay actually noticing the hub is gone, instead of sleeping: the relay's own
    // close handler (which detaches the hub from the registry) was registered at connection
    // time, so by the time a listener added *now* fires, the detach has already run. Only the
    // hub's socket closes here — clear() (the manager's stop-and-forget) doesn't touch the
    // sender's connection.
    const closes = [...relayApp.websocketServer.clients]
      .map((c) => new Promise<void>((r) => c.once('close', () => r())))
    hubApp.relayManager!.clear()
    await Promise.race(closes)

    // The exact message proves the path: 'relay error: hub_offline' can only come from the
    // relay's synchronous ERROR frame — the ack-timeout path says 'no ack from the hub'.
    await expect(sender.notify({ title: TITLE_OFFLINE, severity: 'warn' }))
      .rejects.toThrow('relay error: hub_offline')
  })

  it('criterion 5: no title, body, or answer text appeared on stdout/stderr across the whole run', () => {
    const all = captured.join('\n')
    // Positive control first: the tap must have seen real output (the hub's boot line), or the
    // "nothing leaked" assertions below would pass vacuously with a broken capture.
    expect(all).toContain(`relay: connecting as ${hubUid}`)
    for (const secret of FORBIDDEN) {
      expect(all).not.toContain(secret)
    }
  })
})
