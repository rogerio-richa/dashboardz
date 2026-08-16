import { useEffect, useState } from 'react'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { IconPlus, IconTrash } from '../icons'

interface Sender { id: string; name: string; last_used_at: number | null }

export default function Senders() {
  const [senders, setSenders] = useState<Sender[]>([])
  const [name, setName] = useState('')
  const [newToken, setNewToken] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [ask, confirmDialog] = useConfirm()

  const refresh = () => api<Sender[]>('/admin/api/senders').then(setSenders).catch(() => {})
  useEffect(() => { refresh() }, [])

  return (
    <section>
      <form className="add-form" onSubmit={async (e) => {
        e.preventDefault()
        const res = await api<{ token: string }>('/admin/api/senders', { method: 'POST', body: JSON.stringify({ name }) })
        setNewToken(res.token); setName(''); refresh()
      }}>
        <input placeholder="New sender name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit"><IconPlus />Create sender</button>
      </form>
      {newToken && (
        <p style={{ border: '1px solid #ccc', padding: 12 }}>
          Token (shown once): <code>{newToken}</code> <button onClick={() => setNewToken(null)}>Done</button>
        </p>
      )}
      <table cellPadding={6}>
        <thead><tr><th>Name</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {senders.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.last_used_at ? new Date(s.last_used_at).toLocaleString() : 'never'}</td>
              <td><button onClick={() => ask(
                { title: `Delete ${s.name}?`, body: 'Its token stops working immediately, and anything pushing with it starts failing.' },
                async () => {
                  try { await api(`/admin/api/senders/${s.id}`, { method: 'DELETE' }); refresh() }
                  catch (err) { setError((err as Error).message) }
                },
              )}><IconTrash />Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert">{error}</p>}
      {confirmDialog}
    </section>
  )
}
