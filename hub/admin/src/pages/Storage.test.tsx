import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Storage from './Storage'

const STATS = {
  db_bytes: 2 * 1024 * 1024, // 2 MB
  images_bytes: 512 * 1024, // 0.5 MB
  pools: [
    { id: 'alerts_concluded', label: 'Concluded alerts', rows: 3, bytes: 1200, approx: true },
    { id: 'alerts_active', label: 'Active alerts', rows: 1, bytes: 400, approx: true },
    { id: 'audit_log', label: 'Audit log', rows: 42, bytes: 9000, approx: false },
    { id: 'feed_rows', label: 'Feed rows (journal/streams)', rows: 10, bytes: 3000, approx: false },
    { id: 'feed_values', label: 'Feed value payloads', rows: 2, bytes: 200, approx: true },
  ],
  retention: {
    alerts_days: 90, audit_days: 180,
    source: { alerts_days: 'default' as const, audit_days: 'env' as const },
  },
  last_sweep: null as { ts: number; alerts: number; audit: number } | null,
}

describe('Storage page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const stub = (opts: { patches?: object[]; sweepResult?: { alerts: number; audit: number } } = {}) => {
    const patches = opts.patches ?? []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/storage') return new Response(JSON.stringify(STATS), { status: 200 })
      if (url === '/admin/api/retention' && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return new Response(null, { status: 204 })
      }
      if (url === '/admin/api/retention/sweep' && init?.method === 'POST') {
        return new Response(JSON.stringify(opts.sweepResult ?? { alerts: 0, audit: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    return patches
  }

  it('shows total DB and image size in MB', async () => {
    stub()
    render(<Storage />)
    await waitFor(() => expect(screen.getByText(/2\.00 MB/)).toBeDefined())
    expect(screen.getByText(/0\.50 MB/)).toBeDefined()
  })

  it('lists every pool with label, rows, size, and an approx marker where relevant', async () => {
    stub()
    render(<Storage />)
    await screen.findByText('Concluded alerts')
    expect(screen.getByText('Active alerts')).toBeDefined()
    expect(screen.getByText('Audit log')).toBeDefined()
    expect(screen.getByText('Feed rows (journal/streams)')).toBeDefined()
    expect(screen.getByText('Feed value payloads')).toBeDefined()

    const row = screen.getByText('Concluded alerts').closest('tr')!
    expect(row.textContent).toContain('≈') // approx: true
    const auditRow = screen.getByText('Audit log').closest('tr')!
    expect(auditRow.textContent).not.toContain('≈') // approx: false
  })

  it('shows the current retention values and their source', async () => {
    stub()
    render(<Storage />)
    const alertsInput = await screen.findByLabelText('Concluded alerts retention in days') as HTMLInputElement
    expect(alertsInput.value).toBe('90')
    expect(screen.getByText(/\(default\)/)).toBeDefined()

    const auditInput = screen.getByLabelText('Audit log retention in days') as HTMLInputElement
    expect(auditInput.value).toBe('180')
    expect(screen.getByText(/\(from env\)/)).toBeDefined()
  })

  it('saves an edited retention value on blur, PATCHing only that field', async () => {
    const patches = stub()
    render(<Storage />)
    const alertsInput = await screen.findByLabelText('Concluded alerts retention in days') as HTMLInputElement

    fireEvent.change(alertsInput, { target: { value: '30' } })
    fireEvent.blur(alertsInput)

    await waitFor(() => expect(patches).toEqual([{ alerts_days: 30 }]))
  })

  it('does not PATCH on blur when the value is unchanged', async () => {
    const patches = stub()
    render(<Storage />)
    const alertsInput = await screen.findByLabelText('Concluded alerts retention in days') as HTMLInputElement

    fireEvent.blur(alertsInput)
    await new Promise((r) => setTimeout(r, 10))
    expect(patches).toEqual([])
  })

  it('accepts 0 (keep forever) as a real save', async () => {
    const patches = stub()
    render(<Storage />)
    const auditInput = await screen.findByLabelText('Audit log retention in days') as HTMLInputElement

    fireEvent.change(auditInput, { target: { value: '0' } })
    fireEvent.blur(auditInput)

    await waitFor(() => expect(patches).toEqual([{ audit_days: 0 }]))
  })

  it('shows a Reset control only for a field whose source is "setting"', async () => {
    stub()
    render(<Storage />)
    await screen.findByLabelText('Concluded alerts retention in days')
    // alerts_days is 'default' in STATS, audit_days is 'env' — neither has anything to reset.
    expect(screen.queryByRole('button', { name: 'Reset Concluded alerts retention in days to inherit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset Audit log retention in days to inherit' })).toBeNull()
  })

  it('a saved override shows Reset; clicking it PATCHes the field to null', async () => {
    const patches: object[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/storage') {
        return new Response(JSON.stringify({
          ...STATS,
          retention: { alerts_days: 14, audit_days: 180, source: { alerts_days: 'setting', audit_days: 'env' } },
        }), { status: 200 })
      }
      if (url === '/admin/api/retention' && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Storage />)
    await screen.findByLabelText('Concluded alerts retention in days')

    const resetButton = screen.getByRole('button', { name: 'Reset Concluded alerts retention in days to inherit' })
    fireEvent.click(resetButton)

    await waitFor(() => expect(patches).toEqual([{ alerts_days: null }]))
  })

  it('shows a value the server changed after a refresh, not a stale defaultValue', async () => {
    // First fetch returns 90/default; the save PATCHes, then refresh() re-fetches — and the
    // second response must be what the input displays, not what it showed on first mount.
    let storageCalls = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/storage') {
        storageCalls += 1
        const days = storageCalls === 1 ? 90 : 14
        const source = storageCalls === 1 ? 'default' : 'setting'
        return new Response(JSON.stringify({
          ...STATS, retention: { alerts_days: days, audit_days: 180, source: { alerts_days: source, audit_days: 'env' } },
        }), { status: 200 })
      }
      if (url === '/admin/api/retention' && init?.method === 'PATCH') return new Response(null, { status: 204 })
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)
    render(<Storage />)

    const input = await screen.findByLabelText('Concluded alerts retention in days') as HTMLInputElement
    expect(input.value).toBe('90')

    fireEvent.change(input, { target: { value: '14' } })
    fireEvent.blur(input)

    await waitFor(() => {
      const refreshed = screen.getByLabelText('Concluded alerts retention in days') as HTMLInputElement
      expect(refreshed.value).toBe('14')
    })
  })

  it('sweep now posts and shows the returned counts', async () => {
    stub({ sweepResult: { alerts: 3, audit: 5 } })
    render(<Storage />)
    await screen.findByText('Concluded alerts')

    fireEvent.click(screen.getByRole('button', { name: 'Sweep now' }))

    await waitFor(() => expect(screen.getByText(/Removed 3 alert\(s\), 5 audit row\(s\)\./)).toBeDefined())
  })

  it('shows "No retention sweep has run yet" when last_sweep is null', async () => {
    stub()
    render(<Storage />)
    await screen.findByText('No retention sweep has run yet.')
  })

  it('shows the last sweep summary when present', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/admin/api/storage') {
        return new Response(JSON.stringify({
          ...STATS, last_sweep: { ts: 1754600000000, alerts: 2, audit: 4 },
        }), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Storage />)
    await waitFor(() => expect(screen.getByText(/removed 2 alert\(s\), 4 audit row\(s\)/)).toBeDefined())
  })

  it('shows an error message when the save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/storage') return new Response(JSON.stringify(STATS), { status: 200 })
      if (url === '/admin/api/retention' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ error: 'nope' }), { status: 400 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Storage />)
    const alertsInput = await screen.findByLabelText('Concluded alerts retention in days') as HTMLInputElement
    fireEvent.change(alertsInput, { target: { value: '30' } })
    fireEvent.blur(alertsInput)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('nope'))
  })
})
