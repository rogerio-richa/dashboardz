import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createSecretBox } from '../src/secrets/box.js'
import { listOutputs, listSources } from '../src/db/sources.js'
import { validateContractOutput } from '../src/data/contracts.js'
import { openMeteoProvider } from '../src/sources/providers/openMeteo.js'

/**
 * The whole journey, from an empty hub to changed data on a device's socket.
 *
 * Every layer this crosses has its own focused tests. What none of them can show is the layers
 * agreeing: a draft that previews correctly but promotes to a feed nothing is bound to, a screen
 * that saves but never reaches the glass, a refresh that writes the database while the device sits
 * on stale content. Those are the failures that survive a green suite, so this runs a real
 * listening server, a real WebSocket, and a real in-memory SQLite database, and mocks only the
 * provider's HTTP response.
 *
 * Nothing here stubs contract validation, draft promotion or DATA construction — those are the
 * three things the journey exists to prove.
 */

const PRIVATE_RSS_URL = 'https://family.private.example/secret-calendar-feed.xml'
const PRIVATE_HOST = 'family.private.example'
const rss = readFileSync(new URL('./fixtures/rss-news.xml', import.meta.url), 'utf8')
const weather = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-seven-day.json', import.meta.url), 'utf8'))

const full = { x: 0, y: 0, w: 1, h: 1 }
const left = { x: 0, y: 0, w: 0.5, h: 1 }

/**
 * A second reading from the same place, so "the data changed" is observable on the wire. Both the
 * current temperature and tomorrow's high move, because a device is only pushed the feeds its own
 * screen binds — changing the reading a screen does not render would prove nothing reached it.
 */
const laterWeather = () => {
  const body = structuredClone(weather)
  body.current.temperature_2m = 31.7
  body.daily.temperature_2m_max[0] = 33.4
  return body
}

