import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { IconCopy } from './icons'

/** Mirror of GET /admin/api/relay (hub/src/routes/admin.ts). */
export interface RelayStatus {
  state: 'offline' | 'connecting' | 'ready'
  terminal: boolean
  url: string
  hub_uid: string
  connected_since: number | null
  last_error: { code: 'bad_secret' | 'closed' | 'token_required'; message: string; at: number } | null
  /** Whether a relay account token is stored — the token value itself never comes back from the API. */
  token_set: boolean
  /**
   * False only in the defense-in-depth case: no relay client is running, but a token row
   * survived anyway (should be unreachable through this UI — Disconnect clears both together —
   * but a leftover from a bug or a manual DB edit must still be visible, not silently dropped).
   * `url`/`hub_uid` are empty and `state` is 'offline' whenever this is false.
   */
  configured: boolean
}

/** Built from mkdocs.yml's site_url; hub/test/remote-access-doc.test.ts pins the two together. */
export const DOCS_URL = 'https://www.scztech.com.br/dashboardz/docs/remote-access/'

/**
 * Plain words for every RELAY_ERROR_CODES entry (hub/src/relay/client.ts). Lexically pinned by
 * hub/test/relay-error-copy.test.ts: a code added there without copy here fails the build.
 */
export const ERROR_COPY: Record<'bad_secret' | 'closed' | 'token_required', string> = {
  bad_secret:
    "Another connection claimed this hub's uid on the relay, and the hub has stopped retrying. " +
    'Restart the relay, then restart the hub.',
  closed: 'The connection to the relay dropped. The hub retries automatically with backoff.',
  token_required:
    'This relay rejected the account token (missing, unknown or revoked) and the hub has ' +
    'stopped retrying. Paste a valid token below and Save.',
}

/**
 * Plain words for every RELAY_TEST_FAILURES entry (hub/src/relay/manager.ts). Lexically pinned
 * by hub/test/relay-error-copy.test.ts, same contract as ERROR_COPY above.
 */
export const TEST_ERROR_COPY: Record<'unreachable' | 'bad_secret' | 'timeout' | 'token_required', string> = {
  unreachable: 'Couldn’t reach a relay at that address.',
  timeout: 'The relay didn’t answer in time.',
  bad_secret: 'That relay already has a different hub registered under this hub’s uid.',
  token_required: 'That relay rejected the account token — it’s missing, unknown, or revoked.',
}

// 'off' carries `tokenSet` too: status() can report a stored token even with no client running
// (the defense-in-depth case — RelayStatus.configured), and the badge must never let that go
// silently unreported just because there's no live connection to nest it inside of.
type Poll = { kind: 'unknown' } | { kind: 'off'; tokenSet: boolean } | { kind: 'on'; status: RelayStatus }

const badgeLabel = (p: Poll): string => {
  if (p.kind === 'unknown') return 'Relay: unknown'
  if (p.kind === 'off') return 'Relay: off'
  if (p.status.terminal) return 'Relay: stopped'
  return p.status.state === 'ready' ? 'Relay: connected'
    : p.status.state === 'connecting' ? 'Relay: connecting' : 'Relay: offline'
}

const dotClass = (p: Poll): string => {
  if (p.kind !== 'on') return 'relay-dot muted'
  if (p.status.terminal || p.status.state === 'offline') return 'relay-dot bad'
  return p.status.state === 'ready' ? 'relay-dot good' : 'relay-dot warn'
}

