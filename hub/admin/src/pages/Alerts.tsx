import { useEffect, useState } from 'react'
import { ago } from '../ago'
import { api } from '../api'
import { useConfirm } from '../confirm'

/**
 * What is still ringing, and the one lever that ends it.
 *
 * Built after an evening spent staring at a red tab dot with no way to ask what it meant. A
 * critical is deliberately given no expiry — it is an alarm, and an alarm ends when a person deals
 * with it — but a plain tap on the panel only SILENCES, so an alert can be quiet and still active,
 * still colouring its tab, indefinitely. Before this page the only exits were physically holding
 * the panel's Dismiss button or hand-crafting an API call with the raising sender's own token.
 *
 * So the page answers, in one row: what it says, who raised it, how long it has stood, where each
 * device left it, and which screens it is colouring. Then it offers the way out.
 */
type Severity = 'info' | 'warn' | 'critical'

interface AlertDevice {
  id: string; name: string; delivered: boolean; silenced: boolean; dismissed: boolean
}

interface ActiveAlert {
  id: string; title: string; body: string | null; severity: Severity
  sender: { id: string; name: string }
  created_at: number; updated_at: number; update_count: number
  expires_at: number | null; dedup_key: string | null
  devices: AlertDevice[]
  screens: { id: string; name: string }[]
}

/**
 * Where one device left this alert, in the words the panel's own gestures use. "silenced" is the
 * one that matters: it is the half-action — sound stopped, alert still standing — that strands an
 * alert, and naming it is most of what this page is for.
 */
const standing = (d: AlertDevice): string =>
  d.dismissed ? 'dismissed' : d.silenced ? 'silenced' : d.delivered ? 'showing' : 'not delivered'

export default function Alerts() {
  const [alerts, setAlerts] = useState<ActiveAlert[] | null>(null)
  const [error, setError] = useState('')
  const [ask, confirmDialog] = useConfirm()

  const refresh = () => api<ActiveAlert[]>('/admin/api/alerts/active').then(setAlerts).catch(() => {})
  // Same 5s cadence as Activity: an operator watching this page is usually watching it BECAUSE
  // something is ringing, and wants the row to disappear when the panel is dealt with too.
  useEffect(() => {
    refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t)
  }, [])

  const dismiss = (alert: ActiveAlert) => ask(
    {
      title: `Dismiss “${alert.title}”?`,
      body: 'The panels stop showing it and its tab dot clears. The alert stays in the history; '
        + 'whatever raised it can raise it again.',
      confirmLabel: 'Dismiss',
    },
    async () => {
      try {
        await api(`/admin/api/alerts/${alert.id}/dismiss`, { method: 'POST' })
        setError('')
        await refresh()
      } catch (err) { setError((err as Error).message) }
    },
  )

  // Nothing until the first response lands. The empty state here is a positive claim — "every tab
  // dot is clear" — and showing it while the request is still in flight would be a lie that reads
  // as reassurance, which is the one thing this page must never be wrong about.
  if (alerts === null) return <section />
  return (
    <section>
      {alerts.length === 0 ? (
        <p className="hint">No active alerts — every tab dot is clear.</p>
      ) : (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th>Severity</th><th>Alert</th><th>From</th><th>Standing</th>
              <th>Devices</th><th>Lighting</th><th></th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                {/* The word carries the colour — this console invents no badges (styles.css). */}
                <td data-status={a.severity}>{a.severity}</td>
                <td>
                  {a.title}
                  {a.body && <div className="hint">{a.body}</div>}
                </td>
                <td>{a.sender.name}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {ago(a.created_at)}
                  {a.update_count > 0 && <span className="hint"> · repeated {a.update_count}×</span>}
                </td>
                <td>
                  {a.devices.length === 0
                    // Stranded: every device it was aimed at is gone, so nothing on any panel can
                    // ever conclude it. This row is the only place it can end.
                    ? <span data-status="warn">no target device left</span>
                    : a.devices.map((d) => `${d.name} ${standing(d)}`).join(' · ')}
                </td>
                <td>{a.screens.map((s) => s.name).join(', ') || <span className="hint">no screen</span>}</td>
                <td><button onClick={() => dismiss(a)}>Dismiss</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p role="alert">{error}</p>}
      {confirmDialog}
    </section>
  )
}
