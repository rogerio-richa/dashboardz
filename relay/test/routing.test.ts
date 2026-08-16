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
  const ws = new WebSocket(url)
  return ws
}
async function ready(ws: WebSocket, hello: object): Promise<any> {
  await new Promise((r) => ws.once('open', r))
  ws.send(JSON.stringify(hello))
  return next(ws)
}

describe('routing', () => {
  it('a sender message reaches the hub, and the reply comes back', async () => {
    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })

    const sender = open()
    const readyMsg = await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    expect(readyMsg.type).toBe('READY')
    expect(readyMsg.conn_id).toMatch(/^conn_/)

    sender.send(JSON.stringify({ type: 'SEND', payload: 'Y2lwaGVy' }))
    const delivered = await next(hub)
    expect(delivered).toEqual({ type: 'DELIVER', conn_id: readyMsg.conn_id, payload: 'Y2lwaGVy' })

    hub.send(JSON.stringify({ type: 'REPLY', conn_id: delivered.conn_id, payload: 'YW5zd2Vy' }))
    expect(await next(sender)).toEqual({ type: 'REPLY', payload: 'YW5zd2Vy' })

    hub.close(); sender.close()
  })

  it('sending to an offline hub fails immediately rather than buffering', async () => {
    const sender = open()
    await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_nobody' })
    sender.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    const err = await next(sender)
    expect(err).toEqual({ type: 'ERROR', code: 'hub_offline', message: expect.any(String) })
    sender.close()
  })

  it('a wrong hub secret is refused with 4401', async () => {
    const first = open()
    await ready(first, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })

    const impostor = open()
    await new Promise((r) => impostor.once('open', r))
    const closed = new Promise<number>((r) => impostor.once('close', (c) => r(c)))
    impostor.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 'guess' }))
    expect(await closed).toBe(4401)

    // the real hub must still be routable
    const sender = open()
    const rm = await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    sender.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    expect((await next(first)).conn_id).toBe(rm.conn_id)

    first.close(); sender.close()
  })

  it('a reply to an unknown conn_id is dropped, not fatal', async () => {
    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })
    hub.send(JSON.stringify({ type: 'REPLY', conn_id: 'conn_gone', payload: 'eA==' }))
    // still alive and still routing
    const sender = open()
    const rm = await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    sender.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    expect((await next(hub)).conn_id).toBe(rm.conn_id)
    hub.close(); sender.close()
  })

  it('acting before HELLO is refused', async () => {
    const ws = open()
    await new Promise((r) => ws.once('open', r))
    ws.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    expect((await next(ws)).code).toBe('not_authenticated')
    ws.close()
  })

  it('garbage frames never kill the connection', async () => {
    const hub = open()
    await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })
    hub.send('not json')
    hub.send(JSON.stringify({ type: 'WAT' }))
    hub.send(JSON.stringify(null))
    const sender = open()
    const rm = await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    sender.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    expect((await next(hub)).conn_id).toBe(rm.conn_id)   // survived
    hub.close(); sender.close()
  })

  it('a hub reconnecting while the old socket is still open closes the zombie', async () => {
    const stale = open()
    await ready(stale, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })
    const staleClosed = new Promise<number>((r) => stale.once('close', (c) => r(c)))

    // Same hub_uid, same secret, but the previous socket never closed — a reconnect racing
    // ahead of the old connection's teardown. The relay must not leave `stale` as an
    // unroutable zombie: it should be closed once the fresh registration wins the slot.
    const fresh = open()
    await ready(fresh, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })

    await staleClosed

    // and routing must go to the fresh socket, not into the void
    const sender = open()
    const rm = await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
    sender.send(JSON.stringify({ type: 'SEND', payload: 'eA==' }))
    expect((await next(fresh)).conn_id).toBe(rm.conn_id)

    fresh.close(); sender.close()
  })
})

describe('log hygiene (acceptance criterion 5)', () => {
  it('never writes payload content to stdout or stderr', async () => {
    const seen: string[] = []
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    process.stdout.write = (c: any, ...a: any[]) => { seen.push(String(c)); return so(c, ...a) }
    process.stderr.write = (c: any, ...a: any[]) => { seen.push(String(c)); return se(c, ...a) }
    try {
      const secretish = 'U1VQRVJTRUNSRVRQQVlMT0FE'   // base64 "SUPERSECRETPAYLOAD"
      const hub = open()
      await ready(hub, { type: 'HELLO_HUB', hub_uid: 'hub_a', secret: 's3cret' })
      const sender = open()
      await ready(sender, { type: 'HELLO_SENDER', hub_uid: 'hub_a' })
      sender.send(JSON.stringify({ type: 'SEND', payload: secretish }))
      await next(hub)
      hub.close(); sender.close()
      expect(seen.join('')).not.toContain(secretish)
    } finally {
      process.stdout.write = so
      process.stderr.write = se
    }
  })
})
