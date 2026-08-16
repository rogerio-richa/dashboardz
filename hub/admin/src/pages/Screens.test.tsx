import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Screens from './Screens'

const ROW = { id: 'lay_1', name: 'Kitchen', orientation: 'landscape', created_at: 1,
  grid: { cells: [
    { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} },
    { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'alert_feed', config: { min_severity: 'warn' } },
  ] },
  assigned_count: 1, theme_id: null, rev: 1, sounds: {} }

const SOUND_MANIFEST = {
  rev: 3,
  families: {
    classic: { name: 'Classic beeps' },
    bells: { name: 'Soft bells' },
  },
}

const savedScreen = (body: any, id = 'lay_saved', rev = 1) => ({
  id, name: body.name, orientation: body.orientation, grid: body.grid,
  created_at: 1, assigned_count: 0, theme_id: null, rev,
})

const FEED_VALUE = { id: 'feed_v', name: 'CPU', mode: 'value' }
const FEED_STREAM = { id: 'feed_s', name: 'Builds', mode: 'stream' }
const FEED_IMAGE = { id: 'feed_i', name: 'Doorbell cam', mode: 'image' }

// newId()'s counter is module-level and keeps incrementing across every test in this file, so a
// card's id (e.g. "c1") is only predictable in a file's very first render. Address cards by their
// position on the canvas instead — stable regardless of run order or how many renders preceded it.
const cardAt = (container: HTMLElement, i: number) =>
  container.querySelectorAll('[data-testid^="card-"]')[i] as HTMLElement

const addFromGallery = (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add widget' }))
  fireEvent.click(screen.getByRole('option', { name }))
}

let paintedText: string[] = []

beforeEach(() => {
  paintedText = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), closePath: vi.fn(), drawImage: vi.fn(),
    fill: vi.fn(), fillRect: vi.fn(), fillText: vi.fn((text: string) => paintedText.push(String(text))),
    lineTo: vi.fn(), measureText: vi.fn((text: string) => ({ width: Array.from(String(text)).length * 6 })),
    moveTo: vi.fn(), rect: vi.fn(), restore: vi.fn(), rotate: vi.fn(), save: vi.fn(), scale: vi.fn(),
    setTransform: vi.fn(), stroke: vi.fn(), translate: vi.fn(),
  }) as unknown as CanvasRenderingContext2D)
})

// RTL does not auto-clean in this project (no globals:true, no setup file). The original
// describe below has its own afterEach, but that does NOT cover other describes in the file —
// cleanup must be at FILE scope or one block's renders leak into the next.
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Screens page — theme assignment', () => {
  /**
   * Assigning a theme is the one action that makes theming usable at all, and it lives in the
   * list row rather than behind Edit. NULL means the built-in default — a first-class state.
   */
  const themeStub = () => {
    const patches: { url: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/screens' && !init?.method) return new Response(JSON.stringify([ROW]), { status: 200 })
      if (url.startsWith('/admin/api/screens/') && init?.method === 'PATCH') {
        patches.push({ url, body: JSON.parse(init.body as string) })
        return new Response(JSON.stringify(ROW), { status: 200 })
      }
      if (url === '/admin/api/themes') {
        return new Response(JSON.stringify([{ id: 'thm_cypherpunk', name: 'Cypherpunk' }]), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return patches
  }

  it('assigns a theme from the list row', async () => {
    const patches = themeStub()
    render(<Screens />)
    const picker = await screen.findByLabelText('Kitchen theme')
    fireEvent.change(picker, { target: { value: 'thm_cypherpunk' } })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].body).toEqual({ theme_id: 'thm_cypherpunk' })
  })

  it('sends null, not an empty string, when returning to the built-in default', async () => {
    const patches = themeStub()
    render(<Screens />)
    const picker = await screen.findByLabelText('Kitchen theme')
    fireEvent.change(picker, { target: { value: 'thm_cypherpunk' } })
    await waitFor(() => expect(patches).toHaveLength(1))
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1].body).toEqual({ theme_id: null })
  })
})

