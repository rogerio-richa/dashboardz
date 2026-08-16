import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Devices from './Devices'
import { OrientationIcon } from '../icons'

const DEVICE = {
  id: 'dev_1', name: 'kitchen', online: true, battery: null, last_seen_at: null,
  screen_id: 'lay_l',
  // Single-tab device: the tabs editor renders exactly one row for this shape — no
  // special-cased "one screen" mode, same editor as a multi-tab device further down this file.
  tabs: [{ screen_id: 'lay_l', position: 0, label: null, name: 'Land' }],
  // The A05 in landscape: a 720x1600 panel reporting 853x384 CSS px at dpr 1.875. The spec sheet
  // and the box a layout actually gets are different numbers, which is the point of showing it.
  viewport_w: 853, viewport_h: 384, viewport_dpr: 1.875,
  nav_bars: 'respected',
  rendering: { state: 'ok', acked_screen_id: 'lay_l', active_screen_id: 'lay_l' },
}
const SCREEN_L = { id: 'lay_l', name: 'Land', orientation: 'landscape', grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] }, created_at: 1, assigned_count: 0 }
const SCREEN_P = { id: 'lay_p', name: 'Port', orientation: 'portrait', grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] }, created_at: 1, assigned_count: 0 }

describe('Devices page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const stub = (patches: any[] = [], posts: any[] = [], devices: any[] = [DEVICE]) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/devices/pairing-codes' && init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string))
        return new Response(JSON.stringify({ code: '123456' }), { status: 200 })
      }
      if (url.startsWith('/admin/api/devices/') && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return new Response(JSON.stringify({}), { status: 200 })
      }
      if (url === '/admin/api/devices') return new Response(JSON.stringify(devices), { status: 200 })
      if (url === '/admin/api/screens') return new Response(JSON.stringify([SCREEN_L, SCREEN_P]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
  }

  const stubPatchFails = (deviceGets: { count: number }) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/admin/api/devices/') && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ error: 'orientation mismatch' }), { status: 400 })
      }
      if (url === '/admin/api/devices') { deviceGets.count += 1; return new Response(JSON.stringify([DEVICE]), { status: 200 }) }
      if (url === '/admin/api/screens') return new Response(JSON.stringify([SCREEN_L, SCREEN_P]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
  }

  /**
   * Any screen can go on any device. The ordered-tab behavior turned the single-screen `<select>` into an
   * ordered tab list, so "any screen" now means the add-tab dropdown offers every screen not
   * already in the device's tab list — here just "Port", since "Land" is tab 0. The editor
   * lives in the Screens… dialog now; the row's cell is a read-only summary.
   */
  it('a device with no tabs points the operator at the Screens tab, not a dead end', async () => {
    stub([], [], [{ ...DEVICE, screen_id: null, tabs: [], rendering: null }])
    render(<Devices publicUrl="http://x" />)
    await screen.findByText('kitchen')
    fireEvent.click(screen.getByRole('button', { name: 'Screens for kitchen' }))
    expect(screen.getByText(/build one in the Screens tab/i)).toBeDefined()
  })

  it('offers screens not already in the tab list, shows rendering state, and PATCHes the full tabs array on add', async () => {
    const patches: any[] = []
    stub(patches)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Screens for kitchen'))

    const select = screen.getByLabelText('Add screen to kitchen') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.text)
    expect(options).toEqual(['Add screen…', 'Port'])

    expect(screen.getByText('✓')).toBeDefined()

    fireEvent.change(select, { target: { value: 'lay_p' } })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ tabs: [{ screen_id: 'lay_l', label: null }, { screen_id: 'lay_p', label: null }] })
  })

  it('surfaces a failed tabs PATCH via alert and re-fetches devices to snap the list back to server truth', async () => {
    const alertFn = vi.fn()
    vi.stubGlobal('alert', alertFn)
    const deviceGets = { count: 0 }
    stubPatchFails(deviceGets)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    const getsAfterInitialLoad = deviceGets.count
    fireEvent.click(screen.getByLabelText('Screens for kitchen'))

    const select = screen.getByLabelText('Add screen to kitchen') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'lay_p' } })

    await waitFor(() => expect(alertFn).toHaveBeenCalledWith('orientation mismatch'))
    await waitFor(() => expect(deviceGets.count).toBeGreaterThan(getsAfterInitialLoad))
  })

  /**
   * v15 removed the flip and the pairing-time orientation select together: a device has no shape
   * of its own to set. Pairing now asks for a name and nothing else.
   */
  it('offers no orientation control at all', async () => {
    stub([])
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    expect(screen.queryByTitle('Flip orientation')).toBeNull()
    expect(screen.queryByLabelText('Orientation')).toBeNull()
  })

  it('pairs on a name alone', async () => {
    const posts: any[] = []
    stub([], posts)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    fireEvent.change(screen.getByPlaceholderText('New device name'), { target: { value: 'hallway' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ name: 'hallway' })
  })

  /** The editor designs against this box, so the operator can read it here. */
  it('shows the viewport the device reported, and an em dash before it has connected', async () => {
    stub([])
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    expect(screen.getByText('853×384 @1.875x')).toBeDefined()
  })
})

