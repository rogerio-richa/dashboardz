import { useState } from 'react'
import { api } from '../api'
import { DOCS_URL } from '../docs'

/** What to tell someone whose sign-in failed: a wrong password reads differently from a dead hub. */
export function loginErrorText(err: unknown): string {
  if (err instanceof Error && err.message === 'unauthorized') {
    return "That password didn't match. It's the ADMIN_PASSWORD value the hub was started with."
  }
  if (err instanceof TypeError) return "Can't reach the hub. Check that it's running and try again."
  const detail = err instanceof Error && err.message ? ` (${err.message})` : ''
  return `The hub couldn't sign you in${detail}. Try again in a moment.`
}

/**
 * The sign-in page shares the device pair screen's look (hub/static/device/index.html): the same
 * dark card, bolt, blue action and way back to the hub's front page, so the two doors into a hub
 * feel like one product. The neutral workbench starts after sign-in.
 */
export default function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="login-page">
      <a className="login-back" href="/"><span aria-hidden="true">←</span> Back to the hub</a>
      <div className="login-card">
        <img className="login-mark" src="/admin/favicon.svg" alt="Dashboardz" />
        <h1>Sign in to the admin</h1>
        <p className="login-intro">Build screens, pair devices and manage alerts for this hub.</p>
        <form
          className="login"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!password) { setError('Enter the admin password.'); return }
            setBusy(true)
            setError('')
            try {
              await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password }) })
              onLogin()
            } catch (err) {
              setError(loginErrorText(err))
              setBusy(false)
            }
          }}
        >
          {/* Lets password managers file the password under this hub; the hub has one admin. */}
          <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
          <input
            type="password"
            name="password"
            aria-label="Admin password"
            placeholder="Admin password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="login-error" role="alert">{error}</p>
        </form>
        <div className="login-help">
          <span>
            <a href={DOCS_URL + 'deployment/#resetting-the-admin-password'}>Forgot your password?</a> The hub
            can't send it to you, but you can set a new one where the hub runs.
          </span>
          <span>
            Need help? Read the <a href={DOCS_URL + 'getting-started/'}>getting started guide</a> at
            scztech.com.br/dashboardz/docs.
          </span>
        </div>
      </div>
    </div>
  )
}
