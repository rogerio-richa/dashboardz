import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { startRelay } from '../src/relay/bootstrap.js'
import type { RelaySocket } from '../src/relay/client.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { open, seal } from '../src/relay/envelope.js'
import { activeWireAlertsForDevice } from '../src/db/alerts.js'

const fakeSocket = (): RelaySocket => ({ send: vi.fn(), close: vi.fn() })

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

/** A socket whose lifecycle callbacks can be driven by hand, so a DELIVER can be injected. */
class DrivableSocket implements RelaySocket {
  sent: string[] = []
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
  send(d: string) { this.sent.push(d) }
  close() { this.onClose?.() }
  ping() { /* no-op */ }
  frames() { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>) }
}

describe('startRelay', () => {
  it('touches nothing when relayUrl is not configured', () => {
    const db = openDb(':memory:')
    const app = Fastify()
    const connect = vi.fn(fakeSocket)

    const manager = startRelay({ config: { relayUrl: null }, db, app, connect })

    expect(manager.status()).toBeNull()
    // Not merely "returned null status" — prove the socket was never dialed...
    expect(connect).not.toHaveBeenCalled()
    // ...and the identity table (which getOrCreateIdentity would populate) stays empty, so
    // an unconfigured hub never even touches relay_identity at boot.
    expect(db.prepare('SELECT * FROM relay_identity').all()).toEqual([])
    expect(app.relayManager).toBeDefined()
  })

  it('starts the client, creates identity, and decorates the app when relayUrl is configured', async () => {
    const db = openDb(':memory:')
    const app = Fastify()
    const connect = vi.fn(fakeSocket)

    // startRelay() must run before the app starts listening — it calls app.decorate(), and
    // Fastify throws FST_ERR_DEC_AFTER_START if a decorator is added post-listen (this is the
    // real boot ordering: hub/src/index.ts must call this before app.listen() or Fastify throws
    // on boot with RELAY_URL set. Doing `app.listen()` for real here — not a bare Fastify()
    // that never starts — is what makes this test able to catch that class of bug.
    const manager = startRelay({
      config: { relayUrl: 'wss://relay.example/ws' }, db, app, connect,
      schedule: vi.fn(),
    })
    await app.listen({ port: 0 })

    expect(manager.status()).not.toBeNull()
    expect(connect).toHaveBeenCalledWith('wss://relay.example/ws')
    expect(app.relayManager).toBe(manager)
    expect(db.prepare('SELECT hub_uid, hub_secret FROM relay_identity WHERE id = 1').get()).toBeDefined()

    await app.close()
  })

  // Pins the ordering constraint in code, not just in comments: a future index.ts regression
  // that calls startRelay() after app.listen() must fail loudly and specifically, rather than
  // crash-looping the whole process on a raw Fastify internal error (FST_ERR_DEC_AFTER_START) —
  // or, worse, silently doing nothing.
  it('throws a clear error instead of crashing raw if called after the app has started listening', async () => {
    const db = openDb(':memory:')
    const app = Fastify()
    const connect = vi.fn(fakeSocket)
    await app.listen({ port: 0 })

    expect(() => startRelay({
      config: { relayUrl: 'wss://relay.example/ws' }, db, app, connect, schedule: vi.fn(),
    })).toThrow(/before app\.listen/i)

    // Fails fast, before doing any work — no half-started state left behind.
    expect(connect).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM relay_identity').all()).toEqual([])

    await app.close()
  })

  /**
   * The client's `onDeliver` seam is the only thing joining a live relay frame to real ingest.
   * `relayHandler.test.ts` calls `handleRelayDeliver` directly, so it cannot notice that wiring
   * being dropped or stubbed back out — this test drives the actual socket callbacks instead:
   * open -> HELLO_HUB, READY, then a DELIVER carrying a sealed notify.
   */
  it('wires onDeliver to real ingest: a DELIVER frame creates an alert and a sealed REPLY goes back', async () => {
    const db = openDb(':memory:')
    const dev = redeemPairingCode(db, createPairingCode(db, 'bedside', 0).code, 1)!.device.id
    const token = createSender(db, 'remote', [dev]).token
    const app = await buildServer({ config, db })
    const socket = new DrivableSocket()

    startRelay({
      config: { relayUrl: 'wss://relay.example/ws' }, db, app,
      connect: () => socket, schedule: vi.fn(),
    })

    socket.onOpen?.()
    expect(socket.frames()[0]).toMatchObject({ type: 'HELLO_HUB' })
    socket.onMessage?.(JSON.stringify({ type: 'READY' }))

    socket.onMessage?.(JSON.stringify({
      type: 'DELIVER', conn_id: 'conn_live',
      payload: seal(token, {
        req_id: 'r_live', op: 'notify', title: 'Wired up', severity: 'warn',
      }),
    }))

    const wire = activeWireAlertsForDevice(db, dev, Date.now())
    expect(wire).toHaveLength(1)
    expect(wire[0].title).toBe('Wired up')

    const replies = socket.frames().filter((f) => f.type === 'REPLY')
    expect(replies).toHaveLength(1)
    expect(replies[0].conn_id).toBe('conn_live')
    expect(open<any>(token, replies[0].payload as string))
      .toMatchObject({ req_id: 'r_live', ok: true, alert_id: wire[0].id })

    await app.close()
  })
})

describe('relay audit wiring', () => {
  class FakeSocket {
    sent: string[] = []
    onOpen?: () => void
    onMessage?: (raw: string) => void
    onClose?: (code?: number) => void
    onPong?: () => void
    send(d: string) { this.sent.push(d) }
    close() { this.onClose?.() }
  }
  const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: 'wss://relay.example/ws', masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

  const boot = async () => {
    const db = openDb(':memory:')
    const app = await buildServer({ config, db })
    const sockets: FakeSocket[] = []
    const pending: (() => void)[] = []
    startRelay({
      config, db, app,
      schedule: (_ms, fn) => { pending.push(fn) },
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    })
    const rows = () => db.prepare(
      "SELECT event, actor_type, actor_id, details FROM audit_log WHERE actor_id = 'relay' ORDER BY id",
    ).all() as Array<{ event: string; actor_type: string; actor_id: string; details: string }>
    return { app, db, sockets, pending, rows }
  }

  it('audits relay_ready once on READY, with the hub uid in details', async () => {
    const { sockets, rows } = await boot()
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ event: 'relay_ready', actor_type: 'system', actor_id: 'relay' })
    expect(JSON.parse(rows()[0].details).hub_uid).toMatch(/^hub_/)
  })

  it('reconnect churn writes zero rows; bad_secret writes one relay_terminal', async () => {
    const { sockets, pending, rows } = await boot()
    // five failed dials — nothing audit-worthy happened yet
    for (let i = 0; i < 5; i++) { sockets[i].onClose?.(); pending.shift()?.() }
    expect(rows()).toHaveLength(0)
    sockets[5].onClose?.(4401)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].event).toBe('relay_terminal')
    expect(JSON.parse(rows()[0].details)).toMatchObject({ code: 'bad_secret' })
  })
})
