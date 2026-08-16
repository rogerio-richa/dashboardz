import { useEffect, useState } from 'react'
import { api } from '../api'

interface AuditRow { id: number; ts: number; actor_type: string; actor_id: string | null; event: string; details: string }

export default function Activity() {
  const [rows, setRows] = useState<AuditRow[]>([])
  useEffect(() => {
    const refresh = () => api<AuditRow[]>('/admin/api/audit').then(setRows).catch(() => {})
    refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t)
  }, [])
  return (
    <table cellPadding={6}>
      <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Details</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{new Date(r.ts).toLocaleString()}</td>
            <td>{r.actor_type}{r.actor_id ? `:${r.actor_id}` : ''}</td>
            <td>{r.event}</td>
            {/* Audit details are unbroken JSON — ids, arrays, caps blobs — which cannot wrap on
                its own, so one busy row was dragging the whole table past the viewport.
                `anywhere` lets the string break mid-token; the max width keeps even a wrapped
                monster from owning the page. */}
            <td style={{ maxWidth: 520 }}>
              <code style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{r.details}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