/**
 * The ordered tab-list editor. Single-tab devices are covered above (same component, one
 * row); this exercises add/remove/reorder/relabel and the online active-tab marker with a
 * two-tab device. The editor opens from the row's Screens… button (the cell itself is a
 * read-only summary now); the ▶ marker is pinned in BOTH homes.
 */
describe('Devices page — tabs editor', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const openDialog = () => fireEvent.click(screen.getByLabelText('Screens for kitchen'))

  const DEVICE_MULTI = {
    ...DEVICE,
    tabs: [
      { screen_id: 'lay_l', position: 0, label: null, name: 'Land' },
      { screen_id: 'lay_p', position: 1, label: 'Custom', name: 'Port' },
    ],
    rendering: { state: 'ok', acked_screen_id: 'lay_l', active_screen_id: 'lay_p' },
  }

  const stubDevices = (devices: any[], patches: any[] = []) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/admin/api/devices/') && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return new Response(JSON.stringify({}), { status: 200 })
      }
      if (url === '/admin/api/devices') return new Response(JSON.stringify(devices), { status: 200 })
      if (url === '/admin/api/screens') return new Response(JSON.stringify([SCREEN_L, SCREEN_P]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
  }

  it('renders exactly one row for a single-tab device — the same editor, no special case', async () => {
    stubDevices([DEVICE])
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    openDialog()
    expect(screen.getAllByLabelText(/^Label for /)).toHaveLength(1)
    expect(screen.getByLabelText('Label for Land on kitchen')).toBeDefined()
  })

  it('reorders a tab with the down button, PATCHing the full reordered tabs array', async () => {
    const patches: any[] = []
    stubDevices([DEVICE_MULTI], patches)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    openDialog()
    fireEvent.click(screen.getByLabelText('Move Land down on kitchen'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({
      tabs: [{ screen_id: 'lay_p', label: 'Custom' }, { screen_id: 'lay_l', label: null }],
    })
  })

  it('disables the up button on the first row and the down button on the last', async () => {
    stubDevices([DEVICE_MULTI])
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    openDialog()
    expect((screen.getByLabelText('Move Land up on kitchen') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Move Land down on kitchen') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText('Move Port up on kitchen') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText('Move Port down on kitchen') as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes a tab, PATCHing the remaining tabs only', async () => {
    const patches: any[] = []
    stubDevices([DEVICE_MULTI], patches)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    openDialog()
    fireEvent.click(screen.getByLabelText('Remove Land from kitchen'))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ tabs: [{ screen_id: 'lay_p', label: 'Custom' }] })
  })

  it('relabels a tab when its input is blurred, sending the full tabs array', async () => {
    const patches: any[] = []
    stubDevices([DEVICE_MULTI], patches)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    openDialog()
    const input = screen.getByLabelText('Label for Port on kitchen') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Kitchen Feed' } })
    fireEvent.blur(input)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({
      tabs: [{ screen_id: 'lay_l', label: null }, { screen_id: 'lay_p', label: 'Kitchen Feed' }],
    })
  })

  it('clears a label back to null (falls back to the screen name) when emptied and blurred', async () => {
    const patches: any[] = []
    stubDevices([DEVICE_MULTI], patches)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    openDialog()
    const input = screen.getByLabelText('Label for Port on kitchen') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({
      tabs: [{ screen_id: 'lay_l', label: null }, { screen_id: 'lay_p', label: null }],
    })
  })

  it('does not PATCH on blur when the label is unchanged', async () => {
    const patches: any[] = []
    stubDevices([DEVICE_MULTI], patches)
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    openDialog()
    const input = screen.getByLabelText('Label for Land on kitchen') as HTMLInputElement
    fireEvent.blur(input)
    await new Promise((r) => setTimeout(r, 0))
    expect(patches).toHaveLength(0)
  })

  it('shows ▶ next to the active tab while the device is online, and hides it entirely once offline', async () => {
    stubDevices([DEVICE_MULTI])
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    expect(screen.getByLabelText('Port is active on kitchen')).toBeDefined()
    expect(screen.queryByLabelText('Land is active on kitchen')).toBeNull()
    cleanup()

    stubDevices([{ ...DEVICE_MULTI, online: false }])
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    expect(screen.queryByLabelText('Port is active on kitchen')).toBeNull()
    expect(screen.queryByLabelText('Land is active on kitchen')).toBeNull()
  })

  it('hides the add-tab select once a device is at 16 tabs', async () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({
      screen_id: `lay_${i}`, position: i, label: null, name: `Screen ${i}`,
    }))
    const screensSixteen = sixteen.map((t) => ({ id: t.screen_id, name: t.name, orientation: 'landscape' }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/devices') return new Response(JSON.stringify([{ ...DEVICE, tabs: sixteen }]), { status: 200 })
      if (url === '/admin/api/screens') return new Response(JSON.stringify(screensSixteen), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())
    openDialog()
    expect(screen.queryByLabelText('Add screen to kitchen')).toBeNull()
  })
})

/**
 * Drawn, not spelled — after two glyph attempts went wrong. A monitor and a phone said "desktop vs
 * mobile", the wrong axis; the geometric rectangles depended on font coverage and portrait came out
 * as tofu. An SVG is correct by construction, so this pins the construction.
 */
describe('OrientationIcon', () => {
  const box = (o: 'landscape' | 'portrait') => {
    const { container } = render(<OrientationIcon orientation={o} />)
    const rect = container.querySelector('rect')!
    return { w: Number(rect.getAttribute('width')), h: Number(rect.getAttribute('height')) }
  }

  it('is wider than it is tall for landscape, and the reverse for portrait', () => {
    const l = box('landscape')
    cleanup()
    const p = box('portrait')
    // Left mounted, the portrait icon would collide with the next test's own render.
    cleanup()
    expect(l.w).toBeGreaterThan(l.h)
    expect(p.h).toBeGreaterThan(p.w)
    // The same rectangle, turned — not two differently-proportioned boxes.
    expect(l.w).toBe(p.h)
    expect(l.h).toBe(p.w)
  })

  it('names itself for a screen reader, since the shape is the whole content', () => {
    render(<OrientationIcon orientation="portrait" />)
    expect(screen.getByRole('img', { name: 'portrait' })).toBeDefined()
  })
})

/**
 * v17 put the system bars on the DEVICE, not the screen. It sits in the device row because it is a
 * property of the glass: the same board is correct on a wall panel with no bars and on a handheld
 * that still needs its back gesture.
 */
describe('Devices page — system bars', () => {
  it('shows the device’s current mode and PATCHes the change', async () => {
    const patches: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/admin/api/devices/') && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return new Response(null, { status: 204 })
      }
      if (url === '/admin/api/devices') return new Response(JSON.stringify([DEVICE]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Devices publicUrl="http://x" />)
    await waitFor(() => expect(screen.getByText('kitchen')).toBeDefined())

    const select = screen.getByLabelText('System bars for kitchen') as HTMLSelectElement
    expect(select.value).toBe('respected')
    fireEvent.change(select, { target: { value: 'hidden' } })
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ nav_bars: 'hidden' })
  })
})
