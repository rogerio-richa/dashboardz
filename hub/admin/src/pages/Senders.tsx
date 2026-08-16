import { Fragment, useEffect, useState } from 'react'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { IconEdit, IconPlus, IconReload, IconSave, IconTrash } from '../icons'
import MultiSelect from '../MultiSelect'

interface Sender { id: string; name: string; default_devices: string; created_at: number; last_used_at: number | null }
interface Device { id: string; name: string }

/** The hub's own sender (stale-feed warnings and the like). The API refuses to edit or delete it. */
const HUB_SENDER = 'snd_hub'

const parseDevices = (json: string): string[] => {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}

/**
 * The one sender form, for creating and for editing: name and default devices, nothing else. The
 * token is never part of it; it is shown once at creation and replaced with Rotate token.
 */
function SenderForm({ initialName = '', initialDevices = [], devices, submitLabel, onSubmit, onCancel }: {
  initialName?: string
  initialDevices?: string[]
  devices: Device[]
  submitLabel: string
  onSubmit: (body: { name: string; default_devices: string[] }) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initialName)
  const [picked, setPicked] = useState<string[]>(initialDevices)
  const [error, setError] = useState('')
  return (
    <form className="sender-form" onSubmit={async (e) => {
      e.preventDefault(); setError('')
      try { await onSubmit({ name: name.trim(), default_devices: picked }) } catch (err) { setError((err as Error).message) }
    }}>
      <div className="field-row">
        <input placeholder={initialName ? undefined : 'New sender name'} aria-label="Sender name" value={name} onChange={(e) => setName(e.target.value)} required />
        <MultiSelect
          label="Default devices"
          emptyText="No default devices"
          noOptionsText="No devices paired yet."
          optionLabel={(o) => `Send to ${o.label}`}
          selected={picked}
          onChange={setPicked}
          options={[
            ...devices.map((d) => ({ value: d.id, label: d.name })),
            // A default pointing at a device that is gone: visible, so it can be unticked.
            ...picked.filter((id) => !devices.some((d) => d.id === id)).map((id) => ({ value: id, label: id, missing: true })),
          ]}
        />
        <button type="submit">{submitLabel === 'Create sender' ? <IconPlus /> : <IconSave />}{submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
      <p className="hint-inline" style={{ marginTop: 6 }}>
        Default devices are where this sender’s alerts go when a push doesn’t name any.
      </p>
      {error && <p role="alert" className="source-error">{error}</p>}
    </form>
  )
}

export default function Senders() {
  const [senders, setSenders] = useState<Sender[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [shownToken, setShownToken] = useState<{ name: string; token: string; rotated: boolean } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [error, setError] = useState('')
  const [ask, confirmDialog] = useConfirm()

  const refresh = () => api<Sender[]>('/admin/api/senders').then(setSenders).catch(() => {})
  useEffect(() => {
    refresh()
    api<Device[]>('/admin/api/devices').then(setDevices).catch(() => {})
  }, [])

  const deviceNames = (s: Sender) => {
    const ids = parseDevices(s.default_devices)
    if (ids.length === 0) return <span style={{ color: 'var(--muted)' }}>none</span>
    return ids.map((id, i) => {
      const d = devices.find((x) => x.id === id)
      return (
        <Fragment key={id}>
          {i > 0 && ', '}
          {d ? d.name : <span className="feed-rejected" title={id}>missing device</span>}
        </Fragment>
      )
    })
  }

  return (
    <section>
      <SenderForm
        key={formKey}
        devices={devices}
        submitLabel="Create sender"
        onSubmit={async (body) => {
          const res = await api<{ token: string }>('/admin/api/senders', { method: 'POST', body: JSON.stringify(body) })
          setShownToken({ name: body.name, token: res.token, rotated: false })
          setFormKey((k) => k + 1)
          refresh()
        }}
      />
      {shownToken && (
        <p style={{ border: '1px solid var(--line-strong)', padding: 12 }}>
          {shownToken.rotated ? `New token for ${shownToken.name}` : `Token for ${shownToken.name}`} (shown once,
          the hub keeps only a hash): <code>{shownToken.token}</code>{' '}
          <button type="button" onClick={() => setShownToken(null)}>Done</button>
        </p>
      )}
      <table cellPadding={6}>
        <thead><tr><th>Name</th><th>Default devices</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {senders.map((s) => (
            <Fragment key={s.id}>
              <tr>
                <td>{s.name}</td>
                <td>{deviceNames(s)}</td>
                <td>{s.last_used_at ? new Date(s.last_used_at).toLocaleString() : 'never'}</td>
                <td>
                  {s.id === HUB_SENDER
                    ? <span className="hint-inline">built in</span>
                    : (
                      <div className="row-actions">
                        <button type="button" onClick={() => setEditingId(editingId === s.id ? null : s.id)}><IconEdit />Edit</button>
                        <button type="button" onClick={() => ask(
                          {
                            title: `Rotate the token for ${s.name}?`,
                            body: 'A new token is shown once. The current one stops working immediately, so update whatever pushes with it.',
                            confirmLabel: 'Rotate',
                          },
                          async () => {
                            try {
                              const res = await api<{ token: string }>(`/admin/api/senders/${s.id}/rotate`, { method: 'POST' })
                              setShownToken({ name: s.name, token: res.token, rotated: true })
                            } catch (err) { setError((err as Error).message) }
                          },
                        )}><IconReload />Rotate token</button>
                        <button type="button" onClick={() => ask(
                          { title: `Delete ${s.name}?`, body: 'Its token stops working immediately, and anything pushing with it starts failing.' },
                          async () => {
                            try { await api(`/admin/api/senders/${s.id}`, { method: 'DELETE' }); refresh() }
                            catch (err) { setError((err as Error).message) }
                          },
                        )}><IconTrash />Delete</button>
                      </div>
                      )}
                </td>
              </tr>
              {editingId === s.id && (
                <tr>
                  <td colSpan={4}>
                    <div className="edit-card">
                      <SenderForm
                        devices={devices}
                        initialName={s.name}
                        initialDevices={parseDevices(s.default_devices)}
                        submitLabel="Save sender"
                        onCancel={() => setEditingId(null)}
                        onSubmit={async (body) => {
                          await api(`/admin/api/senders/${s.id}`, { method: 'PATCH', body: JSON.stringify(body) })
                          setEditingId(null)
                          refresh()
                        }}
                      />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {error && <p role="alert">{error}</p>}
      {confirmDialog}
    </section>
  )
}
