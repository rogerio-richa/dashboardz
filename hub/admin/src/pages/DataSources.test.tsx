import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Feeds from './Feeds'
import App from '../App'

/**
 * Data sources is the basement for CONNECTIONS (data-source behavior).
 *
 * Screens are built widget-first in the Screens tab, and a widget's guided setup is where a
 * connection is normally born. This page is where an operator comes afterwards, with a different
 * question: is the weather still arriving, why did the calendar stop, what breaks if I delete this.
 * So the default view is one row per persistent connection — not one row per output feed, and not
 * one row per v18 connector, which no longer exists.
 *
 * Only the LABEL is "Data sources". The route, the tab id and the localStorage key stay `Feeds`, so
 * an admin left open on this tab across the upgrade is still on it afterwards.
 */

const NOW = Date.UTC(2026, 7, 6, 12)
const MINUTE = 60_000

/** Healthy, used by two widgets on one screen and a third on another. */
const WEATHER = {
  id: 'src_weather',
  name: 'Lisbon weather',
  provider: { id: 'dashboardz.open-meteo', label: 'Open-Meteo', available: true },
  config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' },
  interval_s: 900,
  enabled: true,
  health: {
    state: 'healthy', status: 'Connection is healthy.',
    last_run_at: NOW - MINUTE, last_success_at: NOW - MINUTE,
    next_refresh_at: NOW + 14 * MINUTE, failure_count: 0, rate_limited_until: null,
  },
  outputs: [
    {
      id: 'out_now', contract_id: 'dashboardz.weather.current/v1', feed_id: 'feed_now',
      capabilities: ['weather.now.temperature'], last_valid_at: NOW - MINUTE,
      usages: [{ screen_id: 'scr_kitchen', screen_name: 'Kitchen' }],
    },
    {
      id: 'out_week', contract_id: 'dashboardz.weather.daily-forecast/v1', feed_id: 'feed_week',
      capabilities: ['weather.day.high'], last_valid_at: NOW - MINUTE,
      usages: [
        { screen_id: 'scr_kitchen', screen_name: 'Kitchen' },
        { screen_id: 'scr_hall', screen_name: 'Hallway' },
      ],
    },
  ],
  usages: [
    { screen_id: 'scr_kitchen', screen_name: 'Kitchen' },
    { screen_id: 'scr_hall', screen_name: 'Hallway' },
  ],
}

/** Broken and unused — the two states that need different words from "Healthy". */
const NEWS = {
  id: 'src_news',
  name: 'Family news',
  provider: { id: 'dashboardz.rss', label: 'RSS', available: true },
  config: { max_items: 20 },
  interval_s: 1800,
  enabled: true,
  health: {
    state: 'authentication_required',
    status: 'Authentication is required; update this connection’s credentials.',
    last_run_at: NOW - 5 * MINUTE, last_success_at: NOW - 3 * 60 * MINUTE,
    next_refresh_at: NOW + 25 * MINUTE, failure_count: 3, rate_limited_until: null,
  },
  outputs: [{
    id: 'out_news', contract_id: 'dashboardz.news.items/v1', feed_id: 'feed_news',
    capabilities: ['news.item.title'], last_valid_at: NOW - 3 * 60 * MINUTE, usages: [],
  }],
  usages: [],
}

/** Paused deliberately. `state` is still whatever the last run left behind — `enabled` decides. */
const CALENDAR = {
  id: 'src_cal',
  name: 'Family calendar',
  provider: { id: 'dashboardz.ical', label: 'iCalendar', available: true },
  config: { lookahead_days: 7, max_events: 20 },
  interval_s: 300,
  enabled: false,
  health: {
    state: 'healthy', status: 'Connection is healthy.',
    last_run_at: NOW - 2 * 60 * MINUTE, last_success_at: NOW - 2 * 60 * MINUTE,
    next_refresh_at: null, failure_count: 0, rate_limited_until: null,
  },
  outputs: [{
    id: 'out_cal', contract_id: 'dashboardz.calendar.events/v1', feed_id: 'feed_cal',
    capabilities: [], last_valid_at: NOW - 2 * 60 * MINUTE, usages: [],
  }],
  usages: [],
}

