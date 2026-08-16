import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSecretBox, type SecretBox } from '../src/secrets/box.js'
import { openDb, type DB } from '../src/db/index.js'
import { bumpImageRev, createFeed, getFeed, pushValue, recentRows } from '../src/db/feeds.js'
import {
  createOutput, createSource, deleteSource, getSource, listOutputs, putSourceSecret,
  updateOutput, updateSource,
} from '../src/db/sources.js'
import { SourceError } from '../src/sources/errors.js'
import type { ProducedOutput, ProviderDefinition } from '../src/sources/provider.js'
import { runSourceOnce, type SourceRunDeps } from '../src/sources/run.js'
import { sourceResultHash } from '../src/sources/writeOutputs.js'
import type { ContractId, SourceResult } from '../src/data/contracts.js'

const NOW = 100_000

const weatherCurrent = (temp = 21): Extract<SourceResult, { mode: 'value' }> => ({
  mode: 'value',
  payload: {
    location: { name: 'Porto', timezone: 'Europe/Lisbon' },
    observed_at: NOW,
    current: { temp, condition: { code: 'clear', label: 'Clear' } },
    units: { temp: '°C', wind: 'km/h' },
  },
})

const dailyForecast = (high = 24, count = 5): Extract<SourceResult, { mode: 'value' }> => ({
  mode: 'value',
  payload: {
    location: { name: 'Porto', timezone: 'Europe/Lisbon' },
    units: { temperature: 'C', wind_speed: 'km/h' },
    days: Array.from({ length: count }, (_, index) => ({
      date: `2026-08-${String(index + 5).padStart(2, '0')}`,
      high: high + index,
      low: 15 + index,
      condition: { code: 'clear', label: 'Clear' },
    })),
  },
})

const output = (contract_id: ContractId, result: SourceResult): ProducedOutput => ({ contract_id, result })

function provider(
  id: string,
  contracts: readonly ContractId[],
  run: ProviderDefinition['run'],
): ProviderDefinition {
  return {
    id,
    package_id: 'dashboardz.builtin',
    package_version: '1.0.0',
    strategy: 'scheduled',
    label: id,
    category: 'test',
    recommended: false,
    default_interval_s: 60,
    min_interval_s: 1,
    potential_outputs: contracts.map((contract_id) => ({ contract_id, capabilities: [] })),
    setup: [],
    validateSetup: (config, secrets) => ({
      ok: true,
      config: config as Record<string, unknown>,
      secrets: secrets as Readonly<Record<string, string>>,
    }),
    run,
  }
}

