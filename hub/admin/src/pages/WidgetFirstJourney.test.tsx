import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Screens from './Screens'

/**
 * The journey a person actually takes, driven through the real editor.
 *
 * The premise of the whole platform is that somebody who wants the weather on their kitchen screen
 * never learns what a feed is. That claim cannot be checked by any one component's tests: the
 * gallery, the setup dialog, the canvas and the save button each behave correctly in isolation
 * while the path through them still dead-ends. So this drives `Screens` from an empty editor to a
 * saved screen with two live connections, and then back again to reuse one.
 *
 * What it asserts about vocabulary is as load-bearing as what it asserts about state: the words
 * "feed", "contract", "path" and "mode" must not appear anywhere on this path.
 */

const NOW = Date.UTC(2026, 7, 6, 12)

const WEATHER_PREVIEW = {
  location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
  units: { temperature: 'C', wind_speed: 'km/h' },
  days: [
    { date: '2026-08-06', high: 27, low: 18, condition: { code: 'clear', label: 'Clear' } },
    { date: '2026-08-07', high: 26, low: 17, condition: { code: 'partly_cloudy', label: 'Partly cloudy' } },
    { date: '2026-08-08', high: 24, low: 16, condition: { code: 'rain', label: 'Rain' } },
    { date: '2026-08-09', high: 23, low: 16, condition: { code: 'cloudy', label: 'Cloudy' } },
    { date: '2026-08-10', high: 25, low: 17, condition: { code: 'mostly_clear', label: 'Mostly clear' } },
  ],
  attribution: { label: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
}

const NEWS_PREVIEW = [
  { id: 'a', title: 'Rehearsal moved to Thursday', summary: 'The hall is booked.', published_at: NOW, source: 'Example News' },
  { id: 'b', title: 'Bins collected a day late', published_at: NOW - 60_000, source: 'Example News' },
]

const WEATHER_CAPABILITIES = [
  'attribution', 'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
  'weather.daily.temperature.high', 'weather.daily.temperature.low',
]
const NEWS_CAPABILITIES = [
  'news.item.id', 'news.item.title', 'news.item.summary', 'news.item.source', 'news.item.published_at',
]

const openMeteo = {
  id: 'dashboardz.open-meteo', label: 'Open-Meteo', recommended: true,
  default_interval_s: 900, min_interval_s: 300,
  setup: [
    { name: 'city', label: 'Location name', type: 'text', required: true, secret: false },
    { name: 'lat', label: 'Latitude', type: 'number', required: true, secret: false, min: -90, max: 90 },
    { name: 'lon', label: 'Longitude', type: 'number', required: true, secret: false, min: -180, max: 180 },
    {
      name: 'units', label: 'Units', type: 'select', required: true, secret: false,
      options: [{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }],
    },
  ],
  outputs: [{ contract_id: 'dashboardz.weather.daily-forecast/v1', capabilities: WEATHER_CAPABILITIES }],
  compatible_outputs: [{
    contract_id: 'dashboardz.weather.daily-forecast/v1',
    capabilities: WEATHER_CAPABILITIES,
    // Everything this provider genuinely cannot fill. The dialog has to say so in words BEFORE the
    // choice, not leave a blank column on a wall panel afterwards.
    missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen', 'weather.daily.wind'],
  }],
  recommendation: 'Recommended for weather.',
  account: 'No account or API key needed.',
  attribution: 'Weather data includes Open-Meteo attribution.',
}

const rss = {
  id: 'dashboardz.rss', label: 'RSS / Atom', recommended: true,
  default_interval_s: 900, min_interval_s: 300,
  setup: [
    { name: 'url', label: 'Feed URL', type: 'url', required: true, secret: true },
    { name: 'max_items', label: 'Maximum items', type: 'number', required: true, secret: false, min: 1, max: 100 },
  ],
  outputs: [{ contract_id: 'dashboardz.news.items/v1', capabilities: NEWS_CAPABILITIES }],
  compatible_outputs: [{
    contract_id: 'dashboardz.news.items/v1',
    capabilities: NEWS_CAPABILITIES,
    missing_optional: ['attribution', 'news.item.url'],
  }],
  recommendation: 'Recommended for news feeds.',
  account: 'No account is needed; enter the publisher feed URL.',
  attribution: 'Article attribution comes from the configured publisher.',
}

const SECRET_FEED_URL = 'https://family.private.example/news.xml?token=super-secret'

const draftFor = (widget: 'weather_forecast' | 'news_list') => widget === 'weather_forecast'
  ? {
    id: 'drf_weather', provider_id: 'dashboardz.open-meteo', provider: 'Open-Meteo',
    name: 'Lisbon weather', expires_at: NOW + 3_600_000,
    outputs: [{
      contract_id: 'dashboardz.weather.daily-forecast/v1',
      capabilities: WEATHER_CAPABILITIES,
      missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen', 'weather.daily.wind'],
      preview: { mode: 'value', payload: WEATHER_PREVIEW, pushed_at: NOW, stale_after_s: null },
    }],
  }
  : {
    id: 'drf_news', provider_id: 'dashboardz.rss', provider: 'RSS / Atom',
    name: 'Family news', expires_at: NOW + 3_600_000,
    outputs: [{
      contract_id: 'dashboardz.news.items/v1',
      capabilities: NEWS_CAPABILITIES,
      missing_optional: ['attribution', 'news.item.url'],
      preview: {
        mode: 'stream',
        rows: NEWS_PREVIEW.map((item) => ({ payload: item, pushed_at: NOW })),
        pushed_at: NOW, stale_after_s: null,
      },
    }],
  }

/** The saved screen the hub returns: draft ids replaced by the feed each one promoted to. */
const SAVED = {
  id: 'lay_kitchen', name: 'Kitchen', orientation: 'landscape', created_at: 1,
  assigned_count: 0, theme_id: null, rev: 1,
  grid: { cells: [
    { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, widget: 'weather_forecast', config: { days: 5, design: 'forecast', feed: 'feed_weather' } },
    { rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, widget: 'news_list', config: { items: 4, design: 'list', feed: 'feed_news' } },
  ] },
}

/** The connection that now exists, offered back the next time a weather widget is added. */
const EXISTING_WEATHER = {
  source_id: 'src_weather', source_name: 'Lisbon weather', provider_id: 'dashboardz.open-meteo',
  provider: 'Open-Meteo', output_id: 'out_weather', feed_id: 'feed_weather',
  contract_id: 'dashboardz.weather.daily-forecast/v1',
  capabilities: WEATHER_CAPABILITIES,
  missing_optional: ['weather.current', 'weather.daily.humidity', 'weather.daily.pollen', 'weather.daily.wind'],
  last_success_at: NOW - 60_000,
}

interface Write { url: string; method: string; body: any }

const hub = (opts: { screens?: any[]; existing?: any[] } = {}) => {
  const { screens = [], existing = [] } = opts
  const writes: Write[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null })

    if (url === '/admin/api/screens' && method === 'GET') return new Response(JSON.stringify(screens), { status: 200 })
    if (url === '/admin/api/screens' && method === 'POST') return new Response(JSON.stringify(SAVED), { status: 200 })
    if (url.startsWith('/admin/api/screens/') && method === 'PATCH') {
      return new Response(JSON.stringify({ ...SAVED, rev: 2 }), { status: 200 })
    }
    if (url.startsWith('/admin/api/source-choices')) {
      const widget = new URLSearchParams(url.split('?')[1]).get('widget')
      return new Response(JSON.stringify(widget === 'weather_forecast'
        ? {
          widget, title: 'Choose weather data',
          description: 'Reuse a compatible connection or connect a weather provider.',
          existing, providers: [openMeteo],
        }
        : {
          widget, title: 'Choose news data',
          description: 'Reuse a compatible connection or connect a news provider.',
          existing: [], providers: [rss],
        }), { status: 200 })
    }
    if (url.startsWith('/admin/api/geocode')) {
      return new Response(JSON.stringify([
        { name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 },
      ]), { status: 200 })
    }
    if (url === '/admin/api/source-drafts' && method === 'POST') {
      const body = JSON.parse(init!.body as string)
      return new Response(JSON.stringify(
        draftFor(body.provider_id === 'dashboardz.rss' ? 'news_list' : 'weather_forecast'),
      ), { status: 200 })
    }
    if (url === '/admin/api/feeds/feed_weather') {
      return new Response(JSON.stringify({
        id: 'feed_weather', name: 'Lisbon weather', mode: 'value', payload: WEATHER_PREVIEW, rows: [],
      }), { status: 200 })
    }
    if (url === '/admin/api/feeds') return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify([]), { status: 200 })
  }))
  return writes
}

