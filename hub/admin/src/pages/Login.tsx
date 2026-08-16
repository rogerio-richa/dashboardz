import { useState } from 'react'
import { api } from '../api'
import { DOCS_URL } from '../docs'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  return (
    <form
      className="login"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password }) })
          onLogin()
        } catch { setError('Wrong password') }
      }}
    >
      <img className="login-mark" src="/admin/favicon.svg" alt="Dashboardz" />
      <input type="password" placeholder="Admin password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Log in</button>
      <a className="login-help" href={DOCS_URL + 'deployment/#resetting-the-admin-password'}>
        Forgot your password?
      </a>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}
