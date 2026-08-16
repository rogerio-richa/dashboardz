import {
  useCallback, useEffect, useId, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { api } from '../api'
import type {
  ContractId, DraftOutputView, ExistingSourceChoiceView, FeedDetailView, GeocodePlaceView,
  ProviderChoiceView, SetupFieldView, SourceChoicesView, SourceDraftView, SourceSetupResult,
  WirePreview,
} from '../source-types'
import WidgetPreview from './WidgetPreview'

export interface SourceSetupDialogProps {
  widget: string
  config: Record<string, unknown>
  onUse: (result: SourceSetupResult) => void
  onCancel: () => void
}

interface SetupSnapshot {
  choices: SourceChoicesView
  provider: ProviderChoiceView
  name: string
  values: Record<string, string>
  interval: string
  draftId?: string
  error?: string
}

interface PreviewCandidate extends SourceSetupResult {
  draftId?: string
  expiresAt?: number
  returnSetup?: SetupSnapshot
}

type DialogState =
  | { step: 'loading' }
  | { step: 'choose'; choices: SourceChoicesView; error?: string }
  | ({ step: 'setup' } & SetupSnapshot)
  | { step: 'testing'; kind: 'provider'; setup: SetupSnapshot }
  | { step: 'testing'; kind: 'existing'; choices: SourceChoicesView; existing: ExistingSourceChoiceView }
  | { step: 'preview'; choices: SourceChoicesView; candidate: PreviewCandidate }
  | { step: 'load-error'; error: string }

const OPTIONAL_DETAILS: Readonly<Record<string, readonly { id: string; label: string }[]>> = {
  weather_forecast: [
    { id: 'attribution', label: 'Attribution' },
    { id: 'weather.current', label: 'Current conditions' },
    { id: 'weather.daily.humidity', label: 'humidity' },
    { id: 'weather.daily.pollen', label: 'pollen' },
    { id: 'weather.daily.precipitation_probability', label: 'precipitation' },
    { id: 'weather.daily.wind', label: 'wind' },
  ],
  calendar_events: [
    { id: 'calendar.event.all_day', label: 'all-day events' },
    { id: 'calendar.event.location', label: 'locations' },
  ],
  news_list: [
    { id: 'attribution', label: 'Attribution' },
    { id: 'news.item.published_at', label: 'published times' },
    { id: 'news.item.source', label: 'publisher names' },
    { id: 'news.item.summary', label: 'summaries' },
    { id: 'news.item.url', label: 'article links' },
  ],
}

const RESERVED_FIELD_PARTS = new Set([
  '__proto__', 'constructor', 'hasownproperty', 'prototype', 'tostring', 'valueof',
])
const FIELD_NAME = /^[a-z][a-z0-9_]*$/

function safeFields(provider: ProviderChoiceView): SetupFieldView[] {
  const names = new Set<string>()
  return Array.isArray(provider.setup) ? provider.setup.filter((field) => {
    if (!field || typeof field.name !== 'string' || !FIELD_NAME.test(field.name)) return false
    if (field.name.split('_').some((part) => RESERVED_FIELD_PARTS.has(part.toLowerCase()))) return false
    if (names.has(field.name)) return false
    names.add(field.name)
    return ['text', 'number', 'url', 'select'].includes(field.type)
  }) : []
}

function defaultNumber(name: string, field: SetupFieldView): string {
  if (name === 'max_items') return '20'
  if (name === 'lookahead_days') return '7'
  if (name === 'max_events') return '10'
  return field.min === field.max && field.min !== undefined ? String(field.min) : ''
}

function initialSetup(choices: SourceChoicesView, provider: ProviderChoiceView): SetupSnapshot {
  const values = Object.create(null) as Record<string, string>
  for (const field of safeFields(provider)) {
    values[field.name] = field.type === 'select'
      ? field.options?.[0]?.value ?? ''
      : field.type === 'number' ? defaultNumber(field.name, field) : ''
  }
  return {
    choices, provider, name: provider.label, values,
    interval: String(provider.default_interval_s),
  }
}

function normalizedChoices(value: SourceChoicesView): SourceChoicesView {
  return {
    ...value,
    existing: Array.isArray(value.existing) ? value.existing : [],
    providers: (Array.isArray(value.providers) ? value.providers : [])
      .filter((provider) => provider && typeof provider.id === 'string')
      .sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.label.localeCompare(right.label)),
  }
}