describe('runSourceOnce', () => {
  let db: DB
  let secretBox: SecretBox

  beforeEach(() => {
    db = openDb(':memory:')
    secretBox = createSecretBox(new Uint8Array(32).fill(17))
  })

  afterEach(() => db.close())

  const source = (providerId: string, interval_s = 60) => createSource(db, {
    provider_id: providerId,
    package_id: 'dashboardz.builtin',
    package_version: '1.0.0',
    name: 'Test source',
    config: { marker: 'original' },
    interval_s,
  }, 1_000)

  const sourceOutput = (sourceId: string, contract_id: ContractId, name: string) => {
    const mode = contract_id === 'dashboardz.news.items/v1' || contract_id === 'dashboardz.legacy.stream/v1'
      ? 'stream'
      : contract_id === 'dashboardz.legacy.image/v1' ? 'image' : 'value'
    const feed = createFeed(db, { name, mode, cap: 100, stale_after_s: 180, alert_on_stale: true }, 1_000)
    return { feed, output: createOutput(db, { source_id: sourceId, contract_id, feed_id: feed.id }, 1_000) }
  }

  const deps = (
    definition: ProviderDefinition,
    onFeedPush: (feedId: string) => void = () => {},
    jitter: () => number = () => 0,
  ): SourceRunDeps => ({
    fetch: (async () => { throw new Error('test provider must not use network') }) as typeof fetch,
    secretBox,
    providerFor: (id) => id === definition.id ? definition : undefined,
    onFeedPush,
    jitter,
  })

  it('commits a complete two-output run before announcing either changed feed', async () => {
    const src = source('test.weather')
    db.prepare('UPDATE source_instances SET legacy_connector_id = ? WHERE id = ?').run('legacy-weather', src.id)
    const current = sourceOutput(src.id, 'dashboardz.weather.current/v1', 'Weather')
    const definition = provider('test.weather', [
      'dashboardz.weather.current/v1',
      'dashboardz.weather.daily-forecast/v1',
    ], async () => [
      output('dashboardz.weather.current/v1', weatherCurrent()),
      output('dashboardz.weather.daily-forecast/v1', dailyForecast()),
    ])
    const announcements: Array<{ id: string; state: string; payloads: unknown[] }> = []

    await runSourceOnce(db, src.id, deps(definition, (id) => {
      announcements.push({
        id,
        state: getSource(db, src.id)!.state,
        payloads: listOutputs(db, src.id).map((stored) => JSON.parse(getFeed(db, stored.feed_id)!.payload!)),
      })
    }), NOW)

    const outputs = listOutputs(db, src.id)
    expect(outputs.map((stored) => stored.contract_id)).toEqual([
      'dashboardz.weather.current/v1',
      'dashboardz.weather.daily-forecast/v1',
    ])
    expect(outputs[0]!.feed_id).toBe(current.feed.id)
    const createdDaily = getFeed(db, outputs[1]!.feed_id)!
    expect(createdDaily).toMatchObject({
      mode: 'value', cap: 7, stale_after_s: 180, alert_on_stale: 1,
      allowed_senders: '[]', pushed_at: NOW, pushed_by: src.id,
    })
    expect(JSON.parse(getFeed(db, current.feed.id)!.payload!)).toEqual(weatherCurrent().payload)
    expect(JSON.parse(createdDaily.payload!)).toEqual(dailyForecast().payload)
    expect(outputs.every((stored) => stored.content_hash?.startsWith('sha256:'))).toBe(true)
    expect(outputs.every((stored) => stored.last_valid_at === NOW)).toBe(true)
    expect(getSource(db, src.id)).toMatchObject({
      state: 'healthy', failure_count: 0, last_run_at: NOW, last_success_at: NOW,
      last_status: 'Connection refreshed successfully.', next_run_at: NOW + 60_000, rev: src.rev,
    })
    expect(announcements.map((entry) => entry.id)).toEqual([current.feed.id, createdDaily.id])
    expect(announcements.every((entry) => entry.state === 'healthy' && entry.payloads.length === 2)).toBe(true)
  })

  it.each([
    {
      name: 'a missing declared result',
      produced: [output('dashboardz.weather.current/v1', weatherCurrent(30))],
    },
    {
      name: 'a duplicate declared result',
      produced: [
        output('dashboardz.weather.current/v1', weatherCurrent(30)),
        output('dashboardz.weather.daily-forecast/v1', dailyForecast(30)),
        output('dashboardz.weather.daily-forecast/v1', dailyForecast(31)),
      ],
    },
    {
      name: 'contract-invalid daily data',
      produced: [
        output('dashboardz.weather.current/v1', weatherCurrent(30)),
        output('dashboardz.weather.daily-forecast/v1', dailyForecast(30, 4)),
      ],
    },
  ])('preserves every sibling output and records invalid_output for $name', async ({ produced }) => {
    const src = source('test.invalid')
    const current = sourceOutput(src.id, 'dashboardz.weather.current/v1', 'Prior current')
    const daily = sourceOutput(src.id, 'dashboardz.weather.daily-forecast/v1', 'Prior daily')
    pushValue(db, current.feed.id, weatherCurrent(10).payload, src.id, 2_000)
    pushValue(db, daily.feed.id, dailyForecast(20).payload, src.id, 2_000)
    updateOutput(db, current.output.id, { capabilities: ['weather.current'], content_hash: 'old-current', last_valid_at: 2_000 })
    updateOutput(db, daily.output.id, { capabilities: ['weather.daily.entries.5'], content_hash: 'old-daily', last_valid_at: 2_000 })
    const beforeFeeds = db.prepare('SELECT id, payload, pushed_at, pushed_by FROM feeds WHERE id IN (?, ?) ORDER BY id')
      .all(current.feed.id, daily.feed.id)
    const beforeOutputs = db.prepare('SELECT id, capabilities, content_hash, last_valid_at FROM source_outputs WHERE source_id = ? ORDER BY id')
      .all(src.id)
    const definition = provider('test.invalid', [
      'dashboardz.weather.current/v1',
      'dashboardz.weather.daily-forecast/v1',
    ], async () => produced)
    const pushed = vi.fn()

    await runSourceOnce(db, src.id, deps(definition, pushed), NOW)

    expect(db.prepare('SELECT id, payload, pushed_at, pushed_by FROM feeds WHERE id IN (?, ?) ORDER BY id')
      .all(current.feed.id, daily.feed.id)).toEqual(beforeFeeds)
    expect(db.prepare('SELECT id, capabilities, content_hash, last_valid_at FROM source_outputs WHERE source_id = ? ORDER BY id')
      .all(src.id)).toEqual(beforeOutputs)
    expect(getSource(db, src.id)).toMatchObject({
      state: 'invalid_output', failure_count: 1, last_run_at: NOW, last_success_at: null,
      last_status: 'The provider returned invalid data; check this connection.',
      next_run_at: NOW + 60_000, rev: src.rev,
    })
    expect(pushed).not.toHaveBeenCalled()
  })

  it('rolls back sibling writes and runtime health when SQLite aborts inside the write transaction', async () => {
    const src = source('test.transaction')
    const current = sourceOutput(src.id, 'dashboardz.weather.current/v1', 'Atomic current')
    const daily = sourceOutput(src.id, 'dashboardz.weather.daily-forecast/v1', 'Atomic daily')
    pushValue(db, current.feed.id, weatherCurrent(10).payload, src.id, 2_000)
    pushValue(db, daily.feed.id, dailyForecast(20).payload, src.id, 2_000)
    const beforeFeeds = db.prepare('SELECT id, payload, pushed_at, pushed_by FROM feeds WHERE id IN (?, ?) ORDER BY id')
      .all(current.feed.id, daily.feed.id)
    const beforeSource = getSource(db, src.id)
    db.exec(`CREATE TRIGGER abort_daily_write BEFORE UPDATE ON feeds WHEN OLD.id = '${daily.feed.id}'
      BEGIN SELECT RAISE(ABORT, 'daily feed write abort'); END`)
    const definition = provider('test.transaction', [
      'dashboardz.weather.current/v1',
      'dashboardz.weather.daily-forecast/v1',
    ], async () => [
      output('dashboardz.weather.current/v1', weatherCurrent(30)),
      output('dashboardz.weather.daily-forecast/v1', dailyForecast(30)),
    ])
    const pushed = vi.fn()

    await expect(runSourceOnce(db, src.id, deps(definition, pushed), NOW)).rejects.toThrow('daily feed write abort')

    expect(db.prepare('SELECT id, payload, pushed_at, pushed_by FROM feeds WHERE id IN (?, ?) ORDER BY id')
      .all(current.feed.id, daily.feed.id)).toEqual(beforeFeeds)
    expect(getSource(db, src.id)).toEqual(beforeSource)
    expect(pushed).not.toHaveBeenCalled()
  })

  it('deduplicates stream rows, touches a quiet successful feed, and announces only appended data', async () => {
    const src = source('test.news')
    const news = sourceOutput(src.id, 'dashboardz.news.items/v1', 'News')
    let rows = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]
    const definition = provider('test.news', ['dashboardz.news.items/v1'], async () => [output(
      'dashboardz.news.items/v1', { mode: 'stream', rows, dedupe_by: 'id' },
    )])
    const pushed: string[] = []

    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW)
    const firstHash = listOutputs(db, src.id)[0]!.content_hash
    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW + 1_000)
    rows = [...rows, { id: 'c', title: 'C' }]
    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW + 2_000)

    expect(recentRows(db, news.feed.id, 10).map((row) => JSON.parse(row.payload).id)).toEqual(['c', 'b', 'a'])
    expect(recentRows(db, news.feed.id, 10).filter((row) => JSON.parse(row.payload).id === 'a')).toHaveLength(1)
    expect(getFeed(db, news.feed.id)!.pushed_at).toBe(NOW + 2_000)
    expect(firstHash).toMatch(/^sha256:/)
    expect(listOutputs(db, src.id)[0]!.content_hash).not.toBe(firstHash)
    expect(pushed).toEqual([news.feed.id, news.feed.id])
  })

  it('canonicalizes object keys so an unchanged value is fresh without a needless announcement', async () => {
    const src = source('test.value')
    const value = sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Canonical value')
    let payload: Record<string, unknown> = { alpha: 1, nested: { beta: 2, gamma: 3 } }
    const definition = provider('test.value', ['dashboardz.legacy.value/v1'], async () => [output(
      'dashboardz.legacy.value/v1', { mode: 'value', payload },
    )])
    const pushed: string[] = []

    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW)
    const firstHash = listOutputs(db, src.id)[0]!.content_hash
    payload = { nested: { gamma: 3, beta: 2 }, alpha: 1 }
    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW + 1_000)

    expect(listOutputs(db, src.id)[0]!.content_hash).toBe(firstHash)
    expect(getFeed(db, value.feed.id)).toMatchObject({ pushed_at: NOW + 1_000, pushed_by: src.id })
    expect(pushed).toEqual([value.feed.id])
  })

  it('distinguishes and announces a JSON payload with an own __proto__ data property', async () => {
    const src = source('test.proto-value')
    const value = sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Prototype-safe value')
    let payload: Record<string, unknown> = {}
    const definition = provider('test.proto-value', ['dashboardz.legacy.value/v1'], async () => [output(
      'dashboardz.legacy.value/v1', { mode: 'value', payload },
    )])
    const pushed: string[] = []

    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW)
    const firstStored = getFeed(db, value.feed.id)!.payload
    const firstHash = listOutputs(db, src.id)[0]!.content_hash
    payload = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>
    expect(Object.hasOwn(payload, '__proto__')).toBe(true)
    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW + 1_000)

    const secondStored = getFeed(db, value.feed.id)!.payload
    const secondHash = listOutputs(db, src.id)[0]!.content_hash
    expect(firstStored).toBe('{}')
    expect(secondStored).toBe('{"__proto__":{"x":1}}')
    expect(secondHash).not.toBe(firstHash)
    expect(pushed).toEqual([value.feed.id, value.feed.id])
  })

  it('retains nested and stream-row own __proto__ properties in canonical hashes', () => {
    const nestedEmpty = JSON.parse('{"nested":{}}') as Record<string, unknown>
    const nestedProto = JSON.parse('{"nested":{"__proto__":{"x":1}}}') as Record<string, unknown>
    const plainRow = JSON.parse('{"id":"row"}') as Record<string, unknown>
    const protoRow = JSON.parse('{"id":"row","__proto__":{"x":1}}') as Record<string, unknown>

    expect(sourceResultHash({ mode: 'value', payload: nestedProto }))
      .not.toBe(sourceResultHash({ mode: 'value', payload: nestedEmpty }))
    expect(sourceResultHash({ mode: 'stream', rows: [protoRow], dedupe_by: 'id' }))
      .not.toBe(sourceResultHash({ mode: 'stream', rows: [plainRow], dedupe_by: 'id' }))
  })

  it('keeps image revisions monotonic and announces only a changed provider revision', async () => {
    const src = source('test.image')
    const image = sourceOutput(src.id, 'dashboardz.legacy.image/v1', 'Provider image')
    for (let revision = 0; revision < 4; revision++) bumpImageRev(db, image.feed.id, src.id, 2_000 + revision)
    let providerRevision = 40
    const definition = provider('test.image', ['dashboardz.legacy.image/v1'], async () => [output(
      'dashboardz.legacy.image/v1', { mode: 'image', image_rev: providerRevision },
    )])
    const pushed: string[] = []

    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW)
    providerRevision = 40
    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW + 1_000)
    providerRevision = 41
    await runSourceOnce(db, src.id, deps(definition, (id) => pushed.push(id)), NOW + 2_000)

    expect(getFeed(db, image.feed.id)).toMatchObject({ image_rev: 6, pushed_at: NOW + 2_000, pushed_by: src.id })
    expect(listOutputs(db, src.id)[0]).toMatchObject({ last_valid_at: NOW + 2_000 })
    expect(pushed).toEqual([image.feed.id, image.feed.id])
  })

  it('opens repository secret handles for the provider without exposing plaintext to persistence', async () => {
    const src = source('test.secret')
    sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Secret value')
    putSourceSecret(db, src.id, 'token', secretBox.seal('top-secret-value'), 2_000)
    let received: Readonly<Record<string, string>> | undefined
    const definition = provider('test.secret', ['dashboardz.legacy.value/v1'], async (input) => {
      received = input.secrets
      return [output('dashboardz.legacy.value/v1', { mode: 'value', payload: { ok: true } })]
    })

    await runSourceOnce(db, src.id, deps(definition), NOW)

    expect(received).toEqual({ token: 'top-secret-value' })
    expect(JSON.stringify(db.prepare('SELECT * FROM source_instances').all())).not.toContain('top-secret-value')
    expect(JSON.stringify(db.prepare('SELECT * FROM source_secrets').all())).not.toContain('top-secret-value')
  })

  it('uses capped exponential backoff and resets failures after a success', async () => {
    const src = source('test.backoff', 60)
    sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Backoff')
    let failure: unknown = new SourceError('unreachable', 'unsafe provider detail')
    const definition = provider('test.backoff', ['dashboardz.legacy.value/v1'], async () => {
      if (failure) throw failure
      return [output('dashboardz.legacy.value/v1', { mode: 'value', payload: { ok: true } })]
    })

    await runSourceOnce(db, src.id, deps(definition), NOW)
    expect(getSource(db, src.id)).toMatchObject({
      state: 'degraded', failure_count: 1, next_run_at: NOW + 60_000,
      last_status: 'The provider could not be reached; retry is scheduled.',
    })
    await runSourceOnce(db, src.id, deps(definition), NOW + 1_000)
    expect(getSource(db, src.id)).toMatchObject({
      state: 'degraded', failure_count: 2, next_run_at: NOW + 1_000 + 120_000,
    })
    db.prepare('UPDATE source_instances SET failure_count = 99 WHERE id = ?').run(src.id)
    await runSourceOnce(db, src.id, deps(definition), NOW + 2_000)
    expect(getSource(db, src.id)!.next_run_at! - (NOW + 2_000)).toBeLessThanOrEqual(24 * 60 * 60 * 1_000)
    failure = null
    await runSourceOnce(db, src.id, deps(definition), NOW + 3_000)
    expect(getSource(db, src.id)).toMatchObject({ state: 'healthy', failure_count: 0, next_run_at: NOW + 63_000 })
  })

  it('honors Retry-After exactly and maps authentication failures to canonical health', async () => {
    const src = source('test.retry')
    sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Retry')
    let error: SourceError = new SourceError('rate_limited', 'unsafe rate detail', NOW + 321_000)
    const definition = provider('test.retry', ['dashboardz.legacy.value/v1'], async () => { throw error })

    await runSourceOnce(db, src.id, deps(definition), NOW)
    expect(getSource(db, src.id)).toMatchObject({
      state: 'rate_limited', next_run_at: NOW + 321_000,
      last_status: 'The provider is rate limiting this connection; retry is scheduled.',
    })

    error = new SourceError('authentication_required', 'token=top-secret-value')
    await runSourceOnce(db, src.id, deps(definition), NOW + 1_000)
    const auth = getSource(db, src.id)!
    expect(auth).toMatchObject({
      state: 'authentication_required',
      last_status: "Authentication is required; update this connection's credentials.",
    })
    expect(JSON.stringify(auth)).not.toContain('top-secret-value')
  })

  it('does not invoke a disabled source', async () => {
    const src = source('test.paused')
    updateSource(db, src.id, { enabled: false }, 2_000)
    const run = vi.fn(async () => [output('dashboardz.legacy.value/v1', { mode: 'value', payload: true })])
    const definition = provider('test.paused', ['dashboardz.legacy.value/v1'], run)

    await runSourceOnce(db, src.id, deps(definition), NOW)

    expect(run).not.toHaveBeenCalled()
    expect(getSource(db, src.id)).toMatchObject({ state: 'paused', next_run_at: null, last_run_at: null })
  })

  it('discards a result when setup changes during the external fetch', async () => {
    const src = source('test.stale-setup')
    const stored = sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Stale setup')
    let release!: (outputs: ProducedOutput[]) => void
    const definition = provider('test.stale-setup', ['dashboardz.legacy.value/v1'], async () =>
      new Promise<ProducedOutput[]>((resolve) => { release = resolve }))

    const running = runSourceOnce(db, src.id, deps(definition), NOW)
    updateSource(db, src.id, { config: { marker: 'new setup' } }, NOW + 1)
    const changed = getSource(db, src.id)!
    release([output('dashboardz.legacy.value/v1', { mode: 'value', payload: { stale: true } })])
    await running

    expect(getFeed(db, stored.feed.id)!.payload).toBeNull()
    expect(getSource(db, src.id)).toEqual(changed)
  })

  it('discards a result when the source is paused during the external fetch', async () => {
    const src = source('test.stale-pause')
    const stored = sourceOutput(src.id, 'dashboardz.legacy.value/v1', 'Stale pause')
    let release!: (outputs: ProducedOutput[]) => void
    const definition = provider('test.stale-pause', ['dashboardz.legacy.value/v1'], async () =>
      new Promise<ProducedOutput[]>((resolve) => { release = resolve }))

    const running = runSourceOnce(db, src.id, deps(definition), NOW)
    updateSource(db, src.id, { enabled: false }, NOW + 1)
    const paused = getSource(db, src.id)!
    release([output('dashboardz.legacy.value/v1', { mode: 'value', payload: { stale: true } })])
    await running

    expect(getFeed(db, stored.feed.id)!.payload).toBeNull()
    expect(getSource(db, src.id)).toEqual(paused)
  })

  it('does not recreate a source deleted during the external fetch', async () => {
    const src = source('test.stale-delete')
    let release!: (outputs: ProducedOutput[]) => void
    const definition = provider('test.stale-delete', ['dashboardz.legacy.value/v1'], async () =>
      new Promise<ProducedOutput[]>((resolve) => { release = resolve }))

    const running = runSourceOnce(db, src.id, deps(definition), NOW)
    expect(deleteSource(db, src.id)).toEqual({ deleted: true, screenNames: [] })
    release([output('dashboardz.legacy.value/v1', { mode: 'value', payload: { stale: true } })])
    await running

    expect(getSource(db, src.id)).toBeUndefined()
    expect(listOutputs(db, src.id)).toEqual([])
  })

  it('redacts unexpected provider failures instead of persisting or throwing their details', async () => {
    const src = source('test.redaction')
    const definition = provider('test.redaction', ['dashboardz.legacy.value/v1'], async () => {
      throw new Error('secret=top-secret-value')
    })

    await runSourceOnce(db, src.id, deps(definition), NOW)

    const stored = getSource(db, src.id)!
    expect(stored).toMatchObject({
      state: 'degraded', last_status: 'The provider failed to return usable data; retry is scheduled.',
    })
    expect(JSON.stringify(stored)).not.toContain('top-secret-value')
  })
})
