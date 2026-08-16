import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import RelayBadge, { ERROR_COPY, TEST_ERROR_COPY } from './RelayBadge'

const READY = {
  state: 'ready', terminal: false, url: 'wss://relay.example/ws', hub_uid: 'hub_abc123',
  connected_since: 1755000000000, last_error: null, token_set: false, configured: true,
}

const stub = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('RelayBadge', () => {
  it('shows "Relay: off" when no relay is configured, with the explainer in the dialog', async () => {
    stub(null)
    render(<RelayBadge />)
    const btn = await screen.findByRole('button', { name: /relay: off/i })
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/nothing leaves your (own )?network|stays on your LAN/i)
    expect(within(dialog).getByLabelText(/relay url/i)).toBeDefined()
    expect(screen.getByRole('link', { name: /private/i }).getAttribute('href')).toContain('remote-access')
  })

  it('shows a green ready badge and the connection facts in the dialog', async () => {
    stub(READY)
    render(<RelayBadge />)
    const btn = await screen.findByRole('button', { name: /relay: connected/i })
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('wss://relay.example/ws')
    expect(dialog.textContent).toContain('hub_abc123')
  })

  /**
   * A drop the hub has already reconnected past is history, not status. "Relay: connected" and
   * "the connection dropped, retrying with backoff" showing together read as a contradiction —
   * an operator asked which one was true.
   */
  it('hides a last_error older than the current connection', async () => {
    stub({ ...READY, last_error: { code: 'closed', message: 'x', at: READY.connected_since - 60000 } })
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    expect(screen.getByRole('dialog').textContent).not.toContain(ERROR_COPY.closed)
  })

  it('renders the terminal bad_secret state in plain words', async () => {
    stub({ ...READY, state: 'offline', terminal: true, connected_since: null,
      last_error: { code: 'bad_secret', message: 'x', at: 1755000000000 } })
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: stopped/i }))
    expect(screen.getByRole('dialog').textContent).toContain(ERROR_COPY.bad_secret)
  })

  it('a failed poll shows unknown — never an invented outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    render(<RelayBadge />)
    await screen.findByRole('button', { name: /relay: unknown/i })
  })

  it('Escape closes the dialog and focus returns to the badge, even though focus after ' +
    'opening is on the dialog (a sibling of the badge button), not the button itself', async () => {
    stub(READY)
    render(<RelayBadge />)
    const btn = await screen.findByRole('button', { name: /relay: connected/i })
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog')
    // Focus-on-open landed inside the dialog, not on the badge button — confirms the bug
    // (keydown on the button never reaching the dialog's old handler) is actually fixed, not
    // just coincidentally passing.
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(btn)
  })

  it('copies the hub uid', async () => {
    stub(READY)
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(writeText).toHaveBeenCalledWith('hub_abc123')
  })

  it('falls back to prompt() when navigator.clipboard is unavailable (the product\'s normal ' +
    'HTTP-served LAN deployment)', async () => {
    stub(READY)
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null)
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(promptSpy).toHaveBeenCalledWith('Copy the hub uid:', 'hub_abc123')
  })

  /** GET returns `status`; records PUT/DELETE/test calls and answers them with `answers`. */
  const stubRoutes = (status: unknown, answers: { test?: unknown; put?: unknown } = {}) => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (method === 'GET') return new Response(JSON.stringify(status), { status: 200 })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (url.endsWith('/test')) return new Response(JSON.stringify(answers.test ?? { ok: true }), { status: 200 })
      return new Response(JSON.stringify(answers.put ?? { ...READY as object, state: 'connecting' }), { status: 200 })
    }))
    return calls
  }

  it('unconfigured: Save stays disabled until the exact typed URL passes a test, then PUTs', async () => {
    const calls = stubRoutes(null)
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: off/i }))
    const dialog = screen.getByRole('dialog')

    const input = within(dialog).getByLabelText(/relay url/i)
    const save = within(dialog).getByRole('button', { name: /^save$/i })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'wss://relay.example/ws' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
    await within(dialog).findByText(/ready to save/i)
    expect((save as HTMLButtonElement).disabled).toBe(false)

    // Editing after a passing test invalidates it.
    fireEvent.change(input, { target: { value: 'wss://other.example/ws' } })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'wss://relay.example/ws' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
    await within(dialog).findByText(/ready to save/i)
    fireEvent.click(save)
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ url: 'wss://relay.example/ws' })
  })

  it('renders plain-words copy for every test failure code', async () => {
    for (const code of Object.keys(TEST_ERROR_COPY) as (keyof typeof TEST_ERROR_COPY)[]) {
      cleanup()
      stubRoutes(null, { test: { ok: false, code } })
      render(<RelayBadge />)
      fireEvent.click(await screen.findByRole('button', { name: /relay: off/i }))
      const dialog = screen.getByRole('dialog')
      fireEvent.change(within(dialog).getByLabelText(/relay url/i), { target: { value: 'wss://relay.example/ws' } })
      fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
      await within(dialog).findByText(TEST_ERROR_COPY[code])
      expect((within(dialog).getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('connected: Disconnect asks inline first, then DELETEs', async () => {
    const calls = stubRoutes(READY)
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /disconnect/i }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(dialog.textContent).toMatch(/remote senders lose their route/i)
    fireEvent.click(within(dialog).getByRole('button', { name: /yes, disconnect/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
  })

  it('the RELAY_URL environment sentence is gone from the connected dialog', async () => {
    stubRoutes(READY)
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    expect(screen.getByRole('dialog').textContent).not.toMatch(/environment/i)
  })

  it('closing the dialog resets the armed disconnect confirm (Escape then reopen does not ' +
    'skip the confirmation step)', async () => {
    const calls = stubRoutes(READY)
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    let dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /disconnect/i }))
    expect(within(dialog).getByRole('button', { name: /yes, disconnect/i })).toBeDefined()

    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: /yes, disconnect/i })).toBeNull()
    expect(within(dialog).getByRole('button', { name: /disconnect/i })).toBeDefined()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('clears a stale write error when leaving the disconnect confirm for the Change form',
    async () => {
      const calls: Array<{ method: string }> = []
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ method })
        if (method === 'GET') return new Response(JSON.stringify(READY), { status: 200 })
        if (method === 'DELETE') return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }))
      render(<RelayBadge />)
      fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /disconnect/i }))
      fireEvent.click(within(dialog).getByRole('button', { name: /yes, disconnect/i }))
      await within(dialog).findByText(/couldn.t disconnect/i)

      fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
      fireEvent.click(within(dialog).getByRole('button', { name: /^change$/i }))
      expect(within(dialog).queryByText(/couldn.t disconnect/i)).toBeNull()
    })

  // The relay settings endpoint accepts an optional `token`, and the dialog sends it only when the
  // operator typed a replacement; an untouched token is omitted from the PUT body.
  it('unconfigured: typing a relay token and saving PUTs { url, token }', async () => {
    const calls = stubRoutes(null)
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: off/i }))
    const dialog = screen.getByRole('dialog')

    const tokenInput = within(dialog).getByLabelText(/relay token/i) as HTMLInputElement
    expect(tokenInput.value).toBe('')

    fireEvent.change(within(dialog).getByLabelText(/relay url/i), { target: { value: 'wss://relay.example/ws' } })
    fireEvent.change(tokenInput, { target: { value: 'dzr_supersecret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
    await within(dialog).findByText(/ready to save/i)
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body)
      .toEqual({ url: 'wss://relay.example/ws', token: 'dzr_supersecret' })
  })

  // The token itself must never come back from the API — only `token_set` is returned. The
  // dialog must reflect that a token is stored WITHOUT ever having a value to show, and must not
  // send a `token` field on Save unless the operator actually typed a replacement (leaving the
  // field untouched must not silently clear a stored token — Save with no token key means
  // "unchanged" server-side).
  it('connected with token_set: the token field renders as set, never showing a value, and an ' +
    'untouched Save omits token from the PUT body', async () => {
    const calls = stubRoutes({ ...READY, token_set: true })
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^change$/i }))
    const dialog = screen.getByRole('dialog')

    const tokenInput = within(dialog).getByLabelText(/relay token/i) as HTMLInputElement
    expect(tokenInput.value).toBe('')
    expect(dialog.textContent).toMatch(/token.*(already )?set/i)
    // The operator must be told UP FRONT that
    // editing the address (not just an explicit Disconnect) clears a token minted for the old
    // relay — this is the more common way the leak was actually reachable.
    expect(dialog.textContent).toMatch(/different relay address clears this token/i)

    fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
    await within(dialog).findByText(/ready to save/i)
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ url: 'wss://relay.example/ws' })
  })

  // clear() deletes the stored token too; as defense in
  // depth status() must still be able to report a token surviving with no client running (a
  // manual DB edit, a bug elsewhere) rather than silently returning bare null and hiding it — the
  // exact shape that let a stale token ride onto a differently-configured relay. `configured:
  // false` is how the API expresses that; the badge must render as off (no real connection) while
  // still surfacing the token, never its value.
  it('off but a token row still exists (defense in depth): the dialog says so, never showing ' +
    'the value', async () => {
    stub({
      state: 'offline', terminal: false, url: '', hub_uid: '', connected_since: null,
      last_error: null, token_set: true, configured: false,
    })
    render(<RelayBadge />)
    // Still reads as off — there is no real connection to report.
    const btn = await screen.findByRole('button', { name: /relay: off/i })
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/token.*(still )?stored|token is already set/i)
    const tokenInput = within(dialog).getByLabelText(/relay token/i) as HTMLInputElement
    expect(tokenInput.value).toBe('')
    expect(within(dialog).getByRole('button', { name: /remove token/i })).toBeDefined()
  })

  // The off-state "Remove token" uses DELETE (RelayManager.clear()), which clears both settings
  // rows without configuring or dialing a URL. It must not require the URL field to be filled in,
  // because removing a stale token does not require a connection.
  it('off with a stale token: "Remove token" DELETEs (no PUT, no URL required) and clears the ' +
    'badge state', async () => {
    let tokenSet = true
    const calls: Array<{ method: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ method, body })
      if (method === 'GET') {
        if (!tokenSet) return new Response(JSON.stringify(null), { status: 200 })
        return new Response(JSON.stringify({
          state: 'offline', terminal: false, url: '', hub_uid: '', connected_since: null,
          last_error: null, token_set: true, configured: false,
        }), { status: 200 })
      }
      if (method === 'DELETE') { tokenSet = false; return new Response(null, { status: 204 }) }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))
    render(<RelayBadge />)
    const btn = await screen.findByRole('button', { name: /relay: off/i })
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog')

    // Deliberately left blank — the fix must not require typing a URL to remove a stale token.
    expect((within(dialog).getByLabelText(/relay url/i) as HTMLInputElement).value).toBe('')
    const removeBtn = within(dialog).getByRole('button', { name: /remove token/i })
    expect((removeBtn as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(removeBtn)
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)

    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2))
    expect(within(dialog).queryByText(/token.*(still )?stored|token is already set/i)).toBeNull()
  })

  // The UI must support both setting and replacing a token, and reach the API's
  // `token: ''` clear sentinel. "Remove token" must PUT it explicitly and reflect token_set:
  // false afterward — without requiring the operator to also retype the URL.
  it('connected with token_set: "Remove token" PUTs { url, token: \'\' } and clears the badge ' +
    'state', async () => {
    let tokenSet = true
    const calls: Array<{ method: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ method, body })
      if (method === 'GET') return new Response(JSON.stringify({ ...READY, token_set: tokenSet }), { status: 200 })
      if (method === 'PUT') {
        if (body?.token === '') tokenSet = false
        return new Response(JSON.stringify({ ...READY, token_set: tokenSet }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^change$/i }))
    const dialog = screen.getByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: /remove token/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({ url: 'wss://relay.example/ws', token: '' })

    // The dialog re-polls after the write (a second GET, beyond the mount-time one) — wait for
    // that round trip before checking the badge reflects token_set: false.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2))
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /^change$/i }))
    expect(within(dialog).queryByRole('button', { name: /remove token/i })).toBeNull()
  })

  // A 4403 during Test must read as "your token", not "network trouble" —
  // otherwise Save (gated on a passing Test) is unreachable for the one credential problem this
  // whole feature exists to surface.
  it('a token_required Test result renders honest copy, not a network-sounding one', async () => {
    stubRoutes(null, { test: { ok: false, code: 'token_required' } })
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: off/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/relay url/i), { target: { value: 'wss://relay.example/ws' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
    await within(dialog).findByText(TEST_ERROR_COPY.token_required)
    expect(dialog.textContent).not.toMatch(/couldn.t reach|didn.t answer in time/i)
  })

  // Test must use ONLY the token typed into the field for THIS
  // dial, never fall back to whatever is already stored — a fallback would recreate the
  // leak shape (a stored credential reaching an arbitrary URL) against the Test button instead.
  it('Test sends only the typed token, never a fallback to a stored one', async () => {
    const calls = stubRoutes({ ...READY, token_set: true })
    render(<RelayBadge />)
    fireEvent.click(await screen.findByRole('button', { name: /relay: connected/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^change$/i }))
    const dialog = screen.getByRole('dialog')
    // tokenInput is left blank on purpose — token_set is true, but nothing was typed.
    fireEvent.click(within(dialog).getByRole('button', { name: /^test$/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/test'))).toBe(true))
    const test = calls.find((c) => c.url.endsWith('/test'))!
    expect(test.body).toEqual({ url: 'wss://relay.example/ws' })
  })
})
