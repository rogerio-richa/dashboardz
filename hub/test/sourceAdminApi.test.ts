import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createSecretBox } from '../src/secrets/box.js'
import { createScreen } from '../src/db/screens.js'
import { getDraft } from '../src/db/sourceDrafts.js'
import { getSource, listOutputs, listSourceSecrets, recordRun } from '../src/db/sources.js'
import { getFeed, recentRows } from '../src/db/feeds.js'
import { inject } from './support/inject.js'

const NOW = Date.UTC(2026, 7, 5, 12)
const RSS_URL = 'https://private.example.test/family.xml'
const CIPHERTEXT_SENTINEL = 'ciphertext-must-not-leak'
const PROVIDER_BODY_SENTINEL = 'private-provider-body-must-not-leak'
const rss = readFileSync(new URL('./fixtures/rss-news.xml', import.meta.url), 'utf8')
const weather = readFileSync(new URL('./fixtures/open-meteo-seven-day.json', import.meta.url), 'utf8')

const config = {
  port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://hub.test', relayUrl: null,
} as const

describe('connection-first source admin API', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string
  let fetched: string[]
  let rssResponse: string

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    fetched = []
    rssResponse = rss
    const secretBox = createSecretBox(new Uint8Array(32).fill(7))
    db = openDb(':memory:', { secretBox })
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes('geocoding-api.open-meteo.com')) {
        if (url.includes('Neverland')) return new Response(PROVIDER_BODY_SENTINEL, { status: 503 })
        return new Response(JSON.stringify({ results: [{ name: 'Lisbon', latitude: 38.72, longitude: -9.14, country: 'Portugal' }] }))
      }
      if (url.includes('api.open-meteo.com')) return new Response(weather)
      if (url === RSS_URL) return new Response(rssResponse)
      return new Response(PROVIDER_BODY_SENTINEL, { status: 503 })
    }) as typeof fetch
    app = await buildServer({ config: config as any, db, secretBox, fetchImpl })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  const request = (method: string, url: string, payload?: object) =>
    inject(app, { method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) })

  async function draftRss(name = 'News') {
    return request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name, config: { max_items: 20 }, secrets: { url: RSS_URL },
    })
  }

  async function promoteRss(name = 'News') {
    const draft = await draftRss(name)
    expect(draft.statusCode).toBe(200)
    const promoted = await request('POST', `/admin/api/source-drafts/${draft.json().id}/promote`)
    expect(promoted.statusCode).toBe(200)
    return promoted.json() as { source: { id: string }; outputs: Array<{ feed_id: string }> }
  }

  async function promoteWeather(name = 'Weather') {
    const draft = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.open-meteo', name,
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    })
    expect(draft.statusCode).toBe(200)
    const promoted = await request('POST', `/admin/api/source-drafts/${draft.json().id}/promote`)
    expect(promoted.statusCode).toBe(200)
    return promoted.json() as { source: { id: string }; outputs: Array<{ feed_id: string }> }
  }

  it('guards every source route with the shared admin session', async () => {
    const cases: Array<[string, string, object?]> = [
      ['GET', '/admin/api/source-choices?widget=news_list'],
      ['GET', '/admin/api/providers'],
      ['POST', '/admin/api/source-drafts', { provider_id: 'dashboardz.rss', name: 'x', config: {}, secrets: {} }],
      ['DELETE', '/admin/api/source-drafts/drf_missing'],
      ['POST', '/admin/api/source-drafts/drf_missing/promote'],
      ['GET', '/admin/api/sources'],
      ['PATCH', '/admin/api/sources/src_missing', { name: 'x' }],
      ['PUT', '/admin/api/sources/src_missing/setup', { config: {} }],
      ['POST', '/admin/api/sources/src_missing/refresh'],
      ['DELETE', '/admin/api/sources/src_missing'],
      ['GET', '/admin/api/geocode?q=Lisbon'],
    ]
    for (const [method, url, payload] of cases) {
      const response = await inject(app, { method, url, ...(payload === undefined ? {} : { payload }) })
      expect(response.statusCode, `${method} ${url}`).toBe(401)
      expect(response.json()).toEqual({ error: 'unauthorized' })
    }
  })

  it('discovers safe deterministic providers and orders compatible existing outputs before providers', async () => {
    const providers = await request('GET', '/admin/api/providers')
    expect(providers.statusCode).toBe(200)
    expect(providers.json().map((provider: any) => provider.id)).toEqual([
      'dashboardz.ical', 'dashboardz.open-meteo', 'dashboardz.rss',
    ])
    expect(providers.json().find((provider: any) => provider.id === 'dashboardz.open-meteo')).toMatchObject({
      label: 'Open-Meteo', recommended: true,
      account: 'No account or API key needed.',
      setup: expect.arrayContaining([expect.objectContaining({ name: 'city', secret: false })]),
      outputs: expect.arrayContaining([expect.objectContaining({ contract_id: 'dashboardz.weather.daily-forecast/v1' })]),
    })
    expect(JSON.stringify(providers.json())).not.toContain('run')
    expect(JSON.stringify(providers.json())).not.toContain(RSS_URL)

    const promoted = await promoteRss('Daily headlines')
    const choices = await request('GET', '/admin/api/source-choices?widget=news_list')
    expect(choices.statusCode).toBe(200)
    expect(choices.json()).toMatchObject({
      widget: 'news_list',
      title: 'Choose news data',
      existing: [expect.objectContaining({
        source_id: promoted.source.id, source_name: 'Daily headlines', provider_id: 'dashboardz.rss',
        feed_id: promoted.outputs[0]!.feed_id, missing_optional: expect.any(Array),
      })],
    })
    expect(choices.json().providers.map((provider: any) => provider.id)).toEqual(['dashboardz.rss'])
    expect(JSON.stringify(choices.json())).not.toContain('dashboardz.ical')
    expect(JSON.stringify(choices.json())).not.toContain('category')
  })

  it('validates draft bodies, returns only a safe DraftView, and supports cancel, supersede and explicit unbound promotion', async () => {
    const invalid = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name: 'News', config: {}, secrets: { url: RSS_URL }, extra: true,
    })
    expect(invalid.statusCode).toBe(400)

    const first = await draftRss('First')
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      id: expect.stringMatching(/^drf_/), provider_id: 'dashboardz.rss', provider: 'RSS / Atom', name: 'First',
      outputs: [expect.objectContaining({ contract_id: 'dashboardz.news.items/v1', preview: expect.any(Object) })],
    })
    expect(JSON.stringify(first.json())).not.toContain(RSS_URL)
    expect(JSON.stringify(first.json())).not.toContain('ciphertext')

    const replacement = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name: 'Replacement', config: { max_items: 10 },
      secrets: { url: RSS_URL }, supersedes: first.json().id,
    })
    expect(replacement.statusCode).toBe(200)
    expect(getDraft(db, first.json().id)).toBeUndefined()
    expect(await request('DELETE', `/admin/api/source-drafts/${replacement.json().id}`)).toMatchObject({ statusCode: 204 })
    expect(getDraft(db, replacement.json().id)).toBeUndefined()

    const promoted = await promoteRss('Unbound news')
    expect(getSource(db, promoted.source.id)).toBeDefined()
    expect(listOutputs(db, promoted.source.id)).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM screens').get()).toEqual({ n: 0 })
    expect(fetched.filter((url) => url === RSS_URL)).toHaveLength(3)
  })

  it('maps provider, validation, expiry, and upstream failures to stable redacted responses', async () => {
    const unknown = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'toString', name: 'Bad', config: {}, secrets: {},
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json()).toEqual({ error: 'provider_unavailable', message: 'Source provider is unavailable.' })

    const invalid = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name: 'Bad', config: {}, secrets: { url: 'javascript:alert(1)' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toEqual({ error: 'setup_invalid', message: 'Source setup is invalid.' })

    const failed = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name: 'Failed', config: {},
      secrets: { url: 'https://unreachable.example.test/private.xml' },
    })
    expect(failed.statusCode).toBe(422)
    expect(failed.json()).toEqual({ error: 'test_failed', message: 'Could not test source data.' })
    expect(failed.body).not.toContain(PROVIDER_BODY_SENTINEL)

    const expiring = await draftRss('Expiring')
    const id = expiring.json().id
    db.prepare('UPDATE source_drafts SET expires_at = ? WHERE id = ?').run(NOW, id)
    const expired = await request('POST', `/admin/api/source-drafts/${id}/promote`)
    expect(expired.statusCode).toBe(410)
    expect(expired.json()).toEqual({ error: 'draft_expired', message: 'Source draft expired.' })
  })

  it('lists safe source health, rate-limit timing, output capabilities and exact screen usage', async () => {
    const promoted = await promoteRss('Headlines')
    const source = getSource(db, promoted.source.id)!
    recordRun(db, source.id, NOW + 10, {
      state: 'rate_limited', status: 'The provider is rate limiting this connection; retry is scheduled.',
      next_run_at: NOW + 60_000,
    })
    createScreen(db, {
      name: 'Kitchen', orientation: 'landscape',
      grid: { cells: [{ widget: 'news_list', config: { feed: promoted.outputs[0]!.feed_id } }] },
    }, NOW)

    db.prepare("INSERT INTO source_instances (id, provider_id, package_id, package_version, name, config, strategy, interval_s, enabled, state, next_run_at, failure_count, rev, created_at, updated_at) VALUES ('src_unknown', 'legacy.private', 'dashboardz.builtin', '1.0.0', 'Legacy', ?, 'scheduled', 60, 0, 'paused', NULL, 0, 1, ?, ?)")
      .run(JSON.stringify({ url: RSS_URL, ciphertext: CIPHERTEXT_SENTINEL }), NOW, NOW)

    const response = await request('GET', '/admin/api/sources')
    expect(response.statusCode).toBe(200)
    const known = response.json().find((item: any) => item.id === source.id)
    expect(known).toMatchObject({
      provider: { id: 'dashboardz.rss', label: 'RSS / Atom' },
      config: { max_items: 20 }, enabled: true,
      health: {
        state: 'rate_limited', last_success_at: NOW, next_refresh_at: NOW + 60_000,
        rate_limited_until: NOW + 60_000,
      },
      outputs: [expect.objectContaining({
        capabilities: expect.arrayContaining(['news.item.id', 'news.item.title']),
        usages: [{ screen_id: expect.stringMatching(/^lay_/), screen_name: 'Kitchen' }],
      })],
      usages: [{ screen_id: expect.stringMatching(/^lay_/), screen_name: 'Kitchen' }],
    })
    expect(response.json().find((item: any) => item.id === 'src_unknown').config).toBeNull()
    expect(response.body).not.toContain(RSS_URL)
    expect(response.body).not.toContain(CIPHERTEXT_SENTINEL)
  })

  it('patches pause/resume, repairs setup with omitted-secret reuse, preserves feed ids, and refreshes safely', async () => {
    const promoted = await promoteRss('Headlines')
    const sourceId = promoted.source.id
    const feedId = promoted.outputs[0]!.feed_id
    const before = getSource(db, sourceId)!
    const encryptedBefore = listSourceSecrets(db, sourceId)[0]!.ciphertext

    const paused = await request('PATCH', `/admin/api/sources/${sourceId}`, { enabled: false })
    expect(paused.statusCode).toBe(200)
    expect(paused.json()).toMatchObject({ enabled: false, health: { state: 'paused', next_refresh_at: null } })
    expect(getSource(db, sourceId)!.rev).toBe(before.rev + 1)

    const resumed = await request('PATCH', `/admin/api/sources/${sourceId}`, { name: 'Updated', interval_s: 600, enabled: true })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json()).toMatchObject({ name: 'Updated', interval_s: 600, enabled: true })

    const repaired = await request('PUT', `/admin/api/sources/${sourceId}/setup`, {
      config: { max_items: 5 }, secrets: {},
    })
    expect(repaired.statusCode).toBe(200)
    expect(repaired.json()).toMatchObject({ id: sourceId, config: { max_items: 5 } })
    expect(listOutputs(db, sourceId).map((output) => output.feed_id)).toEqual([feedId])
    expect(listSourceSecrets(db, sourceId)[0]!.ciphertext).not.toBe(encryptedBefore)
    expect(fetched.filter((url) => url === RSS_URL)).toHaveLength(2)

    const revBeforeRefresh = getSource(db, sourceId)!.rev
    const refreshed = await request('POST', `/admin/api/sources/${sourceId}/refresh`)
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json()).toMatchObject({ id: sourceId, health: { state: 'healthy', last_success_at: NOW } })
    expect(getSource(db, sourceId)!.rev).toBe(revBeforeRefresh)
  })

  it('rejects unsafe patches and guarded deletion reports exact screen names', async () => {
    const strayDraft = await draftRss('Strict action body')
    expect((await request('POST', `/admin/api/source-drafts/${strayDraft.json().id}/promote`, { unexpected: true })).statusCode).toBe(400)
    expect(getDraft(db, strayDraft.json().id)).toBeDefined()
    expect((await request('DELETE', `/admin/api/source-drafts/${strayDraft.json().id}`, { unexpected: true })).statusCode).toBe(400)

    const promoted = await promoteRss('Used')
    const sourceId = promoted.source.id
    const feedId = promoted.outputs[0]!.feed_id
    expect((await request('PATCH', `/admin/api/sources/${sourceId}`, { config: { url: RSS_URL } })).statusCode).toBe(400)
    expect((await request('PATCH', `/admin/api/sources/${sourceId}`, { interval_s: 1 })).statusCode).toBe(400)
    expect((await request('PATCH', '/admin/api/sources/toString', { name: 'unsafe' })).statusCode).toBe(400)
    expect((await request('POST', `/admin/api/sources/${sourceId}/refresh`, { unexpected: true })).statusCode).toBe(400)
    expect((await request('GET', '/admin/api/providers?unexpected=true')).statusCode).toBe(400)
    expect((await request('GET', '/admin/api/sources?unexpected=true')).statusCode).toBe(400)

    createScreen(db, { name: 'Hall', orientation: 'landscape', grid: { cells: [{ config: { feed: feedId } }] } }, NOW)
    createScreen(db, { name: 'Kitchen', orientation: 'landscape', grid: { cells: [{ config: { feed: feedId } }] } }, NOW + 1)
    const blocked = await request('DELETE', `/admin/api/sources/${sourceId}`)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json()).toEqual({ error: 'source_in_use', screen_names: ['Hall', 'Kitchen'] })
    expect(getSource(db, sourceId)).toBeDefined()

    db.prepare('DELETE FROM screens').run()
    expect((await request('DELETE', `/admin/api/sources/${sourceId}`)).statusCode).toBe(204)
    expect(getSource(db, sourceId)).toBeUndefined()
  })

  it.each([
    'draft create', 'draft cancel', 'draft promote', 'source patch',
    'source setup', 'source refresh', 'source delete',
  ])('rejects undeclared queries before mutation: %s', async (action) => {
    const pending = await draftRss('Pending query guard')
    const promoted = await promoteRss('Persistent query guard')
    const sourceId = promoted.source.id
    const before = getSource(db, sourceId)!
    const output = listOutputs(db, sourceId)[0]!
    const fetchesBefore = fetched.length
    const draftCountBefore = (db.prepare('SELECT COUNT(*) AS n FROM source_drafts').get() as { n: number }).n

    const response = action === 'draft create'
      ? await request('POST', '/admin/api/source-drafts?unexpected=true', {
        provider_id: 'dashboardz.rss', name: 'Must not create', config: { max_items: 20 }, secrets: { url: RSS_URL },
      })
      : action === 'draft cancel'
        ? await request('DELETE', `/admin/api/source-drafts/${pending.json().id}?unexpected=true`)
        : action === 'draft promote'
          ? await request('POST', `/admin/api/source-drafts/${pending.json().id}/promote?unexpected=true`)
          : action === 'source patch'
            ? await request('PATCH', `/admin/api/sources/${sourceId}?unexpected=true`, { name: 'Must not update' })
            : action === 'source setup'
              ? await request('PUT', `/admin/api/sources/${sourceId}/setup?unexpected=true`, { config: { max_items: 5 }, secrets: {} })
              : action === 'source refresh'
                ? await request('POST', `/admin/api/sources/${sourceId}/refresh?unexpected=true`)
                : await request('DELETE', `/admin/api/sources/${sourceId}?unexpected=true`)

    expect(response.statusCode).toBe(400)
    expect(getDraft(db, pending.json().id)).toBeDefined()
    expect(getSource(db, sourceId)).toEqual(before)
    expect(listOutputs(db, sourceId)).toEqual([output])
    expect(getFeed(db, output.feed_id)).toBeDefined()
    expect(fetched).toHaveLength(fetchesBefore)
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_drafts').get() as { n: number }).n).toBe(draftCountBefore)
  })

  it('redacts an unexpected refresh persistence failure', async () => {
    const promoted = await promoteRss('Failure boundary')
    db.exec(`CREATE TRIGGER fail_source_refresh BEFORE UPDATE ON source_instances
      BEGIN SELECT RAISE(ABORT, 'PRIVATE-DB-DETAIL'); END`)

    const response = await request('POST', `/admin/api/sources/${promoted.source.id}/refresh`)

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'refresh_failed', message: 'Source refresh could not be completed.' })
    expect(response.body).not.toContain('PRIVATE-DB-DETAIL')
  })

  it('redacts an unexpected PATCH persistence failure and rolls back the source', async () => {
    const promoted = await promoteRss('Patch rollback')
    const before = getSource(db, promoted.source.id)!
    db.exec(`CREATE TRIGGER fail_source_patch BEFORE UPDATE ON source_instances
      BEGIN SELECT RAISE(ABORT, 'PRIVATE-PATCH-DETAIL'); END`)

    const response = await request('PATCH', `/admin/api/sources/${before.id}`, { name: 'Must roll back' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'source_update_failed', message: 'Source update could not be completed.' })
    expect(response.body).not.toContain('PRIVATE-PATCH-DETAIL')
    expect(getSource(db, before.id)).toEqual(before)
  })

  it('redacts an unexpected DELETE persistence failure and rolls back source-owned rows', async () => {
    const promoted = await promoteRss('Delete rollback')
    const sourceId = promoted.source.id
    const output = listOutputs(db, sourceId)[0]!
    db.exec(`CREATE TRIGGER fail_source_delete BEFORE DELETE ON source_instances
      BEGIN SELECT RAISE(ABORT, 'PRIVATE-DELETE-DETAIL'); END`)

    const response = await request('DELETE', `/admin/api/sources/${sourceId}`)

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'source_delete_failed', message: 'Source deletion could not be completed.' })
    expect(response.body).not.toContain('PRIVATE-DELETE-DETAIL')
    expect(getSource(db, sourceId)).toBeDefined()
    expect(listOutputs(db, sourceId)).toHaveLength(1)
    expect(getFeed(db, output.feed_id)).toBeDefined()
  })

  it('reports successful promotion when post-commit output notification fails', async () => {
    const draft = await draftRss('Committed promotion')
    const privateDetail = 'PRIVATE-PROMOTION-NOTIFY-DETAIL'
    vi.spyOn(app.dataPusher, 'onFeedPush').mockImplementation(() => { throw new Error(privateDetail) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await request('POST', `/admin/api/source-drafts/${draft.json().id}/promote`)

    expect(response.statusCode).toBe(200)
    const sourceId = response.json().source.id as string
    expect(getDraft(db, draft.json().id)).toBeUndefined()
    expect(getSource(db, sourceId)).toBeDefined()
    expect(listOutputs(db, sourceId)).toHaveLength(1)
    expect(response.body).not.toContain(privateDetail)
    expect(warn).toHaveBeenCalledWith('source admin: output notification failed')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateDetail)
  })

  it('reports successful setup when post-commit output notification fails', async () => {
    const promoted = await promoteRss('Committed setup')
    const sourceId = promoted.source.id
    const before = getSource(db, sourceId)!
    const privateDetail = 'PRIVATE-SETUP-NOTIFY-DETAIL'
    rssResponse = '<rss version="2.0"><channel><title>Changed to empty</title></channel></rss>'
    vi.spyOn(app.dataPusher, 'onFeedPush').mockImplementation(() => { throw new Error(privateDetail) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await request('PUT', `/admin/api/sources/${sourceId}/setup`, {
      config: { max_items: 5 }, secrets: {},
    })

    expect(response.statusCode).toBe(200)
    expect(getSource(db, sourceId)).toMatchObject({ config: { max_items: 5 }, rev: before.rev + 1 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_drafts').get() as { n: number }).n).toBe(0)
    expect(response.body).not.toContain(privateDetail)
    expect(warn).toHaveBeenCalledWith('source admin: output notification failed')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateDetail)
  })

  it('announces only setup outputs whose validated snapshot changed', async () => {
    const promoted = await promoteWeather('Unchanged weather')
    const announce = vi.spyOn(app.dataPusher, 'onFeedPush')

    const response = await request('PUT', `/admin/api/sources/${promoted.source.id}/setup`, {
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    })

    expect(response.statusCode).toBe(200)
    expect(announce).not.toHaveBeenCalled()
  })

  it('announces an RSS feed when setup replaces persisted rows with a valid empty snapshot', async () => {
    const promoted = await promoteRss('News becoming empty')
    const sourceId = promoted.source.id
    const outputBefore = listOutputs(db, sourceId)[0]!
    expect(recentRows(db, outputBefore.feed_id, 100)).not.toHaveLength(0)
    rssResponse = '<rss version="2.0"><channel><title>Quiet now</title></channel></rss>'
    const announce = vi.spyOn(app.dataPusher, 'onFeedPush')

    const response = await request('PUT', `/admin/api/sources/${sourceId}/setup`, {
      config: { max_items: 20 }, secrets: {},
    })

    expect(response.statusCode).toBe(200)
    expect(listOutputs(db, sourceId)).toEqual([expect.objectContaining({
      id: outputBefore.id, feed_id: outputBefore.feed_id, contract_id: outputBefore.contract_id,
    })])
    expect(recentRows(db, outputBefore.feed_id, 100)).toEqual([])
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith(outputBefore.feed_id)
  })

  it('does not announce an RSS feed when setup replaces rows with the same snapshot', async () => {
    const promoted = await promoteRss('Unchanged news')
    const sourceId = promoted.source.id
    const output = listOutputs(db, sourceId)[0]!
    const beforePayloads = recentRows(db, output.feed_id, 100).map((row) => row.payload)
    const announce = vi.spyOn(app.dataPusher, 'onFeedPush')

    const response = await request('PUT', `/admin/api/sources/${sourceId}/setup`, {
      config: { max_items: 20 }, secrets: {},
    })

    expect(response.statusCode).toBe(200)
    expect(recentRows(db, output.feed_id, 100).map((row) => row.payload)).toEqual(beforePayloads)
    expect(announce).not.toHaveBeenCalled()
  })

  it('keeps geocoding injected and redacts upstream failures', async () => {
    const ok = await request('GET', '/admin/api/geocode?q=Lisbon')
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual([{ name: 'Lisbon', lat: 38.72, lon: -9.14, country: 'Portugal', region: '' }])
    expect((await request('GET', '/admin/api/geocode?q=%20%20')).json()).toEqual([])

    const failure = await request('GET', '/admin/api/geocode?q=Neverland')
    expect(failure.statusCode).toBe(502)
    expect(failure.body).not.toContain(PROVIDER_BODY_SENTINEL)
  })

  it('keeps source lifecycle audit details to source, provider, and state identifiers only', async () => {
    const promoted = await promoteRss('Audited')
    await request('PATCH', `/admin/api/sources/${promoted.source.id}`, { enabled: false })
    await request('PATCH', `/admin/api/sources/${promoted.source.id}`, { enabled: true })
    await request('POST', `/admin/api/sources/${promoted.source.id}/refresh`)
    await request('DELETE', `/admin/api/sources/${promoted.source.id}`)
    const rows = db.prepare("SELECT event, details FROM audit_log WHERE event LIKE 'source_%' ORDER BY id").all() as Array<{ event: string; details: string }>
    expect(rows.map((row) => row.event)).toEqual(expect.arrayContaining([
      'source_created', 'source_updated', 'source_paused', 'source_resumed', 'source_refreshed', 'source_deleted',
    ]))
    const details = rows.map((row) => ({ event: row.event, details: JSON.parse(row.details) as Record<string, unknown> }))
    for (const row of details) {
      expect(Object.keys(row.details).sort()).toEqual(
        row.event === 'source_created' ? ['provider_id', 'source_id'] : ['provider_id', 'source_id', 'state'],
      )
      expect(row.details).toMatchObject({ source_id: promoted.source.id, provider_id: 'dashboardz.rss' })
    }
    expect(details.filter((row) => row.event === 'source_updated').map((row) => row.details.state)).toEqual(['paused', 'degraded'])
    expect(details.find((row) => row.event === 'source_deleted')?.details.state).toBe('healthy')
    for (const row of rows) {
      expect(row.details).not.toContain(RSS_URL)
      expect(row.details).not.toContain('max_items')
      expect(row.details).not.toContain('ciphertext')
      expect(row.details).not.toContain(PROVIDER_BODY_SENTINEL)
    }
  })
})