function previewData(preview: WirePreview): unknown {
  if (preview.mode === 'value') return preview.payload
  return preview.rows.map((row) => row.payload)
}

function feedPreviewData(detail: FeedDetailView): unknown {
  if (detail.mode === 'value') return detail.payload
  if (detail.mode === 'stream') return detail.rows.map((row) => row.payload)
  return null
}

function errorCopy(error: unknown, action: 'load' | 'test' | 'geocode' | 'preview' | 'cleanup'): string {
  const code = error instanceof Error ? error.message : ''
  if (action === 'load') return 'Couldn’t load connection choices. Try again.'
  if (action === 'geocode') return 'Couldn’t search for that city. Check the spelling or enter coordinates under Advanced.'
  if (action === 'preview') return 'Couldn’t load that preview. Refresh the connection or choose another one.'
  if (action === 'cleanup') return 'Couldn’t discard the unfinished connection. Try Cancel again.'
  if (code === 'provider_unavailable') return 'This provider is unavailable. Choose another provider.'
  if (code === 'setup_invalid') return 'Check the connection details and try again.'
  if (code === 'credential_storage_failed') return 'Couldn’t protect the connection details. Ask an administrator to check the hub.'
  return 'Couldn’t fetch usable data. Check the details and try again.'
}

function optionalCopy(widget: string, missing: readonly string[]) {
  const details = OPTIONAL_DETAILS[widget] ?? []
  const omitted = new Set(missing)
  return {
    available: details.filter((detail) => !omitted.has(detail.id)).map((detail) => detail.label),
    missing: details.filter((detail) => omitted.has(detail.id)).map((detail) => detail.label),
  }
}

function OptionalDetails({ widget, missing }: { widget: string; missing: readonly string[] }) {
  const details = optionalCopy(widget, missing)
  return (
    <div className="source-optional-details">
      <span>Available: {details.available.length > 0 ? details.available.join(', ') : 'Standard details only'}</span>
      <span>Not included: {details.missing.length > 0 ? details.missing.join(', ') : 'Nothing optional is omitted'}</span>
    </div>
  )
}

function formatRefresh(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Not refreshed yet'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
  } catch {
    return new Date(value).toISOString()
  }
}

function providerContract(provider: ProviderChoiceView): ContractId | undefined {
  return provider.compatible_outputs?.[0]?.contract_id
}

