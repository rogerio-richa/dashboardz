import { useEffect, useState } from 'react'
import { api } from '../api'

interface PoolStat { id: string; label: string; rows: number; bytes: number; approx: boolean }

type RetentionSource = 'setting' | 'env' | 'default'

interface StorageStats {
  db_bytes: number
  images_bytes: number
  pools: PoolStat[]
  retention: {
    alerts_days: number
    audit_days: number
    source: { alerts_days: RetentionSource; audit_days: RetentionSource }
  }
  last_sweep: { ts: number; alerts: number; audit: number } | null
}

interface SweepResult { alerts: number; audit: number }

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2)

/** "setting" (a saved admin override) reads as "saved" — matching the other two labels. */
const SOURCE_LABEL: Record<RetentionSource, string> = { setting: 'saved', env: 'from env', default: 'default' }

/**
 * One retention knob: label, input, current source, and — only once there is something to
 * revert — a Reset button that clears the settings-row override (`PATCH` with the field set to
 * `null`) so it falls back to env/default.
 *
 * The input is remounted (`key`) whenever the server's own value or source changes, rather than
 * left as an uncontrolled `defaultValue` a rerender cannot touch: React only applies
 * `defaultValue` on mount, so without this, a value the SERVER changed — a save that round-tripped
 * through validation, a Reset, a second browser tab's edit — would never appear here after a
 * `refresh()`, only after a full page reload. This is deliberately not a controlled input either:
 * that would fight the user while they're mid-edit, before their `onBlur` has even fired.
 */
function RetentionField({
  label, ariaLabel, value, source, onSave, onReset,
}: {
  label: string
  ariaLabel: string
  value: number
  source: RetentionSource
  onSave: (value: number) => void
  onReset: () => void
}) {
  return (
    <label>
      {label}{' '}
      <input
        type="number" min={0} max={3650}
        aria-label={ariaLabel}
        key={`${value}-${source}`}
        defaultValue={value}
        onBlur={(e) => {
          const next = Number(e.target.value)
          if (Number.isInteger(next) && next !== value) onSave(next)
        }}
      />
      <span style={{ color: 'var(--ink-soft)' }}> ({SOURCE_LABEL[source]})</span>
      {source === 'setting' && (
        <button type="button" onClick={onReset} aria-label={`Reset ${ariaLabel} to inherit`}>Reset</button>
      )}
    </label>
  )
}

/**
 * Storage & retention — sizes the two disk pools (the sqlite file,
 * on-disk image bytes) and the five row pools inside the DB, and lets an operator edit the two
 * retention windows that are stored in the hub. Both inputs save independently on blur, matching
 * Devices.tsx's per-tab-label idiom (one field, one PATCH, no page-wide "Save" button) — there is
 * no shared form state here that a single submit could get out of sync with the server.
 */
export default function Storage() {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [error, setError] = useState('')
  const [sweeping, setSweeping] = useState(false)
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null)

  const refresh = () =>
    api<StorageStats>('/admin/api/storage').then(setStats).catch((err) => setError((err as Error).message))
  useEffect(() => { refresh() }, [])

  /** `value: null` resets the key to inherit (env/default) — the same PATCH body shape the API accepts. */
  const patchRetention = async (field: 'alerts_days' | 'audit_days', value: number | null) => {
    try {
      await api('/admin/api/retention', { method: 'PATCH', body: JSON.stringify({ [field]: value }) })
      setError('')
      refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const sweepNow = async () => {
    setSweeping(true)
    setError('')
    try {
      const result = await api<SweepResult>('/admin/api/retention/sweep', { method: 'POST' })
      setSweepResult(result)
      refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSweeping(false)
    }
  }

  if (!stats) return <p>Loading…</p>

  return (
    <section>
      <p>
        Database <strong>{mb(stats.db_bytes)} MB</strong> · Images <strong>{mb(stats.images_bytes)} MB</strong>
      </p>
      <table cellPadding={6}>
        <thead><tr><th>Pool</th><th>Rows</th><th>Size</th></tr></thead>
        <tbody>
          {stats.pools.map((p) => (
            <tr key={p.id}>
              <td>{p.label}</td>
              <td>{p.rows}</td>
              <td>{mb(p.bytes)} MB{p.approx ? ' ≈' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Retention</h3>
      <p>
        Days a concluded alert (and its deliveries) or an audit log row survives before the hourly
        sweep prunes it. 0 means keep forever. Changing these requires a human session — an agent
        token can read this page but not edit or force a sweep.
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <RetentionField
          label="Concluded alerts (days)" ariaLabel="Concluded alerts retention in days"
          value={stats.retention.alerts_days} source={stats.retention.source.alerts_days}
          onSave={(v) => patchRetention('alerts_days', v)}
          onReset={() => patchRetention('alerts_days', null)}
        />
        <RetentionField
          label="Audit log (days)" ariaLabel="Audit log retention in days"
          value={stats.retention.audit_days} source={stats.retention.source.audit_days}
          onSave={(v) => patchRetention('audit_days', v)}
          onReset={() => patchRetention('audit_days', null)}
        />
      </div>

      <p>
        <button type="button" onClick={sweepNow} disabled={sweeping}>Sweep now</button>
        {sweepResult && (
          <span> Removed {sweepResult.alerts} alert(s), {sweepResult.audit} audit row(s).</span>
        )}
      </p>
      <p>
        {stats.last_sweep
          ? `Last sweep: ${new Date(stats.last_sweep.ts).toLocaleString()} — removed ${stats.last_sweep.alerts} alert(s), ${stats.last_sweep.audit} audit row(s).`
          : 'No retention sweep has run yet.'}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
