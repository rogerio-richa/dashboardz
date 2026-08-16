import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { registerRelaySocket } from '../src/socket.js'

/**
 * SEND is rate-limited per hub_uid, but an attacker
 * who only ever sends HELLO_HUB with a fresh random hub_uid — and never SENDs anything —
 * never touches that limiter, and Registry.registerHub has no eviction. Each such connection
 * grows the hub map by one entry forever. This test drives registerRelaySocket directly (not
 * via buildRelay) so it can set a tight `hubRegistrationsPerMinute`, since production's
 * default is deliberately generous.
 */
let app: FastifyInstance
let url: string

beforeEach(async () => {
  app = Fastify({ logger: false })
  await app.register(websocket)
  registerRelaySocket(app, { hubRegistrationsPerMinute: 1 })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (typeof addr === 'string' || addr === null) throw new Error('no port')
  url = `ws://127.0.0.1:${addr.port}/ws`
})
afterEach(async () => { await app.close() })

function open(): WebSocket {
  return new WebSocket(url)
}

describe('hub registration abuse control', () => {
  it('caps HELLO_HUB attempts per remote address, independent of hub_uid and without ever calling SEND', async () => {
    const first = open()
    await new Promise((r) => first.once('open', r))
    const firstReady = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for READY')), 3000)
      first.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())) })
    })
    first.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_reg_1', secret: 's3cret' }))
    expect(await firstReady).toEqual({ type: 'READY' })

    // Same remote address, a brand-new hub_uid, and no SEND involved at all — exactly the
    // registry-growth attack. It must be refused even though the SEND limiter never saw it.
    const second = open()
    await new Promise((r) => second.once('open', r))
    const secondClosed = new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for close')), 3000)
      second.once('close', (c) => { clearTimeout(t); resolve(c) })
    })
    second.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_reg_2', secret: 's3cret' }))
    expect(await secondClosed).toBe(4429)

    first.close()
  })
})
