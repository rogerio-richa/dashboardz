import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createSecretBox } from '../src/secrets/box.js'
import { getDraft } from '../src/db/sourceDrafts.js'
import { getScreen } from '../src/db/screens.js'
import { listOutputs, listSources } from '../src/db/sources.js'
import { inject } from './support/inject.js'

const NOW = Date.UTC(2026, 7, 5, 12)
const RSS_URL = 'https://private.example.test/news.xml'
const PLAINTEXT_SENTINEL = 'private.example.test'
const CIPHERTEXT_SENTINEL = 'ciphertext-must-not-enter-audit'
const rss = readFileSync(new URL('./fixtures/rss-news.xml', import.meta.url), 'utf8')
const weather = readFileSync(new URL('./fixtures/open-meteo-seven-day.json', import.meta.url), 'utf8')
const full = { x: 0, y: 0, w: 1, h: 1 }
const left = { x: 0, y: 0, w: 0.5, h: 1 }
const right = { x: 0.5, y: 0, w: 0.5, h: 1 }

describe('screen save source promotion', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string
  let fetches: string[]

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    fetches = []
    db = openDb(':memory:', { secretBox: createSecretBox(new Uint8Array(32).fill(9)) })
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      fetches.push(url)
      if (url.startsWith('https://api.open-meteo.com/')) return new Response(weather)
      if (url === RSS_URL || url.startsWith(`${RSS_URL}?`)) return new Response(rss)
      return new Response('unavailable', { status: 503 })
    }) as typeof fetch
    app = await buildServer({
      config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://hub.test', relayUrl: null } as any,
      db,
      secretBox: createSecretBox(new Uint8Array(32).fill(9)),
      fetchImpl,
    })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  const request = (method: string, url: string, payload?: object) => inject(app, {
    method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }),
  })

  async function rssDraft(name = 'News') {
    const response = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name, config: { max_items: 20 }, secrets: { url: RSS_URL },
    })
    expect(response.statusCode).toBe(200)
    return response.json() as { id: string; outputs: Array<{ contract_id: string }> }
  }

  async function weatherDraft(name = 'Weather') {
    const response = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.open-meteo', name,
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    })
    expect(response.statusCode).toBe(200)
    return response.json() as { id: string; outputs: Array<{ contract_id: string }> }
  }

  const pendingNews = (draftId: string, rect = full, extra: Record<string, unknown> = {}) => ({
    rect,
    widget: 'news_list',
    config: {
      items: 4, show_summary: true, scale: 1.25, design: 'list', ...extra,
      source_draft_id: draftId, output_contract: 'dashboardz.news.items/v1',
    },
  })

  const pendingWeather = (draftId: string, config: Record<string, unknown> = {}) => ({
    rect: full,
    widget: 'weather_forecast',
    config: {
      days: 5, show_humidity: true, show_pollen: true, scale: 0.9, design: 'forecast', ...config,
      source_draft_id: draftId, output_contract: 'dashboardz.weather.daily-forecast/v1',
    },
  })

  const postScreen = (name: string, cells: object[]) => request('POST', '/admin/api/screens', {
    name, orientation: 'landscape', grid: { cells },
  })

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  it('promotes a new-screen draft without refetching and returns only the persistent feed binding', async () => {
    const draft = await weatherDraft()
    const fetchCount = fetches.length

    const response = await postScreen('Forecast', [pendingWeather(draft.id)])

    expect(response.statusCode).toBe(200)
    expect(fetches).toHaveLength(fetchCount)
    expect(response.json()).toMatchObject({
      id: expect.stringMatching(/^lay_/), rev: 1,
      grid: { cells: [{
        widget: 'weather_forecast',
        config: {
          days: 5, show_humidity: true, show_pollen: true, scale: 0.9, design: 'forecast',
          feed: expect.stringMatching(/^feed_/),
        },
      }] },
    })
    expect(JSON.stringify(response.json().grid)).not.toContain('source_draft_id')
    expect(JSON.stringify(response.json().grid)).not.toContain('output_contract')
    expect(getDraft(db, draft.id)).toBeUndefined()
    const sources = listSources(db)
    expect(sources).toHaveLength(1)
    expect(new Set(listOutputs(db, sources[0]!.id).map((output) => output.contract_id))).toEqual(new Set([
      'dashboardz.weather.daily-forecast/v1',
      'dashboardz.weather.current/v1',
    ]))
  })

  it('updates an existing screen, preserves unrelated cells/config, and returns its normalized new revision', async () => {
    const created = await postScreen('Existing', [
      { rect: left, widget: 'clock', config: { scale: 1.5, design: 'segment' } },
      { rect: right, widget: 'alert_feed', config: { min_severity: 'warn' } },
    ])
    const draft = await rssDraft()
    const candidate = {
      cells: [
        { ...pendingNews(draft.id, left), config: { ...pendingNews(draft.id, left).config, show_source: true } },
        { rect: right, widget: 'alert_feed', config: { min_severity: 'warn' } },
      ],
    }

    const response = await request('PATCH', `/admin/api/screens/${created.json().id}`, {
      grid: candidate, rev: created.json().rev,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().rev).toBe(2)
    expect(response.json().grid.cells[0].config).toEqual({
      items: 4, show_summary: true, scale: 1.25, design: 'list', show_source: true,
      feed: expect.stringMatching(/^feed_/),
    })
    expect(response.json().grid.cells[1]).toEqual(candidate.cells[1])
    expect(JSON.parse(getScreen(db, created.json().id)!.grid)).toEqual(response.json().grid)
  })

  it('materializes one shared draft once and rewrites every reference to the same feed', async () => {
    const draft = await rssDraft('Shared')

    const response = await postScreen('Shared bindings', [
      pendingNews(draft.id, left),
      pendingNews(draft.id, right, { items: 8, show_time: true }),
    ])

    expect(response.statusCode).toBe(200)
    expect(listSources(db)).toHaveLength(1)
    expect(response.json().grid.cells[0].config.feed).toBe(response.json().grid.cells[1].config.feed)
  })

  it('materializes multiple distinct drafts once each in one screen save', async () => {
    const first = await rssDraft('First')
    const second = await rssDraft('Second')

    const response = await postScreen('Two sources', [
      pendingNews(first.id, left), pendingNews(second.id, right),
    ])

    expect(response.statusCode).toBe(200)
    expect(listSources(db).map((source) => source.name).sort()).toEqual(['First', 'Second'])
    expect(new Set(response.json().grid.cells.map((cell: any) => cell.config.feed)).size).toBe(2)
  })

  it('accepts missing optional capabilities but rejects missing required and config-dependent capabilities before promotion', async () => {
    const optional = await rssDraft('Optional details absent')
    const accepted = await postScreen('Optional accepted', [pendingNews(optional.id)])
    expect(accepted.statusCode).toBe(200)

    const required = await rssDraft('Required missing')
    const requiredOutput = getDraft(db, required.id)!.outputs[0]!
    db.prepare('UPDATE source_draft_outputs SET capabilities = ? WHERE id = ?').run(
      JSON.stringify(['news.item.id']), requiredOutput.id,
    )
    const requiredResponse = await postScreen('Required rejected', [pendingNews(required.id)])
    expect(requiredResponse.statusCode).toBe(400)
    expect(requiredResponse.json().error).toContain('news.item.title')
    expect(getDraft(db, required.id)).toBeDefined()

    const fiveDay = await weatherDraft('Five days only')
    const daily = getDraft(db, fiveDay.id)!.outputs.find((output) => output.contract_id.endsWith('daily-forecast/v1'))!
    db.prepare('UPDATE source_draft_outputs SET capabilities = ? WHERE id = ?').run(
      JSON.stringify(daily.capabilities.filter((capability) => capability !== 'weather.daily.entries.7')),
      daily.id,
    )
    const sevenDayResponse = await postScreen('Seven rejected', [pendingWeather(fiveDay.id, { days: 7 })])
    expect(sevenDayResponse.statusCode).toBe(400)
    expect(sevenDayResponse.json().error).toContain('weather.daily.entries.7')
    expect(getDraft(db, fiveDay.id)).toBeDefined()
  })

  it('rejects cross-contract substitution, expired, corrupt, and already-consumed drafts without partial writes', async () => {
    const wrongContract = await weatherDraft('Wrong output')
    const cross = pendingWeather(wrongContract.id)
    cross.config.output_contract = 'dashboardz.weather.current/v1'
    const crossResponse = await postScreen('Cross contract', [cross])
    expect(crossResponse.statusCode).toBe(400)
    expect(getDraft(db, wrongContract.id)).toBeDefined()

    const expired = await rssDraft('Expired')
    db.prepare('UPDATE source_drafts SET expires_at = ? WHERE id = ?').run(NOW, expired.id)
    const expiredResponse = await postScreen('Expired draft', [pendingNews(expired.id)])
    expect(expiredResponse.statusCode).toBe(410)
    expect(getDraft(db, expired.id)).toBeDefined()

    const corrupt = await rssDraft('Corrupt')
    db.prepare('UPDATE source_draft_outputs SET result = ? WHERE draft_id = ?').run('{private corrupt preview', corrupt.id)
    const corruptResponse = await postScreen('Corrupt draft', [pendingNews(corrupt.id)])
    expect(corruptResponse.statusCode).toBe(409)
    expect(corruptResponse.body).not.toContain('private corrupt preview')
    expect(getDraft(db, corrupt.id)).toBeDefined()

    const consumed = await rssDraft('Consumed')
    expect((await postScreen('First consumer', [pendingNews(consumed.id)])).statusCode).toBe(200)
    const second = await postScreen('Second consumer', [pendingNews(consumed.id)])
    expect(second.statusCode).toBe(404)
    expect(count('screens')).toBe(1)
  })

  it('rejects a persistent semantic binding when its output contract is incompatible', async () => {
    const draft = await weatherDraft()
    const promoted = await postScreen('Weather owner', [pendingWeather(draft.id)])
    const dailyFeed = promoted.json().grid.cells[0].config.feed

    const response = await postScreen('Wrong widget', [{
      rect: full, widget: 'news_list', config: { feed: dailyFeed, items: 5 },
    }])

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('news_list requires')
    expect(count('screens')).toBe(1)
  })

  it('throws a transactional revision conflict so promotion and the trigger revision bump both roll back', async () => {
    const created = await postScreen('Contested', [{ rect: full, widget: 'clock', config: {} }])
    const draft = await rssDraft()
    db.prepare(`CREATE TRIGGER move_screen_during_promotion AFTER INSERT ON source_instances BEGIN
      UPDATE screens SET rev = rev + 1 WHERE id = '${created.json().id}';
    END`).run()

    const response = await request('PATCH', `/admin/api/screens/${created.json().id}`, {
      grid: { cells: [pendingNews(draft.id)] }, rev: 1,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'screen changed elsewhere', rev: 2 })
    expect(getScreen(db, created.json().id)!.rev).toBe(1)
    expect(JSON.parse(getScreen(db, created.json().id)!.grid).cells[0].widget).toBe('clock')
    expect(getDraft(db, draft.id)).toBeDefined()
    expect(listSources(db)).toHaveLength(0)
  })

  it('rolls back promoted rows and draft consumption when the final screen write has a duplicate name', async () => {
    await postScreen('Taken', [{ rect: full, widget: 'clock', config: {} }])
    const editable = await postScreen('Editable', [{ rect: full, widget: 'clock', config: {} }])
    const draft = await rssDraft()

    const response = await request('PATCH', `/admin/api/screens/${editable.json().id}`, {
      name: 'Taken', grid: { cells: [pendingNews(draft.id)] }, rev: 1,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'name already exists' })
    expect(listSources(db)).toHaveLength(0)
    expect(count('feeds')).toBe(0)
    expect(count('source_outputs')).toBe(0)
    expect(getDraft(db, draft.id)).toBeDefined()
    expect(getScreen(db, editable.json().id)!.name).toBe('Editable')
  })

  it('rolls back sources, secrets, feeds, outputs, screen and audits when a late audit trigger fails', async () => {
    const draft = await rssDraft('Audit rollback')
    db.prepare(`UPDATE source_draft_secrets SET ciphertext = ? WHERE draft_id = ?`).run(CIPHERTEXT_SENTINEL, draft.id)
    const beforeAudit = count('audit_log')
    db.prepare(`CREATE TRIGGER fail_screen_audit BEFORE INSERT ON audit_log
      WHEN NEW.event = 'screen_created' BEGIN SELECT RAISE(ABORT, 'private sqlite failure'); END`).run()

    const response = await postScreen('Must roll back', [pendingNews(draft.id)])

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'screen save failed' })
    expect(response.body).not.toContain('private sqlite failure')
    expect(count('source_instances')).toBe(0)
    expect(count('source_secrets')).toBe(0)
    expect(count('source_outputs')).toBe(0)
    expect(count('feeds')).toBe(0)
    expect(count('screens')).toBe(0)
    expect(count('audit_log')).toBe(beforeAudit)
    expect(getDraft(db, draft.id)).toBeDefined()
  })

  it('commits before announcing every exactly changed output and does not report notification failure as a failed save', async () => {
    const draft = await weatherDraft('Notify')
    const announced: string[] = []
    vi.spyOn(app.dataPusher, 'onFeedPush').mockImplementation((feedId) => {
      announced.push(feedId)
      throw new Error('notification transport failed')
    })

    const response = await postScreen('Notified', [pendingWeather(draft.id)])

    expect(response.statusCode).toBe(200)
    const source = listSources(db)[0]!
    const feedIds = listOutputs(db, source.id).map((output) => output.feed_id)
    expect(announced).toHaveLength(feedIds.length)
    expect(new Set(announced)).toEqual(new Set(feedIds))
    expect(getScreen(db, response.json().id)).toBeDefined()
    expect(getDraft(db, draft.id)).toBeUndefined()
  })

  it('keeps source-created and screen audit details redacted', async () => {
    const draft = await rssDraft('Private source')

    const response = await postScreen('Audited', [pendingNews(draft.id)])

    expect(response.statusCode).toBe(200)
    const rows = db.prepare("SELECT event, details FROM audit_log WHERE event IN ('source_created', 'screen_created') ORDER BY id")
      .all() as Array<{ event: string; details: string }>
    expect(rows.map((row) => ({ event: row.event, details: JSON.parse(row.details) }))).toEqual([
      {
        event: 'source_created',
        details: { source_id: listSources(db)[0]!.id, provider_id: 'dashboardz.rss' },
      },
      {
        event: 'screen_created',
        details: { screen_id: response.json().id, name: 'Audited', orientation: 'landscape' },
      },
    ])
    const auditText = rows.map((row) => row.details).join(' ')
    expect(auditText).not.toContain(PLAINTEXT_SENTINEL)
    expect(auditText).not.toContain(CIPHERTEXT_SENTINEL)
    expect(auditText).not.toContain('max_items')
    expect(auditText).not.toContain('News —')
  })

  it('bounds semantic binding IDs and requires exactly one pending or stored binding', async () => {
    const cases = [
      { source_draft_id: `drf_${'a'.repeat(81)}`, output_contract: 'dashboardz.news.items/v1' },
      { source_draft_id: 'toString', output_contract: 'dashboardz.news.items/v1' },
      { feed: 'feed_existing', source_draft_id: 'drf_both', output_contract: 'dashboardz.news.items/v1' },
      { items: 5 },
    ]
    for (const [index, binding] of cases.entries()) {
      const response = await postScreen(`Invalid binding ${index}`, [{
        rect: full, widget: 'news_list', config: binding,
      }])
      expect(response.statusCode, JSON.stringify(binding)).toBe(400)
    }
    expect(count('screens')).toBe(0)
  })

  /**
   * The ordering inversion. Until now only the three SEMANTIC widgets could be saved against a
   * source that does not exist yet; every generic widget required a feed id, and `save.ts` rejected
   * an id with no row. So a screen could not be built before its data was — "define the feed first"
   * was a rule of the product rather than a rule of anything.
   *
   * The paths bound below are the ones the built-in providers really produce; they were read off
   * the drafts' own previews, not guessed. A pending generic binding is checked against what the
   * draft's PREVIEW demonstrably carries, which is the same `capabilitiesForPayload` inference a
   * live feed gets — a promise the operator is making right now, so it is checked, and rejected
   * when the draft cannot keep it.
   */
  describe('generic widgets bind to a source that does not exist yet', () => {
    const pendingCell = (widget: string, draftId: string, contract: string, config: Record<string, unknown>) => ({
      rect: full,
      widget,
      config: { ...config, source_draft_id: draftId, output_contract: contract },
    })

    it('saves a gauge against a weather draft, before any feed exists', async () => {
      const draft = await weatherDraft()
      const response = await postScreen('CPU', [
        pendingCell('gauge', draft.id, 'dashboardz.weather.current/v1', { path: 'current.temp', min: 0, max: 50 }),
      ])

      expect(response.statusCode).toBe(200)
      expect(response.json().grid.cells[0].config).toMatchObject({
        path: 'current.temp', feed: expect.stringMatching(/^feed_/),
      })
      expect(JSON.stringify(response.json().grid)).not.toContain('source_draft_id')
      expect(getDraft(db, draft.id)).toBeUndefined()
    })

    it('still rejects a gauge bound to a feed id that does not exist', async () => {
      // The pending path is opt-in via source_draft_id. A typo'd feed id is still an error, not a
      // silent promise — otherwise every mistyped binding becomes a screen that renders nothing.
      const response = await postScreen('Typo', [{
        rect: full, widget: 'gauge', config: { feed: 'feed_nope', path: 'x', min: 0, max: 100 },
      }])
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('unknown feed')
    })

    it('rejects a pending gauge whose draft promises the wrong type at that path', async () => {
      const draft = await weatherDraft()
      const response = await postScreen('Wrong', [
        // `location.name` is a string on this preview, so the draft produces data.scalar@ but no
        // data.number@ for it — a gauge cannot draw a city name against a min/max track.
        pendingCell('gauge', draft.id, 'dashboardz.weather.current/v1', { path: 'location.name', min: 0, max: 50 }),
      ])
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('location.name')
      expect(count('screens')).toBe(0)
      expect(count('source_instances')).toBe(0)
    })

    it('rejects a pending binding whose draft output is the wrong feed MODE', async () => {
      // The mode check a live binding already gets, applied to a promise. stream_list reads rows;
      // a value-mode contract has none, and no amount of correct paths makes that bindable.
      const draft = await weatherDraft()
      const response = await postScreen('Mode', [
        pendingCell('stream_list', draft.id, 'dashboardz.weather.current/v1', { title_path: 'location.name' }),
      ])
      expect(response.statusCode).toBe(400)
      expect(count('screens')).toBe(0)
    })

    it('accepts a pending binding on every generic widget that binds a path', async () => {
      const weather = await weatherDraft()
      const news = await rssDraft()
      const cells = [
        pendingCell('value_tile', weather.id, 'dashboardz.weather.current/v1',
          { path: 'current.condition.label' }),
        pendingCell('text_block', weather.id, 'dashboardz.weather.current/v1',
          { path: 'location.name' }),
        pendingCell('table', weather.id, 'dashboardz.weather.daily-forecast/v1',
          { path: 'days', columns: [{ header: 'Day', path: 'date' }, { header: 'High', path: 'high' }] }),
        pendingCell('stream_list', news.id, 'dashboardz.news.items/v1',
          { title_path: 'title', body_path: 'summary' }),
      ].map((cell, index) => ({ ...cell, rect: { x: 0, y: index * 0.25, w: 1, h: 0.25 } }))

      const response = await postScreen('Everything', cells)

      expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
      for (const cell of response.json().grid.cells) {
        expect(cell.config.feed, cell.widget).toMatch(/^feed_/)
        expect(cell.config.source_draft_id).toBeUndefined()
      }
    })

    /**
     * A stream-bound table takes its columns per row and has no array at `config.path` — the case
     * the mode-conditioned needs exist for. Bound to the same news draft, this cell must save while
     * the value-feed spelling (`data.scalar@days[].date`) plays no part.
     */
    it('accepts a stream-bound pending table, whose columns resolve per row', async () => {
      const news = await rssDraft()
      const response = await postScreen('Headlines', [
        pendingCell('table', news.id, 'dashboardz.news.items/v1',
          { columns: [{ header: 'Story', path: 'title' }, { header: 'Detail', path: 'summary' }] }),
      ])
      expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
    })

    /**
     * Chart binds PER SERIES, so its pending binding is per series too — and a chart may mix a
     * series on a feed that exists with one on a source that does not. Anything else would make
     * the pending case strictly less capable than the live one, on the single widget an operator
     * is most likely to be adding a new source for.
     */
    it('rewrites a pending chart series into a feed id, alongside a live series', async () => {
      const live = await rssDraft('Live')
      const liveScreen = await postScreen('Seed', [{
        rect: full, widget: 'news_list',
        config: { items: 4, source_draft_id: live.id, output_contract: 'dashboardz.news.items/v1' },
      }])
      expect(liveScreen.statusCode).toBe(200)
      const liveFeed = liveScreen.json().grid.cells[0].config.feed as string

      const pending = await rssDraft('Pending')
      const response = await postScreen('Mixed', [{
        rect: full,
        widget: 'chart',
        config: {
          series: [
            { feed: liveFeed, y_path: 'published_at', icon: 'circle' },
            {
              source_draft_id: pending.id, output_contract: 'dashboardz.news.items/v1',
              y_path: 'published_at', icon: 'square',
            },
          ],
        },
      }])

      expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
      const series = response.json().grid.cells[0].config.series as Array<Record<string, unknown>>
      expect(series[0]).toEqual({ feed: liveFeed, y_path: 'published_at', icon: 'circle' })
      expect(series[1]!.feed).toMatch(/^feed_/)
      expect(series[1]!.feed).not.toBe(liveFeed)
      expect(series[1]).not.toHaveProperty('source_draft_id')
      expect(getDraft(db, pending.id)).toBeUndefined()
    })

    /**
     * A pending series is held to ITS OWN y_path and no other. Each series has its own source, so
     * asking one draft to satisfy every series' path would reject exactly the chart this feature
     * exists for — several feeds plotted together, only one of them new. The live series below
     * plots a non-numeric path on purpose: that is a live binding's business (the warning
     * about it, it does not block), and it must not become the pending draft's problem.
     */
    it('holds a pending series to its own y_path, not to the whole chart', async () => {
      const live = await rssDraft('Live')
      const seeded = await postScreen('Seed', [{
        rect: full, widget: 'news_list',
        config: { items: 4, source_draft_id: live.id, output_contract: 'dashboardz.news.items/v1' },
      }])
      const liveFeed = seeded.json().grid.cells[0].config.feed as string

      const pending = await rssDraft('Pending')
      const response = await postScreen('Own path', [{
        rect: full,
        widget: 'chart',
        config: {
          series: [
            { feed: liveFeed, y_path: 'title', icon: 'circle' },
            {
              source_draft_id: pending.id, output_contract: 'dashboardz.news.items/v1',
              y_path: 'published_at', icon: 'square',
            },
          ],
        },
      }])

      expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
    })

    it('rejects a pending chart series whose draft carries no number at that y_path', async () => {
      const draft = await rssDraft()
      const response = await postScreen('NaN', [{
        rect: full,
        widget: 'chart',
        config: {
          series: [{
            source_draft_id: draft.id, output_contract: 'dashboardz.news.items/v1',
            y_path: 'title', icon: 'circle',
          }],
        },
      }])
      expect(response.statusCode).toBe(400)
      expect(count('screens')).toBe(0)
    })
  })
})