const PROVIDERS = [
  {
    id: 'dashboardz.ical', label: 'iCalendar', recommended: false,
    default_interval_s: 300, min_interval_s: 60,
    setup: [
      { name: 'url', label: 'Calendar URL', type: 'url', required: true, secret: true },
      { name: 'lookahead_days', label: 'Look-ahead days', type: 'number', required: true, secret: false, min: 1, max: 60 },
      { name: 'max_events', label: 'Maximum events', type: 'number', required: true, secret: false, min: 1, max: 50 },
    ],
    outputs: [{ contract_id: 'dashboardz.calendar.events/v1', capabilities: [] }],
    recommendation: 'Use a published iCalendar URL.',
    account: 'No account is needed; a calendar URL is required.',
    attribution: 'Calendar details come from the configured publisher.',
  },
  {
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
    outputs: [
      { contract_id: 'dashboardz.weather.current/v1', capabilities: ['weather.now.temperature'] },
      { contract_id: 'dashboardz.weather.daily-forecast/v1', capabilities: ['weather.day.high'] },
    ],
    recommendation: 'Recommended for weather.',
    account: 'No account or API key needed.',
    attribution: 'Weather data includes Open-Meteo attribution.',
  },
  {
    id: 'dashboardz.rss', label: 'RSS', recommended: true,
    default_interval_s: 900, min_interval_s: 300,
    setup: [
      { name: 'url', label: 'Feed URL', type: 'url', required: true, secret: true },
      { name: 'max_items', label: 'Maximum items', type: 'number', required: true, secret: false, min: 1, max: 100 },
    ],
    outputs: [{ contract_id: 'dashboardz.news.items/v1', capabilities: ['news.item.title'] }],
    recommendation: 'Recommended for news feeds.',
    account: 'No account is needed; enter the publisher feed URL.',
    attribution: 'Article attribution comes from the configured publisher.',
  },
]

const DRAFT = {
  id: 'drf_1', provider_id: 'dashboardz.rss', provider: 'RSS', name: 'Family news',
  expires_at: NOW + 60 * MINUTE,
  outputs: [{
    contract_id: 'dashboardz.news.items/v1',
    capabilities: ['news.item.title'],
    missing_optional: [],
    preview: {
      mode: 'stream',
      rows: [{ payload: { title: 'Rehearsal moved to Thursday' }, pushed_at: NOW }],
      pushed_at: NOW, stale_after_s: null,
    },
  }],
}

/** Feeds behind provider outputs, plus the one nobody's provider owns. */
const OUTPUT_FEEDS = ['feed_now', 'feed_week', 'feed_news', 'feed_cal'].map((id, i) => ({
  id, name: `output ${id}`, mode: 'value', cap: 50,
  stale_after_s: 2700, alert_on_stale: true, allowed_senders: null,
  pushed_at: NOW - MINUTE, pushed_by: 'src_weather', image_rev: 0, created_at: i + 1,
  source: null,
}))
const PUSHED_FEED = {
  id: 'feed_cpu', name: 'CPU temp', mode: 'value', cap: 50,
  stale_after_s: 60, alert_on_stale: true, allowed_senders: null,
  pushed_at: NOW - 5000, pushed_by: 'snd_1', image_rev: 0, created_at: 9,
  source: null,
}

interface Write { url: string; method: string; body: any }

const stub = (opts: {
  sources?: any[]
  providers?: any[]
  feeds?: any[]
  respond?: (url: string, method: string) => Response | Promise<Response> | undefined
} = {}) => {
  const { sources = [WEATHER, NEWS, CALENDAR], providers = PROVIDERS, feeds = [...OUTPUT_FEEDS, PUSHED_FEED] } = opts
  const writes: Write[] = []
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    if (method !== 'GET') writes.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null })
    const canned = opts.respond?.(url, method)
    if (canned) return canned
    if (url === '/admin/api/sources' && method === 'GET') return new Response(JSON.stringify(sources), { status: 200 })
    if (url === '/admin/api/providers') return new Response(JSON.stringify(providers), { status: 200 })
    if (url === '/admin/api/feeds' && method === 'GET') return new Response(JSON.stringify(feeds), { status: 200 })
    if (url === '/admin/api/config') return new Response(JSON.stringify({ public_url: 'http://x', brand: 'Dashboardz' }), { status: 200 })
    if (/^\/admin\/api\/feeds\/[^/]+$/.test(url) && method === 'GET') {
      return new Response(JSON.stringify({ ...PUSHED_FEED, payload: null, rows: [], references: [] }), { status: 200 })
    }
    if (url === '/admin/api/source-drafts' && method === 'POST') return new Response(JSON.stringify(DRAFT), { status: 200 })
    if (/\/promote$/.test(url)) return new Response(JSON.stringify({ source: NEWS, outputs: NEWS.outputs }), { status: 200 })
    if (/^\/admin\/api\/sources\/[^/]+\/refresh$/.test(url)) return new Response(JSON.stringify(WEATHER), { status: 200 })
    if (/^\/admin\/api\/sources\/[^/]+/.test(url) && method === 'PATCH') return new Response(JSON.stringify(WEATHER), { status: 200 })
    if (/\/setup$/.test(url)) return new Response(JSON.stringify(WEATHER), { status: 200 })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify([]), { status: 200 })
  }))
  return { writes, calls }
}

