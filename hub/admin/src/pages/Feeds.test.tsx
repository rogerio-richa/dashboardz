import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Feeds from './Feeds'

const FEED_A = {
  id: 'feed_1', name: 'CPU temp', mode: 'value', cap: 50,
  stale_after_s: 60, alert_on_stale: true, allowed_senders: null,
  pushed_at: Date.now() - 5000, pushed_by: 'snd_1', image_rev: 0, created_at: 1,
}
const FEED_B = {
  id: 'feed_2', name: 'Build log', mode: 'stream', cap: 200,
  stale_after_s: null, alert_on_stale: false, allowed_senders: ['snd_2'],
  pushed_at: null, pushed_by: null, image_rev: 0, created_at: 2,
}
const FEED_IMG = {
  id: 'feed_3', name: 'Doorbell cam', mode: 'image', cap: 1,
  stale_after_s: null, alert_on_stale: false, allowed_senders: null,
  pushed_at: Date.now() - 20000, pushed_by: 'snd_3', image_rev: 4, created_at: 3,
}

/**
 * Raw push feeds, listed under "Pushed feeds" on the Data sources page; creating one lives on the
 * Add page's "Advanced: push data yourself" section. Everything a developer or an existing cron
 * integration relies on is still here — create, edit, inspect, delete, and a curl command that
 * matches the feed's mode. The connection-first default view has its own file,
 * `DataSources.test.tsx`.
 */
