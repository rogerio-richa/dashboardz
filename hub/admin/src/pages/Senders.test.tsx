import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Senders from './Senders'

const DEVICES = [{ id: 'dev_1', name: 'kitchen-panel' }, { id: 'dev_2', name: 'bedside' }]
const SENDERS = [
  { id: 'snd_hub', name: 'Hub', default_devices: '[]', created_at: 0, last_used_at: null },
  { id: 'snd_a', name: 'greenhouse', default_devices: '["dev_1"]', created_at: 1, last_used_at: null },
  { id: 'snd_b', name: 'old-test', default_devices: '["dev_gone"]', created_at: 2, last_used_at: null },
]

function stub() {
  const writes: { url: string; method: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    if (url === '/admin/api/devices') return new Response(JSON.stringify(DEVICES), { status: 200 })
    if (url === '/admin/api/senders' && method === 'GET') return new Response(JSON.stringify(SENDERS), { status: 200 })
    if (url === '/admin/api/senders' && method === 'POST') return new Response(JSON.stringify({ sender: SENDERS[1], token: 'dbz_s_created' }), { status: 200 })
    if (url.endsWith('/rotate')) return new Response(JSON.stringify({ token: 'dbz_s_rotated' }), { status: 200 })
    if (method === 'PATCH') return new Response(JSON.stringify(SENDERS[1]), { status: 200 })
    return new Response(JSON.stringify({}), { status: 200 })
  }))
  return writes
}

const rowFor = async (name: string) => (await screen.findByText(name)).closest('tr')!

/**
 * One form creates and edits a sender (name and default devices), so the two can never drift; the
 * token is shown once, and a lost one is replaced by rotating it, which keeps the sender's id.
 */
describe('Senders page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows each sender’s default devices, flagging one that no longer exists', async () => {
    stub()
    render(<Senders />)
    expect(within(await rowFor('greenhouse')).getByText('kitchen-panel')).toBeDefined()
    expect(within(await rowFor('old-test')).getByText(/missing device/i)).toBeDefined()
  })

  it('creates a sender with default devices and shows its token once', async () => {
    const writes = stub()
    render(<Senders />)
    await rowFor('greenhouse')
    fireEvent.change(screen.getByPlaceholderText('New sender name'), { target: { value: 'porch' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Default devices' })[0])
    fireEvent.click(screen.getByLabelText('Send to bedside'))
    fireEvent.click(screen.getByRole('button', { name: /Create sender/ }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ url: '/admin/api/senders', method: 'POST', body: { name: 'porch', default_devices: ['dev_2'] } })
    expect(await screen.findByText('dbz_s_created')).toBeDefined()
  })

  it('edits with the same form, prefilled, and PATCHes only name and default devices', async () => {
    const writes = stub()
    render(<Senders />)
    fireEvent.click(within(await rowFor('greenhouse')).getByRole('button', { name: 'Edit' }))
    const name = screen.getByDisplayValue('greenhouse') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'greenhouse-2' } })
    fireEvent.click(screen.getByRole('button', { name: /Save sender/ }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ url: '/admin/api/senders/snd_a', method: 'PATCH', body: { name: 'greenhouse-2', default_devices: ['dev_1'] } })
  })

  it('rotates a token only after confirming, then shows the new one once', async () => {
    const writes = stub()
    render(<Senders />)
    fireEvent.click(within(await rowFor('greenhouse')).getByRole('button', { name: 'Rotate token' }))
    expect(writes).toHaveLength(0)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ url: '/admin/api/senders/snd_a/rotate', method: 'POST' })
    expect(await screen.findByText('dbz_s_rotated')).toBeDefined()
  })

  it('offers no edit, rotate or delete on the built-in hub sender', async () => {
    stub()
    render(<Senders />)
    const row = await rowFor('Hub')
    expect(within(row).queryByRole('button')).toBeNull()
    expect(within(row).getByText(/built in/i)).toBeDefined()
  })
})