const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status })

beforeEach(() => {
  // The fixtures date everything from NOW. Left on the real clock, "1m ago" and "in 14m" would
  // drift out from under the assertions the moment wall time moved on — the same time bomb that
  // went off in SourceSetupDialog.test.tsx.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const rowFor = async (name: string): Promise<HTMLElement> => {
  const cell = await screen.findByText(name)
  return cell.closest('tr') as HTMLElement
}

/** The heading's Add button — the one door into creating any kind of source now. */
const openAdd = () => fireEvent.click(screen.getByRole('button', { name: 'Add' }))

describe('the tab is called Data sources', () => {
  it('says so in the heading', async () => {
    stub()
    render(<Feeds />)
    expect(await screen.findByRole('heading', { name: 'Data sources' })).toBeDefined()
  })

  /** The id and the stored preference stay `Feeds` — only what a person reads changes. */
  it('says so in the nav, without moving the tab', async () => {
    stub()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Data sources/ })).toBeDefined())
    expect(screen.queryByRole('button', { name: /^Feeds$/ })).toBeNull()
  })
})

describe('the default view lists connections', () => {
  it('shows one row per connection, whatever number of outputs it fills', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')

    // Two outputs, one row. A row per output would show this connection twice and invite an
    // operator to pause half of it.
    expect(screen.getAllByText('Lisbon weather')).toHaveLength(1)
    expect(screen.getByText('Family news')).toBeDefined()
    expect(screen.getByText('Family calendar')).toBeDefined()
  })

  it('names the provider behind each connection', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    expect(within(row).getByText('Open-Meteo')).toBeDefined()
  })

  /**
   * Three words, because there are only three things an operator does next: nothing, fix it, or
   * resume it. The wire has six states and they are not a vocabulary anyone should have to learn.
   */
  it('reduces the wire state to Healthy, Needs attention or Paused', async () => {
    stub()
    render(<Feeds />)
    expect(within(await rowFor('Lisbon weather')).getByText('Healthy')).toBeDefined()
    expect(within(await rowFor('Family news')).getByText('Needs attention')).toBeDefined()
    expect(within(await rowFor('Family calendar')).getByText('Paused')).toBeDefined()
  })

  /** Pausing does not rewrite `state`, so a paused-but-healthy connection must read as Paused. */
  it('lets Paused win over the last run’s state', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Family calendar')
    expect(within(row).queryByText('Healthy')).toBeNull()
  })

  it('repeats the server’s actionable status rather than inventing one', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Family news')
    expect(within(row).getByText(/Authentication is required/)).toBeDefined()
  })

  it('reports the last success and the next attempt in human time', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    expect(within(row).getByText('1m ago')).toBeDefined()
    expect(within(row).getByText('in 14m')).toBeDefined()
  })

  /** Never-succeeded and paused are both "there is no timestamp", and they mean different things. */
  it('says never for a connection that has not succeeded, and dashes a paused next attempt', async () => {
    const cold = { ...NEWS, health: { ...NEWS.health, last_success_at: null } }
    stub({ sources: [cold, CALENDAR] })
    render(<Feeds />)
    expect(within(await rowFor('Family news')).getByText('never')).toBeDefined()
    expect(within(await rowFor('Family calendar')).getByText('—')).toBeDefined()
  })

  /**
   * Three widget bindings across two screens. The screen count de-duplicates and the widget count
   * does not: an operator deleting this breaks three widgets, and two screens go part-blank.
   */
  it('counts widgets across outputs and screens only once', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    expect(within(row).getByText('Used by 3 widgets on 2 screens')).toBeDefined()
    expect(within(row).getByText(/Kitchen/)).toBeDefined()
    expect(within(row).getByText(/Hallway/)).toBeDefined()
  })

  it('singularises a connection used once', async () => {
    const single = {
      ...NEWS,
      outputs: [{ ...NEWS.outputs[0], usages: [{ screen_id: 'scr_hall', screen_name: 'Hallway' }] }],
      usages: [{ screen_id: 'scr_hall', screen_name: 'Hallway' }],
    }
    stub({ sources: [single] })
    render(<Feeds />)
    expect(within(await rowFor('Family news')).getByText('Used by 1 widget on 1 screen')).toBeDefined()
  })

  /** Suggested, never acted on. An unused connection may be one somebody is about to bind. */
  it('suggests cleanup for an unused connection without touching it', async () => {
    const { writes } = stub()
    render(<Feeds />)
    const row = await rowFor('Family news')
    expect(within(row).getByText(/Not used by any widget/)).toBeDefined()
    expect(within(row).getByText(/Safe to remove/)).toBeDefined()
    await waitFor(() => expect(screen.getByText('Family calendar')).toBeDefined())
    expect(writes).toEqual([])
  })

  /** The outputs are plumbing. They are not rows, and they have no delete of their own. */
  it('never lists a provider-owned output feed as a row of its own', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    for (const feed of OUTPUT_FEEDS) expect(screen.queryByText(feed.name)).toBeNull()
  })

  it('asks the v19 source API and never the retired connector one', async () => {
    const { calls } = stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    expect(calls).toContain('GET /admin/api/sources')
    expect(calls.some((call) => call.includes('/admin/api/connector'))).toBe(false)
  })
})

