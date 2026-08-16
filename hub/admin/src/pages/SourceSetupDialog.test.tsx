import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SourceSetupDialog from './SourceSetupDialog'
import type { SourceSetupResult } from '../source-types'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  // The fixtures date everything from NOW, and drafts carry an absolute `expires_at` that the
  // dialog checks against Date.now(). Left on the real clock these tests only pass while wall
  // time is still before NOW + 1h, so they went red on their own an hour after they were written.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const NOW = Date.UTC(2026, 7, 6, 12)
const SECRET = 'https://private.example.test/news.xml?token=super-secret'
const RAW_BODY = 'private upstream response body'

const WEATHER = {
  location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
  units: { temperature: 'C', wind_speed: 'km/h' },
  days: [
    { date: '2026-08-06', high: 27, low: 18, condition: { code: 'clear', label: 'Clear' }, precipitation_probability_pct: 5 },
    { date: '2026-08-07', high: 26, low: 17, condition: { code: 'partly_cloudy', label: 'Partly cloudy' }, precipitation_probability_pct: 15 },
    { date: '2026-08-08', high: 24, low: 16, condition: { code: 'rain', label: 'Rain' }, precipitation_probability_pct: 70 },
    { date: '2026-08-09', high: 23, low: 16, condition: { code: 'cloudy', label: 'Cloudy' }, precipitation_probability_pct: 25 },
    { date: '2026-08-10', high: 25, low: 17, condition: { code: 'mostly_clear', label: 'Mostly clear' }, precipitation_probability_pct: 10 },
  ],
  attribution: { label: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
}

const NEWS = [
  { id: 'new', title: 'Safe normalized headline', summary: 'A safe summary', published_at: NOW, source: 'Example News' },
  { id: 'old', title: 'Earlier normalized headline', published_at: NOW - 60_000, source: 'Example News' },
]

const weatherProvider = {
  id: 'dashboardz.open-meteo',
  label: 'Open-Meteo',
  recommended: true,
  default_interval_s: 900,
  min_interval_s: 300,
  setup: [
    { name: 'city', label: 'Location name', type: 'text', required: true, secret: false },
    { name: 'lat', label: 'Latitude', type: 'number', required: true, secret: false, min: -90, max: 90 },
    { name: 'lon', label: 'Longitude', type: 'number', required: true, secret: false, min: -180, max: 180 },
    { name: 'units', label: 'Units', type: 'select', required: true, secret: false,
      options: [{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }] },
  ],
  outputs: [
    { contract_id: 'dashboardz.weather.current/v1', capabilities: ['weather.current'] },
    { contract_id: 'dashboardz.weather.daily-forecast/v1', capabilities: [
      'attribution', 'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
      'weather.daily.entries.6', 'weather.daily.entries.7', 'weather.daily.precipitation_probability',
      'weather.daily.temperature.high', 'weather.daily.temperature.low', 'weather.daily.wind',
    ] },
  ],
  compatible_outputs: [{
    contract_id: 'dashboardz.weather.daily-forecast/v1',
    capabilities: [
      'attribution', 'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
      'weather.daily.entries.6', 'weather.daily.entries.7', 'weather.daily.precipitation_probability',
      'weather.daily.temperature.high', 'weather.daily.temperature.low', 'weather.daily.wind',
    ],
    missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen'],
  }],
  recommendation: 'Recommended for weather.',
  account: 'No account or API key needed.',
  attribution: 'Weather data includes Open-Meteo attribution.',
}

const rssProvider = {
  id: 'dashboardz.rss',
  label: 'RSS / Atom',
  recommended: true,
  default_interval_s: 900,
  min_interval_s: 300,
  setup: [
    { name: 'url', label: 'Feed URL', type: 'url', required: true, secret: true },
    { name: 'max_items', label: 'Maximum items', type: 'number', required: true, secret: false, min: 1, max: 100 },
  ],
  outputs: [{ contract_id: 'dashboardz.news.items/v1', capabilities: [
    'news.item.id', 'news.item.title', 'news.item.summary', 'news.item.source', 'news.item.published_at',
  ] }],
  compatible_outputs: [{
    contract_id: 'dashboardz.news.items/v1',
    capabilities: ['news.item.id', 'news.item.title', 'news.item.summary', 'news.item.source', 'news.item.published_at'],
    missing_optional: ['attribution', 'news.item.url'],
  }],
  recommendation: 'Recommended for news feeds.',
  account: 'No account is needed; enter the publisher feed URL.',
  attribution: 'Article attribution comes from the configured publisher.',
}

const weatherChoices = {
  widget: 'weather_forecast',
  title: 'Choose weather data',
  description: 'Reuse a compatible connection or connect a weather provider.',
  existing: [{
    source_id: 'src_weather', source_name: 'Daily weather', provider_id: 'dashboardz.open-meteo',
    provider: 'Open-Meteo', output_id: 'out_weather', feed_id: 'feed_weather',
    contract_id: 'dashboardz.weather.daily-forecast/v1',
    capabilities: [
      'attribution', 'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
      'weather.daily.precipitation_probability', 'weather.daily.temperature.high', 'weather.daily.temperature.low',
    ],
    missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen', 'weather.daily.wind'],
    last_success_at: NOW,
  }],
  providers: [weatherProvider],
}

const newsChoices = {
  widget: 'news_list', title: 'Choose news data',
  description: 'Reuse a compatible connection or connect a news provider.',
  existing: [], providers: [rssProvider],
}

const weatherDraft = (id = 'drf_weather', expiresAt = NOW + 60 * 60 * 1_000) => ({
  id, provider_id: weatherProvider.id, provider: weatherProvider.label, name: 'Lisbon weather',
  expires_at: expiresAt,
  outputs: [{
    contract_id: 'dashboardz.weather.daily-forecast/v1',
    capabilities: weatherProvider.compatible_outputs[0].capabilities,
    missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen'],
    preview: { mode: 'value', payload: WEATHER, pushed_at: NOW, stale_after_s: 2_700 },
  }],
})

const newsDraft = (id = 'drf_news') => ({
  id, provider_id: rssProvider.id, provider: rssProvider.label, name: 'Morning news',
  expires_at: NOW + 60 * 60 * 1_000,
  outputs: [{
    contract_id: 'dashboardz.news.items/v1',
    capabilities: rssProvider.compatible_outputs[0].capabilities,
    missing_optional: ['attribution', 'news.item.url'],
    preview: {
      mode: 'stream', rows: NEWS.map((payload) => ({ payload, pushed_at: NOW })),
      pushed_at: NOW, stale_after_s: 2_700,
    },
  }],
})

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})

