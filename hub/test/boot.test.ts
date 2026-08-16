import { describe, expect, it, vi } from 'vitest'
import { boot } from '../src/boot.js'
import { openDb } from '../src/db/index.js'
import type { RelaySocket } from '../src/relay/client.js'
import type { Config } from '../src/config.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { open, seal } from '../src/relay/envelope.js'
import { createSecretBox } from '../src/secrets/box.js'
import { buildServer } from '../src/server.js'
import { createFeed, getFeed } from '../src/db/feeds.js'
import { createOutput, createSource } from '../src/db/sources.js'
import type { ProviderDefinition } from '../src/sources/provider.js'
import { createDraft, getDraft } from '../src/db/sourceDrafts.js'

/**
 * These tests call `boot()` — the literal function index.ts runs — rather than merely
 * `startRelay()` in isolation. `relayBootstrap.test.ts` proves startRelay() behaves correctly
 * given a correct call order; it can't notice index.ts itself getting that order wrong. This
 * file is what actually pins the real boot sequence: if someone reorders the calls inside
 * boot() (the exact regression that shipped once already — startRelay() after app.listen()),
 * the first test below fails with startRelay's own guard error instead of staying green.
 */
const config = (relayUrl: string | null): Config => ({
  port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl, masterKey: null,
  retentionAlertsDays: 90, retentionAuditDays: 180,
})
const fakeSocket = (): RelaySocket => ({ send: vi.fn(), close: vi.fn() })
const secretBox = createSecretBox(new Uint8Array(32).fill(41))

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

