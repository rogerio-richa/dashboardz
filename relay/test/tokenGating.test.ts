import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRelaySocket } from '../src/socket.js'
import { Registry } from '../src/registry.js'
import { TokenStore, hashToken } from '../src/tokens.js'
import { CLOSE_RATE_LIMITED, CLOSE_TOKEN_REQUIRED } from '../src/protocol.js'

/**
 * Follows the connection idiom in test/routing.test.ts (real `ws` clients against a relay
 * bound to an ephemeral port), but drives registerRelaySocket directly — like
 * test/registrationAbuse.test.ts — so each test can control `tokens`/`requireToken`.
 */

let tokensPath: string
function writeTokens(accounts: Record<string, unknown>, tokens: Record<string, unknown>): void {
  writeFileSync(tokensPath, JSON.stringify({ version: 1, accounts, tokens }))
}

let app: FastifyInstance
let url: string
let registry: Registry

async function start(opts: { tokens?: TokenStore; requireToken?: boolean } = {}): Promise<void> {
  app = Fastify({ logger: false })
  await app.register(websocket)
  registry = new Registry()
  registerRelaySocket(app, { registry, tokens: opts.tokens, requireToken: opts.requireToken })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (typeof addr === 'string' || addr === null) throw new Error('no port')
  url = `ws://127.0.0.1:${addr.port}/ws`
}

beforeEach(() => {
  tokensPath = join(mkdtempSync(join(tmpdir(), 'relay-gate-')), 'tokens.json')
})
afterEach(async () => { await app.close() })

function open(): WebSocket { return new WebSocket(url) }

function opened(ws: WebSocket): Promise<void> {
  return new Promise((r) => ws.once('open', r))
}

function next(ws: WebSocket, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms)
    ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())) })
  })
}

function closed(ws: WebSocket, ms = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for close')), ms)
    ws.once('close', (c) => { clearTimeout(t); resolve(c) })
  })
}

function closedWithReason(ws: WebSocket, ms = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for close')), ms)
    ws.once('close', (c, r) => { clearTimeout(t); resolve({ code: c, reason: r.toString() }) })
  })
}

async function ready(ws: WebSocket, hello: object): Promise<any> {
  await opened(ws)
  const p = next(ws)
  ws.send(JSON.stringify(hello))
  return p
}

describe('HELLO_HUB token gating', () => {
  it('1. requireToken: HELLO_HUB with no account_token closes 4403 and registers nothing', async () => {
    writeTokens({}, {})
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })
    const hub = open()
    await opened(hub)
    const hubClosed = closed(hub)
    hub.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' }))
    expect(await hubClosed).toBe(CLOSE_TOKEN_REQUIRED)
    expect(registry.isHubOnline('hub_a')).toBe(false)
    expect(registry.hubAccount('hub_a')).toBeNull()
  })

  it('2. requireToken: HELLO_HUB with an unknown token closes 4403', async () => {
    writeTokens({}, {})
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })
    const hub = open()
    await opened(hub)
    const hubClosed = closed(hub)
    hub.send(JSON.stringify({
      type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_nope',
    }))
    expect(await hubClosed).toBe(CLOSE_TOKEN_REQUIRED)
    expect(registry.isHubOnline('hub_a')).toBe(false)
  })

  it('3. requireToken: HELLO_HUB with a valid token gets READY and is attributed to its account', async () => {
    writeTokens({ acc_x: { label: 'x', maxClients: null, createdAt: 1 } }, {
      [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })
    const hub = open()
    const readyMsg = await ready(hub, {
      type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_good',
    })
    expect(readyMsg).toEqual({ type: 'READY' })
    expect(registry.hubAccount('hub_a')).toBe('acc_x')
    expect(registry.counts()).toEqual({
      accounts: { acc_x: { hubs: 1, hubsOnline: 1, senders: 0 } },
      anonymous: { hubs: 0, hubsOnline: 0, senders: 0 },
    })
    hub.close()
  })

  it("4. requireToken=false: HELLO_HUB with no token still gets READY (today's behaviour, unbroken)", async () => {
    await start({ requireToken: false })
    const hub = open()
    const readyMsg = await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })
    expect(readyMsg).toEqual({ type: 'READY' })
    expect(registry.hubAccount('hub_a')).toBeNull()
    expect(registry.counts()).toEqual({
      accounts: {},
      anonymous: { hubs: 1, hubsOnline: 1, senders: 0 },
    })
    hub.close()
  })

  it('5. requireToken=false: HELLO_HUB with an INVALID token closes 4403 (loud during rollout)', async () => {
    writeTokens({}, {})
    await start({ tokens: new TokenStore(tokensPath), requireToken: false })
    const hub = open()
    await opened(hub)
    const hubClosed = closed(hub)
    hub.send(JSON.stringify({
      type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_bad',
    }))
    expect(await hubClosed).toBe(CLOSE_TOKEN_REQUIRED)
    expect(registry.isHubOnline('hub_a')).toBe(false)
  })
})