describe('Feeds page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const stub = (opts: { posts?: any[]; deletes?: string[]; patches?: any[]; getOne?: any; feeds?: any[]; sources?: any[]; senders?: any[] } = {}) => {
    const { posts = [], deletes = [], patches = [], getOne, feeds = [FEED_A, FEED_B], sources = [], senders = [] } = opts
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/sources') return new Response(JSON.stringify(sources), { status: 200 })
      if (url === '/admin/api/senders') return new Response(JSON.stringify(senders), { status: 200 })
      if (url === '/admin/api/feeds' && init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string))
        return new Response(JSON.stringify({ ...FEED_A, id: 'feed_new' }), { status: 200 })
      }
      if (url === '/admin/api/feeds') return new Response(JSON.stringify(feeds), { status: 200 })
      if (/^\/admin\/api\/feeds\/[^/]+$/.test(url) && init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(null, { status: 204 })
      }
      if (/^\/admin\/api\/feeds\/[^/]+$/.test(url) && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return new Response(JSON.stringify(FEED_A), { status: 200 })
      }
      if (/^\/admin\/api\/feeds\/[^/]+$/.test(url) && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify(getOne ?? { ...FEED_A, payload: null, rows: [], references: [] }), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return { posts, deletes, patches }
  }

  it('lists feeds with age and mode', async () => {
    stub()
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())
    expect(screen.getByText('Build log')).toBeDefined()
    expect(screen.getAllByText('value').length).toBeGreaterThan(0)
    expect(screen.getAllByText('stream').length).toBeGreaterThan(0)
  })

  /**
   * A pushed feed has no format to declare, which is the first thing a newcomer goes looking for.
   * The form says so, explains the chosen mode in one line, and points at the docs for the rest.
   */
  it('explains there is no format to declare, describes the chosen mode, and links the docs', async () => {
    stub()
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText(/no format to declare/i)).toBeDefined()
    const guide = screen.getByRole('link', { name: /how pushing works/i }) as HTMLAnchorElement
    expect(guide.href).toContain('/data-in/#setting-up-a-push-end-to-end')
    const settings = screen.getByRole('link', { name: /what these settings mean/i }) as HTMLAnchorElement
    expect(settings.href).toContain('/data-in/#what-a-feed-accepts')

    expect(screen.getByText(/each push replaces the value/i)).toBeDefined()
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'stream' } })
    expect(screen.getByText(/each push adds a row/i)).toBeDefined()
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'image' } })
    expect(screen.getByText(/PNG, JPEG or static WebP/)).toBeDefined()
  })

  it('creates a feed and posts the right body', async () => {
    const { posts } = stub()
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByPlaceholderText('Feed name'), { target: { value: 'GPU temp' } })
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'stream' } })
    fireEvent.change(screen.getByLabelText('Cap'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create feed' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ name: 'GPU temp', mode: 'stream', cap: 100 })
  })

  /** Sender ids are wire detail: the operator ticks names off the hub's own list instead. */
  it('offers allowed senders in a dropdown and posts the ticked ids', async () => {
    const { posts } = stub({ senders: [{ id: 'snd_1', name: 'cron' }, { id: 'snd_2', name: 'pi' }] })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByPlaceholderText('Feed name'), { target: { value: 'GPU temp' } })
    const picker = screen.getByRole('button', { name: 'Allowed senders' })
    expect(picker.textContent).toContain('Any sender')
    fireEvent.click(picker)
    fireEvent.click(screen.getByLabelText('Allow sender pi'))
    expect(picker.textContent).toContain('pi')
    fireEvent.click(screen.getByRole('button', { name: 'Create feed' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ name: 'GPU temp', mode: 'value', allowed_senders: ['snd_2'] })
  })

  /**
   * The edit form opens IN the table, right under its feed's row, so it remains visible and
   * immediately editable even when the pushed-feeds table is long.
   */
  it('edit opens an inline form under the row, prefilled, and PATCHes on save', async () => {
    const { patches } = stub()
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])

    const row = screen.getByText('Edit — CPU temp').closest('tr')!
    expect(row.parentElement?.tagName).toBe('TBODY')   // inside the table, not appended after it
    const nameInput = within(row).getByPlaceholderText('Feed name') as HTMLInputElement
    expect(nameInput.value).toBe('CPU temp')

    fireEvent.change(nameInput, { target: { value: 'CPU temperature' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save feed' }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({
      name: 'CPU temperature', cap: 50, stale_after_s: 60, alert_on_stale: true, allowed_senders: null,
    })
  })

  it('inspector shows the payload from GET one', async () => {
    stub({ getOne: { ...FEED_A, payload: { cpu: 1 }, rows: [], references: [] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect' })[0])
    await waitFor(() => expect(screen.getByText(/"cpu": 1/)).toBeDefined())
  })

  /**
   * The Age column says "3h"; the inspector is where you go to find out exactly when, so it carries
   * the full date and time of the last push, for every mode.
   */
  it('inspector shows the full date and time of the last push', async () => {
    const at = Date.UTC(2026, 10, 17, 21, 4, 5)
    stub({ getOne: { ...FEED_A, pushed_at: at, payload: { cpu: 1 }, rows: [], references: [] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect' })[0])
    const line = await screen.findByText(/^Last data:/)
    expect(line.textContent).toContain(new Date(at).toLocaleString())
  })

  it('inspector says a feed that was never pushed has no data yet', async () => {
    stub({ getOne: { ...FEED_A, pushed_at: null, payload: null, rows: [], references: [] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect' })[0])
    expect((await screen.findByText(/^Last data:/)).textContent).toBe('Last data: never')
  })

  /**
   * The references belong in the dialog, not in a `confirm()` string: knowing WHICH screens break
   * is the whole reason this confirmation exists. Driven through the modal now — which also means
   * the test proves the delete does not fire until the operator says so, something a stubbed
   * `confirm` returning true could never show.
   */
  it('names the screens that reference a feed, and deletes only on confirm', async () => {
    const { deletes } = stub({ getOne: { ...FEED_A, payload: null, rows: [], references: [{ id: 'lay_1', name: 'A05 board' }] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('A05 board')
    expect(deletes).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deletes).toHaveLength(1))
  })

  it('cancelling the dialog deletes nothing', async () => {
    const { deletes } = stub({ getOne: { ...FEED_A, payload: null, rows: [], references: [] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deletes).toHaveLength(0)
  })

  it('copy-curl writes a ready command to the clipboard', async () => {
    stub()
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy curl' })[0])
    expect(writeText).toHaveBeenCalled()
    const cmd = writeText.mock.calls[0][0] as string
    expect(cmd).toContain('/api/feeds/feed_1')
    expect(cmd).toContain('Bearer')
    expect(cmd).toContain('content-type: application/json')
    expect(cmd).toContain(`-d '{"value": 21.5}'`)
  })

  it('copy-curl emits a row-shaped example for a stream feed, and uses the hub address devices use', async () => {
    stub({ feeds: [FEED_B] })
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<Feeds publicUrl="http://192.0.2.10:8484" />)
    await waitFor(() => expect(screen.getByText('Build log')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Copy curl' }))
    const cmd = writeText.mock.calls[0][0] as string
    expect(cmd).toContain('http://192.0.2.10:8484/api/feeds/feed_2')
    expect(cmd).toContain(`-d '{"title": "Backup finished"}'`)
  })

  // The command matches the feed mode: an image feed receives a binary image push rather than a
  // JSON body, so the "copy a ready command" button always produces a usable request.
  it('copy-curl emits a binary image push for an image feed, not a JSON body', async () => {
    stub({ feeds: [FEED_IMG] })
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('Doorbell cam')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Copy curl' }))
    const cmd = writeText.mock.calls[0][0] as string
    expect(cmd).toContain('/api/feeds/feed_3')
    expect(cmd).toContain('Bearer')
    expect(cmd).toContain('content-type: image/png')
    expect(cmd).toContain('--data-binary @image.png')
    expect(cmd).not.toContain('application/json')
    expect(cmd).not.toContain('example')
  })

  it('mode select offers image on create; creating an image feed posts mode: image', async () => {
    const { posts } = stub()
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const modeSelect = screen.getByLabelText('Mode') as HTMLSelectElement
    const optionValues = Array.from(modeSelect.options).map((o) => o.value)
    expect(optionValues).toEqual(['value', 'stream', 'image'])

    fireEvent.change(screen.getByPlaceholderText('Feed name'), { target: { value: 'Doorbell cam' } })
    fireEvent.change(modeSelect, { target: { value: 'image' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create feed' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ name: 'Doorbell cam', mode: 'image' })
  })

  /**
   * A feed a connection fills is that connection's output, and it is operated from the connection
   * row. Listing it here as well would put an Edit and a Delete next to data a provider overwrites
   * every interval — the operator would be editing something that is about to be replaced, or
   * deleting a widget's data from a page that never mentioned the widget.
   */
  it('hides feeds a connection owns, leaving only the ones something pushes into', async () => {
    stub({
      feeds: [FEED_A, FEED_B],
      sources: [{
        id: 'src_1', name: 'Family news',
        provider: { id: 'dashboardz.rss', label: 'RSS', available: true },
        config: {}, interval_s: 900, enabled: true,
        health: {
          state: 'healthy', status: 'Connection is healthy.', last_run_at: null,
          last_success_at: null, next_refresh_at: null, failure_count: 0, rate_limited_until: null,
        },
        outputs: [{
          id: 'out_1', contract_id: 'dashboardz.news.items/v1', feed_id: FEED_B.id,
          capabilities: [], last_valid_at: null, usages: [],
        }],
        usages: [],
      }],
    })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())

    expect(screen.queryByText('Build log')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copy curl' })).toHaveLength(1)
  })

  const REJECTED = { at: Date.now() - 2000, status: 400, reason: 'invalid_json', label: 'Not valid JSON', by: 'snd_2', via: 'http', count: 3 }

  /**
   * A sender stuck sending bad payloads used to be invisible here: the hub answered it with a 400
   * and kept nothing. Now the row says so, but only while the rejection is newer than the last
   * accepted push; an old one that a later push has superseded stays in Inspect only.
   */
  it('flags a feed whose last push was rejected, with the reason and count', async () => {
    stub({ feeds: [{ ...FEED_A, pushed_at: Date.now() - 60_000, last_rejected: REJECTED }] })
    render(<Feeds />)
    const flag = await screen.findByText(/Rejected: Not valid JSON/)
    expect(flag.textContent).toContain('3×')
  })

  it('does not flag a rejection that an accepted push has since superseded', async () => {
    stub({ feeds: [{ ...FEED_A, pushed_at: Date.now() - 1000, last_rejected: { ...REJECTED, at: Date.now() - 60_000, count: 0 } }] })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())
    expect(screen.queryByText(/Rejected:/)).toBeNull()
  })

  it('inspector shows the last rejection with status, reason, sender name and transport', async () => {
    const feed = { ...FEED_A, last_rejected: REJECTED }
    stub({ feeds: [feed], senders: [{ id: 'snd_2', name: 'pi' }], getOne: { ...feed, payload: 1, rows: [], references: [] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    const line = await screen.findByText(/^Last rejected:/)
    expect(line.textContent).toContain(new Date(REJECTED.at).toLocaleString())
    expect(line.textContent).toContain('400 Not valid JSON')
    expect(line.textContent).toContain('from pi over HTTP')
    expect(line.textContent).toContain('3 since the last accepted push')
  })

  /** Same rule the devices and the stale sweep use: a feed nothing has pushed to yet is not stale. */
  it('does not show a never-pushed feed as stale', async () => {
    stub({ feeds: [{ ...FEED_A, pushed_at: null }] })
    render(<Feeds />)
    const never = await screen.findByText('never')
    expect(never.closest('td')!.getAttribute('style') ?? '').not.toContain('rgb(204, 0, 0)')
  })

  it('an open inspector refreshes with the page, so it can verify a push', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let payload = 1
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/admin/api/feeds') return new Response(JSON.stringify([FEED_A]), { status: 200 })
        if (url === '/admin/api/feeds/feed_1') return new Response(JSON.stringify({ ...FEED_A, payload: { n: payload }, rows: [], references: [] }), { status: 200 })
        return new Response(JSON.stringify([]), { status: 200 })
      }))
      render(<Feeds />)
      await waitFor(() => expect(screen.getByText('CPU temp')).toBeDefined())
      fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
      await waitFor(() => expect(screen.getByText(/"n": 1/)).toBeDefined())
      payload = 2
      await vi.advanceTimersByTimeAsync(5000)
      await waitFor(() => expect(screen.getByText(/"n": 2/)).toBeDefined())
    } finally {
      vi.useRealTimers()
    }
  })

  it('inspector shows image_rev and age for an image feed instead of a JSON payload', async () => {
    stub({ feeds: [FEED_IMG], getOne: { ...FEED_IMG, payload: null, rows: [], references: [] } })
    render(<Feeds />)
    await waitFor(() => expect(screen.getByText('Doorbell cam')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    await waitFor(() => expect(screen.getByText(/rev 4/)).toBeDefined())
    expect(screen.queryByText('Payload')).toBeNull()
    expect(screen.getByText(/^Last data:/)).toBeDefined()
  })
})
