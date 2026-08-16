import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Login from './Login'

afterEach(cleanup)

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
})