interface RequestRecord {
  url: string
  method: string
  body: any
  signal?: AbortSignal | null
}

type FetchOverride = (
  request: RequestRecord,
) => Response | Promise<Response> | undefined

function stubApi(override?: FetchOverride) {
  const requests: RequestRecord[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const request = {
      url, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : null,
      signal: init?.signal,
    }
    requests.push(request)
    const custom = override?.(request)
    if (custom) return custom
    if (url === '/admin/api/source-choices?widget=weather_forecast') return json(weatherChoices)
    if (url === '/admin/api/source-choices?widget=news_list') return json(newsChoices)
    if (url === '/admin/api/feeds/feed_weather') {
      return json({ id: 'feed_weather', name: 'Daily weather', mode: 'value', payload: WEATHER, rows: [] })
    }
    if (url.startsWith('/admin/api/geocode')) {
      return json([{ name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 }])
    }
    if (url === '/admin/api/source-drafts' && request.method === 'POST') return json(weatherDraft())
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    return json({ error: 'unexpected_test_request' }, 500)
  }))
  return requests
}

function setup(widget: 'weather_forecast' | 'news_list' = 'weather_forecast', config: Record<string, unknown> = {}) {
  const onUse = vi.fn<(result: SourceSetupResult) => void>()
  const onCancel = vi.fn()
  const view = render(<SourceSetupDialog widget={widget} config={config} onUse={onUse} onCancel={onCancel} />)
  return { ...view, onUse, onCancel, user: userEvent.setup() }
}

