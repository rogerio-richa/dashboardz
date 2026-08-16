import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { buildRelay } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { hashToken } from '../src/tokens.js'

/**
 * GET /admin/stats: an operator-only connection census. Registered only when ADMIN_TOKEN is
 * configured (404 rather than 401 when it isn't, so the route's existence isn't advertised),
 * bearer-gated once it is, and must never let a token — plaintext or hashed — reach the body.
 */

let tokensPath: string
function writeTokens(accounts: Record<string, unknown>, tokens: Record<string, unknown>): void {
  writeFileSync(tokensPath, JSON.stringify({ version: 1, accounts, tokens }))
}

let app: Awaited<ReturnType<typeof buildRelay>> | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

function opened(ws: WebSocket): Promise<void> {
  return new Promise((r) => ws.once('open', r))
}
function next(ws: WebSocket, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms)
    ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())) })
  })
}
async function ready(ws: WebSocket, hello: object): Promise<any> {
  await opened(ws)
  const p = next(ws)
  ws.send(JSON.stringify(hello))
  return p
}

describe('GET /admin/stats', () => {
  it('is 404 when no ADMIN_TOKEN is configured — the endpoint does not advertise itself', async () => {
    app = await buildRelay({ config: loadConfig({}) })
    const res = await app.inject({ method: 'GET', url: '/admin/stats' })
    expect(res.statusCode).toBe(404)
  })

  it('is 401 with a missing or incorrect bearer once ADMIN_TOKEN is set, without throwing on a length mismatch', async () => {
    app = await buildRelay({ config: loadConfig({ ADMIN_TOKEN: 'sekret' }) })
    const noAuth = await app.inject({ method: 'GET', url: '/admin/stats' })
    expect(noAuth.statusCode).toBe(401)
    const wrongAuth = await app.inject({
      method: 'GET', url: '/admin/stats', headers: { authorization: 'Bearer nope' },
    })
    expect(wrongAuth.statusCode).toBe(401)
    // Deliberately a different length than the expected 'Bearer sekret' — the classic
    // timingSafeEqual crash input (mismatched buffer lengths) must still 401, never throw.
    const shortAuth = await app.inject({
      method: 'GET', url: '/admin/stats', headers: { authorization: 'Bearer x' },
    })
    expect(shortAuth.statusCode).toBe(401)
  })

  it('lists a connected account with its hub counted online, zero-fills an idle account, and reports anonymous zeros', async () => {
    tokensPath = join(mkdtempSync(join(tmpdir(), 'relay-stats-')), 'tokens.json')
    writeTokens(
      {
        acc_x: { label: 'alice', maxClients: 2, createdAt: 1 },
        acc_y: { label: 'bob', maxClients: null, createdAt: 2 },
      },
      { [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 } },
    )
    app = await buildRelay({
      config: loadConfig({ TOKENS_PATH: tokensPath, REQUIRE_TOKEN: 'true', ADMIN_TOKEN: 'sekret' }),
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port
    const hub = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_good' })

    const res = await app.inject({
      method: 'GET', url: '/admin/stats', headers: { authorization: 'Bearer sekret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      accounts: [
        { accountId: 'acc_x', label: 'alice', maxClients: 2, hubs: 1, hubsOnline: 1, senders: 0 },
        { accountId: 'acc_y', label: 'bob', maxClients: null, hubs: 0, hubsOnline: 0, senders: 0 },
      ],
      anonymous: { hubs: 0, hubsOnline: 0, senders: 0 },
    })

    hub.close()
  })

  it('still shows a connection attributed to an account deleted from the store, marked "(deleted)"', async () => {
    // The hub connects and is validated/attributed while the account still exists. The account
    // is then removed from the tokens file — but registry.setHubAccount's binding stays live
    // until this hub next reconnects (server.ts's documented blind spot), so the connection must
    // not silently vanish from the census: it's neither a known account nor anonymous.
    tokensPath = join(mkdtempSync(join(tmpdir(), 'relay-stats-')), 'tokens.json')
    writeTokens(
      { acc_x: { label: 'alice', maxClients: 2, createdAt: 1 } },
      { [hashToken('dzr_good')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 } },
    )
    app = await buildRelay({
      config: loadConfig({ TOKENS_PATH: tokensPath, REQUIRE_TOKEN: 'true', ADMIN_TOKEN: 'sekret' }),
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port
    const hub = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret', account_token: 'dzr_good' })

    // Delete the account from the store (same hot-reload idiom tokens.test.ts uses: bump mtime
    // into the future so the next refresh() is guaranteed to see it as changed).
    writeTokens({}, {})
    utimesSync(tokensPath, new Date(Date.now() + 1000), new Date(Date.now() + 1000))

    const res = await app.inject({
      method: 'GET', url: '/admin/stats', headers: { authorization: 'Bearer sekret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      accounts: [
        { accountId: 'acc_x', label: '(deleted)', maxClients: 0, hubs: 1, hubsOnline: 1, senders: 0 },
      ],
      anonymous: { hubs: 0, hubsOnline: 0, senders: 0 },
    })

    hub.close()
  })

  it('never returns a token, plaintext or hashed', async () => {
    tokensPath = join(mkdtempSync(join(tmpdir(), 'relay-stats-')), 'tokens.json')
    const plainToken = 'dzr_supersecret'
    writeTokens(
      { acc_x: { label: 'alice', maxClients: null, createdAt: 1 } },
      { [hashToken(plainToken)]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 } },
    )
    app = await buildRelay({ config: loadConfig({ TOKENS_PATH: tokensPath, ADMIN_TOKEN: 'sekret' }) })

    const res = await app.inject({
      method: 'GET', url: '/admin/stats', headers: { authorization: 'Bearer sekret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(plainToken)
    expect(res.body).not.toContain(hashToken(plainToken))
  })
})
