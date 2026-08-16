import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Login, { loginErrorText } from './Login'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Login', () => {
  it('shows the Dashboardz mark as the login page identity', () => {
    render(<Login onLogin={() => {}} />)

    const mark = screen.getByRole('img', { name: 'Dashboardz' })
    expect(mark.getAttribute('src')).toBe('/admin/favicon.svg')
  })

  it('links people who forgot their password to the reset instructions', () => {
    render(<Login onLogin={() => {}} />)

    const link = screen.getByRole('link', { name: 'Forgot your password?' })
    expect(link.getAttribute('href')).toBe(
      'https://www.scztech.com.br/dashboardz/docs/deployment/#resetting-the-admin-password',
    )
  })

  it('links to the getting started guide and back to the hub front page', () => {
    render(<Login onLogin={() => {}} />)

    expect(screen.getByRole('link', { name: 'getting started guide' }).getAttribute('href')).toBe(
      'https://www.scztech.com.br/dashboardz/docs/getting-started/',
    )
    expect(screen.getByRole('link', { name: /Back to the hub/ }).getAttribute('href')).toBe('/')
  })

  it('asks for the password instead of sending an empty one', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<Login onLogin={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByRole('alert').textContent).toBe('Enter the admin password.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains a wrong password and lets the person try again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'wrong password' }), { status: 401 })))
    const onLogin = vi.fn()
    render(<Login onLogin={onLogin} />)

    await userEvent.type(screen.getByLabelText('Admin password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect((await screen.findByText(/didn't match/)).textContent).toMatch(/ADMIN_PASSWORD/)
    expect(onLogin).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('loginErrorText', () => {
  it('tells an unreachable hub apart from a wrong password and other failures', () => {
    expect(loginErrorText(new Error('unauthorized'))).toMatch(/didn't match/)
    expect(loginErrorText(new TypeError('Failed to fetch'))).toMatch(/Can't reach the hub/)
    expect(loginErrorText(new Error('Internal Server Error'))).toBe(
      "The hub couldn't sign you in (Internal Server Error). Try again in a moment.",
    )
  })
})
