import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Agents, { DOCS_URL, mcpConfig } from './Agents'

const TOKENS = [
  { id: 'agt_1', name: 'kitchen-builder', created_at: 1, last_used_at: 1754600000000, revoked_at: null },
  { id: 'agt_2', name: 'old-one', created_at: 0, last_used_at: null, revoked_at: 1754500000000 },
]
const AUDIT = [
  { ts: 1754600000000, actor_type: 'agent', actor_id: 'agt_1', event: 'screen_created', details: '{"screen_id":"lay_x"}' },
  { ts: 1754600000001, actor_type: 'admin', actor_id: null, event: 'theme_updated', details: '{}' },
]

describe('Agents page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const stub = (posts: any[] = [], deletes: string[] = []) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/agent-tokens' && init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string))
        return new Response(JSON.stringify({ id: 'agt_3', name: 'new', created_at: 2, last_used_at: null, revoked_at: null, token: 'dbz_a_secret' }), { status: 201 })
      }
      if (url.startsWith('/admin/api/agent-tokens/') && init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(null, { status: 204 })
      }
      if (url === '/admin/api/agent-tokens') return new Response(JSON.stringify(TOKENS), { status: 200 })
      // The real route now does the actor_type filtering server-side; the stub mirrors that so the
      // page's lack of a client-side filter is exercised the same way it would be against the server.
      if (url === '/admin/api/audit?limit=100&actor_type=agent') {
        return new Response(JSON.stringify(AUDIT.filter((r) => r.actor_type === 'agent')), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }))
  }

  it('lists tokens with status, shows the minted token once, states the blast radius', async () => {
    const posts: any[] = []
    stub(posts)
    render(<Agents publicUrl="http://pi:8484" />)
    // "kitchen-builder" legitimately appears twice once loaded: once as the token row, once as the
    // activity attribution below — so this waits for the row rather than the ambiguous full text.
    await waitFor(() => expect(screen.getAllByText('kitchen-builder').length).toBeGreaterThan(0))
    expect(screen.getByText('revoked')).toBeDefined()
    // The page states the risk directly: agent tokens have the same reach as the admin password.
    expect(screen.getByText(/everything the admin password grants/)).toBeDefined()

    fireEvent.change(screen.getByPlaceholderText('New agent name'), { target: { value: 'new' } })
    fireEvent.click(screen.getByText('Create token'))
    await waitFor(() => expect(screen.getByText('dbz_a_secret')).toBeDefined())
    expect(posts).toEqual([{ name: 'new' }])
  })

  it('shows a paste-ready MCP config with a placeholder token before minting', async () => {
    stub()
    render(<Agents publicUrl="http://pi:8484" />)
    await waitFor(() => expect(screen.getAllByText('kitchen-builder').length).toBeGreaterThan(0))
    // clients/mcp/SKILL.md's Setup section documents this exact shape — the tab must match it, not
    // just carry the same information, so an operator can trust the copy-paste without reading both.
    const configBlock = document.querySelector('pre')
    expect(configBlock).not.toBeNull()
    const text = configBlock!.textContent ?? ''
    expect(text).toContain('"mcpServers"')
    const config = JSON.parse(text).mcpServers.dashboardz
    expect(config.command).toBe('node')
    expect(config.args).toEqual(['<absolute-path-to-dashboardz>/clients/mcp/dist/cli.js'])
    expect(text).not.toContain('"npx"')
    expect(text).not.toContain('"dashboardz-mcp"')
    expect(text).toContain('"http://pi:8484"')
    expect(text).toContain('DASHBOARDZ_TOKEN')
  })

  it('swaps the placeholder for the fresh token once one is minted', async () => {
    const posts: any[] = []
    stub(posts)
    render(<Agents publicUrl="http://pi:8484" />)
    await waitFor(() => expect(screen.getAllByText('kitchen-builder').length).toBeGreaterThan(0))

    fireEvent.change(screen.getByPlaceholderText('New agent name'), { target: { value: 'new' } })
    fireEvent.click(screen.getByText('Create token'))
    await waitFor(() => expect(screen.getByText('dbz_a_secret')).toBeDefined())

    const configBlock = document.querySelector('pre')
    expect(configBlock!.textContent ?? '').toContain('dbz_a_secret')

    // Guard the user-facing invariant: the prose says the token "appears in the block below
    // only while the panel above is showing it" — that sentence is only true if the shown-once panel
    // actually precedes the config block in the DOM. DOCUMENT_POSITION_FOLLOWING means shownOncePanel
    // comes before configBlock.
    const shownOncePanel = screen.getByText(/Token \(shown once\)/).closest('p')!
    // eslint-disable-next-line no-bitwise
    expect(shownOncePanel.compareDocumentPosition(configBlock!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('links to the docs site for how agent tokens work', async () => {
    stub()
    render(<Agents publicUrl="http://pi:8484" />)
    await waitFor(() => expect(screen.getAllByText('kitchen-builder').length).toBeGreaterThan(0))
    // The link's visible text is prose ("how agent tokens work"), not the word "docs" — it's the
    // href that must land on the docs site, so find it by href rather than by accessible name.
    const link = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') ?? '').match(/docs/))
    expect(link).toBeDefined()
    expect(link!.getAttribute('href')).toMatch(/^https:\/\/www\.scztech\.com\.br\/dashboardz\/docs\//)
  })

  // Node-side pin, not a DOM assertion: if mkdocs.yml's site_url ever moves, DOCS_URL must move with
  // it or every link this tab renders points at a stale docs root. Path is relative to hub/admin,
  // where vitest's cwd is.
  it('pins DOCS_URL to mkdocs.yml site_url', () => {
    const mkdocs = readFileSync('../../mkdocs.yml', 'utf8')
    expect(mkdocs).toContain(`site_url: ${DOCS_URL}`)
  })

  // Parse both JSON blocks and normalize only their hub URL and token values. The command, its
  // checkout-path placeholder, keys, and nesting must remain identical.
  it('matches the MCP setup structure after normalizing URL and token values', () => {
    const skill = readFileSync('../../clients/mcp/SKILL.md', 'utf8')
    const fenced = skill.match(/```json\n([\s\S]*?)\n```/)
    expect(fenced).not.toBeNull()
    const skillBlock = JSON.parse(fenced![1]!)

    const tabBlock = JSON.parse(mcpConfig('<url>', '<token>'))

    // Normalize only the two environment values: the skill uses examples while the tab receives
    // the operator's actual URL and token. Everything else, including command/args, must match.
    const normalize = (block: any) => ({
      ...block,
      mcpServers: {
        ...block.mcpServers,
        dashboardz: {
          ...block.mcpServers.dashboardz,
          env: { DASHBOARDZ_HUB_URL: '<normalized>', DASHBOARDZ_TOKEN: '<normalized>' },
        },
      },
    })
    expect(normalize(skillBlock)).toEqual(normalize(tabBlock))
  })

  it('shows a mint failure instead of an unhandled rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/agent-tokens' && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'name already exists' }), { status: 400 })
      }
      if (url === '/admin/api/agent-tokens') return new Response(JSON.stringify([]), { status: 200 })
      if (url.startsWith('/admin/api/audit')) return new Response(JSON.stringify([]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    render(<Agents publicUrl="http://pi:8484" />)
    fireEvent.change(screen.getByPlaceholderText('New agent name'), { target: { value: 'dup' } })
    fireEvent.click(screen.getByText('Create token'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('name already exists'))
  })

  it('revokes with confirmation and shows only agent-actor audit rows', async () => {
    const deletes: string[] = []
    stub([], deletes)
    render(<Agents publicUrl="http://pi:8484" />)
    await waitFor(() => expect(screen.getAllByText('kitchen-builder').length).toBeGreaterThan(0))
    // agent activity is filtered to actor_type === 'agent'
    expect(screen.getByText(/screen_created/)).toBeDefined()
    expect(screen.queryByText(/theme_updated/)).toBeNull()

    fireEvent.click(screen.getAllByText('Revoke')[0])
    // confirm.tsx: the confirm button's label matches the verb (see Devices.tsx's own Revoke flow),
    // not a generic "Confirm" — and there are now two "Revoke" buttons on screen, so disambiguate
    // via the dialog like Feeds.test.tsx does.
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(deletes).toEqual(['/admin/api/agent-tokens/agt_1']))
  })
})
