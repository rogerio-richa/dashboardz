import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Themes from './Themes'

const BOARD = {
  bg: '#0b0d12', surface: '#12141c', ink: '#e6e9f0', dim: '#8a90a0', accent: '#4a90d9',
  scrim: 0.5, info: '#4a90d9', warn: '#f0a020', critical: '#e0323c',
  series: ['#4a90d9', '#f0a020', '#e0323c', '#8a90a0'],
}
const CHROME = {
  hairline: '#ffffff14', muted: '#a8adbd', chip: '#c0c5d0', border: '#2a2e38',
  surface_warn: '#141826', surface_critical: '#1a1216', takeover_bg: '#2a080c',
  takeover_meta: '#ff8a90', takeover_body: '#ffb4b8', takeover_hint_bg: '#1c202a',
  on_critical: '#fff',
}

const DEFAULT_THEME = {
  id: 'thm_default', name: 'Default', board: BOARD, widgets: {}, chrome: {}, sounds: {},
  bg_kind: 'none', bg_color: null, bg_rev: 0, rev: 1, builtin: true, created_at: 1,
}
const CYPHER = {
  id: 'thm_cypherpunk', name: 'Cypherpunk',
  board: { ...BOARD, bg: '#0a0a0a', ink: '#ff2b2b' },
  widgets: { clock: 'segment' },
  chrome: CHROME,
  sounds: {},
  bg_kind: 'none', bg_color: null, bg_rev: 0, rev: 1, builtin: true, created_at: 2,
}

const SOUND_MANIFEST = {
  rev: 1,
  families: {
    classic: { name: 'Classic beeps' },
    bells: { name: 'Soft bells' },
    '8bit': { name: '8-bit' },
  },
}

// RTL does not auto-clean here: no globals:true and no setup file, so every file needs this
// at file scope (not inside a describe).
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Installs a fetch mock and returns the array that captures every write. */
const stub = (themes = [DEFAULT_THEME, CYPHER]) => {
  const writes: { url: string; method: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/sounds/manifest.json') {
      return new Response(JSON.stringify(SOUND_MANIFEST), { status: 200 })
    }
    if (url === '/admin/api/themes' && !init?.method) {
      return new Response(JSON.stringify(themes), { status: 200 })
    }
    if (init?.method) {
      // A bg upload's body is a File, not JSON — record it as-is (the blink of parsing it would
      // throw and fail the wrong assertion).
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null
      writes.push({ url, method: init.method, body })
      if (url.endsWith('/bg')) return new Response(JSON.stringify({ ok: true, bg_rev: 1 }), { status: 200 })
      return new Response(JSON.stringify(themes[1]), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }))
  return writes
}