describe('Screens page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const stub = (opts: { posts?: any[]; feeds?: any[]; feedDetails?: Record<string, any> } = {}) => {
    const { posts = [], feeds = [], feedDetails = {} } = opts
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/screens' && init?.method === 'POST') { posts.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ ...ROW, id: 'lay_new' }), { status: 200 }) }
      if (url === '/admin/api/screens') return new Response(JSON.stringify([ROW]), { status: 200 })
      if (url === '/admin/api/feeds') return new Response(JSON.stringify(feeds), { status: 200 })
      const m = /^\/admin\/api\/feeds\/([^/]+)$/.exec(url)
      if (m && feedDetails[m[1]]) return new Response(JSON.stringify(feedDetails[m[1]]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return posts
  }

  it('lists layouts and shows the target info bar for the form state', async () => {
    stub()
    render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    // Target info bar (SenseCraft lesson): orientation · device class · color capability.
    expect(screen.getByText(/landscape · Android & browser · color/)).toBeDefined()
  })

  /**
   * The editor is its own view since the rework, so every test that touches it opens it first —
   * either by creating a layout or by editing one. `openNew` is the create path.
   */
  const openNew = () => fireEvent.click(screen.getByRole('button', { name: 'New layout' }))

  it('creates a layout: adding a card gives per-cell widget dropdowns; POST body is the grid', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Hall' } })
    // The widget is chosen at ADD time and fixed after: a card cannot be converted, so the picker
    // lives beside Add card rather than inside the card.
    addFromGallery(/^Alerts/i)
    fireEvent.click(screen.getByRole('button', { name: 'Card 2 preset half R' }))
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Card 1 preset half L' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      name: 'Hall', orientation: 'landscape',
      grid: { cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'alert_feed', config: { min_severity: 'info', clamp: { title_lines: 1, body_lines: 2 }, overflow: { counter: true } } },
      ], tab_bar: 'bottom' },
    })
  })

  it('edits a layout: Edit loads the row into the form; submit PATCHes the row id with name/orientation/grid', async () => {
    const patches: { url: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/admin/api/screens/${ROW.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        patches.push({ url, body })
        return new Response(JSON.stringify(savedScreen(body, ROW.id, 2)), { status: 200 })
      }
      if (url === '/admin/api/screens') return new Response(JSON.stringify([ROW]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((screen.getByPlaceholderText('Layout name') as HTMLInputElement).value).toBe('Kitchen')

    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Kitchen renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toBe(`/admin/api/screens/${ROW.id}`)
    expect(patches[0].body).toEqual({
      rev: 1,
      name: 'Kitchen renamed', orientation: 'landscape',
      grid: { cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'alert_feed', config: { min_severity: 'warn' } },
      ], tab_bar: 'bottom' },
    })
  })

  /**
   * The only switch that can make an info alert audible anywhere. A sender cannot ask for one —
   * the hub refuses (`resolveSound`) — so if this is off, routine traffic is silent on this
   * screen's device, which is the point. Off unless somebody in the room turns it on.
   */
  it('keeps the info chime off until the screen asks for it', async () => {
    const patches: { url: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/admin/api/screens/${ROW.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        patches.push({ url, body })
        return new Response(JSON.stringify(savedScreen(body, ROW.id, 2)), { status: 200 })
      }
      if (url === '/admin/api/screens') return new Response(JSON.stringify([ROW]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // Card 2 is the alert feed; the toggle belongs to it and to nothing else.
    fireEvent.pointerDown(cardAt(container, 1))
    const chime = await screen.findByLabelText('Chime on info alerts') as HTMLInputElement
    expect(chime.checked).toBe(false)

    fireEvent.click(chime)
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].body.grid.cells[1].config).toMatchObject({ min_severity: 'warn', sound_info: true })

    // And it stays off for a card that is not an alert feed.
    fireEvent.pointerDown(cardAt(container, 0))
    expect(screen.queryByLabelText('Chime on info alerts')).toBeNull()
  })

  /**
   * The stream/table counterpart to the info-alert chime above: a sender's routine stream entries
   * (new build, new commit) are silent by default, and a room can only turn that noise on for
   * itself. Mirrors the `sound_info` test's exact shape — edit, select the card, toggle, save,
   * assert the PATCH body — because it is the same knob on a different widget pair.
   */
  it('keeps the activity chime off until the screen asks for it', async () => {
    const streamRow = { ...ROW, grid: { cells: [
      { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} },
      { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'stream_list', config: { feed: '' } },
    ] } }
    const patches: { url: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/admin/api/screens/${streamRow.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        patches.push({ url, body })
        return new Response(JSON.stringify(savedScreen(body, streamRow.id, 2)), { status: 200 })
      }
      if (url === '/admin/api/screens') return new Response(JSON.stringify([streamRow]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // Card 2 is the stream list; the toggle belongs to it and to nothing else.
    fireEvent.pointerDown(cardAt(container, 1))
    const chime = await screen.findByLabelText('Card 2 chime on new entries') as HTMLInputElement
    expect(chime.checked).toBe(false)

    fireEvent.click(chime)
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].body.grid.cells[1].config).toMatchObject({ feed: '', chime_activity: true })

    // And it stays off for a card that is not a stream_list/table.
    fireEvent.pointerDown(cardAt(container, 0))
    expect(screen.queryByLabelText('Card 1 chime on new entries')).toBeNull()
  })

  it('offers all twelve widgets and defaults legacy configs', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Data cell' } })

    // Every widget is offered where a card is CREATED — the only place its type is decided.
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }))
    expect(screen.getByRole('listbox', { name: 'Widgets' }).querySelectorAll('[role="option"]')).toHaveLength(12)
    fireEvent.click(screen.getByRole('option', { name: /^Value/i }))
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    expect(container.querySelector('.card-widget')?.textContent).toBe('Value')
    expect((screen.getByText('Advanced').closest('details') as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByLabelText('Cell 1 feed')).toBeDefined()
    expect(screen.getByLabelText('Cell 1 path')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0]).toMatchObject({ widget: 'value_tile', config: { feed: '', path: '' } })
  })

  it('filters the feed dropdown to stream feeds for stream_list', async () => {
    stub({ feeds: [FEED_VALUE, FEED_STREAM] })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))

    addFromGallery(/^Stream list/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      const names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
      expect(names).toContain('Builds')
    })
    const names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(names).not.toContain('CPU')
  })

  it('excludes image feeds from the feed dropdown for every widget — no current widget can bind one', async () => {
    stub({ feeds: [FEED_VALUE, FEED_STREAM, FEED_IMAGE] })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))

    // value_tile: non-stream-only widget — image feed must still be excluded alongside value/stream feeds staying.
    addFromGallery(/^Value/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      const names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
      expect(names).toContain('CPU')
    })
    let names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(names).toContain('Builds')
    expect(names).not.toContain('Doorbell cam')

    // stream_list: image feed must be excluded on top of the existing stream-only filter.
    addFromGallery(/^Stream list/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
      expect(names).toContain('Builds')
    })
    expect(names).not.toContain('Doorbell cam')
    expect(names).not.toContain('CPU')
  })

  it('live preview resolves the path against the fetched payload', async () => {
    const detail = { ...FEED_VALUE, cap: 50, stale_after_s: null, alert_on_stale: false, allowed_senders: null,
      pushed_at: 1, pushed_by: 's', image_rev: 0, created_at: 1,
      payload: { cpu: { load: 37.2 } }, rows: [], references: [] }
    stub({ feeds: [FEED_VALUE], feedDetails: { feed_v: detail } })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))

    addFromGallery(/^Value/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      const opts = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.value)
      expect(opts).toContain('feed_v')
    })
    fireEvent.change(screen.getByLabelText('Cell 1 feed'), { target: { value: 'feed_v' } })
    fireEvent.change(screen.getByLabelText('Cell 1 path'), { target: { value: 'cpu.load' } })

    await waitFor(() => expect(screen.getByLabelText('Cell 1 preview').textContent).toBe('37.2'))
  })

  it('live preview shows an em dash for a bad path', async () => {
    const detail = { ...FEED_VALUE, cap: 50, stale_after_s: null, alert_on_stale: false, allowed_senders: null,
      pushed_at: 1, pushed_by: 's', image_rev: 0, created_at: 1,
      payload: { cpu: { load: 37.2 } }, rows: [], references: [] }
    stub({ feeds: [FEED_VALUE], feedDetails: { feed_v: detail } })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))

    addFromGallery(/^Value/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      const opts = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.value)
      expect(opts).toContain('feed_v')
    })
    fireEvent.change(screen.getByLabelText('Cell 1 feed'), { target: { value: 'feed_v' } })
    fireEvent.change(screen.getByLabelText('Cell 1 path'), { target: { value: 'cpu.nope' } })

    await waitFor(() => expect(screen.getByLabelText('Cell 1 preview').textContent).toBe('—'))
  })

  it('table columns editor adds and posts columns', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Table cell' } })

    addFromGallery(/^Table/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    expect(screen.getByLabelText('Cell 1 column 1 header')).toBeDefined()

    fireEvent.change(screen.getByLabelText('Cell 1 column 1 header'), { target: { value: 'Name' } })
    fireEvent.change(screen.getByLabelText('Cell 1 column 1 path'), { target: { value: 'name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }))
    fireEvent.change(screen.getByLabelText('Cell 1 column 2 header'), { target: { value: 'Value' } })
    fireEvent.change(screen.getByLabelText('Cell 1 column 2 path'), { target: { value: 'value' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0].config.columns).toEqual([
      { header: 'Name', path: 'name' },
      { header: 'Value', path: 'value' },
    ])
  })

  it('scale input rides into the posted config', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Scale cell' } })

    addFromGallery(/^Value/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    fireEvent.change(screen.getByLabelText('Cell 1 scale'), { target: { value: '1.5' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0].config).toEqual({ feed: '', path: '', scale: 1.5 })
  })

  // screen editor behavior: design picker. ROW's cell 0 is already `{ widget: 'clock', config: {} }` — a clock,
  // which is the one non-data widget with no other config UI, so it is what proves the picker
  // renders above CellConfig's `!DATA_WIDGETS.includes` early return.
  it('offers a design picker on a clock cell, which has no other config', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Themed clock' } })

    const picker = screen.getByLabelText('Cell 1 design') as HTMLSelectElement
    expect(picker.value).toBe('') // blank ⇒ follow the theme
    fireEvent.change(picker, { target: { value: 'segment' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0].config.design).toBe('segment')
  })

  it('clearing the design removes the key rather than sending an empty string', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Themed clock' } })

    const picker = screen.getByLabelText('Cell 1 design')
    fireEvent.change(picker, { target: { value: 'segment' } })
    fireEvent.change(picker, { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect('design' in posts[0].grid.cells[0].config).toBe(false)
  })

  it('chart series editor: added rows get a different default icon; POST carries the full series array', async () => {
    const posts = stub({ feeds: [FEED_STREAM] })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Chart cell' } })

    addFromGallery(/^Chart/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => expect(screen.getByLabelText('Cell 1 series 1 feed')).toBeDefined())
    expect((screen.getByLabelText('Cell 1 series 1 icon') as HTMLSelectElement).value).toBe('circle')

    fireEvent.click(screen.getByRole('button', { name: 'Add series' }))
    const icon2 = screen.getByLabelText('Cell 1 series 2 icon') as HTMLSelectElement
    // Ambiguity rule: the second row's default icon must not collide with the first row's —
    // the server rejects duplicate icons within one chart (feedCheck in hub/src/routes/admin.ts).
    expect(icon2.value).not.toBe('circle')
    expect(icon2.value).toBe('square')

    fireEvent.change(screen.getByLabelText('Cell 1 series 1 feed'), { target: { value: 'feed_s' } })
    fireEvent.change(screen.getByLabelText('Cell 1 series 1 y_path'), { target: { value: 'cpu.load' } })
    fireEvent.change(screen.getByLabelText('Cell 1 series 2 feed'), { target: { value: 'feed_s' } })
    fireEvent.change(screen.getByLabelText('Cell 1 series 2 y_path'), { target: { value: 'mem.used' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0]).toMatchObject({
      widget: 'chart',
      config: {
        series: [
          { feed: 'feed_s', y_path: 'cpu.load', icon: 'circle' },
          { feed: 'feed_s', y_path: 'mem.used', icon: 'square' },
        ],
        style: 'line',
      },
    })
  })

  it('chart series feed select is stream-only; style/window/y-bounds inputs ride into the posted config', async () => {
    const posts = stub({ feeds: [FEED_VALUE, FEED_STREAM] })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Chart bounds cell' } })

    addFromGallery(/^Chart/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      const names = Array.from((screen.getByLabelText('Cell 1 series 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
      expect(names).toContain('Builds')
    })
    const names = Array.from((screen.getByLabelText('Cell 1 series 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(names).not.toContain('CPU')

    fireEvent.change(screen.getByLabelText('Cell 1 series 1 feed'), { target: { value: 'feed_s' } })
    fireEvent.change(screen.getByLabelText('Cell 1 series 1 y_path'), { target: { value: 'cpu.load' } })
    // `Cell 1 Style`, capitalised: `style` is a GENERATED field now, labelled by
    // `chart/plot.mjs`'s own `meta.options` rather than by a hand-built select in CellConfig
    // Selecting it by the design's label is what proves the generated block
    // actually renders it — the hand-built copy is gone, so nothing else could.
    // ...and it is gone, not merely unused: the same assertion `CellConfig.gauge.test.tsx` makes
    // after its own hand-built knobs moved to the generated block. Two controls writing one config
    // key is how an operator ends up watching a select snap back to a value they did not choose.
    expect(screen.queryByLabelText('Cell 1 style')).toBeNull()
    fireEvent.change(screen.getByLabelText('Cell 1 Style'), { target: { value: 'bar' } })
    fireEvent.change(screen.getByLabelText('Cell 1 window_s'), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText('Cell 1 y_min'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Cell 1 y_max'), { target: { value: '100' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0].config).toEqual({
      series: [{ feed: 'feed_s', y_path: 'cpu.load', icon: 'circle' }],
      style: 'bar', window_s: 60, y_min: 0, y_max: 100,
    })
  })

  it('filters the feed dropdown to image-mode feeds for the image widget — the inverse of every other widget', async () => {
    stub({ feeds: [FEED_VALUE, FEED_STREAM, FEED_IMAGE] })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))

    addFromGallery(/^Image/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => {
      const names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
      expect(names).toContain('Doorbell cam')
    })
    const names = Array.from((screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(names).not.toContain('CPU')
    expect(names).not.toContain('Builds')
  })

  it('image widget defaults to fit "contain" and omits scale (not in its save schema)', async () => {
    const posts = stub({ feeds: [FEED_IMAGE] })
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Image cell' } })
    addFromGallery(/^Image/i)
    // Drop the starter clock, so the new card is the only one — and the only Cell 1.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    // No scale input for image — its save schema is additionalProperties:false without `scale`.
    expect(screen.queryByLabelText('Cell 1 scale')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0]).toMatchObject({ widget: 'image', config: { feed: '', fit: 'contain' } })
  })

  it('creates a layout with a preset rect', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'strip board' } })
    fireEvent.click(screen.getByRole('button', { name: 'Card 1 preset top strip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 0.2 })
    expect(posts[0].grid.template).toBeUndefined()
  })

  it('warns about overlapping cards and blocks submit', async () => {
    stub()
    render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    addFromGallery(/^Clock/i)
    // both cards default to full bleed -> guaranteed overlap
    expect(await screen.findByText('cards 1 and 2 overlap')).toBeDefined()
    expect((screen.getByRole('button', { name: 'Create layout' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('thirds presets carry the remainder on the last card so the row covers the board', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    addFromGallery(/^Clock/i)
    addFromGallery(/^Clock/i)
    // Three cards; "Add card" leaves the newest (card 3) selected. Set each card's preset in turn.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Card 1 preset third 1' }))
    fireEvent.pointerDown(cardAt(container, 1))
    fireEvent.click(screen.getByRole('button', { name: 'Card 2 preset third 2' }))
    fireEvent.pointerDown(cardAt(container, 2))
    fireEvent.click(screen.getByRole('button', { name: 'Card 3 preset third 3' }))
    expect(screen.queryByText(/overlap/)).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Thirds' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells.map((c: { rect: unknown }) => c.rect)).toEqual([
      { x: 0, y: 0, w: 0.333, h: 1 },
      { x: 0.333, y: 0, w: 0.333, h: 1 },
      { x: 0.666, y: 0, w: 0.334, h: 1 },
    ])
  })

  it('editing a card rect quantizes to 3dp', async () => {
    const posts = stub()
    const { container } = render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Quantized' } })
    // Quantization now happens on blur, not on every keystroke (mid-typing values like "0." no
    // longer flash "invalid rect") — a real click away from the field blurs it first, so the test
    // does the same rather than relying on an intermediate keystroke value.
    fireEvent.change(screen.getByLabelText('Card 1 w'), { target: { value: '0.3333333' } })
    fireEvent.blur(screen.getByLabelText('Card 1 w'))
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].grid.cells[0].rect.w).toBe(0.333)
  })

  it('survives a row whose grid parses but is not a grid — the list still renders and stays deletable', async () => {
    // The server deliberately keeps a corrupt row visible so an operator can delete it. A throw
    // inside render unmounts the whole list, which takes away the only way to fix the problem.
    const BROKEN = { id: 'lay_bad', name: 'Corrupt', orientation: 'landscape', created_at: 1,
      grid: {}, assigned_count: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/screens') return new Response(JSON.stringify([BROKEN, ROW]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Screens />)
    // Both rows render: the broken one shows 0 cards rather than taking the good one down.
    await waitFor(() => expect(screen.getByText('Corrupt')).toBeDefined())
    expect(screen.getByText('Kitchen')).toBeDefined()
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2)
  })

  it('survives editing a two-cell row where one cell has rect: null — the list and canvas both render with both cards present', async () => {
    // safeRect proved this in isolation on LayoutCanvas alone. Integrated, Screens.tsx
    // reads the SAME raw rect unconditionally in two spots (overlappingIds here, `others` in
    // LayoutCanvas's gesture effect) before the canvas ever gets a chance to coerce it — a null
    // rect throws `TypeError: Cannot read properties of null (reading 'x')` out of rectsOverlap
    // during render, unmounting the whole admin root. This is the assertion that would have
    // caught it.
    const CORRUPT = { id: 'lay_corrupt', name: 'Corrupt rect', orientation: 'landscape', created_at: 1,
      grid: { cells: [
        { rect: null, widget: 'clock', config: {} },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'alert_feed', config: { min_severity: 'warn' } },
      ] },
      assigned_count: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/screens') return new Response(JSON.stringify([CORRUPT]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    const { container } = render(<Screens />)
    await waitFor(() => expect(screen.getByText('Corrupt rect')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // The editor opened rather than the admin root unmounting — the name carried across, which is
    // what proves the corrupt rect did not throw during render.
    await waitFor(() => expect((screen.getByPlaceholderText('Layout name') as HTMLInputElement).value).toBe('Corrupt rect'))
    // The canvas rendered, and both cards — including the corrupt one — are present on it.
    expect(screen.getByTestId('canvas-board')).toBeDefined()
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(2)
    // editRow auto-selects card 0 — the corrupt one — so its inspector is what's on screen. The
    // rect input reads `c.rect?.[k]`, not `c.rect[k]`: it shows blank rather than throwing.
    expect((screen.getByLabelText('Card 1 x') as HTMLInputElement).value).toBe('')
  })

  it('editing a row with no cells loads a full-bleed clock rather than breaking the form', async () => {
    const BROKEN = { id: 'lay_bad', name: 'Corrupt', orientation: 'landscape', created_at: 1,
      grid: {}, assigned_count: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/screens') return new Response(JSON.stringify([BROKEN]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Screens />)
    await waitFor(() => expect(screen.getByText('Corrupt')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // The editor falls back to the same starting card a fresh layout gets.
    await waitFor(() => expect(screen.getByLabelText('Card 1 w')).toBeDefined())
    expect((screen.getByLabelText('Card 1 w') as HTMLInputElement).value).toBe('1')
  })

  it('preserves a later card\'s edited value when an earlier card is removed', async () => {
    // NOT a regression guard on id-vs-index keying: clicking "Remove card" fires native
    // blur-on-focus-loss before the click handler runs, in both jsdom and real browsers, and
    // every rect input here is fully controlled with quantize() running synchronously inline in
    // onBlur (no debounce). So the blurred edit is always committed to state before the removal's
    // filter runs, and this interaction shape cannot discriminate stable ids from array indices —
    // both pass. It only checks that removal correctly shifts a later card's already-committed
    // value into its new visible slot. The genuinely discriminating case — reorder a card WITHOUT
    // blurring a focused input first, then blur, and assert the commit lands on the pre-reorder
    // logical card rather than whatever now occupies its old position — needs drag reordering to
    // exist before it's reachable through the UI; write it there.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/screens') return new Response(JSON.stringify([]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    const { container } = render(<Screens />)
    openNew()
    addFromGallery(/^Clock/i)
    addFromGallery(/^Clock/i)
    // Three cards now; "Add card" leaves the newest (card 3) selected. Give it a distinctive width.
    const w3 = screen.getByLabelText('Card 3 w') as HTMLInputElement
    fireEvent.change(w3, { target: { value: '0.25' } })
    fireEvent.blur(w3)
    // Select and delete card 1 — only the selected card's "Remove card" button is on the page.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    // What was card 3 is card 2 now; select it and confirm it still carries 0.25.
    fireEvent.pointerDown(cardAt(container, 1))
    await waitFor(() => expect((screen.getByLabelText('Card 2 w') as HTMLInputElement).value).toBe('0.25'))
  })

  it('removing a selected middle card moves the inspector to the card that shifted into its slot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const { container } = render(<Screens />)
    openNew()
    addFromGallery(/^Clock/i)
    addFromGallery(/^Clock/i)
    // Three cards; give each a distinct, identifiable width.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByLabelText('Card 1 w'), { target: { value: '0.2' } })
    fireEvent.blur(screen.getByLabelText('Card 1 w'))
    fireEvent.pointerDown(cardAt(container, 1))
    fireEvent.change(screen.getByLabelText('Card 2 w'), { target: { value: '0.3' } })
    fireEvent.blur(screen.getByLabelText('Card 2 w'))
    fireEvent.pointerDown(cardAt(container, 2))
    fireEvent.change(screen.getByLabelText('Card 3 w'), { target: { value: '0.4' } })
    fireEvent.blur(screen.getByLabelText('Card 3 w'))
    // Select and remove the middle card (card 2) — no reselect afterwards, so the visible result
    // is entirely down to removeCard's own selection reassignment.
    fireEvent.pointerDown(cardAt(container, 1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    // The card that shifted into slot 2 (formerly card 3, w 0.4) is now the one shown.
    await waitFor(() => expect((screen.getByLabelText('Card 2 w') as HTMLInputElement).value).toBe('0.4'))
    // Only the selected card's inspector renders — card 1 is not it.
    expect(screen.queryByLabelText('Card 1 w')).toBeNull()
  })

  it('removing the last selected card falls back to the new last card instead of pointing past the end', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const { container } = render(<Screens />)
    openNew()
    addFromGallery(/^Clock/i)
    // Two cards; give card 1 an identifiable width.
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.change(screen.getByLabelText('Card 1 w'), { target: { value: '0.2' } })
    fireEvent.blur(screen.getByLabelText('Card 1 w'))
    // Select and remove card 2 — it is the last card, and the one being removed is the selected one.
    fireEvent.pointerDown(cardAt(container, 1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    // Selection falls back to the new last card (card 1) rather than an index past the end of the
    // now-shorter array — proves the Math.min(idx, next.length - 1) clamp, not just the shift.
    await waitFor(() => expect((screen.getByLabelText('Card 1 w') as HTMLInputElement).value).toBe('0.2'))
    // The removed card's own button is gone with it — only one card, one inspector block.
    expect(screen.queryByLabelText('Card 2 w')).toBeNull()
  })

  it('never sends the editor-local id to the server', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.body) calls.push(String(init.body))
      if (url === '/admin/api/screens' && init?.method === 'POST') {
        return new Response(JSON.stringify(savedScreen(JSON.parse(init.body as string))), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.join()).not.toContain('"id"')
  })

  it('editing a row whose cells is not an array loads a full-bleed clock instead of throwing', async () => {
    // `grid: { cells: 5 }` parses as JSON but is not a grid — `??` alone lets a non-null,
    // non-array value through, which then crashes placementError's `.entries()` and the render's
    // `.map()`, unmounting the whole admin root (there is no error boundary). Edit must still
    // open, falling back to the same starting card a fresh layout gets.
    const BROKEN = { id: 'lay_bad', name: 'Corrupt', orientation: 'landscape', created_at: 1,
      grid: { cells: 5 }, assigned_count: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/screens') return new Response(JSON.stringify([BROKEN]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Screens />)
    await waitFor(() => expect(screen.getByText('Corrupt')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(screen.getByLabelText('Card 1 w')).toBeDefined())
    expect((screen.getByLabelText('Card 1 w') as HTMLInputElement).value).toBe('1')
  })

  it('shows only the selected card in the inspector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const { container } = render(<Screens />)
    openNew()
    addFromGallery(/^Clock/i)
    // Two cards exist, but only the selected one is editable.
    fireEvent.pointerDown(cardAt(container, 0))
    await waitFor(() => expect(screen.getByLabelText('Card 1 w')).toBeDefined())
    expect(screen.queryByLabelText('Card 2 w')).toBeNull()
    fireEvent.pointerDown(cardAt(container, 1))
    await waitFor(() => expect(screen.getByLabelText('Card 2 w')).toBeDefined())
    expect(screen.queryByLabelText('Card 1 w')).toBeNull()
  })

  it('prompts to pick a card when nothing is selected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    fireEvent.pointerDown(screen.getByTestId('canvas-board'))
    await waitFor(() => expect(screen.getByText(/select a card/i)).toBeDefined())
  })

  it('redraws the canvas at the chosen target shape without touching the saved rects', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.body) calls.push(String(init.body))
      if (url === '/admin/api/screens' && init?.method === 'POST') {
        return new Response(JSON.stringify(savedScreen(JSON.parse(init.body as string))), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('16 / 10')
    fireEvent.change(screen.getByLabelText('Target shape'), { target: { value: '9:20 (Galaxy A05 portrait)' } })
    await waitFor(() => expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('9 / 20'))
    // Preview preference only — it must never appear in what we send.
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.join()).not.toContain('aspect')
  })

  it('an explicit shape pick survives an orientation round-trip, even when the pick is the other orientation\'s default label', async () => {
    // Regression: syncShapeToOrientation must not infer "untouched" by comparing shapeLabel's
    // text against the two default labels — TWO entries are themselves named "default
    // landscape"/"default portrait", so picking one of them while in the OTHER orientation is
    // textually indistinguishable from "nothing touched it yet" under a label-comparison guard,
    // and the next orientation round-trip would silently clobber the pick.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    render(<Screens />)
    await screen.findByText('Screens')
    openNew()

    fireEvent.click(screen.getByRole('radio', { name: 'portrait' }))
    await waitFor(() => expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('10 / 16'))

    // Explicit pick of the LANDSCAPE default while orientation is portrait.
    fireEvent.change(screen.getByLabelText('Target shape'), { target: { value: '16:10 (default landscape)' } })
    await waitFor(() => expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('16 / 10'))

    // Round-trip orientation away and back.
    fireEvent.click(screen.getByRole('radio', { name: 'landscape' }))
    fireEvent.click(screen.getByRole('radio', { name: 'portrait' }))

    // The operator's explicit pick must still be in effect.
    expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('16 / 10')
  })




  // jsdom has no real DataTransfer, so these drive the canvas board's onDrop directly with a
  // plain object standing in for it — enough to prove dropWidget's own guard, not a full gesture.
  // getBoundingClientRect is stubbed non-zero: jsdom's real one is all zeros, which would make
  // the handler bail on the width/height check before ever reaching widget validation, letting
  // the "unknown widget" case below pass vacuously without exercising the guard at all.
  const stubBoardGeometry = (board: HTMLElement) =>
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 250, width: 400, height: 250, toJSON: () => ({}),
    } as DOMRect)

  it('a drop with no text/dbz-widget payload does not add a card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const { container } = render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    const board = screen.getByTestId('canvas-board')
    stubBoardGeometry(board)
    fireEvent.drop(board, { clientX: 100, clientY: 100, dataTransfer: { getData: () => '', types: [] } })
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(1)
  })

  it('a drop with an unknown widget value does not add a card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const { container } = render(<Screens />)
    await screen.findByText('Screens')
    openNew()
    const board = screen.getByTestId('canvas-board')
    stubBoardGeometry(board)
    fireEvent.drop(board, { clientX: 100, clientY: 100, dataTransfer: { getData: () => 'not_a_real_widget', types: ['text/dbz-widget'] } })
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(1)
  })
})

const WEATHER_PREVIEW = {
  location: { name: 'Porto', timezone: 'Europe/Lisbon' },
  units: { temperature: 'C', wind_speed: 'km/h' },
  days: [
    { date: '2026-08-06', high: 24, low: 16, condition: { code: 'clear', label: 'Clear' } },
    { date: '2026-08-07', high: 23, low: 15, condition: { code: 'cloudy', label: 'Cloudy' } },
    { date: '2026-08-08', high: 22, low: 14, condition: { code: 'rain', label: 'Rain' } },
    { date: '2026-08-09', high: 25, low: 17, condition: { code: 'mostly_clear', label: 'Mostly clear' } },
    { date: '2026-08-10', high: 26, low: 18, condition: { code: 'partly_cloudy', label: 'Partly cloudy' } },
  ],
}
const NEWS_PREVIEW = [{ id: 'headline-1', title: 'A real normalized headline', source: 'Example News' }]
const WEATHER_CONTRACT = 'dashboardz.weather.daily-forecast/v1'
const NEWS_CONTRACT = 'dashboardz.news.items/v1'

const providerChoice = (widget: 'weather_forecast' | 'news_list') => ({
  id: widget === 'weather_forecast' ? 'test.weather' : 'test.news',
  label: widget === 'weather_forecast' ? 'Test Weather' : 'Test News',
  recommended: true,
  default_interval_s: 900,
  min_interval_s: 300,
  setup: [],
  outputs: [{
    contract_id: widget === 'weather_forecast' ? WEATHER_CONTRACT : NEWS_CONTRACT,
    capabilities: widget === 'weather_forecast'
      ? ['weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5', 'weather.daily.temperature.high', 'weather.daily.temperature.low']
      : ['news.item.id', 'news.item.title'],
  }],
  compatible_outputs: [{
    contract_id: widget === 'weather_forecast' ? WEATHER_CONTRACT : NEWS_CONTRACT,
    capabilities: widget === 'weather_forecast'
      ? ['weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5', 'weather.daily.temperature.high', 'weather.daily.temperature.low']
      : ['news.item.id', 'news.item.title'],
    missing_optional: [],
  }],
  recommendation: 'Recommended for this widget.',
  account: 'No account needed.',
  attribution: 'Data from the test provider.',
})

const savedWeatherRow = {
  id: 'lay_weather', name: 'Forecast screen', orientation: 'landscape' as const, created_at: 1,
  grid: { cells: [{
    rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'weather_forecast',
    config: { feed: 'feed_saved_weather', days: 5, show_precipitation: true },
  }] },
  assigned_count: 0, theme_id: null, rev: 12,
}

interface WidgetFirstStubOptions {
  rows?: any[]
  existingWeather?: boolean
  failFirstSave?: boolean
  deleteStatus?: number
  normalizedRev?: number
  draftGate?: Promise<void>
  deleteGate?: Promise<void>
}

function stubWidgetFirst(options: WidgetFirstStubOptions = {}) {
  const requests: { url: string; method: string; body: any }[] = []
  let saveAttempts = 0
  let currentRows = options.rows ?? []
  const normalizedRev = options.normalizedRev ?? 41
  const normalized = (body: any, id: string, rev: number) => ({
    id, name: body.name ?? currentRows[0]?.name ?? 'Screen',
    orientation: body.orientation ?? currentRows[0]?.orientation ?? 'landscape',
    grid: { cells: body.grid.cells.map((cell: any) => {
      if (!cell.config.source_draft_id) return cell
      const config = { ...cell.config, feed: `feed_promoted_${cell.widget}` }
      delete config.source_draft_id
      delete config.output_contract
      return { ...cell, config }
    }) },
    created_at: 1, assigned_count: 0, theme_id: null, rev,
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : null
    requests.push({ url, method, body })
    if (url === '/admin/api/screens' && method === 'GET') return new Response(JSON.stringify(currentRows), { status: 200 })
    if (url === '/admin/api/feeds' && method === 'GET') {
      return new Response(JSON.stringify([
        { id: 'feed_saved_weather', name: 'Home weather', mode: 'value' },
        { id: 'feed_existing_weather', name: 'Home weather', mode: 'value' },
        { id: 'feed_promoted_weather_forecast', name: 'Test Weather', mode: 'value' },
        { id: 'feed_promoted_news_list', name: 'Test News', mode: 'stream' },
      ]), { status: 200 })
    }
    if (url === '/admin/api/themes' || url === '/admin/api/devices') return new Response(JSON.stringify([]), { status: 200 })
    if (url === '/admin/api/source-choices?widget=weather_forecast') {
      const existing = options.existingWeather ? [{
        source_id: 'src_home', source_name: 'Home weather', provider_id: 'test.weather', provider: 'Test Weather',
        output_id: 'out_home', feed_id: 'feed_existing_weather', contract_id: WEATHER_CONTRACT,
        capabilities: providerChoice('weather_forecast').outputs[0].capabilities,
        missing_optional: [], last_success_at: 1,
      }] : []
      return new Response(JSON.stringify({
        widget: 'weather_forecast', title: 'Choose weather data', description: 'Choose a connection.',
        existing, providers: [providerChoice('weather_forecast')],
      }), { status: 200 })
    }
    if (url === '/admin/api/source-choices?widget=news_list') return new Response(JSON.stringify({
      widget: 'news_list', title: 'Choose news data', description: 'Choose a connection.',
      existing: [], providers: [providerChoice('news_list')],
    }), { status: 200 })
    if (url === '/admin/api/feeds/feed_existing_weather') return new Response(JSON.stringify({
      id: 'feed_existing_weather', name: 'Home weather', mode: 'value', payload: WEATHER_PREVIEW, rows: [],
    }), { status: 200 })
    if (url === '/admin/api/source-drafts' && method === 'POST') {
      if (options.draftGate) await options.draftGate
      const weather = body.provider_id === 'test.weather'
      const widget = weather ? 'weather_forecast' : 'news_list'
      const output = providerChoice(widget).compatible_outputs[0]
      return new Response(JSON.stringify({
        id: weather ? 'drf_weather_replacement' : 'drf_news',
        provider_id: body.provider_id, provider: weather ? 'Test Weather' : 'Test News',
        name: body.name, expires_at: Date.now() + 60_000,
        outputs: [{ ...output, preview: weather
          ? { mode: 'value', payload: WEATHER_PREVIEW, pushed_at: Date.now(), stale_after_s: 900 }
          : { mode: 'stream', rows: NEWS_PREVIEW.map((payload) => ({ payload, pushed_at: Date.now() })), pushed_at: Date.now(), stale_after_s: 900 } }],
      }), { status: 200 })
    }
    if (url.startsWith('/admin/api/source-drafts/') && method === 'DELETE') {
      if (options.deleteGate) await options.deleteGate
      const status = options.deleteStatus ?? 204
      return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify({ error: 'not_found' }), { status })
    }
    if (url === '/admin/api/screens' && method === 'POST') {
      saveAttempts++
      if (options.failFirstSave && saveAttempts === 1) return new Response(JSON.stringify({ error: 'screen save failed' }), { status: 500 })
      const row = normalized(body, 'lay_created', normalizedRev)
      currentRows = [row]
      return new Response(JSON.stringify(row), { status: 200 })
    }
    if (url.startsWith('/admin/api/screens/') && method === 'PATCH') {
      saveAttempts++
      if (options.failFirstSave && saveAttempts === 1) return new Response(JSON.stringify({ error: 'screen save failed' }), { status: 500 })
      const row = normalized(body, url.slice('/admin/api/screens/'.length), normalizedRev + saveAttempts - 1)
      currentRows = [row]
      return new Response(JSON.stringify(row), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }))
  return requests
}

const selectWidget = async (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add widget' }))
  fireEvent.click(await screen.findByRole('option', { name }))
}

const useNewConnection = async (widget: 'weather_forecast' | 'news_list') => {
  await selectWidget(widget === 'weather_forecast' ? /Five-day forecast/i : /News list/i)
  fireEvent.click(await screen.findByRole('button', {
    name: widget === 'weather_forecast' ? /Set up Test Weather/i : /Set up Test News/i,
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Use this data' }))
}

describe('Screens editor — widget-first connections', () => {
  it('opens and closes the gallery, while Clock, Text and an Advanced widget place without setup', async () => {
    const requests = stubWidgetFirst()
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))

    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }))
    expect(screen.getByRole('listbox', { name: 'Widgets' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Close widget gallery' }))
    expect(screen.queryByRole('listbox', { name: 'Widgets' })).toBeNull()

    await selectWidget(/Clock/i)
    await selectWidget(/^Text/i)
    await selectWidget(/^Value/i)
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(4)
    expect(requests.some((request) => request.url.startsWith('/admin/api/source-choices'))).toBe(false)

    await selectWidget(/Five-day forecast/i)
    await screen.findByRole('heading', { name: 'Choose weather data' })
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Choose weather data' })).toBeNull())
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(4)
  })

  it('places an existing compatible connection without draft copy or draft cleanup', async () => {
    const requests = stubWidgetFirst({ existingWeather: true })
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await selectWidget(/Five-day forecast/i)
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(1)
    fireEvent.click(await screen.findByRole('button', { name: /Preview Home weather/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this data' }))

    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(2)
    expect(screen.getByText('Home weather')).toBeDefined()
    expect(screen.queryByText('Not saved yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create layout' })).toBeDefined()
    expect(requests.some((request) => request.method === 'POST' && request.url === '/admin/api/source-drafts')).toBe(false)
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false)

    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Existing weather' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create layout' }))
    await waitFor(() => expect(requests.some((request) => request.url === '/admin/api/screens' && request.method === 'POST')).toBe(true))
    const create = requests.find((request) => request.url === '/admin/api/screens' && request.method === 'POST')!
    expect(create.body.grid.cells[0].config).toMatchObject({ feed: 'feed_existing_weather' })
    expect(create.body.grid.cells[0].config).not.toHaveProperty('source_draft_id')
  })

  it('stores the exact draft binding and safe preview, then consumes the normalized create response exactly', async () => {
    const requests = stubWidgetFirst({ normalizedRev: 47 })
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await useNewConnection('news_list')

    expect(screen.getAllByText('Not saved yet').length).toBeGreaterThan(0)
    expect(paintedText).toContain('A real normalized headline')
    expect(screen.getByRole('button', { name: 'Save screen & connections' })).toBeDefined()

    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Morning headlines' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save screen & connections' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save layout' })).toBeDefined())

    const create = requests.find((request) => request.url === '/admin/api/screens' && request.method === 'POST')!
    expect(create.body.grid.cells[0].config).toMatchObject({
      source_draft_id: 'drf_news', output_contract: NEWS_CONTRACT,
    })
    expect(create.body.grid.cells[0].config).not.toHaveProperty('preview')
    expect(create.body.grid.cells[0].config).not.toHaveProperty('connection')
    expect(screen.queryByText('Not saved yet')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1))
    const patch = requests.find((request) => request.method === 'PATCH')!
    expect(patch.body.rev).toBe(47)
    expect(patch.body.grid.cells[0].config).toMatchObject({ feed: 'feed_promoted_news_list' })
    expect(patch.body.grid.cells[0].config).not.toHaveProperty('source_draft_id')
    expect(requests.filter((request) => request.url === '/admin/api/screens' && request.method === 'GET').length).toBeGreaterThan(1)
    expect(requests.filter((request) => request.url === '/admin/api/feeds' && request.method === 'GET').length).toBeGreaterThan(1)
  })

  it('keeps a failed save and its live draft for retry', async () => {
    const requests = stubWidgetFirst({ failFirstSave: true })
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await useNewConnection('news_list')
    fireEvent.pointerDown(cardAt(container, 0))
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Retry me' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save screen & connections' }))
    await screen.findByText('screen save failed')
    expect((screen.getByPlaceholderText('Layout name') as HTMLInputElement).value).toBe('Retry me')
    expect(screen.getAllByText('Not saved yet').length).toBeGreaterThan(0)
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Save screen & connections' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save layout' })).toBeDefined())
  })

  it('removing a pending card and cancelling an editor clean only owned drafts, including an already-cleaned 404', async () => {
    const requests = stubWidgetFirst({ deleteStatus: 404 })
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await useNewConnection('news_list')
    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(1))
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.url))
      .toEqual(['/admin/api/source-drafts/drf_news'])

    await useNewConnection('news_list')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel screen editing' }))
    await screen.findByRole('button', { name: 'New layout' })
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.url))
      .toEqual(['/admin/api/source-drafts/drf_news', '/admin/api/source-drafts/drf_news'])
    expect(requests.some((request) => request.url.includes('feed_saved_weather') && request.method === 'DELETE')).toBe(false)
  })

  it('preserves widgets added while a pending draft deletion is in flight', async () => {
    let releaseDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve })
    stubWidgetFirst({ deleteGate })
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await useNewConnection('news_list')

    fireEvent.click(screen.getByRole('button', { name: 'Remove card' }))
    await selectWidget(/Clock/i)
    expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(3)

    releaseDelete()
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="card-"]')).toHaveLength(2))
    expect(container.querySelector('.card-widget')?.textContent).toBe('Clock')
  })

  it('does not let a late setup result resurrect a cancelled editor', async () => {
    let releaseDraft!: () => void
    const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve })
    const requests = stubWidgetFirst({ draftGate })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'New layout' }))
    await selectWidget(/News list/i)
    fireEvent.click(await screen.findByRole('button', { name: /Set up Test News/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('status', { name: 'Testing connection' })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel screen editing' }))
    await screen.findByRole('button', { name: 'New layout' })
    releaseDraft()
    await waitFor(() => expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.url))
      .toEqual(['/admin/api/source-drafts/drf_news']))
    expect(screen.queryByText('Not saved yet')).toBeNull()
    expect(screen.queryByPlaceholderText('Layout name')).toBeNull()
  })

  it('preserves a saved semantic binding while changing it, and abandons only the tested replacement', async () => {
    const requests = stubWidgetFirst({ rows: [savedWeatherRow] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Home weather')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Change connection' }))
    expect(screen.getByText('Home weather')).toBeDefined()
    fireEvent.click(await screen.findByRole('button', { name: /Set up Test Weather/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this data' }))
    expect(screen.getAllByText('Not saved yet').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel screen editing' }))
    await screen.findByText('Forecast screen')
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.url))
      .toEqual(['/admin/api/source-drafts/drf_weather_replacement'])
  })

  it('uses the normalized PATCH cells and returned revision instead of incrementing locally', async () => {
    const requests = stubWidgetFirst({ rows: [savedWeatherRow], normalizedRev: 83 })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Change connection' }))
    fireEvent.click(await screen.findByRole('button', { name: /Set up Test Weather/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this data' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save screen & connections' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save layout' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2))
    const patches = requests.filter((request) => request.method === 'PATCH')
    expect(patches[0].body.rev).toBe(12)
    expect(patches[0].body.grid.cells[0].config).toMatchObject({
      source_draft_id: 'drf_weather_replacement', output_contract: WEATHER_CONTRACT,
    })
    expect(patches[1].body.rev).toBe(83)
    expect(patches[1].body.grid.cells[0].config).toMatchObject({ feed: 'feed_promoted_weather_forecast' })
  })
})

/**
 * A screen is authored FOR a device, and a device has a size.
 *
 * Before this the editor offered a target-shape dropdown; an operator picked 16:10 for a 20:9
 * handset and every cell came out ~28% shorter in pixels than the preview showed. Worse, cards too
 * small for their widget were only discovered on the wall.
 */
describe('Screens editor — device-aware target', () => {
  const A05 = {
    id: 'dev_1', name: 'galaxy-a05-wifi', screen_id: 'lay_1', online: true,
    viewport_w: 853, viewport_h: 384, viewport_dpr: 1.875,
  }

  const stubWith = (devices: any[]) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/screens' && !init?.method) return new Response(JSON.stringify([ROW]), { status: 200 })
      if (url === '/admin/api/devices') return new Response(JSON.stringify(devices), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
  }

  it('designs against the assigned device\'s real pixels, not a picked shape', async () => {
    stubWith([A05])
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const banner = await screen.findByLabelText('Target device')
    expect(banner.textContent).toContain('galaxy-a05-wifi')
    expect(banner.textContent).toContain('853')
    expect(banner.textContent).toContain('384')
    // The guess is gone once a real target exists.
    expect(screen.queryByLabelText('Target shape')).toBeNull()
  })

  /**
   * A device that has never connected tells us nothing, so the shape picker is shown when no
   * measured device is available.
   */
  it('falls back to the shape picker when no device has reported', async () => {
    stubWith([{ ...A05, viewport_w: null, viewport_h: null, viewport_dpr: null }])
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByLabelText('Target shape')).toBeDefined()
    expect(screen.queryByLabelText('Target device')).toBeNull()
  })

  /**
   * ROW's first card is a 0.5x1 clock and its second a 0.5x1 alert_feed, so on an 853x384 device
   * both clear their minimums. Shrinking one below WIDGET_MIN_PX must be called out while drawing.
   */
  it('warns about a card too small for its widget on that device', async () => {
    stubWith([A05])
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    // 0.05 of 384px = 19px tall: far below any widget's minimum.
    fireEvent.change(screen.getByLabelText('Card 1 h'), { target: { value: '0.05' } })

    const warning = await screen.findByLabelText('undersized warning')
    expect(warning.textContent).toContain('too small')
    expect(warning.textContent).toContain('galaxy-a05-wifi')
    // And the card itself is marked on the canvas.
    expect(container.querySelector('[data-undersized="true"]')).not.toBeNull()
  })

  it('says nothing about minimums when it cannot know them', async () => {
    stubWith([{ ...A05, viewport_w: null, viewport_h: null, viewport_dpr: null }])
    const { container } = render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Card 1 h'), { target: { value: '0.05' } })
    expect(screen.queryByLabelText('undersized warning')).toBeNull()
    expect(container.querySelector('[data-undersized="true"]')).toBeNull()
  })
})

/**
 * The lost-update guard, from the editor's side (v14).
 *
 * The editor PATCHes the WHOLE grid, so it must say which version it read, and it must survive
 * being told no. Discarding the operator's cells on a 409 would replace one way of losing work
 * with another.
 */
describe('Screens page — saving a layout that moved underneath it', () => {
  const saveStub = (patchStatus: number, patchBody: object = {}) => {
    const patches: { url: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/screens' && !init?.method) {
        return new Response(JSON.stringify([{ ...ROW, rev: 7 }]), { status: 200 })
      }
      if (url.startsWith('/admin/api/screens/') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        patches.push({ url, body })
        return patchStatus === 204
          ? new Response(JSON.stringify(savedScreen(body, ROW.id, 8)), { status: 200 })
          : new Response(JSON.stringify(patchBody), { status: patchStatus })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return patches
  }

  it('sends the rev it loaded the layout at', async () => {
    const patches = saveStub(204)
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].body.rev).toBe(7)
  })

  it('keeps the operator’s edits on the screen when the save is refused', async () => {
    saveStub(409, { error: 'screen changed elsewhere', rev: 9 })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByPlaceholderText('Layout name'), { target: { value: 'Kitchen renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))

    await waitFor(() => expect(screen.getByText(/changed elsewhere/)).toBeDefined())
    // Still editing, and the unsaved name is still in the form — nothing was thrown away.
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeDefined()
    expect((screen.getByPlaceholderText('Layout name') as HTMLInputElement).value).toBe('Kitchen renamed')
  })
})

/**
 * The editor is a mode you leave deliberately. Saving keeps the editor open so a layout can be
 * built in several passes without reopening it after every checkpoint.
 */
describe('Screens page — the editor is its own view', () => {
  const ROW2 = { ...ROW, rev: 3 }
  const stubEdit = () => {
    const patches: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/admin/api/screens/') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        patches.push(body)
        return new Response(JSON.stringify(savedScreen(body, ROW.id, ROW2.rev + patches.length)), { status: 200 })
      }
      if (url === '/admin/api/screens' && !init?.method) return new Response(JSON.stringify([ROW2]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return patches
  }

  it('keeps the editor open after a save, and carries the new rev into the next one', async () => {
    const patches = stubEdit()
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByPlaceholderText('Layout name')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].rev).toBe(3)

    // Still editing — no trip back to the list.
    expect(screen.getByPlaceholderText('Layout name')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeDefined()

    // And the second save carries the rev the first one produced, or it would 409 on itself.
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1].rev).toBe(4)
  })

  it('shows the list, and no editor, until you ask for one', async () => {
    stubEdit()
    render(<Screens />)
    await screen.findByText('Kitchen')
    expect(screen.queryByPlaceholderText('Layout name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New layout' }))
    expect(screen.getByPlaceholderText('Layout name')).toBeDefined()
  })
})