async function openWeatherSetup(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Use an existing connection' })
  await user.click(screen.getByRole('button', { name: /set up open-meteo/i }))
}

async function chooseLisbon(user: ReturnType<typeof userEvent.setup>) {
  const city = screen.getByRole('combobox', { name: 'City' })
  await user.clear(city)
  await user.type(city, 'Lisbon')
  await user.click(screen.getByRole('button', { name: 'Find city' }))
  await user.click(await screen.findByRole('option', { name: 'Lisbon, Lisbon, Portugal' }))
}

async function openNewsSetup(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Connect a provider' })
  await user.click(screen.getByRole('button', { name: /set up rss \/ atom/i }))
}

describe('guided source setup', () => {
  it('retries an unavailable choice list without exposing the server response', async () => {
    let attempts = 0
    stubApi((request) => {
      if (request.url === '/admin/api/source-choices?widget=weather_forecast') {
        attempts++
        return attempts === 1 ? json({ error: RAW_BODY, message: RAW_BODY }, 503) : json(weatherChoices)
      }
      return undefined
    })
    const { user } = setup()

    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load connection choices')
    expect(document.body.innerHTML).not.toContain(RAW_BODY)
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { name: 'Use an existing connection' })).toBeDefined()
    expect(attempts).toBe(2)
  })

  it('puts reusable connections before recommended providers and describes optional details in human terms', async () => {
    stubApi()
    setup()

    const existing = await screen.findByRole('heading', { name: 'Use an existing connection' })
    const providers = screen.getByRole('heading', { name: 'Connect a provider' })
    expect(existing.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const card = screen.getByRole('button', { name: /preview daily weather/i })
    expect(card.textContent).toContain('Daily weather')
    expect(card.textContent).toContain('Open-Meteo')
    expect(card.textContent).toContain('Last refreshed')
    expect(card.textContent).toContain('Available: Attribution, precipitation')
    expect(card.textContent).toContain('Not included: Current conditions, humidity, pollen, wind')

    const providerGroup = providers.parentElement!
    const firstProvider = within(providerGroup).getAllByRole('button')[0]
    expect(firstProvider.textContent).toContain('Recommended')
    expect(firstProvider.textContent).toContain('Open-Meteo')
    expect(firstProvider.textContent).toContain('No account or API key needed.')
    expect(screen.getByRole('dialog').textContent?.toLowerCase()).not.toMatch(/\bfeed\b|contract id|source instance|json path/)
  })

  it('previews an existing connection with real data and emits exactly its reusable binding plus safe preview', async () => {
    stubApi()
    const { onUse, user } = setup()

    await user.click(await screen.findByRole('button', { name: /preview daily weather/i }))
    expect(await screen.findByRole('heading', { name: 'Preview with real data' })).toBeDefined()
    expect(screen.getByLabelText('Five-day forecast preview')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Use this data' }))

    expect(onUse).toHaveBeenCalledTimes(1)
    expect(onUse).toHaveBeenCalledWith({
      binding: { feed: 'feed_weather' },
      preview: WEATHER,
      connection: { name: 'Daily weather', provider: 'Open-Meteo' },
      missing_optional: weatherChoices.existing[0].missing_optional,
    })
  })

  it('generates the weather form from server fields, keeps coordinates and refresh under Advanced, and uses city results', async () => {
    const requests = stubApi()
    const { user } = setup('weather_forecast', { days: 5 })
    await openWeatherSetup(user)

    expect(screen.getByLabelText('Connection name')).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'City' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByLabelText('Units')).toBeDefined()
    const advanced = screen.getByText('Advanced').parentElement as HTMLDetailsElement
    expect(advanced.open).toBe(false)
    expect(advanced.contains(screen.getByLabelText('Latitude'))).toBe(true)
    expect(advanced.contains(screen.getByLabelText('Longitude'))).toBe(true)
    expect(advanced.contains(screen.getByLabelText('Refresh every (seconds)'))).toBe(true)

    await chooseLisbon(user)
    await user.click(screen.getByText('Advanced'))
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).valueAsNumber).toBe(38.72)
    expect((screen.getByLabelText('Longitude') as HTMLInputElement).valueAsNumber).toBe(-9.14)
    expect((screen.getByLabelText('Refresh every (seconds)') as HTMLInputElement).valueAsNumber).toBe(900)
    expect(screen.getByText('Open-Meteo allows refreshes every 300 seconds or slower.')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })
    const post = requests.find(({ url, method }) => url === '/admin/api/source-drafts' && method === 'POST')
    expect(post?.body).toEqual({
      provider_id: 'dashboardz.open-meteo', name: 'Lisbon',
      config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' },
      secrets: {}, interval_s: 900,
    })
  })

  it('generates RSS fields from the server schema and treats secret fields as write-only', async () => {
    let resolveDraft!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveDraft = resolve })
    stubApi((request) => request.url === '/admin/api/source-drafts' && request.method === 'POST'
      ? pending
      : undefined)
    const { user } = setup('news_list', { items: 5 })
    await openNewsSetup(user)

    const secret = screen.getByLabelText('Feed URL') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.autocomplete).toBe('off')
    expect((screen.getByLabelText('Maximum items') as HTMLInputElement).valueAsNumber).toBe(20)
    await user.clear(screen.getByLabelText('Connection name'))
    await user.type(screen.getByLabelText('Connection name'), 'Morning news')
    await user.type(secret, SECRET)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByRole('status', { name: 'Testing connection' })).toBeDefined()
    expect(secret.value).toBe('')
    expect(document.body.textContent).not.toContain(SECRET)
    resolveDraft(json(newsDraft()))
    await screen.findByRole('heading', { name: 'Preview with real data' })
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('blocks double submission synchronously and renders the actual safe draft preview before explicit use', async () => {
    let resolveDraft!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveDraft = resolve })
    const requests = stubApi((request) => request.url === '/admin/api/source-drafts' && request.method === 'POST'
      ? pending
      : undefined)
    const { onUse, user } = setup()
    await openWeatherSetup(user)
    await chooseLisbon(user)

    await user.dblClick(screen.getByRole('button', { name: 'Test connection' }))
    expect(requests.filter(({ url, method }) => url === '/admin/api/source-drafts' && method === 'POST')).toHaveLength(1)
    expect(await screen.findByRole('status', { name: 'Testing connection' })).toBeDefined()
    resolveDraft(json(weatherDraft()))

    expect(await screen.findByRole('heading', { name: 'Preview with real data' })).toBeDefined()
    expect(screen.getByText('Not included: Current conditions, humidity, pollen')).toBeDefined()
    expect(screen.getByLabelText('Five-day forecast preview')).toBeDefined()
    await user.dblClick(screen.getByRole('button', { name: 'Use this data' }))
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(onUse).toHaveBeenCalledWith({
      binding: { source_draft_id: 'drf_weather', output_contract: 'dashboardz.weather.daily-forecast/v1' },
      preview: WEATHER,
      connection: { name: 'Lisbon weather', provider: 'Open-Meteo' },
      missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen'],
    })
  })

  it('ignores a late successful test after cancellation and deletes the stale draft', async () => {
    let resolveDraft!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveDraft = resolve })
    const requests = stubApi((request) => request.url === '/admin/api/source-drafts' && request.method === 'POST'
      ? pending
      : undefined)
    const { onCancel, user } = setup()
    await openWeatherSetup(user)
    await chooseLisbon(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('status', { name: 'Testing connection' })

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    resolveDraft(json(weatherDraft('drf_too_late')))

    await waitFor(() => expect(requests.some(({ method, url }) =>
      method === 'DELETE' && url.endsWith('/drf_too_late'))).toBe(true))
    expect(screen.queryByRole('heading', { name: 'Preview with real data' })).toBeNull()
  })

  it('retests with supersedes, leaves secret inputs blank, and owns only the replacement draft', async () => {
    const liveDrafts = new Set<string>()
    const returned = [newsDraft('drf_first'), newsDraft('drf_second')]
    const requests = stubApi((request) => {
      if (request.url === '/admin/api/source-drafts' && request.method === 'POST') {
        const draft = returned.shift()!
        if (request.body.supersedes) liveDrafts.delete(request.body.supersedes)
        liveDrafts.add(draft.id)
        return json(draft)
      }
      if (request.method === 'DELETE') {
        liveDrafts.delete(request.url.split('/').pop()!)
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    const { user } = setup('news_list')
    await openNewsSetup(user)
    await user.type(screen.getByLabelText('Feed URL'), SECRET)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })

    await user.click(screen.getByRole('button', { name: 'Change details' }))
    expect((screen.getByLabelText('Feed URL') as HTMLInputElement).value).toBe('')
    await user.type(screen.getByLabelText('Feed URL'), 'https://example.test/replacement.xml')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })

    const posts = requests.filter(({ url, method }) => url === '/admin/api/source-drafts' && method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1].body.supersedes).toBe('drf_first')
    expect([...liveDrafts]).toEqual(['drf_second'])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(liveDrafts.size).toBe(0))
    expect(requests.some(({ method, url }) => method === 'DELETE' && url.endsWith('/drf_first'))).toBe(false)
    expect(requests.some(({ method, url }) => method === 'DELETE' && url.endsWith('/drf_second'))).toBe(true)
  })

  it('discards a prepared draft before backing out to choose another connection', async () => {
    const liveDrafts = new Set<string>()
    stubApi((request) => {
      if (request.url === '/admin/api/source-drafts' && request.method === 'POST') {
        liveDrafts.add('drf_backed_out')
        return json(newsDraft('drf_backed_out'))
      }
      if (request.method === 'DELETE') {
        liveDrafts.delete(request.url.split('/').pop()!)
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    const { user } = setup('news_list')
    await openNewsSetup(user)
    await user.type(screen.getByLabelText('Feed URL'), SECRET)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })
    await user.click(screen.getByRole('button', { name: 'Change details' }))

    await user.click(screen.getByRole('button', { name: 'Back' }))

    await screen.findByRole('heading', { name: 'Connect a provider' })
    await waitFor(() => expect([...liveDrafts]).toEqual([]))
  })

  it('recovers an expired draft in the setup step instead of emitting an unusable binding', async () => {
    let clock = NOW
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const requests = stubApi((request) => request.url === '/admin/api/source-drafts' && request.method === 'POST'
      ? json(weatherDraft('drf_expiring', NOW + 100))
      : undefined)
    const { onUse, user } = setup()
    await openWeatherSetup(user)
    await chooseLisbon(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })

    clock = NOW + 101
    await user.click(screen.getByRole('button', { name: 'Use this data' }))

    expect(onUse).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Set up Open-Meteo' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('preview expired')
    await waitFor(() => expect(requests.some(({ method, url }) => method === 'DELETE' && url.endsWith('/drf_expiring'))).toBe(true))
  })

  it('keeps actionable provider errors in setup and never renders raw error bodies or typed secrets', async () => {
    stubApi((request) => request.url === '/admin/api/source-drafts' && request.method === 'POST'
      ? json({ error: RAW_BODY, message: `${RAW_BODY}: ${SECRET}` }, 422)
      : undefined)
    const { user } = setup('news_list')
    await openNewsSetup(user)
    await user.type(screen.getByLabelText('Feed URL'), SECRET)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByRole('heading', { name: 'Set up RSS / Atom' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t fetch usable data')
    expect((screen.getByLabelText('Feed URL') as HTMLInputElement).value).toBe('')
    expect(document.body.innerHTML).not.toContain(RAW_BODY)
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('ignores unsafe prototype-shaped setup fields and stale geocoding responses', async () => {
    let resolveLisbon!: (response: Response) => void
    let resolvePorto!: (response: Response) => void
    const lisbon = new Promise<Response>((resolve) => { resolveLisbon = resolve })
    const porto = new Promise<Response>((resolve) => { resolvePorto = resolve })
    const hostileChoices = {
      ...weatherChoices,
      existing: [],
      providers: [{ ...weatherProvider, setup: [
        ...weatherProvider.setup,
        { name: '__proto__', label: 'Prototype trap', type: 'text', required: false, secret: false },
        { name: 'constructor', label: 'Constructor trap', type: 'text', required: false, secret: false },
      ] }],
    }
    let geocodeCalls = 0
    const requests = stubApi((request) => {
      if (request.url === '/admin/api/source-choices?widget=weather_forecast') return json(hostileChoices)
      if (request.url.startsWith('/admin/api/geocode')) {
        geocodeCalls++
        return geocodeCalls === 1 ? lisbon : porto
      }
      return undefined
    })
    const { user } = setup()
    await openWeatherSetup(user)
    expect(screen.queryByLabelText('Prototype trap')).toBeNull()
    expect(screen.queryByLabelText('Constructor trap')).toBeNull()

    const city = screen.getByRole('combobox', { name: 'City' })
    await user.type(city, 'Lisbon')
    await user.click(screen.getByRole('button', { name: 'Find city' }))
    await user.clear(city)
    await user.type(city, 'Porto')
    await user.click(screen.getByRole('button', { name: 'Find city' }))
    resolvePorto(json([{ name: 'Porto', region: 'Porto', country: 'Portugal', lat: 41.15, lon: -8.61 }]))
    expect(await screen.findByRole('option', { name: 'Porto, Porto, Portugal' })).toBeDefined()
    resolveLisbon(json([{ name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 }]))
    await waitFor(() => expect(screen.queryByRole('option', { name: /Lisbon/ })).toBeNull())

    await user.click(screen.getByRole('option', { name: 'Porto, Porto, Portugal' }))
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })
    const post = requests.find(({ url, method }) => url === '/admin/api/source-drafts' && method === 'POST')!
    expect(Object.hasOwn(post.body.config, '__proto__')).toBe(false)
    expect(Object.hasOwn(post.body.config, 'constructor')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('invalidates a pending city search before leaving and reopening provider setup', async () => {
    let resolveSearch!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { resolveSearch = resolve })
    const requests = stubApi((request) => request.url.startsWith('/admin/api/geocode') ? pending : undefined)
    const { user } = setup()
    await openWeatherSetup(user)
    await user.type(screen.getByRole('combobox', { name: 'City' }), 'Lisbon')
    await user.click(screen.getByRole('button', { name: 'Find city' }))

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(await screen.findByRole('button', { name: /set up open-meteo/i }))
    resolveSearch(json([{ name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 }]))

    await waitFor(() => expect(screen.queryByRole('option', { name: /Lisbon/ })).toBeNull())
    expect((screen.getByRole('combobox', { name: 'City' }) as HTMLInputElement).value).toBe('')
    const geocode = requests.find(({ url }) => url.startsWith('/admin/api/geocode'))
    expect(geocode?.signal?.aborted).toBe(true)
  })

  it('operates city results by keyboard with an active option and Enter selection', async () => {
    stubApi((request) => request.url.startsWith('/admin/api/geocode') ? json([
      { name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 },
      { name: 'Porto', region: 'Porto', country: 'Portugal', lat: 41.15, lon: -8.61 },
    ]) : undefined)
    const { user } = setup()
    await openWeatherSetup(user)
    const city = screen.getByRole('combobox', { name: 'City' }) as HTMLInputElement
    await user.type(city, 'Portugal')
    await user.click(screen.getByRole('button', { name: 'Find city' }))
    const lisbon = await screen.findByRole('option', { name: 'Lisbon, Lisbon, Portugal' })
    const porto = screen.getByRole('option', { name: 'Porto, Porto, Portugal' })
    city.focus()

    await user.keyboard('{ArrowDown}')
    expect(city.getAttribute('aria-activedescendant')).toBe(lisbon.id)
    expect(lisbon.getAttribute('aria-selected')).toBe('true')
    expect(porto.getAttribute('aria-selected')).toBe('false')
    await user.keyboard('{ArrowDown}')
    expect(city.getAttribute('aria-activedescendant')).toBe(porto.id)
    expect(porto.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(city.getAttribute('aria-activedescendant')).toBe(lisbon.id)
    await user.keyboard('{ArrowUp}')
    expect(city.getAttribute('aria-activedescendant')).toBe(porto.id)
    await user.keyboard('{Enter}')

    expect(city.value).toBe('Porto')
    expect(city.getAttribute('aria-activedescendant')).toBeNull()
    expect(screen.queryByRole('listbox', { name: 'Matching cities' })).toBeNull()
  })

  it('does not close over a draft when cleanup fails, and retries before restoring opener focus', async () => {
    let deletes = 0
    stubApi((request) => {
      if (request.url === '/admin/api/source-drafts' && request.method === 'POST') return json(weatherDraft())
      if (request.method === 'DELETE') {
        deletes++
        return deletes === 1
          ? json({ error: RAW_BODY, message: RAW_BODY }, 500)
          : new Response(null, { status: 204 })
      }
      return undefined
    })
    const opener = document.createElement('button')
    opener.textContent = 'Open setup'
    document.body.append(opener)
    opener.focus()
    const { onCancel, user } = setup()
    await openWeatherSetup(user)
    await chooseLisbon(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t discard')
    expect(document.body.innerHTML).not.toContain(RAW_BODY)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('treats an already-expired draft as cleaned when cancelling', async () => {
    stubApi((request) => {
      if (request.url === '/admin/api/source-drafts' && request.method === 'POST') return json(weatherDraft())
      if (request.method === 'DELETE') return json({ error: 'not_found' }, 404)
      return undefined
    })
    const { onCancel, user } = setup()
    await openWeatherSetup(user)
    await chooseLisbon(user)
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/couldn’t discard/i)).toBeNull()
  })

  it('traps keyboard focus, cancels with Escape, and aborts requests plus cleans a draft on unmount', async () => {
    const requests = stubApi()
    const opener = document.createElement('button')
    opener.textContent = 'Open setup'
    document.body.append(opener)
    opener.focus()
    const first = setup()
    const dialog = await screen.findByRole('dialog')
    await screen.findByRole('heading', { name: 'Use an existing connection' })
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    const buttons = within(dialog).getAllByRole('button')
    await first.user.tab({ shift: true })
    expect(document.activeElement).toBe(buttons.at(-1))
    dialog.focus()
    await first.user.tab()
    expect(document.activeElement).toBe(buttons[0])
    buttons.at(-1)!.focus()
    await first.user.tab()
    expect(document.activeElement).toBe(buttons[0])
    await first.user.keyboard('{Escape}')
    expect(first.onCancel).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(opener)
    first.unmount()

    const second = setup()
    await openWeatherSetup(second.user)
    await chooseLisbon(second.user)
    await second.user.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('heading', { name: 'Preview with real data' })
    second.unmount()

    await waitFor(() => expect(requests.some(({ method, url }) => method === 'DELETE' && url.endsWith('/drf_weather'))).toBe(true))
    expect(requests.some(({ signal }) => signal?.aborted)).toBe(true)
    opener.remove()
  })
})
