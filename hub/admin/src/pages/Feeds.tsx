import { Fragment, useEffect, useRef, useState } from 'react'
import { ago } from '../ago'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { IconCopy, IconEdit, IconInspect, IconPause, IconPlay, IconPlus, IconReload, IconSave, IconTrash } from '../icons'
import type { ContractId, SetupFieldView, WirePreview } from '../source-types'

type FeedMode = 'value' | 'stream' | 'image'
interface FeedRow {
  id: string; name: string; mode: FeedMode; cap: number
  stale_after_s: number | null; alert_on_stale: boolean
  allowed_senders: string[] | null
  pushed_at: number | null; pushed_by: string | null; image_rev: number; created_at: number
}
interface FeedDetail extends FeedRow {
  payload: unknown
  rows: { payload: unknown; pushed_at: number }[]
  references: { id: string; name: string }[]
}

/** Just enough of a sender to offer it in the allowed-senders picker. */
interface SenderRow { id: string; name: string }

interface SourceUsage { screen_id: string; screen_name: string }
interface SourceOutput {
  id: string; contract_id: ContractId; feed_id: string; capabilities: string[]
  last_valid_at: number | null; usages: SourceUsage[]
}
interface SourceHealth {
  state: string; status: string
  last_run_at: number | null; last_success_at: number | null; next_refresh_at: number | null
  failure_count: number; rate_limited_until: number | null
}
/** One persistent connection, exactly as `/admin/api/sources` reports it. */
interface SourceRow {
  id: string; name: string
  provider: { id: string; label: string; available: boolean }
  config: Record<string, unknown> | null
  interval_s: number; enabled: boolean
  health: SourceHealth
  outputs: SourceOutput[]
  usages: SourceUsage[]
}
interface ProviderRow {
  id: string; label: string; recommended: boolean
  default_interval_s: number; min_interval_s: number
  setup: SetupFieldView[]
  outputs: { contract_id: ContractId; capabilities: string[] }[]
  recommendation: string; account: string; attribution: string
}
interface DraftRow {
  id: string; provider_id: string; provider: string; name: string; expires_at: number
  outputs: { contract_id: ContractId; capabilities: string[]; missing_optional: string[]; preview: WirePreview }[]
}

const isStale = (f: FeedRow): boolean =>
  f.stale_after_s !== null && (f.pushed_at === null || (Date.now() - f.pushed_at) / 1000 > f.stale_after_s)