describe('per-account client cap', () => {
  it('6. maxClients=1: a second HELLO_SENDER for that account is closed; the first stays open', async () => {
    writeTokens({ acc_x: { label: 'x', maxClients: 1, createdAt: 1 } }, {
      [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })

    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_good' })

    const sender1 = open()
    const r1 = await ready(sender1, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    expect(r1.type).toBe('READY')
    expect(registry.counts().accounts.acc_x.senders).toBe(1)

    const sender2 = open()
    await opened(sender2)
    const sender2Closed = closed(sender2)
    sender2.send(JSON.stringify({ type: 'HELLO_SENDER', hub_uid: 'hub_a' }))
    expect(await sender2Closed).toBe(CLOSE_RATE_LIMITED)
    expect(registry.counts().accounts.acc_x.senders).toBe(1)

    // the first sender must still be live and routable
    sender1.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    const delivered = await next(hub)
    expect(delivered.conn_id).toBe(r1.conn_id)

    hub.close(); sender1.close()
  })

  it('7. maxClients=1 is per ACCOUNT: with two hubs under one account, a sender on the second ' +
     "hub is refused while the first hub's sender is live", async () => {
    writeTokens({ acc_x: { label: 'x', maxClients: 1, createdAt: 1 } }, {
      [hashToken('dzr_a')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
      [hashToken('dzr_b')]: { id: 'tk_2', accountId: 'acc_x', createdAt: 2 },
    })
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })

    const hubA = open()
    await ready(hubA, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's1', account_token: 'dzr_a' })
    const hubB = open()
    await ready(hubB, { type: 'HELLO_HUB', hub_uid: 'hub_b', secret: 's2', account_token: 'dzr_b' })
    expect(registry.counts().accounts.acc_x).toEqual({ hubs: 2, hubsOnline: 2, senders: 0 })

    const sender1 = open()
    const r1 = await ready(sender1, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    expect(r1.type).toBe('READY')

    const sender2 = open()
    await opened(sender2)
    const sender2Closed = closed(sender2)
    sender2.send(JSON.stringify({ type: 'HELLO_SENDER', hub_uid: 'hub_b' }))
    expect(await sender2Closed).toBe(CLOSE_RATE_LIMITED)

    expect(registry.counts().accounts.acc_x.senders).toBe(1)

    hubA.close(); hubB.close(); sender1.close()
  })

  it('8. a hub rejected for a bad token does not claim its uid — a later valid-token HELLO_HUB ' +
     'with a DIFFERENT secret for the same uid succeeds', async () => {
    writeTokens({ acc_x: { label: 'x', maxClients: null, createdAt: 1 } }, {
      [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })

    const impostor = open()
    await opened(impostor)
    const impostorClosed = closed(impostor)
    // No account_token at all -> rejected. If TOFU had already claimed hub_shared for this
    // socket's secret, the later registration below (a different secret) would be refused
    // with CLOSE_BAD_SECRET instead of succeeding.
    impostor.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_shared', secret: 'impostor-secret' }))
    expect(await impostorClosed).toBe(CLOSE_TOKEN_REQUIRED)
    expect(registry.isHubOnline('hub_shared')).toBe(false)

    const real = open()
    const readyMsg = await ready(real, {
      type: 'HELLO_HUB', hub_uid: 'hub_shared', secret: 'a-totally-different-secret', account_token: 'dzr_good',
    })
    expect(readyMsg).toEqual({ type: 'READY' })
    expect(registry.hubAccount('hub_shared')).toBe('acc_x')

    real.close()
  })
})

describe('hardening: fail-closed on a gone account, malformed tokens', () => {
  it('an account deleted after attribution fails closed for new senders; the existing sender is unaffected', async () => {
    writeTokens({ acc_x: { label: 'x', maxClients: null, createdAt: 1 } }, {
      [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })

    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_good' })

    const sender1 = open()
    const r1 = await ready(sender1, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    expect(r1.type).toBe('READY')

    // Operator deletes the account (the natural response to abuse). The hub's attribution
    // persists in the registry until it reconnects, but the store no longer knows acc_x —
    // this must fail closed, not collapse back to "unlimited".
    writeTokens({}, {})
    const future = new Date(Date.now() + 1000)
    utimesSync(tokensPath, future, future)

    const sender2 = open()
    await opened(sender2)
    const sender2Closed = closed(sender2)
    sender2.send(JSON.stringify({ type: 'HELLO_SENDER', hub_uid: 'hub_a' }))
    expect(await sender2Closed).toBe(CLOSE_RATE_LIMITED)

    // sender1, already attached before the deletion, must be unaffected
    sender1.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    const delivered = await next(hub)
    expect(delivered.conn_id).toBe(r1.conn_id)

    hub.close(); sender1.close()
  })

  it('a storeless relay presented with a token closes 4403 blaming the relay, not the token', async () => {
    await start({ requireToken: false })   // no tokens store configured at all
    const hub = open()
    await opened(hub)
    const hubClosed = closedWithReason(hub)
    hub.send(JSON.stringify({
      type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_whatever',
    }))
    const { code, reason } = await hubClosed
    expect(code).toBe(CLOSE_TOKEN_REQUIRED)
    expect(reason).toBe('this relay has no account-token store')
  })

  it('maxClients=0 refuses the very first sender for that account', async () => {
    writeTokens({ acc_x: { label: 'x', maxClients: 0, createdAt: 1 } }, {
      [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })
    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_good' })

    const sender = open()
    await opened(sender)
    const senderClosed = closed(sender)
    sender.send(JSON.stringify({ type: 'HELLO_SENDER', hub_uid: 'hub_a' }))
    expect(await senderClosed).toBe(CLOSE_RATE_LIMITED)
    expect(registry.counts().accounts.acc_x.senders).toBe(0)

    hub.close()
  })

  it('a present but non-string account_token is rejected when requireToken is true', async () => {
    writeTokens({}, {})
    await start({ tokens: new TokenStore(tokensPath), requireToken: true })
    const hub = open()
    await opened(hub)
    const hubClosed = closed(hub)
    hub.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's1', account_token: 12345 }))
    expect(await hubClosed).toBe(CLOSE_TOKEN_REQUIRED)
    expect(registry.isHubOnline('hub_a')).toBe(false)
  })

  it('a present but non-string account_token is rejected when requireToken is false, not silently ignored', async () => {
    writeTokens({}, {})
    await start({ tokens: new TokenStore(tokensPath), requireToken: false })
    const hub = open()
    await opened(hub)
    const hubClosed = closed(hub)
    hub.send(JSON.stringify({
      type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's1', account_token: { nested: true },
    }))
    expect(await hubClosed).toBe(CLOSE_TOKEN_REQUIRED)
    expect(registry.isHubOnline('hub_a')).toBe(false)
  })
})