describe('operating a connection', () => {
  it('refreshes through the source API', async () => {
    const { writes } = stub()
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(writes[0]).toMatchObject({
      url: '/admin/api/sources/src_weather/refresh', method: 'POST',
    }))
  })

  /** One click starts one refresh; a second click is disabled while it is in flight. */
  it('disables Refresh while one is in flight', async () => {
    // Held open until the assertion below has looked at the button, then released so the component
    // can settle before the test ends.
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    stub({
      respond: (url, method) => (method === 'POST' && url.endsWith('/refresh')
        ? held.then(() => new Response(JSON.stringify(WEATHER), { status: 200 }))
        : undefined),
    })
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    const button = within(row).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement
    fireEvent.click(button)
    await waitFor(() => expect(button.disabled).toBe(true))

    release()
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it('cannot refresh a paused connection at all', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Family calendar')
    expect((within(row).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('pauses and resumes without deleting anything', async () => {
    const { writes } = stub()
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Lisbon weather')).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(writes[0]).toMatchObject({
      url: '/admin/api/sources/src_weather', method: 'PATCH', body: { enabled: false },
    }))

    fireEvent.click(within(await rowFor('Family calendar')).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(writes[1]).toMatchObject({
      url: '/admin/api/sources/src_cal', method: 'PATCH', body: { enabled: true },
    }))
  })

  /** Codes are for the wire. What reaches the page is a sentence saying what to do about it. */
  it('turns a wire error code into a sentence', async () => {
    stub({ respond: (url, method) => (method === 'POST' && url.endsWith('/refresh') ? fail(500, 'refresh_failed') : undefined) })
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/Couldn’t refresh this connection/)).toBeDefined()
    expect(screen.queryByText('refresh_failed')).toBeNull()
  })
})

describe('deleting a connection', () => {
  it('is disabled while widgets depend on it, and says which screens', async () => {
    stub()
    render(<Feeds />)
    const row = await rowFor('Lisbon weather')
    const button = within(row).getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('Kitchen')
    expect(button.title).toContain('Hallway')
  })

  it('confirms, names the connection, then deletes an unused one', async () => {
    const { writes } = stub()
    render(<Feeds />)
    const row = await rowFor('Family news')
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Family news')
    expect(writes).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(writes[0]).toMatchObject({
      url: '/admin/api/sources/src_news', method: 'DELETE',
    }))
  })

  /**
   * The UI disables it, but the UI's usage snapshot is up to five seconds old — a widget bound in
   * another tab in the meantime means the API is the one that has to say no, and it does.
   */
  it('reports the API’s refusal when a connection was bound while the page was stale', async () => {
    stub({ respond: (url, method) => (method === 'DELETE' && url === '/admin/api/sources/src_news' ? fail(409, 'source_in_use') : undefined) })
    render(<Feeds />)
    const row = await rowFor('Family news')
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/still used by a screen/i)).toBeDefined()
  })
})

