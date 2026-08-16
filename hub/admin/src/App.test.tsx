import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

let loggedIn = false
let forceUnauthorized = false

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  loggedIn = false
  forceUnauthorized = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/config') {
      if (forceUnauthorized || !loggedIn) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      return new Response(JSON.stringify({ public_url: 'http://x', brand: 'Dashboardz' }), { status: 200 })
    }
    if (url === '/admin/api/login' && init?.method === 'POST') {
      loggedIn = true
      return new Response(null, { status: 204 })
    }
    if (url === '/admin/api/relay') return new Response(JSON.stringify(null), { status: 200 })
    if (forceUnauthorized) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    return new Response(JSON.stringify([]), { status: 200 })
  }))
})

async function login() {
  render(<App />)
  await screen.findByPlaceholderText('Admin password')
  await userEvent.type(screen.getByPlaceholderText('Admin password'), 'pw')
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

describe('App', () => {
  it('shows login, then real config-backed tabs after successful login', async () => {
    await login()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboardz admin' })).toBeDefined())
    expect(screen.getByRole('button', { name: 'Devices' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Senders' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Activity' })).toBeDefined()
    // The default Devices tab actually rendered its content (config loaded, not blank).
    expect(screen.getByRole('button', { name: 'Add device' })).toBeDefined()
  })

  /**
   * The console has to be reachable from the console. A tab dot going red with the only cure
   * living on the panel itself — or in a hand-written API call — is the gap this tab closes.
   */
  it('carries an Alerts tab that opens the active-alert list', async () => {
    await login()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboardz admin' })).toBeDefined())

    await userEvent.click(screen.getByRole('button', { name: 'Alerts' }))

    await screen.findByText(/No active alerts/)
  })

  it('returns to Login when the session expires mid-session', async () => {
    await login()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboardz admin' })).toBeDefined())

    forceUnauthorized = true
    await userEvent.click(screen.getByRole('button', { name: 'Senders' }))

    await waitFor(() => expect(screen.getByPlaceholderText('Admin password')).toBeDefined())
  })
})
