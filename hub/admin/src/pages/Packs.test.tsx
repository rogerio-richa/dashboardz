import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Packs from './Packs'

const MANIFEST = { id: 'vintage', name: 'Vintage', version: '1.0.0', theme: { board: { bg: '#f4ecd8', surface: '#fbf6ea' } } }
const fileAt = (path: string, body: string) => {
  const f = new File([body], path.split('/').pop()!)
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}
const FOLDER = [fileAt('vintage/pack.json', JSON.stringify(MANIFEST)), fileAt('vintage/designs/gauge/vintage-dial.mjs', 'export default {}'), fileAt('vintage/README.md', '# hi')]

function stub(opts: { enabled?: boolean; findings?: unknown[]; installed?: unknown[] } = {}) {
  const calls: { url: string; method: string; body?: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    if (url === '/admin/api/config') return new Response(JSON.stringify({ packs_enabled: opts.enabled ?? true }))
    if (url === '/admin/api/packs' && method === 'GET') return new Response(JSON.stringify(opts.installed ?? []))
    if (url === '/admin/api/packs/check') return new Response(JSON.stringify({ findings: opts.findings ?? [] }))
    if (url === '/admin/api/packs' && method === 'POST') return new Response(JSON.stringify({ id: 'vintage', version: '1.0.0', theme_id: 'thm_x', install_rev: 1, findings: [] }))
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('[]')
  }))
  return calls
}
const pick = () => fireEvent.change(screen.getByLabelText('Choose a theme pack folder'), { target: { files: FOLDER } })

describe('Install a theme pack', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows the checker\'s problems and no Install button when the pack has errors', async () => {
    const calls = stub({ findings: [{ level: 'error', where: 'pack.json theme.board', rule: 'theme.contrast.ink', message: 'Text (ink) on the background is too pale.' }] })
    render(<Packs />)
    await screen.findByText(/Install a theme pack/)
    pick()
    expect(await screen.findByText(/too pale/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /^Install Vintage/ })).toBeNull()
    const check = calls.find((c) => c.url === '/admin/api/packs/check')!
    expect(check.body.manifest.id).toBe('vintage')
    expect(check.body.designs).toEqual([{ path: 'designs/gauge/vintage-dial.mjs', source: 'export default {}' }])
  })

  it('a clean pack shows the trust note and installs on click', async () => {
    const calls = stub()
    render(<Packs />)
    await screen.findByText(/Install a theme pack/)
    pick()
    const install = await screen.findByRole('button', { name: /^Install Vintage/ })
    expect(screen.getByText(/only install packs you wrote or trust/i)).toBeDefined()
    fireEvent.click(install)
    await waitFor(() => expect(calls.some((c) => c.url === '/admin/api/packs' && c.method === 'POST')).toBe(true))
    expect(await screen.findByText(/Installed Vintage/)).toBeDefined()
  })

  /** The admin learns installed designs at startup, so after an install it reloads to know the new ones. */
  it('reloads the admin after installing, so the new designs appear everywhere', async () => {
    stub()
    const reloadPage = vi.fn()
    render(<Packs reloadPage={reloadPage} reloadDelayMs={0} />)
    await screen.findByText(/Install a theme pack/)
    pick()
    fireEvent.click(await screen.findByRole('button', { name: /^Install Vintage/ }))
    await waitFor(() => expect(reloadPage).toHaveBeenCalled())
  })

  it('shows the reasons when the hub refuses an install', async () => {
    stub()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/admin/api/config') return new Response(JSON.stringify({ packs_enabled: true }))
      if (url === '/admin/api/packs/check') return new Response(JSON.stringify({ findings: [] }))
      if (url === '/admin/api/packs' && method === 'POST') return new Response(JSON.stringify({ error: 'This pack has problems; nothing was installed.', findings: [{ level: 'error', where: 'design vintage-dial', rule: 'pack.design-clash', message: '"vintage-dial" is already installed by the pack "Old".' }] }), { status: 400 })
      return new Response('[]')
    }))
    render(<Packs reloadPage={() => {}} />)
    await screen.findByText(/Install a theme pack/)
    pick()
    fireEvent.click(await screen.findByRole('button', { name: /^Install Vintage/ }))
    expect(await screen.findByText(/already installed by the pack "Old"/)).toBeDefined()
  })

  it('removes an installed pack only after confirming', async () => {
    const calls = stub({ installed: [{ id: 'vintage', name: 'Vintage', version: '1.0.0', designs: [{ widget: 'gauge', id: 'vintage-dial' }], install_rev: 1 }] })
    render(<Packs />)
    const row = (await screen.findByText('Vintage')).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/default design/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/admin/api/packs/vintage')).toBe(true))
  })

  it('is hidden when this hub has theme packs turned off', async () => {
    stub({ enabled: false })
    const { container } = render(<Packs />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