/**
 * screen editor behavior: per-screen sound overrides + play-this-mix-on-device audition. The mixer's suggestion
 * is the assigned theme's sounds resolved to all four events (unset events fall back to
 * 'classic') — never null, unlike the theme editor's own mixer, which has no further
 * fallback. Overrides PATCH immediately (field-level PATCH takes no `rev` — only the whole-grid
 * save does), and the test-on-device row plays the effective family (override ?? suggestion) for
 * each event, in sequence, on a device that actually shows this screen.
 */
describe('Screens editor — sound overrides + test-on-device', () => {
  const DEVICE = { id: 'dev_1', name: 'kitchen', online: true, tabs: [{ screen_id: ROW.id }] }

  const soundStub = (opts: {
    devices?: any[]; screenTheme?: string | null; themeSounds?: Record<string, string>
  } = {}) => {
    const { devices = [], screenTheme = null, themeSounds = {} } = opts
    const patches: { url: string; body: any }[] = []
    const posts: { url: string; body: any }[] = []
    const row = { ...ROW, theme_id: screenTheme }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/sounds/manifest.json') return new Response(JSON.stringify(SOUND_MANIFEST), { status: 200 })
      if (url === '/admin/api/screens' && !init?.method) return new Response(JSON.stringify([row]), { status: 200 })
      if (url.startsWith('/admin/api/screens/') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        patches.push({ url, body })
        return new Response(JSON.stringify({ ...row, ...body }), { status: 200 })
      }
      if (url === '/admin/api/themes') {
        return new Response(JSON.stringify([{ id: 'thm_cypherpunk', name: 'Cypherpunk', sounds: themeSounds }]), { status: 200 })
      }
      if (url === '/admin/api/devices') return new Response(JSON.stringify(devices), { status: 200 })
      if (/^\/admin\/api\/devices\/[^/]+\/play-sound$/.test(url) && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body as string) })
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return { patches, posts }
  }

  it('renders the Sounds card inside the edit form, above Save layout / Cancel', async () => {
    soundStub({ devices: [DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const sounds = await screen.findByRole('heading', { name: 'Sounds' })
    const save = screen.getByRole('button', { name: /Save layout/ })
    // Same form, and Sounds comes first in document order — below the per-card sections,
    // above the submit row.
    expect(sounds.closest('form')).toBe(save.closest('form'))
    expect(sounds.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('PATCHes a sparse override immediately on change, with no rev (field-level PATCH)', async () => {
    const { patches } = soundStub({ devices: [DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByLabelText('Choose Critical alarm sound'))
    fireEvent.click(screen.getByLabelText('Use Soft bells for Critical alarm'))
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ sounds: { critical: 'bells' } }))
    expect(patches.at(-1)?.body).not.toHaveProperty('rev')
  })

  it('test-on-device POSTs play-sound for each event to the chosen device, including activity', async () => {
    const { posts } = soundStub({ devices: [DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Test sounds on device'), { target: { value: 'dev_1' } })
    fireEvent.click(screen.getByLabelText('Play this mix on kitchen'))
    await waitFor(() => expect(posts.map((p) => p.url)).toContain('/admin/api/devices/dev_1/play-sound'))
    // The first event posted is the effective (override ?? suggestion) family — 'classic' here,
    // since nothing is overridden and the screen has no assigned theme.
    expect(posts[0].body).toEqual({ family: 'classic', event: 'critical' })
    // The sequence walks the whole SOUND_EVENTS list — 'activity' is the newest, trailing entry,
    // ~1.2s behind the one before it (real time; this test runs the full ~4.8s sequence to prove it).
    await waitFor(() => expect(posts.map((p) => p.body.event)).toContain('activity'), { timeout: 6000 })
  }, 8000)

  it('resolves the mixer suggestion from the assigned theme, filling unset events with classic', async () => {
    soundStub({ devices: [DEVICE], screenTheme: 'thm_cypherpunk', themeSounds: { warn: 'bells' } })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByLabelText('Warn chime sound: Soft bells (from theme)')).toBeDefined()
    expect(screen.getByLabelText('Critical alarm sound: Classic beeps (from theme)')).toBeDefined()
  })

  it('falls back to any online device with a hint, when none show this screen', async () => {
    const OTHER_DEVICE = { id: 'dev_2', name: 'hallway', online: true, tabs: [{ screen_id: 'lay_other' }] }
    soundStub({ devices: [OTHER_DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const picker = await screen.findByLabelText('Test sounds on device') as HTMLSelectElement
    expect(Array.from(picker.options).map((o) => o.textContent)).toContain('hallway')
    expect(screen.getByText(/no device is showing this screen/i)).toBeDefined()
  })

  it('excludes offline devices, even one assigned to this screen, from the picker', async () => {
    const OFFLINE = { id: 'dev_3', name: 'garage', online: false, tabs: [{ screen_id: ROW.id }] }
    soundStub({ devices: [OFFLINE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('Choose Critical alarm sound')
    expect(screen.queryByLabelText('Test sounds on device')).toBeNull()
    expect(screen.getByText(/no online device/i)).toBeDefined()
  })

  /**
   * Without a re-entrancy guard, a double-click starts two independent
   * `playMixOnDevice` loops, each posting every ~1.2s — two overlapping sequences of POSTs to the
   * same device, exactly the pile-up the sequencing exists to prevent. A wrongly-started second
   * loop's OWN first POST would land immediately (nothing precedes the first event in a sequence),
   * so a short real-time wait after both clicks is enough to catch it without waiting out the
   * whole ~4.8s sequence.
   */
  it('a double-click on Play this mix does not start a second overlapping sequence', async () => {
    const { posts } = soundStub({ devices: [DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Test sounds on device'), { target: { value: 'dev_1' } })
    const button = screen.getByLabelText('Play this mix on kitchen')
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(posts.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    expect(posts.filter((p) => p.body.event === 'critical')).toHaveLength(1)
  })

  it('disables Play this mix, and names the device it is playing on, while a sequence is in flight', async () => {
    soundStub({ devices: [DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Test sounds on device'), { target: { value: 'dev_1' } })
    fireEvent.click(screen.getByLabelText('Play this mix on kitchen'))
    const playing = await screen.findByLabelText('Playing on kitchen…') as HTMLButtonElement
    expect(playing.disabled).toBe(true)
  })

  /**
   * cancelEdit/resetAfterCancel resets `testDeviceId`, and playback must also be told to stop so a
   * running `playMixOnDevice` loop to stop — it kept firing POSTs on its own schedule after the
   * operator left the section entirely. `cancelPlayback` bumps a generation token the loop checks
   * between every awaited step, so the 'warn' POST that would follow 'critical' (after the ~1.2s
   * gap) must never arrive once the editor has been cancelled.
   */
  it('stops posting once the editor is cancelled mid-sequence', async () => {
    const { posts } = soundStub({ devices: [DEVICE] })
    render(<Screens />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Test sounds on device'), { target: { value: 'dev_1' } })
    fireEvent.click(screen.getByLabelText('Play this mix on kitchen'))
    await waitFor(() => expect(posts).toHaveLength(1)) // 'critical' posted; sequence is mid-gap now
    fireEvent.click(screen.getByRole('button', { name: 'Cancel screen editing' }))
    // Real-time wait past the 1.2s gap: an uncancelled sequence would post 'warn' by now.
    await new Promise((r) => setTimeout(r, 1400))
    expect(posts).toHaveLength(1)
  })
})

describe('Screens page — starter screen finish-setup prompt', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  // The exact shape pairing seeds (hub/src/screens/starter.ts): one full-bleed clock.
  const STARTER_ROW = { id: 'lay_starter', name: 'bedside', orientation: 'landscape', created_at: 1,
    grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] },
    assigned_count: 1, theme_id: null, rev: 1, sounds: {} }

  const stubList = (rows: any[]) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/admin/api/screens') return new Response(JSON.stringify(rows), { status: 200 })
    return new Response(JSON.stringify([]), { status: 200 })
  }))

  it('editing a starter-shaped screen offers weather and calendar; Add weather opens the data flow', async () => {
    stubList([STARTER_ROW])
    render(<Screens />)
    await waitFor(() => expect(screen.getByText('bedside')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Add a calendar' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Add weather' }))
    await screen.findByText('Choose data')
  })

  it('a screen with more than the starter clock gets no prompt', async () => {
    stubList([ROW])
    render(<Screens />)
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Add weather' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a calendar' })).toBeNull()
  })
})