beforeEach(() => {
  // Drafts carry an absolute `expires_at` the dialog checks against Date.now(). On the real clock
  // this file would go red by itself an hour after it was written.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const dialog = () => screen.getByRole('dialog')

/**
 * A fresh layout starts with one full-bleed clock. Every real person drops it the moment they add
 * the widget they actually came for, and so does this — left in place it overlaps everything and
 * the editor refuses to save, which is correct behaviour and nothing to do with the journey.
 */
const cardAt = (container: HTMLElement, index: number) =>
  container.querySelectorAll('[data-testid^="card-"]')[index] as HTMLElement

const dropStarterClock = (container: HTMLElement) => {
  fireEvent.pointerDown(cardAt(container, 0))
  fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
}

const addWidget = async (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add widget' }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

/** Provider chosen, location found, tested — stopping at the preview, before it is accepted. */
async function setUpWeather() {
  await addWidget(/Five-day forecast/i)
  fireEvent.click(await within(dialog()).findByRole('button', { name: 'Set up Open-Meteo' }))

  fireEvent.change(await screen.findByLabelText('City'), { target: { value: 'Lisbon' } })
  fireEvent.click(screen.getByRole('button', { name: 'Find city' }))
  fireEvent.click(await screen.findByRole('option', { name: /Lisbon, Lisbon, Portugal/ }))

  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  return await screen.findByRole('button', { name: 'Use this data' })
}

async function setUpNews() {
  await addWidget(/News list/i)
  fireEvent.click(await within(dialog()).findByRole('button', { name: 'Set up RSS / Atom' }))
  fireEvent.change(await screen.findByLabelText('Feed URL'), { target: { value: SECRET_FEED_URL } })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Use this data' }))
}

describe('the non-technical journey', () => {
  it('builds a weather-and-news screen from the editor, with its connections, in one save', async () => {
    const writes = hub()
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))

    // Choosing the widget is what starts the data conversation — there is no trip to Data sources
    // first, and nothing was written while the person was still deciding.
    const useWeather = await setUpWeather()
    expect(writes.filter((write) => write.url === '/admin/api/screens')).toEqual([])

    // Real data, before committing to it: this is the actual forecast, and the honest list of what
    // this provider will leave blank.
    const omitted = within(dialog()).getByText(/Not included:/).textContent ?? ''
    expect(omitted).toContain('pollen')
    expect(omitted).toContain('humidity')
    fireEvent.click(useWeather)

    // The card is named by its connection and openly not saved yet. Only the selected card shows
    // its inspector, so each is checked as it is added rather than both at the end.
    await waitFor(() => expect(screen.getByText('Lisbon weather')).toBeDefined())
    expect(screen.getAllByText('Not saved yet').length).toBeGreaterThan(0)
    dropStarterClock(container)

    await setUpNews()
    await waitFor(() => expect(screen.getByText('Family news')).toBeDefined())
    expect(screen.getAllByText('Not saved yet').length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Kitchen' } })
    // The button says what it is about to do. "Save layout" would understate it — this creates two
    // persistent connections as well.
    fireEvent.click(screen.getByRole('button', { name: 'Save screen & connections' }))

    await waitFor(() => expect(writes.find((write) => write.url === '/admin/api/screens')).toBeDefined())
    const save = writes.find((write) => write.url === '/admin/api/screens')!
    expect(save.method).toBe('POST')
    expect(save.body.name).toBe('Kitchen')

    // One save carries both drafts. Two round trips would leave a window where a screen exists
    // referencing a connection that does not.
    const drafts = save.body.grid.cells.map((cell: any) => cell.config.source_draft_id)
    expect(new Set(drafts)).toEqual(new Set(['drf_weather', 'drf_news']))
    expect(save.body.grid.cells.map((cell: any) => cell.config.output_contract)).toEqual([
      'dashboardz.weather.daily-forecast/v1', 'dashboardz.news.items/v1',
    ])
  })

  /**
   * The vocabulary check. Every one of these words is real and correct inside the hub, and every
   * one of them is a reason for somebody to give up on a wall display.
   */
  it('never shows the plumbing to the person building the screen', async () => {
    hub()
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    fireEvent.click(await setUpWeather())
    await waitFor(() => expect(screen.getByText('Lisbon weather')).toBeDefined())
    dropStarterClock(container)
    await setUpNews()
    await waitFor(() => expect(screen.getByText('Family news')).toBeDefined())

    const visible = document.body.textContent ?? ''
    for (const jargon of ['feed_', 'drf_', 'contract', 'dashboardz.', 'output_contract', 'stream mode']) {
      expect(visible, `"${jargon}" reached the editor`).not.toContain(jargon)
    }
  })

  /** A typed credential is never echoed anywhere, including into the card that now uses it. */
  it('keeps a typed feed URL out of the page after it has been used', async () => {
    hub()
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await setUpNews()
    await waitFor(() => expect(screen.getByText('Family news')).toBeDefined())

    expect(document.body.textContent ?? '').not.toContain('family.private.example')
    expect(document.body.textContent ?? '').not.toContain('super-secret')
  })

  /**
   * The second time round. Adding another weather widget offers the connection that already
   * exists — no city to find again, no provider to choose, and no second poll against Open-Meteo
   * for data the hub already has.
   */
  it('offers the existing connection back, and binds to it without any setup', async () => {
    const writes = hub({ screens: [SAVED], existing: [EXISTING_WEATHER] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await addWidget(/Five-day forecast/i)

    const reuse = await within(dialog()).findByRole('button', { name: 'Preview Lisbon weather' })
    expect(reuse.textContent).toContain('Open-Meteo')
    fireEvent.click(reuse)

    fireEvent.click(await screen.findByRole('button', { name: 'Use this data' }))
    await waitFor(() => expect(screen.getAllByText('Lisbon weather').length).toBeGreaterThan(0))

    // Reuse creates nothing: no draft was tested, so nothing has to be promoted or cleaned up.
    expect(writes.filter((write) => write.url === '/admin/api/source-drafts')).toEqual([])
    expect(screen.queryByText('Not saved yet')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(writes.find((write) => write.method === 'PATCH')).toBeDefined())
    const saved = writes.find((write) => write.method === 'PATCH')!
    const added = saved.body.grid.cells[saved.body.grid.cells.length - 1]
    expect(added.config.feed).toBe('feed_weather')
    expect(added.config.source_draft_id).toBeUndefined()
  })
})