export default function RelayBadge() {
  const [poll, setPoll] = useState<Poll>({ kind: 'unknown' })
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const [editing, setEditing] = useState(false)          // form open (auto-open when off)
  const [urlInput, setUrlInput] = useState('')
  // Never pre-filled from a status payload — the token value never comes back from the API, so this
  // field starts blank even when token_set is true. Blank-on-save means
  // "leave whatever is stored alone", not "clear it" (see tokenBody() below).
  const [tokenInput, setTokenInput] = useState('')
  const [tested, setTested] = useState<{ url: string; token: string; result: { ok: true } | { ok: false; code: keyof typeof TEST_ERROR_COPY } } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [writeError, setWriteError] = useState('')

  const tick = useCallback(() => {
    api<RelayStatus | null>('/admin/api/relay')
      .then((s) => {
        if (!s) return setPoll({ kind: 'off', tokenSet: false })
        // `configured: false` is the defense-in-depth "no client, but a token row survived"
        // case — render it as off (there is no real connection), but keep tokenSet honest.
        if (!s.configured) return setPoll({ kind: 'off', tokenSet: s.token_set })
        setPoll({ kind: 'on', status: s })
      })
      // An admin-side network blip must not masquerade as a relay outage: "unknown", not red.
      .catch(() => setPoll({ kind: 'unknown' }))
  }, [])

  useEffect(() => {
    tick()
    const t = setInterval(tick, 5000)   // same cadence the Devices tab already uses
    return () => clearInterval(t)
  }, [tick])

  // The component stays mounted across opens/closes (it's not re-created), so any transient
  // form/confirm state left over from a previous visit — most importantly an armed disconnect
  // confirm — must be cleared here, not just on successful save/disconnect. Otherwise Escape-then-
  // reopen (or Close-then-reopen) lands straight back on the state the user was just looking at,
  // which for the disconnect confirm means skipping the confirmation friction entirely.
  const close = useCallback(() => {
    setOpen(false)
    setEditing(false)
    setConfirmingDisconnect(false)
    setTested(null)
    setUrlInput('')
    setTokenInput('')
    setWriteError('')
    btnRef.current?.focus()
  }, [])

  // Same idiom as SourceSetupDialog.tsx:283-318: focus lands on the dialog itself when it opens
  // (so aria-modal is truthful and Escape/Tab reach a handler at all — the badge button that
  // opened it is a sibling, not an ancestor, so keydown on the button never bubbles into the
  // dialog subtree), and a document-level listener handles Escape-to-close plus a Tab trap.
  useEffect(() => {
    if (open) dialogRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!dialog || !focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === dialog) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === dialog) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  const copyUid = (uid: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(uid).catch(() => {
        prompt('Copy the hub uid:', uid)   // same fallback Feeds.tsx uses for tokens
      })
    } else {
      prompt('Copy the hub uid:', uid)     // Feeds.tsx:549-550 shape: no clipboard API, degrade gracefully
    }
  }

  // Omitted (not '') unless the operator actually typed something: PUT/test read an absent
  // `token` key as "leave whatever is stored alone", so an untouched field must never clear or
  // overwrite a previously saved token just because the dialog was opened and Saved again.
  const tokenBody = () => (tokenInput !== '' ? { token: tokenInput } : {})

  const testUrl = async () => {
    setWriteError(''); setBusy(true)
    try {
      const result = await api<{ ok: true } | { ok: false; code: keyof typeof TEST_ERROR_COPY }>(
        '/admin/api/relay/test', { method: 'POST', body: JSON.stringify({ url: urlInput, ...tokenBody() }) })
      setTested({ url: urlInput, token: tokenInput, result })
    } catch {
      setWriteError('Couldn’t run the test. Try again.')
    } finally { setBusy(false) }
  }

  const saveUrl = async () => {
    setWriteError(''); setBusy(true)
    try {
      await api('/admin/api/relay', { method: 'PUT', body: JSON.stringify({ url: urlInput, ...tokenBody() }) })
      setEditing(false); setTested(null)
      tick()   // poll immediately so the badge reflects the new connection attempt
    } catch {
      setWriteError('Couldn’t save the relay. Try again.')
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    setWriteError(''); setBusy(true)
    try {
      await api('/admin/api/relay', { method: 'DELETE' })
      setConfirmingDisconnect(false)
      tick()
    } catch {
      setWriteError('Couldn’t disconnect. Try again.')
    } finally { setBusy(false) }
  }

  const testMatchesInputs = tested !== null && tested.url === urlInput && tested.token === tokenInput
  const testedOk = testMatchesInputs && tested.result.ok

  // A token can be "already set" whether the hub is actually connected (poll.status.token_set)
  // or in the defense-in-depth off-but-stored case (poll.tokenSet) — both must show it.
  const tokenAlreadySet = poll.kind === 'on' ? poll.status.token_set : poll.kind === 'off' ? poll.tokenSet : false

  // The URL to clear the token AGAINST: a real connected relay already has one (poll.status.url);
  // otherwise there is nothing stored to reuse, so the operator must type the destination first —
  // PUT always requires a valid ws/wss url, clearing a token is not a bare "unset" operation.
  const removeTokenUrl = poll.kind === 'on' ? poll.status.url : urlInput

  // In the connected state there's a real relay to keep talking to, so this stays a PUT that
  // clears just the token. In the off state there is nothing to dial — a PUT there would
  // configure AND connect to removeTokenUrl (claiming a uid via TOFU) just to get rid of a stale
  // token, forcing a connection on an operator who only wanted the token gone. DELETE clears both
  // settings rows (RelayManager.clear()) without dialing anywhere, and is idempotent whether or
  // not a URL row happens to exist.
  const removeToken = async () => {
    setWriteError(''); setBusy(true)
    try {
      if (poll.kind === 'on') {
        await api('/admin/api/relay', { method: 'PUT', body: JSON.stringify({ url: removeTokenUrl, token: '' }) })
      } else {
        await api('/admin/api/relay', { method: 'DELETE' })
      }
      setTokenInput(''); setTested(null)
      tick()
    } catch {
      setWriteError('Couldn’t remove the token. Try again.')
    } finally { setBusy(false) }
  }

  const configureForm = (
    <div className="relay-config">
      <label className="source-field">
        <span>Relay URL</span>
        <input
          type="text" placeholder="wss://relay.example.com/ws" value={urlInput}
          aria-label="Relay URL"
          onChange={(e) => setUrlInput(e.target.value)}
        />
      </label>
      <label className="source-field">
        <span>Relay token</span>
        <input
          type="password"
          placeholder={tokenAlreadySet ? 'Token is already set — leave blank to keep it' : 'Paste an account token (optional)'}
          value={tokenInput}
          aria-label="Relay token"
          onChange={(e) => setTokenInput(e.target.value)}
        />
      </label>
      {tokenAlreadySet && tokenInput === '' && (
        <div className="relay-token-status">
          <p className="hint">
            A token is already set for this relay. Leave blank to keep it, or paste a new one to
            replace it. Saving a DIFFERENT relay address clears this token automatically — a
            token minted for one relay isn’t valid on another — so you’ll need to re-enter it if
            you switch relays.
          </p>
          <button onClick={removeToken} disabled={busy || (poll.kind === 'on' && removeTokenUrl.trim() === '')}>
            Remove token
          </button>
        </div>
      )}
      <div className="source-setup-actions">
        <button onClick={testUrl} disabled={busy || urlInput.trim() === ''}>Test</button>
        <button onClick={saveUrl} disabled={busy || !testedOk}>Save</button>
        {poll.kind === 'on' && <button onClick={() => { setEditing(false); setTested(null); setTokenInput(''); setWriteError('') }} disabled={busy}>Cancel</button>}
      </div>
      {testMatchesInputs && (
        tested.result.ok
          ? <p className="hint">Relay answered — ready to save.</p>
          : <p className="relay-error">{TEST_ERROR_COPY[tested.result.code]}</p>
      )}
      {writeError && <p className="relay-error">{writeError}</p>}
    </div>
  )

  return (
    <div className="relay-badge">
      <button ref={btnRef} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <span className={dotClass(poll)} aria-hidden="true" />{badgeLabel(poll)}
      </button>
      {open && (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Relay status"
          className="relay-dialog" tabIndex={-1}>
          {poll.kind === 'off' && (
            <>
              <p>
                No relay is configured — nothing leaves your own network. Alerts, screens and data stay on your LAN.
              </p>
              <p>
                Connecting to a relay lets senders outside this network reach the hub without
                opening any inbound port. Payloads stay sealed end-to-end.
              </p>
              {poll.tokenSet && (
                <p className="relay-error">
                  A relay account token from a previous configuration is still stored, even though
                  no relay is connected right now. It will be sent to the next relay you save
                  unless you remove it below first.
                </p>
              )}
              {configureForm}
            </>
          )}
          {poll.kind === 'unknown' && <p>Status unknown — the admin could not reach the hub just now.</p>}
          {poll.kind === 'on' && (
            <dl>
              <dt>State</dt>
              <dd>{poll.status.terminal ? "stopped (won't retry)" : poll.status.state}</dd>
              <dt>Relay</dt>
              <dd><code>{poll.status.url}</code></dd>
              <dt>Hub uid</dt>
              <dd>
                <code>{poll.status.hub_uid}</code>{' '}
                <button onClick={() => copyUid(poll.status.hub_uid)}><IconCopy />Copy</button>
              </dd>
              {poll.status.connected_since !== null && (
                <><dt>Connected since</dt><dd>{new Date(poll.status.connected_since).toLocaleString()}</dd></>
              )}
              {poll.status.last_error &&
                // An error older than the current connection is history, not status: showing
                // "connected" and "the connection dropped, retrying" in the same dialog reads
                // as a contradiction. Terminal errors always show (connected_since is null then).
                (poll.status.connected_since === null ||
                  poll.status.last_error.at > poll.status.connected_since) && (
                <><dt>Last error</dt>
                <dd className="relay-error">
                  {ERROR_COPY[poll.status.last_error.code]}{' '}
                  <small>({new Date(poll.status.last_error.at).toLocaleString()})</small>
                </dd></>
              )}
            </dl>
          )}
          {poll.kind === 'on' && !editing && !confirmingDisconnect && (
            <div className="source-setup-actions">
              <button onClick={() => { setUrlInput(poll.status.url); setTokenInput(''); setTested(null); setWriteError(''); setEditing(true) }}>Change</button>
              <button onClick={() => { setWriteError(''); setConfirmingDisconnect(true) }}>Disconnect</button>
            </div>
          )}
          {poll.kind === 'on' && editing && configureForm}
          {poll.kind === 'on' && confirmingDisconnect && (
            <div className="relay-config">
              <p>
                Disconnect from the relay? Remote senders lose their route to this hub;
                everything on your LAN keeps working.
              </p>
              <div className="source-setup-actions">
                <button onClick={disconnect} disabled={busy}>Yes, disconnect</button>
                <button onClick={() => { setConfirmingDisconnect(false); setWriteError('') }} disabled={busy}>Cancel</button>
              </div>
              {writeError && <p className="relay-error">{writeError}</p>}
            </div>
          )}
          <p>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              How the relay keeps your data private
            </a>
          </p>
          <button onClick={close}>Close</button>
        </div>
      )}
    </div>
  )
}