describe('the widget-first journey', () => {
  let app: FastifyInstance
  let db: DB
  let base: string
  let wsUrl: string
  let cookie: string
  let fetched: string[]
  let currentWeather: unknown

  beforeEach(async () => {
    fetched = []
    currentWeather = weather
    const secretBox = createSecretBox(new Uint8Array(32).fill(23))
    db = openDb(':memory:', { secretBox })
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes('api.open-meteo.com')) return new Response(JSON.stringify(currentWeather))
      if (url.startsWith(PRIVATE_RSS_URL)) return new Response(rss)
      return new Response('unavailable', { status: 503 })
    }) as typeof fetch

    app = await buildServer({
      config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://hub.test', relayUrl: null } as any,
      db,
      secretBox,
      fetchImpl,
    })
    await app.listen({ port: 0 })
    const port = (app.server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}`
    wsUrl = `ws://127.0.0.1:${port}/ws/device`

    const login = await fetch(`${base}/admin/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
    })
    expect(login.status).toBe(204)
    cookie = login.headers.get('set-cookie')!
  })

  afterEach(async () => { await app.close() })

  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      // No content-type without a body: the refresh and delete routes take no body at all, and
      // Fastify rejects an empty one that claims to be JSON before the handler ever runs.
      headers: body === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, json: async () => response.json() as Promise<any> }
  }

  /** A connected device, with the same message queue e2e.test.ts uses. */
  async function connectDevice(name: string, screenId?: string) {
    const { code } = await (await admin('POST', '/admin/api/devices/pairing-codes', { name })).json()
    const paired = await (await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    })).json()
    // Assigned BEFORE the socket opens, which is the real order: a wall panel is configured and
    // then switched on. Connecting first would put an empty STATE ahead of the useful one and
    // prove nothing about what a device sees when it boots.
    if (screenId !== undefined) {
      await admin('PATCH', `/admin/api/devices/${paired.device_id}`, { screen_id: screenId })
    }

    const socket = new WebSocket(wsUrl)
    const queue: any[] = []
    let resolver: ((msg: any) => void) | null = null
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (resolver) { resolver(message); resolver = null } else { queue.push(message) }
    })
    const next = () => new Promise<any>((resolve) => {
      if (queue.length > 0) resolve(queue.shift())
      else resolver = resolve
    })
    /** The next message of one type, so an interleaved STATE cannot fail a DATA assertion. */
    const nextOfType = async (type: string) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const message = await next()
        if (message.type === type) return message
      }
      throw new Error(`no ${type} message arrived`)
    }
    await new Promise((resolve) => socket.on('open', resolve))
    socket.send(JSON.stringify({ type: 'HELLO', token: paired.device_token, caps: { kind: 'journey' } }))
    return { deviceId: paired.device_id as string, socket, next, nextOfType }
  }

  it('goes from an empty hub to changed weather on a device, without a reconnect', async () => {
    /*
     * 1. Discovery. The widget asks what could feed it; nothing has been configured, so the answer
     *    is providers only — and the keyless one is first, because a person who has just dropped a
     *    weather widget on a screen should not have to register for an API key.
     */
    const choices = await (await admin('GET', '/admin/api/source-choices?widget=weather_forecast')).json()
    expect(choices.existing).toEqual([])
    expect(choices.providers[0]).toMatchObject({
      id: 'dashboardz.open-meteo', recommended: true, account: 'No account or API key needed.',
    })

    /*
     * 2. Test before commit. The draft performs the real fetch and returns normalized data — the
     *    answer to "is this the right place?" is the reading itself, not a green tick. Nothing
     *    persistent exists yet.
     */
    const draft = await (await admin('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.open-meteo', name: 'Lisbon weather',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    })).json()
    expect(listSources(db)).toEqual([])

    const forecast = draft.outputs.find((o: any) => o.contract_id === 'dashboardz.weather.daily-forecast/v1')
    expect(forecast.preview.payload.days).toHaveLength(7)
    expect(validateContractOutput('dashboardz.weather.daily-forecast/v1', {
      mode: 'value', payload: forecast.preview.payload,
    }).ok).toBe(true)
    // The optional detail this provider cannot fill, absent from what it claims rather than
    // silently null — which is what lets the dialog say "pollen will be blank" before you commit.
    expect(forecast.capabilities).not.toContain('weather.daily.pollen')

    /*
     * 3. Save the screen. Promotion happens inside the screen-save transaction, so the screen and
     *    the connection it depends on commit together. What comes back is a feed binding — the
     *    draft vocabulary never leaves the editor.
     */
    const fetchesBeforeSave = fetched.length
    const screen = await (await admin('POST', '/admin/api/screens', {
      name: 'Kitchen', orientation: 'landscape',
      grid: { cells: [{
        rect: full,
        widget: 'weather_forecast',
        config: {
          days: 5, show_humidity: true, design: 'forecast',
          source_draft_id: draft.id, output_contract: 'dashboardz.weather.daily-forecast/v1',
        },
      }] },
    })).json()

    // Promotion reuses what the draft already fetched: a second call here would double every
    // provider's request rate at setup time, and could disagree with the preview just approved.
    expect(fetched).toHaveLength(fetchesBeforeSave)
    const feedId = screen.grid.cells[0].config.feed
    expect(feedId).toMatch(/^feed_/)
    expect(JSON.stringify(screen.grid)).not.toContain('source_draft_id')

    /*
     * 4. The glass. A device assigned this screen receives its layout and its data on connect —
     *    the data without a second round trip, because a board that renders a layout and then waits
     *    for content shows an empty frame for as long as that takes.
     */
    const device = await connectDevice('kitchen-panel', screen.id)

    const state = await device.nextOfType('STATE')
    expect(state.screen.grid.cells[0].config.feed).toBe(feedId)
    const data = await device.nextOfType('DATA')
    expect(data.feeds[feedId].payload.days).toHaveLength(7)
    expect(data.feeds[feedId].payload.days[0]).toMatchObject({
      date: expect.any(String), high: expect.any(Number), low: expect.any(Number),
    })

    /*
     * 5. A later refresh reaches the glass on the socket that is already open. This is the whole
     *    point of the platform: no poll from the device, no reload, no reconnect.
     */
    currentWeather = laterWeather()
    const sourceId = listSources(db)[0]!.id
    const refreshed = await admin('POST', `/admin/api/sources/${sourceId}/refresh`)
    expect(refreshed.status).toBe(200)

    // Only the bound feed is pushed: the same source's `weather.current` output exists and was
    // refreshed too, but this screen does not render it, so it is not on this device's wire.
    const currentFeed = listOutputs(db, sourceId)
      .find((output) => output.contract_id === 'dashboardz.weather.current/v1')!.feed_id
    const pushed = await device.nextOfType('DATA')
    expect(pushed.feeds[feedId].payload.days[0].high).toBe(33.4)
    expect(pushed.feeds[currentFeed]).toBeUndefined()
    expect(device.socket.readyState).toBe(WebSocket.OPEN)

    device.socket.close()
  }, 20_000)

  it('offers an existing connection back, and serves two widgets from one poll', async () => {
    const draft = await (await admin('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.open-meteo', name: 'Lisbon weather',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
    })).json()
    const first = await (await admin('POST', '/admin/api/screens', {
      name: 'Kitchen', orientation: 'landscape',
      grid: { cells: [{
        rect: full, widget: 'weather_forecast',
        config: {
          days: 5, design: 'forecast',
          source_draft_id: draft.id, output_contract: 'dashboardz.weather.daily-forecast/v1',
        },
      }] },
    })).json()

    // Second time round, the widget offers what is already connected — no URL to retype, no second
    // account to think about, and no second poll against the same provider.
    const choices = await (await admin('GET', '/admin/api/source-choices?widget=weather_forecast')).json()
    expect(choices.existing).toHaveLength(1)
    expect(choices.existing[0]).toMatchObject({
      source_name: 'Lisbon weather', contract_id: 'dashboardz.weather.daily-forecast/v1',
    })

    const reused = await (await admin('POST', '/admin/api/screens', {
      name: 'Hallway', orientation: 'landscape',
      grid: { cells: [{
        rect: full, widget: 'weather_forecast',
        config: { days: 5, design: 'forecast', feed: choices.existing[0].feed_id },
      }] },
    })).json()

    expect(listSources(db)).toHaveLength(1)
    expect(reused.grid.cells[0].config.feed).toBe(first.grid.cells[0].config.feed)

    // One source, two outputs, two contracts — a single poll fills both, which is why a screen can
    // carry "now" and "this week" without connecting the provider twice.
    const outputs = listOutputs(db, listSources(db)[0]!.id)
    expect(new Set(outputs.map((output) => output.contract_id))).toEqual(new Set([
      'dashboardz.weather.current/v1', 'dashboardz.weather.daily-forecast/v1',
    ]))
  }, 20_000)

  /**
   * What the database is allowed to contain after all of that. Each of these is a leak that would
   * be invisible from the UI and permanent once it happened.
   */
  describe('what is left behind', () => {
    const everyStoredString = (): string => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>
      return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all())).join('\n')
    }

    it('never stores a source credential in plaintext, anywhere', async () => {
      const draft = await (await admin('POST', '/admin/api/source-drafts', {
        provider_id: 'dashboardz.rss', name: 'Family news',
        config: { max_items: 20 }, secrets: { url: PRIVATE_RSS_URL },
      })).json()
      await admin('POST', '/admin/api/screens', {
        name: 'News', orientation: 'landscape',
        grid: { cells: [{
          rect: full, widget: 'news_list',
          config: {
            items: 4, design: 'list',
            source_draft_id: draft.id, output_contract: 'dashboardz.news.items/v1',
          },
        }] },
      })

      // The URL IS the credential for a private feed. It was fetched, so it exists in memory —
      // what must not exist is a row anybody with the database file can read it out of.
      expect(fetched.some((url) => url.startsWith(PRIVATE_RSS_URL))).toBe(true)
      expect(everyStoredString()).not.toContain(PRIVATE_HOST)

      // Nor is it handed back to the browser on re-edit.
      const sources = await (await admin('GET', '/admin/api/sources')).json()
      expect(JSON.stringify(sources)).not.toContain(PRIVATE_HOST)
    })

    it('stores normalized contract data, not the provider’s raw response', async () => {
      await (await admin('POST', '/admin/api/source-drafts', {
        provider_id: 'dashboardz.open-meteo', name: 'Lisbon weather',
        config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {},
      })).json()

      // `temperature_2m` is Open-Meteo's word. Anything storing it has stored the upstream body,
      // which is how a provider's schema change becomes a rendering bug months later.
      const stored = everyStoredString()
      expect(stored).not.toContain('temperature_2m')
      expect(stored).not.toContain('current_units')
    })

    it('leaves nothing at all behind when a test fails', async () => {
      const sourcesBefore = listSources(db).length
      const failed = await admin('POST', '/admin/api/source-drafts', {
        provider_id: 'dashboardz.rss', name: 'Typo',
        config: { max_items: 20 }, secrets: { url: 'https://unreachable.example/nope.xml' },
      })

      expect(failed.status).toBe(422)
      expect(listSources(db)).toHaveLength(sourcesBefore)
      expect((db.prepare('SELECT COUNT(*) AS n FROM feeds').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM source_drafts').get() as { n: number }).n).toBe(0)
    })
  })

  /**
   * The developer's side of the same platform: the seams stay usable without any of the machinery
   * above, and the old way of getting data in still works.
   */
  describe('the developer journey', () => {
    it('still drives a widget from a feed something pushes into by hand', async () => {
      const sender = await (await admin('POST', '/admin/api/senders', { name: 'cron' })).json()
      const feed = await (await admin('POST', '/admin/api/feeds', { name: 'CPU temp', mode: 'value' })).json()
      const screen = await (await admin('POST', '/admin/api/screens', {
        name: 'Rack', orientation: 'landscape',
        grid: { cells: [{ rect: left, widget: 'value_tile', config: { feed: feed.id, path: 'load' } }] },
      })).json()

      const device = await connectDevice('rack-panel', screen.id)
      await device.nextOfType('STATE')
      await device.nextOfType('DATA')

      const push = await fetch(`${base}/api/feeds/${feed.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ load: 1.5 }),
      })
      expect(push.status).toBe(200)

      const data = await device.nextOfType('DATA')
      expect(data.feeds[feed.id].payload).toEqual({ load: 1.5 })
      device.socket.close()
    }, 20_000)

    /** A provider is a plain function over a fixture. No Fastify, no database, no network. */
    it('runs a provider against a fixture with nothing else wired up', async () => {
      const fetchImpl = (async () => new Response(JSON.stringify(weather))) as typeof fetch
      const [current] = await openMeteoProvider.run(
        { config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {} },
        { fetch: fetchImpl, now: Date.UTC(2026, 7, 5, 12), signal: new AbortController().signal },
      )

      expect(current.contract_id).toBe('dashboardz.weather.current/v1')
      expect(validateContractOutput(current.contract_id, current.result).ok).toBe(true)
    })

    /** A shape the contract does not accept fails the same way wherever it comes from. */
    it('rejects a mismatched shape through the same validation path', () => {
      const mismatch = validateContractOutput('dashboardz.weather.current/v1', {
        mode: 'value', payload: { location: { name: 'Nowhere', timezone: null }, current: {} },
      } as any)
      expect(mismatch.ok).toBe(false)

      const wrongMode = validateContractOutput('dashboardz.news.items/v1', {
        mode: 'value', payload: { items: [] },
      } as any)
      expect(wrongMode.ok).toBe(false)
    })
  })
})