describe('Themes page', () => {
  it('lists the themes from the API', async () => {
    stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    expect(screen.getByText('Default')).toBeDefined()
  })

  it('edits a board colour and saves', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    const ink = await screen.findByLabelText('board ink')
    fireEvent.change(ink, { target: { value: '#ffffff' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body.board.ink).toBe('#ffffff')
  })

  /**
   * The data-loss shape in this API: PATCH replaces `board`/`chrome`/`widgets` wholesale, so a
   * partial object silently drops sibling keys. The editor must always send complete sub-objects.
   */
  it('sends a COMPLETE board object, not just the changed key', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    fireEvent.change(await screen.findByLabelText('board ink'), { target: { value: '#ffffff' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(Object.keys(writes[0].body.board).sort()).toEqual(
      ['accent', 'bg', 'critical', 'dim', 'info', 'ink', 'scrim', 'series', 'surface', 'warn'],
    )
    // the untouched keys keep their values
    expect(writes[0].body.board.bg).toBe('#0a0a0a')
    expect(writes[0].body.board.series).toEqual(BOARD.series)
  })

  it('sends a COMPLETE chrome object too', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    fireEvent.click(screen.getByRole('button', { name: 'Chrome colours' }))
    fireEvent.change(await screen.findByLabelText('chrome hairline'), { target: { value: '#ff000022' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(Object.keys(writes[0].body.chrome)).toHaveLength(11)
    expect(writes[0].body.chrome.hairline).toBe('#ff000022')
  })

  /**
   * thm_default reproduces today's palette exactly and is the one reference point worth
   * protecting. Every other seeded preset is a starting point, not a fixture.
   */
  it('makes thm_default read-only, offering Duplicate instead', async () => {
    stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Default')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Edit Default' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Duplicate Default' })).toBeDefined()
  })

  it('lets the seeded cypherpunk preset be edited despite being builtin', async () => {
    stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Edit Cypherpunk' })).toBeDefined()
  })

  it('saves the sounds map with the theme', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    fireEvent.click(await screen.findByLabelText('Choose Warn chime sound'))
    fireEvent.click(screen.getByLabelText('Use Soft bells for Warn chime'))
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body.sounds).toMatchObject({ warn: 'bells' })
  })
})

/**
 * A theme's per-widget entry is a bare DESIGN ID (v11).
 *
 * Every design's slots already default to a board colour, so the palette does that job and a theme
 * names geometry only.
 */
describe('Themes page — a theme names a design per widget type', () => {
  it('offers a design picker and NO colour inputs', async () => {
    stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    expect(await screen.findByLabelText('clock design')).toBeDefined()
    for (const slot of ['segment_on', 'bezel', 'colon']) {
      expect(screen.queryByLabelText(`clock ${slot}`)).toBeNull()
    }
    // The colorset picker went with the colorsets.
    expect(screen.queryByLabelText('clock colorset')).toBeNull()
  })

  it('saves the design id alone', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    fireEvent.change(await screen.findByLabelText('clock design'), { target: { value: 'analog' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].url).toBe('/admin/api/themes/thm_cypherpunk')
    expect(writes[0].body.widgets.clock).toBe('analog')
  })

  it('choosing "follow the board" removes the widget entry entirely', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    fireEvent.change(await screen.findByLabelText('clock design'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect('clock' in writes[0].body.widgets).toBe(false)
  })
})

/**
 * A theme could be deleted through the API since the delete-cascade landed, and never through the
 * UI — so the only way to remove one you had made was curl. A built-in still cannot go: the API
 * refuses it, and offering a button that returns 400 is worse than not offering one.
 */
describe('Themes page — deleting', () => {
  const stubList = (themes: object[]) => {
    const deletes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deletes.push(url); return new Response(null, { status: 204 }) }
      if (url === '/admin/api/themes') return new Response(JSON.stringify(themes), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return deletes
  }
  const THEME = (over: object) => ({
    id: 'thm_x', name: 'Mine', board: {}, widgets: {}, chrome: {}, bg_kind: 'none', bg_color: null,
    bg_rev: 0, backdrop: 'flat', rev: 1, builtin: false, created_at: 1, ...over,
  })

  it('deletes one you made, after confirming, and says what it costs', async () => {
    const deletes = stubList([THEME({})])
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Mine')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('built-in default')
    expect(deletes).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deletes).toEqual(['/admin/api/themes/thm_x']))
  })

  it('offers no delete for a built-in, because the API would refuse it', async () => {
    stubList([THEME({ id: 'thm_terminal', name: 'Terminal', builtin: true })])
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Terminal')).toBeDefined())
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
  })

  it('uploads a background image immediately, with the file’s own content type', async () => {
    const writes = stub()
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'bg.png', { type: 'image/png' })
    fireEvent.change(await screen.findByLabelText('Upload background image'), { target: { files: [file] } })

    await waitFor(() => {
      const put = writes.find((w) => w.url === '/admin/api/themes/thm_cypherpunk/bg')
      expect(put?.method).toBe('PUT')
      expect(put?.body).toBe(file)
    })
    // Confirmed upload flips the row to "set" with a Remove action — no Save theme involved.
    expect(await screen.findByRole('button', { name: 'Remove background image' })).toBeDefined()
  })

  it('Remove issues a field-level PATCH turning bg_kind off', async () => {
    const withImage = [DEFAULT_THEME, { ...CYPHER, bg_kind: 'image', bg_rev: 3 }]
    const writes = stub(withImage)
    render(<Themes />)
    await waitFor(() => expect(screen.getByText('Cypherpunk')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cypherpunk' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove background image' }))
    await waitFor(() => {
      const patch = writes.find((w) => w.url === '/admin/api/themes/thm_cypherpunk' && w.method === 'PATCH')
      expect(patch?.body).toEqual({ bg_kind: 'none' })
    })
  })
})