describe('settings and repair', () => {
  it('renames through PATCH and leaves setup alone', async () => {
    const { writes } = stub()
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Lisbon weather')).getByRole('button', { name: 'Settings' }))

    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Kitchen weather' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({
      url: '/admin/api/sources/src_weather', method: 'PATCH', body: { name: 'Kitchen weather' },
    })
  })

  it('builds the repair form from the provider’s own setup schema, prefilled', async () => {
    stub()
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Lisbon weather')).getByRole('button', { name: 'Settings' }))

    expect((await screen.findByLabelText('Location name') as HTMLInputElement).value).toBe('Lisbon')
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).value).toBe('38.72')
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('metric')
  })

  /**
   * The server never sends a stored secret back, so the input has nothing to prefill with — and a
   * blank it treats as "clear this" would let an operator wipe a token by fixing a neighbouring
   * field. Blank means keep.
   */
  it('leaves a secret field blank and omits it from the save when untouched', async () => {
    const { writes } = stub()
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Family news')).getByRole('button', { name: 'Settings' }))

    const url = await screen.findByLabelText('Feed URL') as HTMLInputElement
    expect(url.value).toBe('')
    expect(url.type).toBe('password')
    expect(url.placeholder).toMatch(/keep/i)

    fireEvent.change(screen.getByLabelText('Maximum items'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ url: '/admin/api/sources/src_news/setup', method: 'PUT' })
    expect(writes[0].body.config).toEqual({ max_items: 10 })
    expect(writes[0].body.secrets ?? {}).toEqual({})
  })

  it('sends a replacement secret when one is typed', async () => {
    const { writes } = stub()
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Family news')).getByRole('button', { name: 'Settings' }))

    fireEvent.change(await screen.findByLabelText('Feed URL'), { target: { value: 'https://news.example.test/new.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body.secrets).toEqual({ url: 'https://news.example.test/new.xml' })
  })

  /**
   * The setup PUT tests against the real provider before it commits. A failure must leave the
   * persistent connection exactly as it was — including its name, which is why the rename is not
   * sent first and then abandoned half-applied.
   */
  it('does not rename when the setup test fails', async () => {
    const { writes } = stub({ respond: (url) => (url.endsWith('/setup') ? fail(422, 'test_failed') : undefined) })
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Family news')).getByRole('button', { name: 'Settings' }))

    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByLabelText('Maximum items'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

    expect(await screen.findByText(/Couldn’t fetch usable data/)).toBeDefined()
    expect(writes.filter((write) => write.method === 'PATCH')).toEqual([])
  })

  it('offers the refresh interval under Advanced, not beside the name', async () => {
    stub()
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Lisbon weather')).getByRole('button', { name: 'Settings' }))

    const interval = await screen.findByLabelText('Refresh every (seconds)')
    expect((interval as HTMLInputElement).value).toBe('900')
    expect(interval.closest('details')).not.toBeNull()
  })

  it('says so plainly when the provider is missing from this build', async () => {
    const orphan = { ...NEWS, provider: { id: 'legacy.telepathy', label: 'Unavailable provider', available: false }, config: null }
    stub({ sources: [orphan] })
    render(<Feeds />)
    fireEvent.click(within(await rowFor('Family news')).getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText(/provider isn’t available/)).toBeDefined()
    expect(screen.queryByLabelText('Feed URL')).toBeNull()
  })
})

describe('the Add page', () => {
  it('opens from the heading’s Add button, with providers under Standard', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    // Nothing to add is visible on the list itself — the page has exactly one door in.
    expect(screen.queryByRole('button', { name: /Open-Meteo/ })).toBeNull()
    openAdd()
    expect(screen.getByRole('heading', { name: 'Standard' })).toBeDefined()
    expect(screen.getByRole('button', { name: /Open-Meteo/ })).toBeDefined()
  })

  it('the breadcrumb leads back to the list', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    expect(screen.queryByText('Lisbon weather')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Data sources' }))
    expect(await screen.findByText('Lisbon weather')).toBeDefined()
  })

  /** iCalendar ships with no calendar widget yet, and still has to be creatable and repairable. */
  it('offers every prepared provider, including ones no widget consumes yet', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    expect(screen.getByRole('button', { name: /iCalendar/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /RSS/ })).toBeDefined()
  })

  it('generates the chosen provider’s fields and defaults its interval', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /iCalendar/ }))

    expect((await screen.findByLabelText('Calendar URL') as HTMLInputElement).type).toBe('password')
    expect((screen.getByLabelText('Look-ahead days') as HTMLInputElement).value).toBe('7')
    expect((screen.getByLabelText('Maximum events') as HTMLInputElement).value).toBe('10')
  })

  it('tests against real data before anything is created', async () => {
    const { writes } = stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /RSS/ }))

    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Family news' } })
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://news.example.test/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ url: '/admin/api/source-drafts', method: 'POST' })
    expect(writes[0].body).toMatchObject({
      provider_id: 'dashboardz.rss', name: 'Family news',
      config: { max_items: 20 }, secrets: { url: 'https://news.example.test/feed.xml' },
    })
    // Nothing persistent yet — a draft is a test, and the operator has not said yes.
    expect(writes.filter((write) => /promote/.test(write.url))).toEqual([])
  })

  it('shows what actually arrived, then creates the connection only when asked', async () => {
    const { writes } = stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /RSS/ }))
    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Family news' } })
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://news.example.test/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText(/Rehearsal moved to Thursday/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))

    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]).toMatchObject({ url: '/admin/api/source-drafts/drf_1/promote', method: 'POST' })
  })

  /** A draft holds a live credential and an expiry. Walking away has to take it with you. */
  it('cleans up its draft when the operator backs out', async () => {
    const { writes } = stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /RSS/ }))
    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Family news' } })
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://news.example.test/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('button', { name: 'Add connection' })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(writes.find((write) => write.method === 'DELETE')).toMatchObject({
      url: '/admin/api/source-drafts/drf_1',
    }))
  })

  it('supersedes the previous draft rather than stacking a second one', async () => {
    const { writes } = stub()
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /RSS/ }))
    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Family news' } })
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://news.example.test/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('button', { name: 'Add connection' })

    fireEvent.click(screen.getByRole('button', { name: 'Test again' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].body).toMatchObject({ supersedes: 'drf_1' })
  })

  /**
   * An expired draft is the one failure a person will actually hit — they tested, went to lunch,
   * came back and pressed the button. Losing the URL they typed would be the second insult.
   */
  it('keeps the typed setup when promotion fails, and says what to do', async () => {
    stub({ respond: (url) => (/promote$/.test(url) ? fail(410, 'draft_expired') : undefined) })
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /RSS/ }))
    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Family news' } })
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://news.example.test/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add connection' }))

    expect(await screen.findByText(/expired/i)).toBeDefined()
    expect((screen.getByLabelText('Feed URL') as HTMLInputElement).value).toBe('https://news.example.test/feed.xml')
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDefined()
  })

  it('reports a failed test as advice, not as a status code', async () => {
    stub({ respond: (url, method) => (url === '/admin/api/source-drafts' && method === 'POST' ? fail(422, 'test_failed') : undefined) })
    render(<Feeds />)
    await screen.findByText('Lisbon weather')
    openAdd()
    fireEvent.click(screen.getByRole('button', { name: /RSS/ }))
    fireEvent.change(await screen.findByLabelText('Connection name'), { target: { value: 'Family news' } })
    fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: 'https://news.example.test/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText(/Couldn’t fetch usable data/)).toBeDefined()
    expect(screen.queryByText('test_failed')).toBeNull()
  })
})

describe('pushed feeds', () => {
  it('lists them in the open under their own heading; creating one lives on the Add page', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('CPU temp')
    expect(screen.getByRole('heading', { name: 'Pushed feeds' })).toBeDefined()
    // The create form is no longer on the list page — it moved behind Add, under Advanced.
    expect(screen.queryByPlaceholderText('Feed name')).toBeNull()
    openAdd()
    expect(screen.getByRole('heading', { name: 'Advanced: push data yourself' })).toBeDefined()
    expect(screen.getByPlaceholderText('Feed name')).toBeDefined()
  })

  /**
   * A provider owns its output feed's contents. Offering "Edit" and "Delete" beside one would let
   * an operator break a widget in a way the connection row cannot show or undo.
   */
  it('lists only feeds no connection owns', async () => {
    stub()
    render(<Feeds />)
    await screen.findByText('CPU temp')
    for (const feed of OUTPUT_FEEDS) expect(screen.queryByText(feed.name)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copy curl' })).toHaveLength(1)
  })
})