function draftOutput(draft: SourceDraftView, contractId: ContractId | undefined): DraftOutputView | undefined {
  return contractId ? draft.outputs.find((output) => output.contract_id === contractId) : undefined
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default function SourceSetupDialog({ widget, config, onUse, onCancel }: SourceSetupDialogProps) {
  const [state, setState] = useState<DialogState>({ step: 'loading' })
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [places, setPlaces] = useState<GeocodePlaceView[]>([])
  const [activePlaceIndex, setActivePlaceIndex] = useState<number | null>(null)
  const [geocodeError, setGeocodeError] = useState('')
  const [cleanupError, setCleanupError] = useState('')
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const openerRef = useRef<Element | null>(document.activeElement)
  const mountedRef = useRef(true)
  const handedOffRef = useRef(false)
  const usedRef = useRef(false)
  const testingRef = useRef(false)
  const closingRef = useRef(false)
  const choicesSeq = useRef(0)
  const testSeq = useRef(0)
  const previewSeq = useRef(0)
  const geocodeSeq = useRef(0)
  const ownedDrafts = useRef(new Set<string>())
  const choicesAbort = useRef<AbortController | null>(null)
  const testAbort = useRef<AbortController | null>(null)
  const previewAbort = useRef<AbortController | null>(null)
  const geocodeAbort = useRef<AbortController | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  const restoreFocus = useCallback(() => {
    const opener = openerRef.current
    if (opener instanceof HTMLElement) opener.focus()
  }, [])

  const discardDraft = useCallback(async (id: string): Promise<void> => {
    try {
      await api<void>(`/admin/api/source-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
      ownedDrafts.current.delete(id)
    } catch (error) {
      // Expiry and a winning superseding test may have removed it first; either way ownership is
      // already discharged. Other failures keep the dialog open so Cancel can safely be retried.
      if (error instanceof Error && error.message === 'not_found') {
        ownedDrafts.current.delete(id)
        return
      }
      throw error
    }
  }, [])

  const cancel = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    setCleanupBusy(true)
    setCleanupError('')
    choicesSeq.current++
    testSeq.current++
    previewSeq.current++
    geocodeSeq.current++
    choicesAbort.current?.abort()
    testAbort.current?.abort()
    previewAbort.current?.abort()
    geocodeAbort.current?.abort()
    try {
      for (const id of [...ownedDrafts.current]) await discardDraft(id)
      restoreFocus()
      onCancel()
    } catch (error) {
      if (mountedRef.current) setCleanupError(errorCopy(error, 'cleanup'))
    } finally {
      closingRef.current = false
      if (mountedRef.current) setCleanupBusy(false)
    }
  }, [discardDraft, onCancel, restoreFocus])

  useEffect(() => {
    mountedRef.current = true
    const draftsOwnedByThisDialog = ownedDrafts.current
    const seq = ++choicesSeq.current
    const controller = new AbortController()
    choicesAbort.current = controller
    setState({ step: 'loading' })
    api<SourceChoicesView>(`/admin/api/source-choices?widget=${encodeURIComponent(widget)}`, {
      signal: controller.signal,
    }).then((choices) => {
      if (mountedRef.current && seq === choicesSeq.current) {
        setState({ step: 'choose', choices: normalizedChoices(choices) })
      }
    }).catch((error) => {
      if (mountedRef.current && seq === choicesSeq.current && !isAbort(error)) {
        setState({ step: 'load-error', error: errorCopy(error, 'load') })
      }
    })
    return () => {
      mountedRef.current = false
      controller.abort()
      testAbort.current?.abort()
      previewAbort.current?.abort()
      geocodeAbort.current?.abort()
      if (!handedOffRef.current) {
        for (const id of draftsOwnedByThisDialog) {
          void fetch(`/admin/api/source-drafts/${encodeURIComponent(id)}`, {
            method: 'DELETE', credentials: 'include', keepalive: true,
          }).catch(() => undefined)
        }
      }
    }
  }, [loadAttempt, widget])

  useEffect(() => {
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
  }, [state.step])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void cancel()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === panelRef.current) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === panelRef.current) {
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
  }, [cancel])

  const updateSetup = (patch: Partial<SetupSnapshot>) => {
    setState((current) => current.step === 'setup' ? { ...current, ...patch } : current)
  }

  const resetGeocodeContext = () => {
    geocodeSeq.current++
    geocodeAbort.current?.abort()
    geocodeAbort.current = null
    setPlaces([])
    setActivePlaceIndex(null)
    setGeocodeError('')
  }

  const backFromSetup = async (setup: SetupSnapshot) => {
    if (cleanupBusy) return
    resetGeocodeContext()
    setCleanupError('')
    if (setup.draftId) {
      setCleanupBusy(true)
      try {
        await discardDraft(setup.draftId)
      } catch (error) {
        if (mountedRef.current) setCleanupError(errorCopy(error, 'cleanup'))
        return
      } finally {
        if (mountedRef.current) setCleanupBusy(false)
      }
    }
    if (mountedRef.current) setState({ step: 'choose', choices: setup.choices })
  }

  const setValue = (name: string, value: string) => {
    if (name === 'city') resetGeocodeContext()
    setState((current) => {
      if (current.step !== 'setup') return current
      const values = Object.assign(Object.create(null), current.values, { [name]: value }) as Record<string, string>
      if (name === 'city') {
        values.lat = ''
        values.lon = ''
      }
      return { ...current, values, error: undefined }
    })
  }

  const searchCity = async () => {
    if (state.step !== 'setup') return
    const query = (state.values.city ?? '').trim()
    if (!query) {
      setGeocodeError('Enter a city to search.')
      return
    }
    const seq = ++geocodeSeq.current
    geocodeAbort.current?.abort()
    const controller = new AbortController()
    geocodeAbort.current = controller
    setPlaces([])
    setActivePlaceIndex(null)
    setGeocodeError('')
    try {
      const found = await api<GeocodePlaceView[]>(`/admin/api/geocode?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
      if (!mountedRef.current || seq !== geocodeSeq.current) return
      setPlaces(found)
      setActivePlaceIndex(null)
      if (found.length === 0) setGeocodeError('No matching city was found. Try a nearby place or enter coordinates under Advanced.')
    } catch (error) {
      if (mountedRef.current && seq === geocodeSeq.current && !isAbort(error)) {
        setGeocodeError(errorCopy(error, 'geocode'))
      }
    }
  }

  const selectPlace = (place: GeocodePlaceView) => {
    if (state.step !== 'setup') return
    const values = Object.assign(Object.create(null), state.values, {
      city: place.name, lat: String(place.lat), lon: String(place.lon),
    }) as Record<string, string>
    updateSetup({
      values,
      name: state.name === state.provider.label || state.name.trim() === '' ? place.name : state.name,
      error: undefined,
    })
    resetGeocodeContext()
  }

  const onCityKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (places.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActivePlaceIndex((current) => current === null ? 0 : (current + 1) % places.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActivePlaceIndex((current) => current === null ? places.length - 1 : (current - 1 + places.length) % places.length)
      return
    }
    if (event.key === 'Enter' && activePlaceIndex !== null) {
      event.preventDefault()
      const place = places[activePlaceIndex]
      if (place) selectPlace(place)
    }
  }

  const buildRequest = (setup: SetupSnapshot) => {
    const fields = safeFields(setup.provider)
    const configOut = Object.create(null) as Record<string, unknown>
    const secretsOut = Object.create(null) as Record<string, string>
    let missing = ''
    for (const field of fields) {
      if (field.secret) {
        const control = formRef.current?.elements.namedItem(field.name)
        const value = control instanceof HTMLInputElement || control instanceof HTMLSelectElement
          ? control.value.trim() : ''
        if (field.required && value === '') missing ||= field.label
        if (value !== '') secretsOut[field.name] = value
        if (control instanceof HTMLInputElement) control.value = ''
        continue
      }
      const raw = setup.values[field.name] ?? ''
      if (field.required && raw.trim() === '') missing ||= field.label
      if (raw.trim() === '') continue
      configOut[field.name] = field.type === 'number' ? Number(raw) : raw
    }
    const interval = Number(setup.interval)
    if (setup.name.trim() === '') missing ||= 'Connection name'
    if (!Number.isInteger(interval) || interval < setup.provider.min_interval_s) missing ||= 'Refresh interval'
    return {
      missing,
      body: {
        provider_id: setup.provider.id,
        name: setup.name.trim(),
        config: configOut,
        secrets: secretsOut,
        interval_s: interval,
        ...(setup.draftId ? { supersedes: setup.draftId } : {}),
      },
    }
  }

  const testProvider = async (event: FormEvent) => {
    event.preventDefault()
    if (state.step !== 'setup' || testingRef.current) return
    const setup: SetupSnapshot = {
      choices: state.choices, provider: state.provider, name: state.name,
      values: state.values, interval: state.interval, draftId: state.draftId,
    }
    const request = buildRequest(setup)
    if (request.missing) {
      setState({ ...state, error: `Complete ${request.missing} before testing.` })
      return
    }
    testingRef.current = true
    const seq = ++testSeq.current
    testAbort.current?.abort()
    const controller = new AbortController()
    testAbort.current = controller
    resetGeocodeContext()
    setState({ step: 'testing', kind: 'provider', setup })
    try {
      const draft = await api<SourceDraftView>('/admin/api/source-drafts', {
        method: 'POST', body: JSON.stringify(request.body), signal: controller.signal,
      })
      ownedDrafts.current.add(draft.id)
      if (!mountedRef.current || seq !== testSeq.current) {
        await discardDraft(draft.id).catch(() => undefined)
        return
      }
      const output = draftOutput(draft, providerContract(setup.provider))
      if (!output) {
        await discardDraft(draft.id).catch(() => undefined)
        setState({ step: 'setup', ...setup, error: 'This provider did not return data this widget can use.' })
        return
      }
      if (draft.expires_at <= Date.now()) {
        await discardDraft(draft.id).catch(() => undefined)
        setState({ step: 'setup', ...setup, draftId: undefined, error: 'This preview expired. Test the connection again.' })
        return
      }
      if (setup.draftId && setup.draftId !== draft.id) ownedDrafts.current.delete(setup.draftId)
      const candidate: PreviewCandidate = {
        binding: { source_draft_id: draft.id, output_contract: output.contract_id },
        preview: previewData(output.preview),
        connection: { name: draft.name, provider: draft.provider },
        missing_optional: output.missing_optional,
        draftId: draft.id,
        expiresAt: draft.expires_at,
        returnSetup: { ...setup, draftId: draft.id },
      }
      setState({ step: 'preview', choices: setup.choices, candidate })
    } catch (error) {
      if (mountedRef.current && seq === testSeq.current && !isAbort(error)) {
        setState({ step: 'setup', ...setup, error: errorCopy(error, 'test') })
      }
    } finally {
      testingRef.current = false
    }
  }

  const previewExisting = async (existing: ExistingSourceChoiceView, choices: SourceChoicesView) => {
    if (testingRef.current) return
    testingRef.current = true
    const seq = ++previewSeq.current
    previewAbort.current?.abort()
    const controller = new AbortController()
    previewAbort.current = controller
    setState({ step: 'testing', kind: 'existing', choices, existing })
    try {
      const detail = await api<FeedDetailView>(`/admin/api/feeds/${encodeURIComponent(existing.feed_id)}`, {
        signal: controller.signal,
      })
      if (!mountedRef.current || seq !== previewSeq.current) return
      const data = feedPreviewData(detail)
      if (data === null) throw new Error('preview_unavailable')
      setState({
        step: 'preview', choices,
        candidate: {
          binding: { feed: existing.feed_id }, preview: data,
          connection: { name: existing.source_name, provider: existing.provider },
          missing_optional: existing.missing_optional,
        },
      })
    } catch (error) {
      if (mountedRef.current && seq === previewSeq.current && !isAbort(error)) {
        setState({ step: 'choose', choices, error: errorCopy(error, 'preview') })
      }
    } finally {
      testingRef.current = false
    }
  }

  const useCandidate = () => {
    if (state.step !== 'preview' || usedRef.current) return
    const { candidate } = state
    if (candidate.draftId && candidate.expiresAt !== undefined && candidate.expiresAt <= Date.now()) {
      const expiredId = candidate.draftId
      const setup = candidate.returnSetup
      if (setup) setState({ step: 'setup', ...setup, draftId: undefined, error: 'This preview expired. Test the connection again.' })
      void discardDraft(expiredId).catch(() => undefined)
      return
    }
    usedRef.current = true
    handedOffRef.current = true
    if (candidate.draftId) ownedDrafts.current.delete(candidate.draftId)
    onUse({
      binding: candidate.binding,
      preview: candidate.preview,
      connection: candidate.connection,
      missing_optional: candidate.missing_optional,
    })
  }

  const heading = state.step === 'choose' ? state.choices.title
    : state.step === 'setup' ? `Set up ${state.provider.label}`
      : state.step === 'preview' ? 'Preview with real data'
        : state.step === 'testing' ? (state.kind === 'provider' ? 'Testing connection' : 'Loading preview')
          : 'Choose data'
  const description = state.step === 'choose' ? state.choices.description
    : state.step === 'setup' ? state.provider.account
      : state.step === 'preview' ? `Real data from ${state.candidate.connection.name}`
        : 'Preparing compatible choices.'

  const renderSetupField = (field: SetupFieldView, setup: SetupSnapshot) => {
    if (setup.provider.id === 'dashboardz.open-meteo' && ['city', 'lat', 'lon'].includes(field.name)) return null
    if (field.secret) {
      return (
        <label className="source-field" key={field.name}>
          <span>{field.label}</span>
          <input
            name={field.name}
            type="password"
            autoComplete="off"
            required={field.required}
            aria-label={field.label}
            inputMode={field.type === 'url' ? 'url' : undefined}
          />
          <small>Write-only: saved values are never shown again.</small>
        </label>
      )
    }
    if (field.type === 'select') {
      return (
        <label className="source-field" key={field.name}>
          <span>{field.label}</span>
          <select aria-label={field.label} value={setup.values[field.name] ?? ''}
            onChange={(event) => setValue(field.name, event.target.value)}>
            {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      )
    }
    return (
      <label className="source-field" key={field.name}>
        <span>{field.label}</span>
        <input
          aria-label={field.label}
          type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
          required={field.required}
          min={field.min}
          max={field.max}
          value={setup.values[field.name] ?? ''}
          onChange={(event) => setValue(field.name, event.target.value)}
        />
      </label>
    )
  }

  return (
    <div className="modal-backdrop source-setup-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) void cancel() }}>
      <div
        className="modal source-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="source-setup-header">
          <div>
            <h2 id={titleId}>{heading}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button type="button" onClick={() => void cancel()} disabled={cleanupBusy}>Cancel</button>
        </header>

        {cleanupError && <p className="source-error" role="alert">{cleanupError}</p>}

        {state.step === 'loading' && <p role="status">Loading connection choices…</p>}
        {state.step === 'load-error' && (
          <div>
            <p className="source-error" role="alert">{state.error}</p>
            <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button>
          </div>
        )}

        {state.step === 'choose' && (
          <div className="source-choice-flow">
            {state.error && <p className="source-error" role="alert">{state.error}</p>}
            <section className="source-choice-section">
              <h3>Use an existing connection</h3>
              {state.choices.existing.length === 0
                ? <p className="hint">No compatible saved connections yet.</p>
                : <div className="source-choice-grid">
                  {state.choices.existing.map((existing) => (
                    <button
                      type="button"
                      className="source-choice-card"
                      key={existing.output_id}
                      aria-label={`Preview ${existing.source_name}`}
                      onClick={() => void previewExisting(existing, state.choices)}
                    >
                      <strong>{existing.source_name}</strong>
                      <span>{existing.provider}</span>
                      <span>Last refreshed: {formatRefresh(existing.last_success_at)}</span>
                      <OptionalDetails widget={widget} missing={existing.missing_optional} />
                    </button>
                  ))}
                </div>}
            </section>
            <section className="source-choice-section">
              <h3>Connect a provider</h3>
              <div className="source-choice-grid">
                {state.choices.providers.map((provider) => (
                  <button
                    type="button"
                    className="source-choice-card"
                    key={provider.id}
                    aria-label={`Set up ${provider.label}`}
                    onClick={() => {
                      resetGeocodeContext()
                      setState({ step: 'setup', ...initialSetup(state.choices, provider) })
                    }}
                  >
                    {provider.recommended && <span className="source-recommended">Recommended</span>}
                    <strong>{provider.label}</strong>
                    <span>{provider.account}</span>
                    <span>{provider.attribution}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {state.step === 'setup' && (
          <form ref={formRef} className="source-setup-form" onSubmit={testProvider} noValidate>
            {state.error && <p className="source-error" role="alert">{state.error}</p>}
            <label className="source-field">
              <span>Connection name</span>
              <input aria-label="Connection name" value={state.name}
                onChange={(event) => updateSetup({ name: event.target.value, error: undefined })} />
            </label>

            {state.provider.id === 'dashboardz.open-meteo' && (
              <div className="source-city-field">
                <label className="source-field">
                  <span>City</span>
                  <input
                    role="combobox"
                    aria-label="City"
                    aria-expanded={places.length > 0}
                    aria-controls={`${titleId}-places`}
                    aria-autocomplete="list"
                    aria-activedescendant={activePlaceIndex === null ? undefined : `${titleId}-place-${activePlaceIndex}`}
                    value={state.values.city ?? ''}
                    onChange={(event) => setValue('city', event.target.value)}
                    onKeyDown={onCityKeyDown}
                  />
                </label>
                <button type="button" onClick={() => void searchCity()}>Find city</button>
                {places.length > 0 && (
                  <div className="source-place-list" role="listbox" id={`${titleId}-places`} aria-label="Matching cities">
                    {places.map((place, index) => {
                      const label = [place.name, place.region, place.country].filter(Boolean).join(', ')
                      return <button type="button" role="option" id={`${titleId}-place-${index}`}
                        aria-selected={activePlaceIndex === index} tabIndex={-1} key={`${place.lat},${place.lon}`}
                        onClick={() => selectPlace(place)}>{label}</button>
                    })}
                  </div>
                )}
                {geocodeError && <p className="source-error" role="alert">{geocodeError}</p>}
              </div>
            )}

            <div className="source-fields">
              {safeFields(state.provider).map((field) => renderSetupField(field, state))}
            </div>

            <details className="source-advanced">
              <summary>Advanced</summary>
              {state.provider.id === 'dashboardz.open-meteo' && (
                <div className="source-coordinate-fields">
                  {safeFields(state.provider).filter((field) => field.name === 'lat' || field.name === 'lon')
                    .map((field) => (
                      <label className="source-field" key={field.name}>
                        <span>{field.label}</span>
                        <input type="number" aria-label={field.label} min={field.min} max={field.max}
                          value={state.values[field.name] ?? ''}
                          onChange={(event) => setValue(field.name, event.target.value)} />
                      </label>
                    ))}
                </div>
              )}
              <label className="source-field">
                <span>Refresh every (seconds)</span>
                <input type="number" aria-label="Refresh every (seconds)" min={state.provider.min_interval_s}
                  max={86_400} value={state.interval}
                  onChange={(event) => updateSetup({ interval: event.target.value, error: undefined })} />
              </label>
              <p className="hint">{state.provider.label} allows refreshes every {state.provider.min_interval_s} seconds or slower.</p>
            </details>

            <div className="source-setup-actions">
              <button type="button" disabled={cleanupBusy}
                onClick={() => void backFromSetup(state)}>Back</button>
              <button type="submit">Test connection</button>
            </div>
          </form>
        )}

        {state.step === 'testing' && (
          <div className="source-testing" role="status"
            aria-label={state.kind === 'provider' ? 'Testing connection' : 'Loading preview'}>
            <span className="source-testing-mark" aria-hidden="true">•••</span>
            <strong>{state.kind === 'provider' ? 'Testing connection…' : 'Loading real preview…'}</strong>
            <p>Checking for usable, current data.</p>
          </div>
        )}

        {state.step === 'preview' && (
          <div className="source-real-preview">
            <WidgetPreview widget={widget} config={config} data={state.candidate.preview}
              width={widget === 'weather_forecast' ? 600 : 360}
              height={widget === 'weather_forecast' ? 280 : 480} />
            <OptionalDetails widget={widget} missing={state.candidate.missing_optional} />
            <div className="source-setup-actions">
              {state.candidate.returnSetup
                ? <button type="button" onClick={() => {
                  usedRef.current = false
                  setState({ step: 'setup', ...state.candidate.returnSetup!, error: undefined })
                }}>Change details</button>
                : <button type="button" onClick={() => setState({ step: 'choose', choices: state.choices })}>Back</button>}
              <button type="button" onClick={useCandidate}>Use this data</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
