import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { createDraft, getDraft } from '../src/db/sourceDrafts.js'
import { getFeed, listFeeds } from '../src/db/feeds.js'
import { getSource, listOutputs, listSourceSecrets } from '../src/db/sources.js'
import { createSecretBox, type SecretBox } from '../src/secrets/box.js'
import type { ContractId, SourceResult } from '../src/data/contracts.js'
import type { ProducedOutput, ProviderDefinition } from '../src/sources/provider.js'
import { wireFeed } from '../src/ws/dataPush.js'
import { sourceResultHash } from '../src/sources/writeOutputs.js'
import {
  expireSourceDrafts,
  materializeSourceDraft,
  promoteSourceDraft,
  removeSourceDraft,
  startDraftSweep,
  testSourceDraft,
  type DraftDeps,
} from '../src/sources/drafts.js'

const NOW = Date.parse('2026-08-05T12:00:00Z')
const weatherFixture = (): Record<string, unknown> => JSON.parse(readFileSync(
  new URL('./fixtures/open-meteo-seven-day.json', import.meta.url), 'utf8',
)) as Record<string, unknown>

const current = (temp = 21): Extract<SourceResult, { mode: 'value' }> => ({
  mode: 'value',
  payload: {
    location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
    observed_at: NOW,
    current: { temp, condition: { code: 'clear', label: 'Clear' } },
    units: { temp: '°C', wind: 'km/h' },
  },
})

