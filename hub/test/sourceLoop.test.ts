import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContractId } from '../src/data/contracts.js'
import { createFeed, getFeed } from '../src/db/feeds.js'
import { openDb, type DB } from '../src/db/index.js'
import { createOutput, createSource, getSource } from '../src/db/sources.js'
import { createSecretBox } from '../src/secrets/box.js'
import type { ProviderDefinition } from '../src/sources/provider.js'
import { startSourceLoop } from '../src/sources/loop.js'

const provider = (run: ProviderDefinition['run']): ProviderDefinition => ({
  id: 'test.loop',
  package_id: 'dashboardz.builtin',
  package_version: '1.0.0',
  strategy: 'scheduled',
  label: 'Loop test',
  category: 'test',
  recommended: false,
  default_interval_s: 1,
  min_interval_s: 1,
  potential_outputs: [{ contract_id: 'dashboardz.legacy.value/v1', capabilities: [] }],
  setup: [],
  validateSetup: (config, secrets) => ({
    ok: true,
    config: config as Record<string, unknown>,
    secrets: secrets as Readonly<Record<string, string>>,
  }),
  run,
})

describe('startSourceLoop', () => {
  let db: DB

  beforeEach(() => { db = openDb(':memory:') })
  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  const seed = (marker: string, now: number, contractId: ContractId = 'dashboardz.legacy.value/v1') => {
    const source = createSource(db, {
      provider_id: 'test.loop',
      package_id: 'dashboardz.builtin',
      package_version: '1.0.0',
      name: marker,
      config: { marker },
      interval_s: 1,
    }, now)
    const feed = createFeed(db, { name: `Feed ${marker}`, mode: 'value' }, now)
    createOutput(db, { source_id: source.id, contract_id: contractId, feed_id: feed.id }, now)
    return { source, feed }
  }

  const deps = (definition: ProviderDefinition, clock: () => number = () => 0) => ({
    fetch: (async () => { throw new Error('loop test must not use network') }) as typeof fetch,
    secretBox: createSecretBox(new Uint8Array(32).fill(29)),
    providerFor: (id: string) => id === definition.id ? definition : undefined,
    onFeedPush: vi.fn(),
    jitter: () => 0,
    clock,
  })

  it('runs due sources sequentially in deterministic order and continues after a transaction failure', async () => {
    const first = seed('first-fails', 1_000)
    const later = seed('later', 1_001)
    const earlierDue = seed('earlier-due', 1_002)
    db.prepare('UPDATE source_instances SET next_run_at = ? WHERE id = ?').run(500, earlierDue.source.id)
    db.exec(`CREATE TRIGGER abort_first_source BEFORE UPDATE ON feeds WHEN OLD.id = '${first.feed.id}'
      BEGIN SELECT RAISE(ABORT, 'first source write abort'); END`)
    const order: string[] = []
    const definition = provider(async (input) => {
      order.push(String(input.config.marker))
      return [{
        contract_id: 'dashboardz.legacy.value/v1',
        result: { mode: 'value', payload: { marker: input.config.marker } },
      }]
    })
    const injected = deps(definition)
    const loop = startSourceLoop(db, injected, { intervalMs: 60_000 })

    await Promise.resolve()
    await loop.run(2_000)

    expect(order).toEqual(['earlier-due', 'first-fails', 'later'])
    expect(getFeed(db, earlierDue.feed.id)!.payload).toBe(JSON.stringify({ marker: 'earlier-due' }))
    expect(getFeed(db, first.feed.id)!.payload).toBeNull()
    expect(getSource(db, first.source.id)!.last_run_at).toBeNull()
    expect(getFeed(db, later.feed.id)!.payload).toBe(JSON.stringify({ marker: 'later' }))
    expect(getSource(db, later.source.id)!.state).toBe('healthy')
    expect(injected.onFeedPush).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  // The loop runs unattended — no human session and no agent token is behind it — so a source that
  // produces its first output must create that feed's audit trail attributed to 'system', not the
  // 'admin' default that a human-initiated call site would want.
  it('audits the output feed a scheduled run creates as actor_type system', async () => {
    const source = createSource(db, {
      provider_id: 'test.loop', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'first-output', config: {}, interval_s: 1,
    }, 5_000)
    const definition = provider(async () => [{
      contract_id: 'dashboardz.legacy.value/v1',
      result: { mode: 'value', payload: 'first' },
    }])
    const injected = deps(definition)
    const loop = startSourceLoop(db, injected, { intervalMs: 60_000 })

    await Promise.resolve()
    await loop.run(5_000)

    const row = db.prepare("SELECT actor_type FROM audit_log WHERE event = 'feed_created'").get() as
      { actor_type: string } | undefined
    expect(row?.actor_type).toBe('system')
    loop.stop()
  })

  it('starts one immediate pass without waiting for it to finish', async () => {
    const seeded = seed('immediate', 0)
    let started = 0
    let release!: () => void
    const definition = provider(async () => {
      started++
      await new Promise<void>((resolve) => { release = resolve })
      return [{ contract_id: 'dashboardz.legacy.value/v1', result: { mode: 'value', payload: true } }]
    })

    const loop = startSourceLoop(db, deps(definition, () => 0), { intervalMs: 60_000 })

    expect(started).toBe(1)
    loop.stop()
    release()
    await vi.waitFor(() => expect(getSource(db, seeded.source.id)!.last_run_at).toBe(0))
  })

  it('does not overlap immediate and scheduled passes and stop clears later ticks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const seeded = seed('slow', 0)
    let started = 0
    let release!: () => void
    const definition = provider(async () => {
      started++
      await new Promise<void>((resolve) => { release = resolve })
      return [{ contract_id: 'dashboardz.legacy.value/v1', result: { mode: 'value', payload: started } }]
    })
    const loop = startSourceLoop(db, deps(definition, () => Date.now()), { intervalMs: 1_000 })

    expect(started).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(started).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(getFeed(db, seeded.feed.id)!.payload).toBe('1')
    db.prepare('UPDATE source_instances SET next_run_at = 0 WHERE id = ?').run(seeded.source.id)
    loop.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(started).toBe(1)
  })
})