describe('boot', () => {
  it('starts and stops the expiring source-draft sweep with the boot lifecycle', async () => {
    const db = openDb(':memory:')
    const expired = createDraft(db, {
      provider_id: 'test.boot-draft', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Expired boot draft', config: {}, interval_s: 60, expires_at: Date.now() - 1,
      secrets: [], outputs: [],
    }, Date.now() - 10)

    const app = await boot(config(null), db, secretBox, { draftIntervalMs: 5 })
    await vi.waitFor(() => expect(getDraft(db, expired.id)).toBeUndefined(), { timeout: 500, interval: 5 })
    await app.close()

    const afterClose = createDraft(db, {
      provider_id: 'test.boot-draft', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Expired after close', config: {}, interval_s: 60, expires_at: Date.now() - 1,
      secrets: [], outputs: [],
    }, Date.now() - 10)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getDraft(db, afterClose.id)).toBeDefined()
  })

  it('starts a non-blocking source pass with app seams and stops the one runtime on close', async () => {
    const db = openDb(':memory:')
    const source = createSource(db, {
      provider_id: 'test.boot',
      package_id: 'dashboardz.builtin',
      package_version: '1.0.0',
      name: 'Boot source',
      config: {},
      interval_s: 1,
    }, 0)
    const sourceFeed = createFeed(db, { name: 'Boot source feed', mode: 'value' }, 0)
    createOutput(db, {
      source_id: source.id,
      contract_id: 'dashboardz.legacy.value/v1',
      feed_id: sourceFeed.id,
    }, 0)
    // A feed nothing owns. Only the source runtime writes feeds now, so this one staying empty
    // through a full boot, a source pass and a shutdown is what shows there is no second writer —
    // the current schema has no separate writer table to inspect.
    const unowned = createFeed(db, { name: 'Nobody writes this', mode: 'value' }, 0)
    let started = 0
    let release!: () => void
    let providerFetch: typeof fetch | undefined
    const definition: ProviderDefinition = {
      id: 'test.boot',
      package_id: 'dashboardz.builtin',
      package_version: '1.0.0',
      strategy: 'scheduled',
      label: 'Boot test',
      category: 'test',
      recommended: false,
      default_interval_s: 1,
      min_interval_s: 1,
      potential_outputs: [{ contract_id: 'dashboardz.legacy.value/v1', capabilities: [] }],
      setup: [],
      validateSetup: (safeConfig, secrets) => ({
        ok: true,
        config: safeConfig as Record<string, unknown>,
        secrets: secrets as Readonly<Record<string, string>>,
      }),
      async run(_input, ctx) {
        providerFetch = ctx.fetch
        started++
        await new Promise<void>((resolve) => { release = resolve })
        return [{ contract_id: 'dashboardz.legacy.value/v1', result: { mode: 'value', payload: { booted: true } } }]
      },
    }

    const app = await boot(config(null), db, secretBox, {
      sourceProviderFor: (id) => id === definition.id ? definition : undefined,
      sourceClock: () => 0,
      sourceIntervalMs: 100,
    })

    expect(started).toBe(1)
    expect(getFeed(db, sourceFeed.id)!.payload).toBeNull()
    expect(providerFetch).toBe(app.sourceFetch)
    release()
    await vi.waitFor(() => expect(JSON.parse(getFeed(db, sourceFeed.id)!.payload!)).toEqual({ booted: true }), {
      timeout: 500,
      interval: 1,
    })
    db.prepare('UPDATE source_instances SET next_run_at = 0 WHERE id = ?').run(source.id)
    expect(getFeed(db, unowned.id)!.pushed_at).toBeNull()

    await app.close()
    await new Promise((resolve) => setTimeout(resolve, 140))

    expect(started).toBe(1)
    expect(getFeed(db, unowned.id)!.pushed_at).toBeNull()
  })

  it('starts the relay client before the app starts listening, when RELAY_URL is configured', async () => {
    const db = openDb(':memory:')
    const connect = vi.fn(fakeSocket)
    const app = await boot(config('wss://relay.example/ws'), db, secretBox, { connect, schedule: vi.fn() })
    expect(app.relayManager!.status()).not.toBeNull()
    expect(connect).toHaveBeenCalledWith('wss://relay.example/ws')
    expect(app.secretBox).toBe(secretBox)
    await app.close()
  })

  it('never starts a relay client when RELAY_URL is unset', async () => {
    const db = openDb(':memory:')
    const app = await boot(config(null), db, secretBox)
    expect(app.relayManager!.status()).toBeNull()
    expect(db.prepare('SELECT * FROM relay_identity').all()).toEqual([])
    await app.close()
  })

  /**
   * Pins the OTHER wiring seam in boot(): `startTtlSweep` receiving the relay client. Dropping
   * that argument compiled, type-checked and left the whole suite green while relay timeouts
   * silently stopped being delivered in production — the third covered-unit/uncovered-caller
   * bug on this branch and the second one hiding in boot().
   *
   * `TtlSweepOpts.relay` is now a required property, so the literal omission is a compile error.
   * This test covers what typing cannot: a caller that passes `undefined` anyway, or a sweep
   * that stops forwarding what it was given. It drives the real chain end to end —
   * boot -> startTtlSweep -> runSweep -> emitRelayOutcome -> RelayClient.sendReply -> socket —
   * with only the socket and the sweep interval faked.
   */
  it('wires the TTL sweep to the relay: an expired answerable alert reports a timeout upstream', async () => {
    const db = openDb(':memory:')
    const dev = redeemPairingCode(db, createPairingCode(db, 'bedside', 0).code, 1)!.device.id
    const token = createSender(db, 'remote', [dev]).token
    const socket = new DrivableSocket()

    const app = await boot(config('wss://relay.example/ws'), db, secretBox, {
      connect: () => socket, schedule: vi.fn(), ttlIntervalMs: 5,
    })

    socket.onOpen?.()
    socket.onMessage?.(JSON.stringify({ type: 'READY' }))
    socket.onMessage?.(JSON.stringify({
      type: 'DELIVER', conn_id: 'conn_boot',
      payload: seal(token, {
        req_id: 'r_boot', op: 'notify', title: 'Meds', severity: 'warn',
        ttl_s: 60, options: [{ id: 'taken', label: 'Taken' }],
      }),
    }))

    const alertId = (db.prepare('SELECT id FROM alerts').get() as { id: string }).id
    // Backdate the expiry rather than waiting out a real TTL: the sweep, not the clock, is what
    // this test is about.
    db.prepare('UPDATE alerts SET expires_at = ? WHERE id = ?').run(Date.now() - 1, alertId)

    const timeout = await vi.waitFor(() => {
      const replies = socket.frames().filter((f) => f.type === 'REPLY')
      const found = replies
        .map((r) => ({ connId: r.conn_id, body: open<any>(token, r.payload as string) }))
        .find((d) => d.body?.event === 'timeout')
      expect(found).toBeDefined()
      return found!
    }, { timeout: 2000, interval: 5 })

    expect(timeout.body).toMatchObject({ req_id: 'r_boot', event: 'timeout' })
    expect(typeof timeout.body.at).toBe('number')
    expect(timeout.connId).toBe('conn_boot')

    await app.close()
  })

  it('decorates a fail-closed secret box sentinel when direct server assembly omits one', async () => {
    const app = await buildServer({ config: config(null), db: openDb(':memory:') })

    expect(() => app.secretBox.seal('plaintext must not be retained')).toThrow(/unavailable/i)
    expect(() => app.secretBox.open('v1.invalid')).toThrow(/unavailable/i)

    await app.close()
  })
})