const daily = (high = 24, count = 5): Extract<SourceResult, { mode: 'value' }> => ({
  mode: 'value',
  payload: {
    location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
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
    min_interval_s: 10,
    potential_outputs: contracts.map((contract_id) => ({ contract_id, capabilities: [] })),
    setup: [],
    validateSetup: (config, secrets) => ({
      ok: true,
      config: config as Record<string, unknown>,
      secrets: secrets as Readonly<Record<string, string>>,
    }),
    async run(input, ctx) {
      await ctx.fetch('https://provider.example.test/data', { signal: ctx.signal })
      return run(input, ctx)
    },
  }
}

function tableCounts(db: DB) {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  return {
    drafts: count('source_drafts'),
    draftSecrets: count('source_draft_secrets'),
    draftOutputs: count('source_draft_outputs'),
    sources: count('source_instances'),
    secrets: count('source_secrets'),
    outputs: count('source_outputs'),
    feeds: count('feeds'),
  }
}

describe('source draft service', () => {
  let db: DB
  let secretBox: SecretBox

  beforeEach(() => {
    db = openDb(':memory:')
    secretBox = createSecretBox(new Uint8Array(32).fill(29))
  })

  afterEach(() => db.close())

  const deps = (overrides: Partial<DraftDeps> = {}): DraftDeps => ({
    db,
    fetch: (async () => new Response(JSON.stringify(weatherFixture()), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
    secretBox,
    now: NOW,
    ...overrides,
  })

  it('tests a real built-in provider once and stores only canonical validated previews', async () => {
    const calls: string[] = []
    const fetchImpl = (async (request: RequestInfo | URL) => {
      calls.push(String(request))
      return new Response(JSON.stringify(weatherFixture()))
    }) as typeof fetch

    const view = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo',
      name: ' Lisbon weather ',
      config: { name: ' Lisbon ', latitude: '38.72', longitude: -9.14, units: 'metric', ignored: 'raw' },
      secrets: {},
      interval_s: 30,
    }, deps({ fetch: fetchImpl }))

    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!).searchParams.get('forecast_days')).toBe('7')
    expect(view).toMatchObject({
      provider_id: 'dashboardz.open-meteo',
      provider: 'Open-Meteo',
      name: 'Lisbon weather',
      expires_at: NOW + 60 * 60 * 1_000,
    })
    const currentView = view.outputs.find((item) => item.contract_id === 'dashboardz.weather.current/v1')!
    const dailyView = view.outputs.find((item) => item.contract_id === 'dashboardz.weather.daily-forecast/v1')!
    expect(currentView).toMatchObject({
      capabilities: expect.arrayContaining(['attribution', 'weather.current']),
      missing_optional: [],
      preview: { mode: 'value', pushed_at: NOW, stale_after_s: 900 },
    })
    expect(dailyView).toMatchObject({
      capabilities: expect.arrayContaining([
        'weather.daily.entries.7', 'weather.daily.humidity', 'weather.daily.wind',
      ]),
      missing_optional: ['weather.daily.pollen'],
      preview: { mode: 'value', pushed_at: NOW, stale_after_s: 900 },
    })
    expect((dailyView.preview as { payload: { days: unknown[] } }).payload.days).toHaveLength(7)
    expect(JSON.stringify(view)).not.toContain('ignored')
    expect(tableCounts(db)).toEqual({
      drafts: 1, draftSecrets: 0, draftOutputs: 2,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
    expect(getDraft(db, view.id)).toMatchObject({
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' },
      interval_s: 300,
    })
  })

  it('persists declared secrets only as ciphertext and never retains raw provider bodies', async () => {
    const plaintext = 'https://news.example.test/private-feed.xml'
    const rawOnly = 'RAW_PROVIDER_BODY_SENTINEL'
    const xml = `<rss><channel><description>${rawOnly}</description><item>
      <title>Safe normalized title</title><link>https://news.example.test/one</link>
    </item></channel></rss>`

    const view = await testSourceDraft({
      provider_id: 'dashboardz.rss',
      name: 'Private news',
      config: { max_items: 999, ignored: rawOnly },
      secrets: { url: plaintext, undeclared: 'must-not-survive' },
    }, deps({ fetch: (async () => new Response(xml)) as typeof fetch }))

    const stored = getDraft(db, view.id)!
    expect(stored.config).toEqual({ max_items: 100 })
    expect(stored.secrets).toHaveLength(1)
    expect(stored.secrets[0]).toMatchObject({ name: 'url' })
    expect(stored.secrets[0]!.ciphertext).toMatch(/^v1\./)
    expect(secretBox.open(stored.secrets[0]!.ciphertext)).toBe(plaintext)
    const allStoredRows = JSON.stringify([
      ...db.prepare('SELECT * FROM source_drafts').all(),
      ...db.prepare('SELECT * FROM source_draft_secrets').all(),
      ...db.prepare('SELECT * FROM source_draft_outputs').all(),
    ])
    expect(allStoredRows).not.toContain(plaintext)
    expect(allStoredRows).not.toContain('must-not-survive')
    expect(allStoredRows).not.toContain(rawOnly)
    expect(JSON.stringify(view)).not.toContain(plaintext)
    expect(JSON.stringify(view)).not.toContain(stored.secrets[0]!.ciphertext)
    expect(JSON.stringify(view.outputs[0]!.preview)).toContain('Safe normalized title')
  })

  it.each([
    {
      name: 'missing',
      produced: [output('dashboardz.weather.current/v1', current())],
    },
    {
      name: 'duplicate',
      produced: [
        output('dashboardz.weather.current/v1', current()),
        output('dashboardz.weather.daily-forecast/v1', daily()),
        output('dashboardz.weather.daily-forecast/v1', daily(25)),
      ],
    },
    {
      name: 'invalid',
      produced: [
        output('dashboardz.weather.current/v1', current()),
        output('dashboardz.weather.daily-forecast/v1', daily(24, 4)),
      ],
    },
  ])('canonically rejects a $name provider result set without a promotable partial draft', async ({ produced }) => {
    const definition = provider('test.invalid-set', [
      'dashboardz.weather.current/v1', 'dashboardz.weather.daily-forecast/v1',
    ], async () => produced)

    await expect(testSourceDraft({
      provider_id: definition.id, name: 'Invalid', config: {}, secrets: {},
    }, deps({ providerFor: (id) => id === definition.id ? definition : undefined })))
      .rejects.toThrow('The provider returned an invalid output set')

    expect(tableCounts(db)).toEqual({
      drafts: 0, draftSecrets: 0, draftOutputs: 0,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
  })

  it('redacts setup and provider failures and leaves a previously valid draft independent', async () => {
    const good = provider('test.good', ['dashboardz.legacy.value/v1'], async () => [
      output('dashboardz.legacy.value/v1', { mode: 'value', payload: { safe: true } }),
    ])
    const goodView = await testSourceDraft({
      provider_id: good.id, name: 'Good', config: {}, secrets: {},
    }, deps({ providerFor: (id) => id === good.id ? good : undefined }))
    const plaintext = 'TOP-SECRET-INPUT'
    const rawBody = 'PRIVATE-PROVIDER-BODY'
    const bad: ProviderDefinition = {
      ...provider('test.bad', ['dashboardz.legacy.value/v1'], async () => {
        throw new Error(`provider leaked ${rawBody}`)
      }),
      setup: [{ name: 'token', label: 'Token', type: 'text', required: true, secret: true }],
      validateSetup: () => ({ ok: true, config: {}, secrets: { token: plaintext } }),
    }

    const caught = await testSourceDraft({
      provider_id: bad.id, name: 'Bad', config: {}, secrets: { token: plaintext },
    }, deps({ providerFor: (id) => id === bad.id ? bad : undefined })).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Could not test source data')
    expect((caught as Error).message).not.toContain(plaintext)
    expect((caught as Error).message).not.toContain(rawBody)
    expect(getDraft(db, goodView.id)).toBeDefined()
    expect(tableCounts(db).drafts).toBe(1)
  })

  it('enforces exactly one provider fetch and never persists a multi-fetch partial result', async () => {
    const definition = provider('test.multi-fetch', ['dashboardz.legacy.value/v1'], async (_input, ctx) => {
      await ctx.fetch('https://provider.example.test/second', { signal: ctx.signal })
      return [output('dashboardz.legacy.value/v1', { mode: 'value', payload: { unsafe: true } })]
    })
    let networkCalls = 0

    await expect(testSourceDraft({
      provider_id: definition.id, name: 'Too many requests', config: {}, secrets: {},
    }, deps({
      providerFor: (id) => id === definition.id ? definition : undefined,
      fetch: (async () => {
        networkCalls++
        return new Response('{}')
      }) as typeof fetch,
    }))).rejects.toThrow('Could not test source data')

    expect(networkCalls).toBe(1)
    expect(tableCounts(db).drafts).toBe(0)
  })

  it('projects normalized config through non-secret declarations before persistence', async () => {
    const plaintext = 'SECRET-MUST-NOT-BE-CONFIG'
    const definition: ProviderDefinition = {
      ...provider('test.config-boundary', ['dashboardz.legacy.value/v1'], async () => [
        output('dashboardz.legacy.value/v1', { mode: 'value', payload: { safe: true } }),
      ]),
      setup: [
        { name: 'region', label: 'Region', type: 'text', required: true, secret: false },
        { name: 'token', label: 'Token', type: 'text', required: true, secret: true },
      ],
      validateSetup: () => ({
        ok: true,
        config: { region: 'eu', token: plaintext, undeclared: plaintext },
        secrets: { token: plaintext },
      }),
    }

    const view = await testSourceDraft({
      provider_id: definition.id, name: 'Bounded config', config: {}, secrets: { token: plaintext },
    }, deps({ providerFor: (id) => id === definition.id ? definition : undefined }))

    expect(getDraft(db, view.id)!.config).toEqual({ region: 'eu' })
    expect(JSON.stringify(db.prepare('SELECT config FROM source_drafts').all())).not.toContain(plaintext)
  })

  it('isolates persisted setup when a provider tries to mutate declared and undeclared runtime config', async () => {
    const plaintext = 'MUTATED-PLAINTEXT-SENTINEL'
    let runtimeWasFrozen = false
    const definition: ProviderDefinition = {
      ...provider('test.config-mutation', ['dashboardz.legacy.value/v1'], async (input) => {
        runtimeWasFrozen = Object.isFrozen(input.config)
        try { input.config.region = plaintext } catch { /* expected for the frozen runtime snapshot */ }
        try { input.config.undeclared = plaintext } catch { /* expected for the frozen runtime snapshot */ }
        return [output('dashboardz.legacy.value/v1', { mode: 'value', payload: { safe: true } })]
      }),
      setup: [{ name: 'region', label: 'Region', type: 'text', required: true, secret: false }],
      validateSetup: () => ({ ok: true, config: { region: 'eu' }, secrets: {} }),
    }

    const view = await testSourceDraft({
      provider_id: definition.id, name: 'Immutable setup', config: { region: 'eu' }, secrets: {},
    }, deps({ providerFor: (id) => id === definition.id ? definition : undefined }))

    expect(runtimeWasFrozen).toBe(true)
    expect(getDraft(db, view.id)!.config).toEqual({ region: 'eu' })
    expect(JSON.stringify(view)).not.toContain(plaintext)
    expect(JSON.stringify(db.prepare('SELECT * FROM source_drafts WHERE id = ?').all(view.id))).not.toContain(plaintext)
  })

  it('hashes, stores, and previews only the canonical semantic result shape', async () => {
    const plaintext = 'NESTED-PROVIDER-ONLY-PLAINTEXT'
    const canonical = current()
    const dirty = JSON.parse(JSON.stringify(canonical)) as Extract<SourceResult, { mode: 'value' }> & {
      provider_private?: string
    }
    dirty.provider_private = plaintext
    const payload = dirty.payload as Record<string, any>
    payload.provider_private = plaintext
    payload.location.provider_private = plaintext
    payload.current.provider_private = plaintext
    payload.current.condition.provider_private = plaintext
    const definition = provider('test.result-projection', ['dashboardz.weather.current/v1'], async () => [
      output('dashboardz.weather.current/v1', dirty),
    ])

    const view = await testSourceDraft({
      provider_id: definition.id, name: 'Projected weather', config: {}, secrets: {},
    }, deps({ providerFor: (id) => id === definition.id ? definition : undefined }))

    const stored = getDraft(db, view.id)!.outputs[0]!
    expect(stored.result).toEqual(canonical)
    expect(stored.content_hash).toBe(sourceResultHash(canonical))
    expect(JSON.stringify(stored)).not.toContain(plaintext)
    expect(JSON.stringify(view)).not.toContain(plaintext)
    expect(JSON.stringify(db.prepare('SELECT * FROM source_draft_outputs WHERE draft_id = ?').all(view.id)))
      .not.toContain(plaintext)
  })

  it('replaces a superseded draft only after the replacement test succeeds', async () => {
    // Explicitly typed rather than `as const`: `as const` froze `revision` to the literal `1`, so
    // the reassignment below (the whole point of the test — a second, different result) was a type
    // error nothing was checking.
    let result: { mode: 'value'; payload: { revision: number } } = { mode: 'value', payload: { revision: 1 } }
    const definition = provider('test.supersede', ['dashboardz.legacy.value/v1'], async () => [
      output('dashboardz.legacy.value/v1', result),
    ])
    const draftDeps = deps({ providerFor: (id) => id === definition.id ? definition : undefined })
    const first = await testSourceDraft({
      provider_id: definition.id, name: 'First', config: {}, secrets: {},
    }, draftDeps)
    result = { mode: 'value', payload: { revision: 2 } }
    const second = await testSourceDraft({
      provider_id: definition.id, name: 'Second', config: {}, secrets: {}, supersedes: first.id,
    }, draftDeps)

    expect(getDraft(db, first.id)).toBeUndefined()
    expect(getDraft(db, second.id)).toBeDefined()
    expect(tableCounts(db).drafts).toBe(1)

    const failing = provider('test.supersede-fail', ['dashboardz.legacy.value/v1'], async () => {
      throw new Error('unsafe failure')
    })
    await expect(testSourceDraft({
      provider_id: failing.id, name: 'Third', config: {}, secrets: {}, supersedes: second.id,
    }, deps({ providerFor: (id) => id === failing.id ? failing : undefined }))).rejects.toThrow()
    expect(getDraft(db, second.id)).toBeDefined()
  })

  it('supports explicit cancellation, deterministic expiry, and a stoppable sweep', async () => {
    const definition = provider('test.lifecycle', ['dashboardz.legacy.value/v1'], async () => [
      output('dashboardz.legacy.value/v1', { mode: 'value', payload: { ok: true } }),
    ])
    const draftDeps = deps({ providerFor: (id) => id === definition.id ? definition : undefined })
    const cancelled = await testSourceDraft({
      provider_id: definition.id, name: 'Cancelled', config: {}, secrets: {},
    }, draftDeps)
    expect(removeSourceDraft(db, cancelled.id)).toBe(true)
    expect(removeSourceDraft(db, cancelled.id)).toBe(false)

    const first = await testSourceDraft({
      provider_id: definition.id, name: 'First expiry', config: {}, secrets: {},
    }, draftDeps)
    const second = await testSourceDraft({
      provider_id: definition.id, name: 'Second expiry', config: {}, secrets: {},
    }, deps({ now: NOW + 1, providerFor: (id) => id === definition.id ? definition : undefined }))
    expect(expireSourceDrafts(db, first.expires_at - 1)).toBe(0)
    expect(expireSourceDrafts(db, first.expires_at)).toBe(1)
    expect(getDraft(db, first.id)).toBeUndefined()
    expect(getDraft(db, second.id)).toBeDefined()

    const sweep = startDraftSweep(db, { intervalMs: 60_000 })
    expect(sweep.run(second.expires_at)).toBe(1)
    sweep.stop()
    expect(getDraft(db, second.id)).toBeUndefined()
  })

  it('materializes every output inside its caller transaction and performs no second fetch', async () => {
    let fetches = 0
    const view = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Weather',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    }, deps({ fetch: (async () => {
      fetches++
      return new Response(JSON.stringify(weatherFixture()))
    }) as typeof fetch }))

    expect(() => db.transaction(() => {
      materializeSourceDraft(db, view.id, NOW + 100)
      throw new Error('outer operation failed')
    })()).toThrow('outer operation failed')
    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db).sources).toBe(0)
    expect(tableCounts(db).feeds).toBe(0)

    const promoted = db.transaction(() => materializeSourceDraft(db, view.id, NOW + 200))()

    expect(fetches).toBe(1)
    expect(getDraft(db, view.id)).toBeUndefined()
    expect(getSource(db, promoted.source.id)).toMatchObject({
      state: 'healthy', last_run_at: NOW + 200, last_success_at: NOW + 200,
      last_status: 'Connection refreshed successfully.', next_run_at: NOW + 200 + 900_000,
    })
    expect(promoted.outputs.map((stored) => stored.contract_id).sort()).toEqual([
      'dashboardz.weather.current/v1',
      'dashboardz.weather.daily-forecast/v1',
    ])
    expect([...promoted.changed_feed_ids].sort()).toEqual(promoted.outputs.map((stored) => stored.feed_id).sort())
    const currentOutput = promoted.outputs.find((stored) => stored.contract_id === 'dashboardz.weather.current/v1')!
    const dailyOutput = promoted.outputs.find((stored) => stored.contract_id === 'dashboardz.weather.daily-forecast/v1')!
    const currentFeed = getFeed(db, currentOutput.feed_id)!
    const dailyFeed = getFeed(db, dailyOutput.feed_id)!
    expect(currentFeed).toMatchObject({
      name: 'Weather — Current weather', mode: 'value', cap: 50, stale_after_s: 2700,
      allowed_senders: '[]', pushed_at: NOW + 200, pushed_by: promoted.source.id,
    })
    expect(dailyFeed).toMatchObject({
      name: 'Weather — Daily forecast', mode: 'value', cap: 7, stale_after_s: 2700,
      allowed_senders: '[]', pushed_at: NOW + 200, pushed_by: promoted.source.id,
    })
    expect(promoted.outputs.every((stored) => stored.last_valid_at === NOW + 200)).toBe(true)
    expect(promoted.outputs.every((stored) => stored.content_hash?.startsWith('sha256:'))).toBe(true)
    expect(JSON.parse(currentFeed.payload!)).toEqual((view.outputs.find((item) => item.contract_id === currentOutput.contract_id)!.preview as { payload: unknown }).payload)
    expect(JSON.parse(dailyFeed.payload!)).toEqual((view.outputs.find((item) => item.contract_id === dailyOutput.contract_id)!.preview as { payload: unknown }).payload)
  })

  it('copies secret ciphertext opaquely and explicit promotion consumes a draft exactly once', async () => {
    const plaintext = 'https://news.example.test/private.xml'
    let fetches = 0
    const view = await testSourceDraft({
      provider_id: 'dashboardz.rss', name: 'News', config: { max_items: 20 }, secrets: { url: plaintext },
    }, deps({ fetch: (async () => {
      fetches++
      return new Response('<rss><channel><item><title>One</title><link>https://example.test/1</link></item></channel></rss>')
    }) as typeof fetch }))
    const ciphertext = getDraft(db, view.id)!.secrets[0]!.ciphertext

    const promoted = promoteSourceDraft(db, view.id, NOW)

    expect(fetches).toBe(1)
    expect(listSourceSecrets(db, promoted.source.id)).toEqual([
      expect.objectContaining({ name: 'url', ciphertext }),
    ])
    const feed = getFeed(db, promoted.outputs[0]!.feed_id)!
    expect(wireFeed(db, feed)).toEqual(view.outputs[0]!.preview)
    expect(JSON.stringify(listSourceSecrets(db, promoted.source.id))).not.toContain(plaintext)
    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('Source draft is unavailable')
    expect(fetches).toBe(1)
  })

  it('rejects a draft missing one provider-declared output before any promotion write', async () => {
    const view = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Incomplete weather',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    }, deps())
    db.prepare('DELETE FROM source_draft_outputs WHERE draft_id = ? AND contract_id = ?')
      .run(view.id, 'dashboardz.weather.daily-forecast/v1')

    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('Source draft preview is invalid')

    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db)).toEqual({
      drafts: 1, draftSecrets: 0, draftOutputs: 1,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
  })

  it('rejects an altered declared-secret name before writes and leaves the draft retryable', async () => {
    const plaintext = 'https://news.example.test/manifest.xml'
    const view = await testSourceDraft({
      provider_id: 'dashboardz.rss', name: 'Manifest news', config: { max_items: 20 }, secrets: { url: plaintext },
    }, deps({
      fetch: (async () => new Response(
        '<rss><channel><item><title>One</title><link>https://example.test/1</link></item></channel></rss>',
      )) as typeof fetch,
    }))
    db.prepare('UPDATE source_draft_secrets SET name = ? WHERE draft_id = ?').run('unexpected_secret', view.id)

    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('Source draft preview is invalid')

    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db)).toEqual({
      drafts: 1, draftSecrets: 1, draftOutputs: 1,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
    db.prepare('UPDATE source_draft_secrets SET name = ? WHERE draft_id = ?').run('url', view.id)
    expect(promoteSourceDraft(db, view.id, NOW + 2).outputs).toHaveLength(1)
  })

  it.each([
    {
      corruption: 'a missing required field',
      mutate: (config: Record<string, unknown>) => { delete config.city },
    },
    {
      corruption: 'an undeclared field',
      mutate: (config: Record<string, unknown>) => { config.provider_private = 'must-not-promote' },
    },
    {
      corruption: 'an out-of-range numeric field',
      mutate: (config: Record<string, unknown>) => { config.lat = 91 },
    },
    {
      corruption: 'an invalid select value',
      mutate: (config: Record<string, unknown>) => { config.units = 'kelvin' },
    },
  ])('rejects registry-invalid draft config with $corruption before writes', async ({ mutate }) => {
    const canonicalConfig = { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }
    const view = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Corrupt config', config: canonicalConfig, secrets: {},
    }, deps())
    const corrupted = { ...canonicalConfig }
    mutate(corrupted)
    db.prepare('UPDATE source_drafts SET config = ? WHERE id = ?').run(JSON.stringify(corrupted), view.id)

    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('Source draft preview is invalid')

    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db)).toEqual({
      drafts: 1, draftSecrets: 0, draftOutputs: 2,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
    db.prepare('UPDATE source_drafts SET config = ? WHERE id = ?').run(JSON.stringify(canonicalConfig), view.id)
    expect(promoteSourceDraft(db, view.id, NOW + 2).outputs).toHaveLength(2)
  })

  it.each([
    { corruption: 'zero', interval: 0 },
    { corruption: 'below the provider minimum', interval: 299 },
    { corruption: 'above the allowed maximum', interval: 86_401 },
  ])('rejects a draft interval $corruption before writes', async ({ interval }) => {
    const view = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Corrupt interval',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    }, deps())
    db.prepare('UPDATE source_drafts SET interval_s = ? WHERE id = ?').run(interval, view.id)

    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('Source draft preview is invalid')

    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db)).toEqual({
      drafts: 1, draftSecrets: 0, draftOutputs: 2,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
    db.prepare('UPDATE source_drafts SET interval_s = ? WHERE id = ?').run(900, view.id)
    expect(promoteSourceDraft(db, view.id, NOW + 2).outputs).toHaveLength(2)
  })

  it('rejects expired drafts and rolls back sibling outputs, feeds, and deletion on write failure', async () => {
    const expired = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Expired',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    }, deps())
    expect(() => promoteSourceDraft(db, expired.id, expired.expires_at)).toThrow('Source draft is unavailable')
    expect(getDraft(db, expired.id)).toBeDefined()
    expect(tableCounts(db).sources).toBe(0)

    const retryable = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Retryable',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    }, deps())
    db.exec(`CREATE TRIGGER abort_draft_daily BEFORE INSERT ON source_outputs
      WHEN NEW.contract_id = 'dashboardz.weather.daily-forecast/v1'
      BEGIN SELECT RAISE(ABORT, 'draft daily output failed'); END`)

    expect(() => promoteSourceDraft(db, retryable.id, NOW + 10)).toThrow('draft daily output failed')

    expect(getDraft(db, retryable.id)).toBeDefined()
    expect(tableCounts(db)).toEqual({
      drafts: 2, draftSecrets: 0, draftOutputs: 4,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
    expect(listFeeds(db)).toEqual([])
    db.exec('DROP TRIGGER abort_draft_daily')
    expect(promoteSourceDraft(db, retryable.id, NOW + 11).outputs).toHaveLength(2)
  })

  it('rolls back an opaque secret copy when the first output write fails', async () => {
    const plaintext = 'https://news.example.test/retryable.xml'
    const view = await testSourceDraft({
      provider_id: 'dashboardz.rss', name: 'Retryable secret', config: { max_items: 20 }, secrets: { url: plaintext },
    }, deps({
      fetch: (async () => new Response(
        '<rss><channel><item><title>One</title><link>https://example.test/1</link></item></channel></rss>',
      )) as typeof fetch,
    }))
    db.exec(`CREATE TRIGGER abort_draft_news BEFORE INSERT ON source_outputs
      WHEN NEW.contract_id = 'dashboardz.news.items/v1'
      BEGIN SELECT RAISE(ABORT, 'draft news output failed'); END`)

    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('draft news output failed')

    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db)).toEqual({
      drafts: 1, draftSecrets: 1, draftOutputs: 1,
      sources: 0, secrets: 0, outputs: 0, feeds: 0,
    })
    db.exec('DROP TRIGGER abort_draft_news')
    expect(promoteSourceDraft(db, view.id, NOW + 2).outputs).toHaveLength(1)
  })

  it('refuses a corrupt persisted preview rather than promoting a partial source', () => {
    const draft = createDraft(db, {
      provider_id: 'test.corrupt', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Corrupt', config: {}, interval_s: 60, expires_at: NOW + 1000, secrets: [],
      outputs: [{
        contract_id: 'dashboardz.legacy.value/v1', mode: 'value',
        result: { mode: 'value', payload: { safe: true } }, capabilities: [], content_hash: 'hash',
      }],
    }, NOW)
    db.prepare('UPDATE source_draft_outputs SET result = ? WHERE draft_id = ?').run('{private broken body', draft.id)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => promoteSourceDraft(db, draft.id, NOW + 1)).toThrow('Source draft preview is invalid')
      expect(getDraft(db, draft.id)).toBeDefined()
    } finally {
      warn.mockRestore()
    }
    expect(tableCounts(db).sources).toBe(0)
  })

  it('canonically rejects a parseable stored preview whose nested semantic shape is corrupt', async () => {
    const view = await testSourceDraft({
      provider_id: 'dashboardz.open-meteo', name: 'Structurally corrupt',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    }, deps())
    db.prepare('UPDATE source_draft_outputs SET result = ? WHERE draft_id = ? AND contract_id = ?').run(
      JSON.stringify({ mode: 'value', payload: {} }), view.id, 'dashboardz.weather.current/v1',
    )

    expect(() => promoteSourceDraft(db, view.id, NOW + 1)).toThrow('Source draft preview is invalid')
    expect(getDraft(db, view.id)).toBeDefined()
    expect(tableCounts(db).sources).toBe(0)
  })
})
