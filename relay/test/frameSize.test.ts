import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { buildRelay } from '../src/server.js'
import { loadConfig } from '../src/config.js'

let app: FastifyInstance
let url: string

beforeEach(async () => {
  app = await buildRelay({ config: loadConfig({ PORT: '0' }) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  if (typeof addr === 'string' || addr === null) throw new Error('no port')
  url = `ws://127.0.0.1:${addr.port}/ws`
})
afterEach(async () => { await app.close() })

/** Resolve on the next message, with a timeout so a hang fails loudly instead of stalling. */
function next(ws: WebSocket, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms)
    ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())) })
  })
}
function open(): WebSocket {
  return new WebSocket(url)
}
async function ready(ws: WebSocket, hello: object): Promise<any> {
  await new Promise((r) => ws.once('open', r))
  ws.send(JSON.stringify(hello))
  return next(ws)
}

// Must match MAX_FRAME_BYTES in src/server.ts — the whole point is that ws enforces this
// BEFORE socket.ts buffers and JSON.parses the frame, i.e. before any rate limiter runs.
const CAP = 65536

describe('frame size cap', () => {
  it('terminates a connection sending an over-cap frame — never parsed, never routed, relay stays up', async () => {
    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })
    const hubInbox: unknown[] = []
    hub.on('message', (d) => hubInbox.push(JSON.parse(d.toString())))

    const sender = open()
    await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    const closed = new Promise<number>((r) => sender.once('close', (c) => r(c)))
    // Deliberately a WELL-FORMED SEND just over the cap: were it ever parsed, socket.ts would
    // route it to the hub — the empty hubInbox below proves ws killed the frame first.
    sender.send(JSON.stringify({ type: 'SEND', payload: 'x'.repeat(CAP) }))
    expect(await closed).toBe(1009)   // ws close code: message too big

    // The close already round-tripped, so any DELIVER would have arrived by now: nothing did.
    expect(hubInbox).toEqual([])

    // And the relay is still alive: a fresh connection with a normal frame routes fine.
    const sender2 = open()
    const rm = await ready(sender2, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    sender2.send(JSON.stringify({ type: 'SEND', payload: 'Y2lwaGVy' }))
    expect(await next(hub)).toEqual({ type: 'DELIVER', conn_id: rm.conn_id, payload: 'Y2lwaGVy' })

    hub.close(); sender2.close()
  })

  it('still accepts a frame at exactly the cap (headroom, not a haircut for real envelopes)', async () => {
    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_b', secret: 's3cret' })
    const sender = open()
    await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_b' })

    const overhead = JSON.stringify({ type: 'SEND', payload: '' }).length
    const frame = JSON.stringify({ type: 'SEND', payload: 'x'.repeat(CAP - overhead) })
    expect(Buffer.byteLength(frame)).toBe(CAP)
    sender.send(frame)
    expect((await next(hub)).payload).toHaveLength(CAP - overhead)

    hub.close(); sender.close()
  })
})
