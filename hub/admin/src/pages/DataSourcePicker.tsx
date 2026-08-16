import { useEffect, useState } from 'react'
import { api } from '../api'
import { IconCopy } from '../icons'
// @ts-expect-error plain JS module without types
import { feedModesFor } from '../../../static/device/widgets/bindings.mjs'
import type { FeedRow } from './Screens'

interface SenderRow { id: string; name: string }

export interface DataSourcePickerProps {
  label: string
  widget: string
  value: string
  feeds: FeedRow[]
  /**
   * This cell's config, so the hub can answer which feeds fit it. Omitted where a caller has
   * nothing to ask about; the picker then filters by mode alone, exactly as it always has.
   */
  config?: Record<string, unknown>
  onChange: (feedId: string) => void
  onFeedCreated: (feed: FeedRow) => void
  /** Preserved for current callers; connector path suggestions no longer belong to this picker. */
  onSuggestPath?: (path: string) => void
}

/**
 * Advanced generic widgets keep their existing feed/push path. Semantic Weather and News setup is
 * owned by SourceSetupDialog, so this control intentionally has no provider-creation form.
 */
export default function DataSourcePicker(props: DataSourcePickerProps) {
  const { label, widget, value, feeds, config, onChange, onFeedCreated } = props
  const modes = feedModesFor(widget) as string[]
  const [unfit, setUnfit] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [feedName, setFeedName] = useState('')
  const [feedMode, setFeedMode] = useState('')
  const [senders, setSenders] = useState<SenderRow[]>([])
  const [senderId, setSenderId] = useState('')
  const [curl, setCurl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * Which feeds cannot satisfy this cell, asked of the HUB. The matching rule is
   * `compatibleGeneric`, which lives in `hub/src` and cannot be imported here (`rootDir: src`);
   * restating it in the admin would be a second home for a rule, and unlike the mode table there
   * is no test that could compare two copies of a matcher's body.
   *
   * `serialized` rather than `config` in the dependency list because a config object is rebuilt on
   * every keystroke in the editor; comparing its JSON asks again only when something really moved.
   */
  const serialized = JSON.stringify(config ?? {})
  useEffect(() => {
    if (config === undefined) return
    let live = true
    api<{ unfit: { id: string }[] }>(
      `/admin/api/feed-fit?widget=${encodeURIComponent(widget)}&config=${encodeURIComponent(serialized)}`,
    )
      // Fail OPEN. A picker that hides every feed because a check did not complete is worse than
      // one that never checked: the operator sees an empty list and is told nothing about why.
      .then((answer) => { if (live) setUnfit(answer.unfit.map((entry) => entry.id)) })
      .catch(() => { if (live) setUnfit([]) })
    return () => { live = false }
  }, [widget, serialized, config])

  // The feed already bound is never hidden, whatever the hub says about it. Dropping it would
  // silently blank the control on an existing board and make the mistake impossible to see, let
  // alone correct — the same reason a mismatch on save warns instead of blocking.
  const offered = feeds.filter((feed) =>
    modes.includes(feed.mode) && (feed.id === value || !unfit.includes(feed.id)))

  const openPush = () => {
    setOpen((current) => !current)
    setError('')
    setCurl('')
    setFeedMode((current) => current || modes[0] || 'value')
    if (!open) api<SenderRow[]>('/admin/api/senders').then(setSenders).catch(() => setSenders([]))
  }

  const createFeedAndSender = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const feed = await api<FeedRow>('/admin/api/feeds', {
        method: 'POST', body: JSON.stringify({ name: feedName, mode: feedMode }),
      })
      let token = 'YOUR_SENDER_TOKEN'
      if (senderId === '') {
        const made = await api<{ sender: SenderRow; token: string }>('/admin/api/senders', {
          method: 'POST', body: JSON.stringify({ name: feedName }),
        })
        token = made.token
      }
      onFeedCreated(feed)
      onChange(feed.id)
      setCurl(`curl -X POST ${window.location.origin}/api/feeds/${feed.id} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "content-type: application/json" \\\n  -d '{"value":1}'`)
    } catch {
      setError('Could not create this push destination. Check the details and try again.')
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(curl)
    else prompt('Copy this command:', curl)
  }

  const panelStyle = { marginTop: 6, maxWidth: '100%', boxSizing: 'border-box' as const }
  const fullWidth = { width: '100%', boxSizing: 'border-box' as const }

  return (
    <div style={{ marginLeft: 12, display: 'inline-block', maxWidth: 'calc(100% - 12px)' }}>
      <label>
        feed{' '}
        <select aria-label={`${label} feed`} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">choose a feed</option>
          {offered.map((feed) => (
            <option key={feed.id} value={feed.id}>{feed.name}</option>
          ))}
        </select>
      </label>
      <button type="button" style={{ marginLeft: 4 }} aria-label={`${label} push it yourself`} onClick={openPush}>
        Push it yourself
      </button>

      {open && (
        <div className="edit-card" style={panelStyle}>
          <input aria-label={`${label} new feed name`} style={fullWidth} placeholder="Call it…"
            value={feedName} onChange={(event) => setFeedName(event.target.value)} />
          {modes.length > 1 && (
            <label style={{ marginLeft: 6 }}>shape{' '}
              <select aria-label={`${label} feed mode`} value={feedMode}
                onChange={(event) => setFeedMode(event.target.value)}>
                {modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </label>
          )}
          <label style={{ marginLeft: 6 }}>pushed by{' '}
            <select aria-label={`${label} sender`} value={senderId} onChange={(event) => setSenderId(event.target.value)}>
              <option value="">a new key, named after this</option>
              {senders.map((sender) => <option key={sender.id} value={sender.id}>{sender.name}</option>)}
            </select>
          </label>
          <div style={{ marginTop: 6 }}>
            <button type="button" aria-label={`${label} create feed`} disabled={busy}
              onClick={() => void createFeedAndSender()}>{busy ? 'Creating…' : 'Create it'}</button>
          </div>
          {curl && (
            <div style={{ marginTop: 6 }}>
              <pre aria-label={`${label} curl`} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{curl}</pre>
              <button type="button" style={{ marginTop: 4 }} onClick={copy}><IconCopy />Copy</button>
              {senderId !== '' && (
                <p className="hint">That key’s token was shown once and cannot be read back — paste yours in.</p>
              )}
            </div>
          )}
          {error && <p className="source-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