/** "900" is a number of seconds; "15m" is how often. The table wants the second one. */
const every = (s: number): string => {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 360) / 10}h`.replace('.0', '')
}

/** A duration, rounded to the unit somebody would say out loud. */
const span = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * Three words, because there are only three things to do next: nothing, fix it, resume it. The wire
 * carries six states (`rate_limited`, `invalid_output`, `authentication_required`…) and the specific
 * one is already spelled out in the server's status sentence beside this — it does not also need to
 * be a vocabulary an operator has to learn to read the column.
 *
 * `enabled` outranks `state`, because pausing does not rewrite the last run's state: a connection
 * paused while healthy still reports `healthy`, and calling that "Healthy" would be telling someone
 * their calendar is fine while nothing is fetching it.
 */
const healthWord = (source: SourceRow): string =>
  !source.enabled ? 'Paused' : source.health.state === 'healthy' ? 'Healthy' : 'Needs attention'

const lastRefresh = (source: SourceRow): string =>
  source.health.last_success_at === null ? 'never' : `${span(Date.now() - source.health.last_success_at)} ago`

const nextRefresh = (source: SourceRow): string =>
  !source.enabled || source.health.next_refresh_at === null
    ? '—'
    : `in ${span(source.health.next_refresh_at - Date.now())}`

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Widgets are counted per output, screens are not. A weather connection feeding "now" to one screen
 * and the forecast to two is three widget bindings across two screens: deleting it breaks three
 * widgets, and two rooms go part-blank. Counting screens twice would overstate the damage; counting
 * widgets once would understate it.
 */
const widgetCount = (source: SourceRow): number =>
  source.outputs.reduce((total, output) => total + output.usages.length, 0)

const usageText = (source: SourceRow): string =>
  `Used by ${plural(widgetCount(source), 'widget')} on ${plural(source.usages.length, 'screen')}`

const screenNames = (source: SourceRow): string =>
  source.usages.map((usage) => usage.screen_name).join(', ')

/** What each contract is, said in the words a person would use for the data inside it. */
const CONTRACT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'dashboardz.weather.current/v1': 'Weather now',
  'dashboardz.weather.daily-forecast/v1': 'Daily forecast',
  'dashboardz.news.items/v1': 'News items',
  'dashboardz.calendar.events/v1': 'Calendar events',
  'dashboardz.legacy.value/v1': 'Pushed value',
  'dashboardz.legacy.stream/v1': 'Pushed stream',
  'dashboardz.legacy.image/v1': 'Pushed image',
})
const contractLabel = (id: string): string => CONTRACT_LABEL[id] ?? id

/**
 * Wire codes are for the wire. Every one of these reaches a person who wants to know what to do
 * next, so each maps to a sentence that says it — and an unrecognised code degrades to a sentence
 * too, rather than leaking `source_update_failed` into the page.
 */
const ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  source_paused: 'Resume this connection before refreshing it.',
  refresh_in_flight: 'This connection is already refreshing.',
  refresh_failed: 'Couldn’t refresh this connection. Check its settings and try again.',
  source_in_use: 'This connection is still used by a screen. Remove it there first.',
  source_delete_failed: 'Couldn’t remove this connection. Try again.',
  source_update_failed: 'Couldn’t save this connection. Try again.',
  interval_invalid: 'That refresh interval is shorter than this provider allows.',
  not_found: 'This connection is no longer here. Reload the page.',
  provider_unavailable: 'This connection’s provider isn’t available in this build.',
  credentials_unavailable: 'The stored credentials couldn’t be opened. Check the hub’s master key.',
  setup_conflict: 'Something else changed this connection while it was being tested. Try again.',
  setup_invalid: 'Check the connection details and try again.',
  credential_storage_failed: 'Couldn’t protect the connection details. Ask an administrator to check the hub.',
  draft_expired: 'That test expired. Test the connection again before adding it.',
  draft_invalid: 'That test is no longer usable. Test the connection again.',
  test_failed: 'Couldn’t fetch usable data. Check the details and try again.',
  invalid_body: 'The hub rejected that request. Reload the page and try again.',
})
const errorCopy = (error: unknown): string => {
  const code = error instanceof Error ? error.message : ''
  return ERROR_COPY[code] ?? 'Something went wrong. Try again.'
}
/** Promotion failures where the draft is already gone server-side — retrying the button is futile. */
const DRAFT_LOST = new Set(['draft_expired', 'draft_invalid', 'not_found'])

const RESERVED_FIELD_PARTS = new Set([
  '__proto__', 'constructor', 'hasownproperty', 'prototype', 'tostring', 'valueof',
])
const FIELD_NAME = /^[a-z][a-z0-9_]*$/

/**
 * The same filter the widget-side chooser applies (`SourceSetupDialog`). A provider list is server
 * data, and a field named `__proto__` written into a plain config object is the classic way to turn
 * "render this form" into something else entirely.
 */
function safeFields(provider: ProviderRow | undefined): SetupFieldView[] {
  const names = new Set<string>()
  return provider && Array.isArray(provider.setup) ? provider.setup.filter((field) => {
    if (!field || typeof field.name !== 'string' || !FIELD_NAME.test(field.name)) return false
    if (field.name.split('_').some((part) => RESERVED_FIELD_PARTS.has(part.toLowerCase()))) return false
    if (names.has(field.name)) return false
    names.add(field.name)
    return ['text', 'number', 'url', 'select'].includes(field.type)
  }) : []
}

/** Same numeric defaults the guided chooser uses, so a connection made either way starts equal. */
function defaultNumber(name: string, field: SetupFieldView): string {
  if (name === 'max_items') return '20'
  if (name === 'lookahead_days') return '7'
  if (name === 'max_events') return '10'
  return field.min === field.max && field.min !== undefined ? String(field.min) : ''
}

function blankValue(field: SetupFieldView): string {
  if (field.type === 'select') return field.options?.[0]?.value ?? ''
  return field.type === 'number' ? defaultNumber(field.name, field) : ''
}

/**
 * Ordinary config is prefilled from what the server returned; a secret NEVER is, because the server
 * does not send it back. The blank that leaves behind means "keep what is stored" — see `setupBody`.
 */
function initialValues(fields: SetupFieldView[], config: Record<string, unknown> | null): Record<string, string> {
  const values = Object.create(null) as Record<string, string>
  for (const field of fields) {
    const current = field.secret ? undefined : config?.[field.name]
    values[field.name] = current === undefined || current === null ? blankValue(field) : String(current)
  }
  return values
}

function configFrom(fields: SetupFieldView[], values: Record<string, string>): Record<string, unknown> {
  const config = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    if (field.secret) continue
    const raw = values[field.name] ?? ''
    config[field.name] = field.type === 'number' ? Number(raw) : raw
  }
  return config
}

/** Only secrets the operator actually typed. A blank one is not sent, so the stored value stands. */
function secretsFrom(fields: SetupFieldView[], values: Record<string, string>): Record<string, string> {
  const secrets = Object.create(null) as Record<string, string>
  for (const field of fields) {
    if (!field.secret) continue
    const raw = (values[field.name] ?? '').trim()
    if (raw !== '') secrets[field.name] = raw
  }
  return secrets
}

/** Comparable form of the config the server holds, in schema order, so "did this change?" is honest. */
function canonicalConfig(fields: SetupFieldView[], config: Record<string, unknown> | null): string {
  return JSON.stringify(configFrom(fields, initialValues(fields, config)))
}

function previewText(preview: WirePreview): string {
  const data = preview.mode === 'stream' ? preview.rows.map((row) => row.payload) : preview.payload
  return JSON.stringify(data, null, 2).slice(0, 800)
}

function SetupFields({ fields, values, onChange }: {
  fields: SetupFieldView[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  return (
    <div className="source-fields">
      {fields.map((field) => (
        <label className="source-field" key={field.name}>
          <span>{field.label}</span>
          {field.type === 'select'
            ? (
              <select value={values[field.name] ?? ''} onChange={(e) => onChange(field.name, e.target.value)}>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              )
            : (
              <input
                type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
                value={values[field.name] ?? ''}
                min={field.min}
                max={field.max}
                autoComplete={field.secret ? 'new-password' : 'off'}
                placeholder={field.secret ? 'Leave blank to keep the stored value' : undefined}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
              )}
        </label>
      ))}
    </div>
  )
}

export default function Feeds() {
  const [sources, setSources] = useState<SourceRow[]>([])
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [rows, setRows] = useState<FeedRow[]>([])
  const [ask, confirmDialog] = useConfirm()

  const [connectionError, setConnectionError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  /**
   * Which of the tab's two faces is showing: the connections list, or the add page behind the
   * heading's Add button. Keeping them as separate views avoids presenting two competing ways to
   * add a feed.
   */
  const [pageView, setPageView] = useState<'list' | 'add'>('list')

  /** The connection whose settings panel is open, and the form it is holding. */
  const [settingsId, setSettingsId] = useState<string | null>(null)
  const [settingsName, setSettingsName] = useState('')
  const [settingsInterval, setSettingsInterval] = useState('')
  const [settingsValues, setSettingsValues] = useState<Record<string, string>>({})
  const [settingsError, setSettingsError] = useState('')
  const [settingsBusy, setSettingsBusy] = useState(false)

  /** The standalone "add a connection" flow, which owns its draft until promotion. */
  const [addProviderId, setAddProviderId] = useState<string | null>(null)
  const [addName, setAddName] = useState('')
  const [addInterval, setAddInterval] = useState('')
  const [addValues, setAddValues] = useState<Record<string, string>>({})
  const [addError, setAddError] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [draft, setDraft] = useState<DraftRow | null>(null)
  // Unmounting mid-flow has to take the draft with it: a draft holds a live credential and its own
  // expiry, and leaving one behind means a tested-but-abandoned connection sitting in the database.
  const draftRef = useRef<string | null>(null)

  const [name, setName] = useState('')
  const [mode, setMode] = useState<FeedMode>('value')
  const [cap, setCap] = useState('')
  const [staleAfterS, setStaleAfterS] = useState('')
  const [alertOnStale, setAlertOnStale] = useState(false)
  /** Picked from the hub's own sender list — ids are wire detail nobody should have to type. */
  const [allowedSenderIds, setAllowedSenderIds] = useState<string[]>([])
  const [senderRows, setSenderRows] = useState<SenderRow[]>([])
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<FeedDetail | null>(null)

  const refresh = () => {
    api<SourceRow[]>('/admin/api/sources').then(setSources).catch(() => {})
    api<FeedRow[]>('/admin/api/feeds').then(setRows).catch(() => {})
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [])
  useEffect(() => {
    api<ProviderRow[]>('/admin/api/providers').then(setProviders).catch(() => {})
    api<SenderRow[]>('/admin/api/senders').then(setSenderRows).catch(() => {})
  }, [])
  useEffect(() => () => {
    const abandoned = draftRef.current
    if (abandoned) api(`/admin/api/source-drafts/${abandoned}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const providerFor = (id: string): ProviderRow | undefined => providers.find((p) => p.id === id)

  /**
   * A feed a connection fills is that connection's output. It is operated from the connection row —
   * listing it below as well would put an Edit and a Delete beside data a provider overwrites every
   * interval, which is either a pointless edit or a broken widget.
   */
  const ownedFeedIds = new Set(sources.flatMap((source) => source.outputs.map((output) => output.feed_id)))
  const pushedFeeds = rows.filter((feed) => !ownedFeedIds.has(feed.id))

  const patchSource = async (source: SourceRow, body: Record<string, unknown>) => {
    setConnectionError('')
    try {
      await api(`/admin/api/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      refresh()
    } catch (err) { setConnectionError(errorCopy(err)) }
  }

  const refreshSource = async (source: SourceRow) => {
    setConnectionError('')
    setBusyId(source.id)
    try {
      await api(`/admin/api/sources/${source.id}/refresh`, { method: 'POST' })
      refresh()
    } catch (err) {
      setConnectionError(errorCopy(err))
    } finally { setBusyId(null) }
  }

  const deleteSource = (source: SourceRow) => {
    ask(
      {
        title: `Delete ${source.name}?`,
        body: 'The hub stops fetching this data and forgets its credentials. Nothing else is removed.',
      },
      async () => {
        setConnectionError('')
        try {
          await api(`/admin/api/sources/${source.id}`, { method: 'DELETE' })
          refresh()
        } catch (err) { setConnectionError(errorCopy(err)) }
      },
    )
  }

  const openSettings = (source: SourceRow) => {
    setSettingsId(source.id)
    setSettingsName(source.name)
    setSettingsInterval(String(source.interval_s))
    setSettingsValues(initialValues(safeFields(providerFor(source.provider.id)), source.config))
    setSettingsError('')
  }
  const closeSettings = () => { setSettingsId(null); setSettingsError('') }

  /**
   * Setup goes first, and a failed setup stops everything.
   *
   * `PUT /sources/:id/setup` tests against the real provider before it commits, so a bad URL leaves
   * the persistent connection exactly as it was. Sending the rename first would break that promise
   * halfway: the operator would be looking at an error message beside a connection that had already
   * taken the new name.
   */
  const saveSettings = async (source: SourceRow) => {
    const provider = providerFor(source.provider.id)
    const fields = safeFields(provider)
    const config = configFrom(fields, settingsValues)
    const secrets = secretsFrom(fields, settingsValues)
    const setupChanged = source.provider.available && fields.length > 0 &&
      (JSON.stringify(config) !== canonicalConfig(fields, source.config) || Object.keys(secrets).length > 0)

    setSettingsError('')
    setSettingsBusy(true)
    try {
      if (setupChanged) {
        const body: Record<string, unknown> = { config }
        if (Object.keys(secrets).length > 0) body.secrets = secrets
        await api(`/admin/api/sources/${source.id}/setup`, { method: 'PUT', body: JSON.stringify(body) })
      }
      const patch: Record<string, unknown> = {}
      if (settingsName !== source.name) patch.name = settingsName
      if (Number(settingsInterval) !== source.interval_s) patch.interval_s = Number(settingsInterval)
      if (Object.keys(patch).length > 0) {
        await api(`/admin/api/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      }
      closeSettings()
      refresh()
    } catch (err) {
      setSettingsError(errorCopy(err))
    } finally { setSettingsBusy(false) }
  }

  const chooseProvider = (provider: ProviderRow) => {
    setAddProviderId(provider.id)
    setAddName(provider.label)
    setAddInterval(String(provider.default_interval_s))
    setAddValues(initialValues(safeFields(provider), null))
    setAddError('')
    setDraft(null)
  }

  const discardDraft = async () => {
    const id = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (id) await api(`/admin/api/source-drafts/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const cancelAdd = async () => {
    await discardDraft()
    setAddProviderId(null)
    setAddError('')
  }

  const openAdd = () => {
    cancelEdit()
    setPageView('add')
  }

  /** The breadcrumb's way back: drop any half-made connection and clear the feed form. */
  const backToList = async () => {
    await cancelAdd()
    cancelEdit()
    setPageView('list')
  }

  /**
   * Test, then promote — never one call. The draft is where a credential is proven to work against
   * the real provider before anything persistent exists, and `supersedes` means a second attempt
   * replaces the first rather than leaving a trail of tested-but-unused drafts behind it.
   */
  const testDraft = async (provider: ProviderRow) => {
    const fields = safeFields(provider)
    setAddError('')
    setAddBusy(true)
    try {
      const body: Record<string, unknown> = {
        provider_id: provider.id,
        name: addName,
        config: configFrom(fields, addValues),
        secrets: secretsFrom(fields, addValues),
        interval_s: Number(addInterval),
      }
      if (draftRef.current) body.supersedes = draftRef.current
      const tested = await api<DraftRow>('/admin/api/source-drafts', { method: 'POST', body: JSON.stringify(body) })
      draftRef.current = tested.id
      setDraft(tested)
    } catch (err) {
      setAddError(errorCopy(err))
    } finally { setAddBusy(false) }
  }

  const promoteDraft = async (id: string) => {
    setAddError('')
    setAddBusy(true)
    try {
      await api(`/admin/api/source-drafts/${id}/promote`, { method: 'POST' })
      draftRef.current = null
      setDraft(null)
      setAddProviderId(null)
      setPageView('list')
      refresh()
    } catch (err) {
      // The typed setup survives a failed promotion — an expired draft is the failure a real person
      // hits (test, lunch, press the button), and losing the URL they typed would be the second
      // insult. The draft itself is dropped only when the server says it is already gone.
      if (err instanceof Error && DRAFT_LOST.has(err.message)) {
        draftRef.current = null
        setDraft(null)
      }
      setAddError(errorCopy(err))
    } finally { setAddBusy(false) }
  }

  const editRow = (f: FeedRow) => {
    setEditingId(f.id)
    setName(f.name)
    setMode(f.mode)
    setCap(String(f.cap))
    setStaleAfterS(f.stale_after_s === null ? '' : String(f.stale_after_s))
    setAlertOnStale(f.alert_on_stale)
    setAllowedSenderIds(f.allowed_senders ?? [])
    setError('')
  }
  const cancelEdit = () => {
    setEditingId(null)
    setName('')
    setMode('value')
    setCap('')
    setStaleAfterS('')
    setAlertOnStale(false)
    setAllowedSenderIds([])
    setError('')
  }

  const onInspect = async (f: FeedRow) => {
    if (detailId === f.id) { setDetailId(null); setDetail(null); return }
    try {
      const d = await api<FeedDetail>(`/admin/api/feeds/${f.id}`)
      setDetailId(f.id); setDetail(d)
    } catch (err) { setError((err as Error).message) }
  }

  const onDelete = async (f: FeedRow) => {
    try {
      const d = await api<FeedDetail>(`/admin/api/feeds/${f.id}`)
      const body = d.references.length
        ? `Referenced by: ${d.references.map((r) => r.name).join(', ')}`
        : 'Not referenced by any screen'
      ask(
        { title: `Delete ${f.name}?`, body },
        async () => {
          try {
            await api(`/admin/api/feeds/${f.id}`, { method: 'DELETE' })
            refresh()
          } catch (err) { setError((err as Error).message) }
        },
      )
    } catch (err) { setError((err as Error).message) }
  }

  /**
   * The command has to match the feed's MODE, not just its id: an image feed rejects a JSON body
   * with `400 image feeds take an image push` (hub routes/feeds.ts), while value/stream both take
   * the same JSON push. Mode is a two-way split, not a three-way one.
   */
  const copyCurl = (f: FeedRow) => {
    const base = `curl -X POST ${window.location.origin}/api/feeds/${f.id} -H "Authorization: Bearer YOUR_SENDER_TOKEN"`
    const cmd = f.mode === 'image'
      ? `${base} -H "content-type: image/png" --data-binary @image.png`
      : `${base} -H "content-type: application/json" -d '{"example":1}'`
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cmd)
    else prompt('Copy this curl command:', cmd) // degrade gracefully — no clipboard API, leave it selectable
  }

  const addProvider = addProviderId === null ? undefined : providerFor(addProviderId)

  /**
   * The raw feed form, shared by its two homes: creating on the add page (under Advanced), and
   * editing an existing pushed feed on the list page. Only one home renders at a time — `openAdd`
   * clears any edit in progress, so `editingId` is always null on the add page.
   */
  const feedForm = (
    <form style={{ marginTop: 16 }} onSubmit={async (e) => {
      e.preventDefault(); setError('')
      // No boxes ticked keeps the old blank-input meaning: any sender may push.
      const senders = allowedSenderIds.length === 0 ? null : allowedSenderIds
      try {
        if (editingId) {
          const body: Record<string, unknown> = {
            name, cap: Number(cap),
            stale_after_s: staleAfterS === '' ? null : Number(staleAfterS),
            alert_on_stale: alertOnStale,
            allowed_senders: senders,
          }
          await api(`/admin/api/feeds/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) })
        } else {
          const body: Record<string, unknown> = { name, mode }
          if (cap !== '') body.cap = Number(cap)
          if (staleAfterS !== '') body.stale_after_s = Number(staleAfterS)
          if (alertOnStale) body.alert_on_stale = true
          if (senders !== null) body.allowed_senders = senders
          await api('/admin/api/feeds', { method: 'POST', body: JSON.stringify(body) })
        }
        cancelEdit(); setPageView('list'); refresh()
      } catch (err) { setError((err as Error).message) }
    }}>
      <input placeholder="Feed name" value={name} onChange={(e) => setName(e.target.value)} required />
      <label style={{ marginLeft: 12 }}>Mode{' '}
        <select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value as FeedMode)} disabled={!!editingId}>
          <option value="value">value</option>
          <option value="stream">stream</option>
          <option value="image">image</option>
        </select>
      </label>
      <label style={{ marginLeft: 12 }}>Cap{' '}
        <input aria-label="Cap" type="number" min={1} max={500} placeholder="50"
          value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 60 }} />
      </label>
      <label style={{ marginLeft: 12 }}>Stale after (s){' '}
        <input aria-label="Stale after (s)" type="number" min={5} placeholder="none"
          value={staleAfterS} onChange={(e) => setStaleAfterS(e.target.value)} style={{ width: 70 }} />
      </label>
      <label style={{ marginLeft: 12 }}>
        <input aria-label="Alert on stale" type="checkbox" checked={alertOnStale}
          onChange={(e) => setAlertOnStale(e.target.checked)} /> Alert on stale
      </label>
      <div style={{ marginTop: 8 }}>
        <span style={{ marginRight: 10 }}>Allowed senders (none ticked = any):</span>
        {senderRows.map((s) => (
          <label key={s.id} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              aria-label={`Allow sender ${s.name}`}
              checked={allowedSenderIds.includes(s.id)}
              onChange={(e) => setAllowedSenderIds((ids) => (
                e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)
              ))}
            /> {s.name}
          </label>
        ))}
        {/* A stored id whose sender is gone still restricts the feed — keep it visible and
            untickable-away rather than an invisible rule nobody can remove. */}
        {allowedSenderIds.filter((id) => !senderRows.some((s) => s.id === id)).map((id) => (
          <label key={id} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              aria-label={`Allow sender ${id}`}
              checked
              onChange={() => setAllowedSenderIds((ids) => ids.filter((other) => other !== id))}
            /> <code>{id}</code>
          </label>
        ))}
        {senderRows.length === 0 && allowedSenderIds.length === 0 && (
          <span className="hint">No senders yet — create one on the Senders tab, or leave open to any.</span>
        )}
      </div>
      <div style={{ marginTop: 8 }}>
        <button type="submit">{editingId ? 'Save feed' : 'Create feed'}</button>
        {editingId && <button type="button" onClick={cancelEdit}>Cancel</button>}
      </div>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
    </form>
  )

  if (pageView === 'add') {
    return (
      <section>
        <h2>
          <button type="button" className="crumb" onClick={backToList}>Data sources</button>
          <span className="crumb-sep" aria-hidden>›</span>
          Add
        </h2>
        {addProvider === undefined
          ? (
            <div className="source-choice-flow">
              {/*
                The standard providers the hub fetches for you. The widget-first path in the Screens
                tab remains the front door — this page exists so a source is creatable and
                repairable even before a widget consumes it (iCalendar has no widget yet).
              */}
              <section className="source-choice-section">
                <h3>Standard</h3>
                <div className="source-choice-grid">
                  {providers.map((provider) => (
                    <button className="source-choice-card" key={provider.id} onClick={() => chooseProvider(provider)}>
                      <strong>{provider.label}</strong>
                      <span>{provider.recommendation}</span>
                      <span>{provider.account}</span>
                    </button>
                  ))}
                </div>
              </section>
              {/*
                Everything the raw feed API could do before, kept intact: cron jobs and hand-rolled
                senders are how this hub got useful in the first place.
              */}
              <section className="source-choice-section">
                <h3>Advanced: push data yourself</h3>
                <p className="hint">
                  A feed something outside the hub posts into — a cron job, a script, a sender.
                </p>
                {feedForm}
              </section>
            </div>
            )
          : (
            <div className="source-setup-form">
              <div className="source-fields">
                <label className="source-field">
                  <span>Connection name</span>
                  <input value={addName} onChange={(e) => setAddName(e.target.value)} />
                </label>
              </div>
              <SetupFields
                fields={safeFields(addProvider)}
                values={addValues}
                onChange={(field, value) => setAddValues((v) => ({ ...v, [field]: value }))}
              />
              <details className="source-advanced">
                <summary>Advanced</summary>
                <label className="source-field">
                  <span>Refresh every (seconds)</span>
                  <input
                    type="number" min={addProvider.min_interval_s}
                    value={addInterval}
                    onChange={(e) => setAddInterval(e.target.value)}
                  />
                </label>
              </details>
              {draft && (
                <div className="source-real-preview">
                  <p className="hint">This is what arrived just now. {addProvider.attribution}</p>
                  {draft.outputs.map((output) => (
                    <div key={output.contract_id}>
                      <strong>{contractLabel(output.contract_id)}</strong>
                      <pre>{previewText(output.preview)}</pre>
                    </div>
                  ))}
                </div>
              )}
              <div className="source-setup-actions">
                {draft
                  ? (
                    <>
                      <button onClick={() => promoteDraft(draft.id)} disabled={addBusy}>Add connection</button>
                      <button onClick={() => testDraft(addProvider)} disabled={addBusy}>Test again</button>
                    </>
                    )
                  : <button onClick={() => testDraft(addProvider)} disabled={addBusy}>Test connection</button>}
                <button onClick={cancelAdd} disabled={addBusy}>Cancel</button>
              </div>
              {addError && <p className="source-error">{addError}</p>}
            </div>
            )}
        {confirmDialog}
      </section>
    )
  }

  return (
    <section>
      {/*
        "Data sources", not "Feeds". The schema's word was the complaint: a person wants the
        weather on their kitchen screen and should never have to learn what a feed is. This page is
        the basement — screens are built widget-first in the Screens tab, and a widget's guided setup
        is where a connection is normally born. What is left here is the operator's question: is it
        still arriving, why did it stop, and what breaks if I remove it.
      */}
      <div className="page-head">
        <h2>Data sources</h2>
        <button onClick={openAdd}><IconPlus />Add</button>
      </div>
      <p className="hint">
        Connections the hub refreshes on a schedule. Build screens in the Screens tab — a widget will
        offer to reuse one of these, or set up a new one for you.
      </p>
      {connectionError && <p className="source-error">{connectionError}</p>}

      {sources.length === 0
        ? <p className="hint">No connections yet. Add one from a widget in the Screens tab, or with the Add button above.</p>
        : (
          <table className="connections" cellPadding={6}>
            <thead>
              <tr>
                <th>Connection</th><th>Health</th><th>Last refresh</th><th>Next refresh</th>
                <th>Used by</th><th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const used = source.usages.length > 0
                const fields = safeFields(providerFor(source.provider.id))
                return (
                  <Fragment key={source.id}>
                    <tr>
                      <td>
                        <strong>{source.name}</strong>
                        <div className="connection-sub">
                          <span>{source.provider.label}</span>
                          <span> · every {every(source.interval_s)}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`connection-health is-${healthWord(source).split(' ')[0].toLowerCase()}`}>
                          {healthWord(source)}
                        </span>
                        <div className="connection-sub">{source.health.status}</div>
                      </td>
                      <td>{lastRefresh(source)}</td>
                      <td>{nextRefresh(source)}</td>
                      <td>
                        {used
                          ? (
                            <>
                              <span>{usageText(source)}</span>
                              <div className="connection-sub">{screenNames(source)}</div>
                            </>
                            )
                          : (
                            <>
                              <span>Not used by any widget</span>
                              {/* Suggested, never acted on: an unused connection may be one somebody
                                  is about to bind, and cleaning it up for them is not our call. */}
                              <div className="connection-sub">Safe to remove if you no longer need it.</div>
                            </>
                            )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            onClick={() => refreshSource(source)}
                            disabled={!source.enabled || busyId === source.id}
                            title={source.enabled ? 'Fetch this connection now' : 'Resume this connection before refreshing it'}
                          ><IconReload />Refresh</button>
                          {/* Pause, not delete: a connection you have stopped is one you can start
                              again, and every widget bound to it is untouched either way. */}
                          <button onClick={() => patchSource(source, { enabled: !source.enabled })}>
                            {source.enabled ? <><IconPause />Pause</> : <><IconPlay />Resume</>}
                          </button>
                          <button onClick={() => openSettings(source)}><IconEdit />Settings</button>
                          <button
                            onClick={() => deleteSource(source)}
                            disabled={used}
                            title={used ? `Remove this connection from ${screenNames(source)} first.` : 'Remove this connection'}
                          ><IconTrash />Delete</button>
                        </div>
                      </td>
                    </tr>
                    {settingsId === source.id && (
                      <tr>
                        <td colSpan={6}>
                          <div className="edit-card">
                            <h3>Settings — {source.name}</h3>
                            <div className="source-fields">
                              <label className="source-field">
                                <span>Connection name</span>
                                <input value={settingsName} onChange={(e) => setSettingsName(e.target.value)} />
                              </label>
                            </div>
                            {source.provider.available && fields.length > 0
                              ? (
                                <SetupFields
                                  fields={fields}
                                  values={settingsValues}
                                  onChange={(field, value) => setSettingsValues((v) => ({ ...v, [field]: value }))}
                                />
                                )
                              : (
                                <p className="hint">
                                  This connection’s provider isn’t available in this build. You can still
                                  rename, pause or remove it.
                                </p>
                                )}
                            <details className="source-advanced">
                              <summary>Advanced</summary>
                              <label className="source-field">
                                <span>Refresh every (seconds)</span>
                                <input
                                  type="number" min={1}
                                  value={settingsInterval}
                                  onChange={(e) => setSettingsInterval(e.target.value)}
                                />
                              </label>
                            </details>
                            <div className="source-setup-actions">
                              <button onClick={() => saveSettings(source)} disabled={settingsBusy}>
                                <IconSave />Save connection
                              </button>
                              <button onClick={closeSettings} disabled={settingsBusy}>Close</button>
                            </div>
                            {settingsError && <p className="source-error">{settingsError}</p>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          )}

      {/*
        Pushed feeds sit in the open now — the operator asked for the ones they made to stop hiding
        behind a disclosure. Creating one moved to the Add page (Advanced section); what stays here
        is operating them: inspect, edit, delete, copy the curl.
      */}
      <h3>Pushed feeds</h3>
      <p className="hint">
        Feeds something outside the hub posts into. Provider-owned feeds are operated from their
        connection above and are not listed here.
      </p>
      <table cellPadding={6}>
        <thead>
          <tr><th>Name</th><th>Mode</th><th>Cap</th><th>Staleness</th><th>Age</th><th></th></tr>
        </thead>
        <tbody>
          {pushedFeeds.map((f) => (
            <Fragment key={f.id}>
              <tr>
                <td>{f.name}</td>
                <td>{f.mode}</td>
                <td>{f.cap}</td>
                <td>{f.stale_after_s !== null ? `${f.stale_after_s}s` : '—'} {f.alert_on_stale ? '⚠' : ''}</td>
                <td style={{ color: isStale(f) ? '#c00' : undefined }}>{ago(f.pushed_at)}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => onInspect(f)}><IconInspect />{detailId === f.id ? 'Hide' : 'Inspect'}</button>
                    <button onClick={() => editRow(f)}><IconEdit />Edit</button>
                    <button onClick={() => onDelete(f)}><IconTrash />Delete</button>
                    <button onClick={() => copyCurl(f)}><IconCopy />Copy curl</button>
                  </div>
                </td>
              </tr>
              {editingId === f.id && (
                // Inline, like a connection's Settings row above, so a wall of pushed feeds cannot
                // put the form below the fold and make Edit look ineffective.
                <tr>
                  <td colSpan={6}>
                    <div className="edit-card">
                      <h3>Edit — {f.name}</h3>
                      {feedForm}
                    </div>
                  </td>
                </tr>
              )}
              {detailId === f.id && detail && (
                <tr>
                  <td colSpan={6}>
                    {detail.mode === 'image'
                      ? (
                        // Image feeds carry no JSON payload — their meaningful state is the
                        // revision counter (bumps on every push) and when that last happened.
                        <p>rev {detail.image_rev} · pushed {ago(detail.pushed_at)}</p>
                        )
                      : (
                        <>
                          <strong>Payload</strong>
                          <pre>{JSON.stringify(detail.payload, null, 2)}</pre>
                          <strong>Rows (newest 20)</strong>
                          <pre>{JSON.stringify(detail.rows, null, 2)}</pre>
                        </>
                        )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* Inspect/delete failures need a home even when no edit form is open to carry them. */}
      {error && editingId === null && <p className="source-error">{error}</p>}
      {confirmDialog}
    </section>
  )
}
