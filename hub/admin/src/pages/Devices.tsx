import { Fragment, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { IconEdit, IconPlus, IconReload, IconScreens, IconTrash } from '../icons'

type Orientation = 'landscape' | 'portrait'
type NavBarsMode = 'hidden' | 'respected' | 'on_tap'

/**
 * What this device does with its system bars (hub v17). A property of the GLASS: the same
 * board is correct on a wall panel with no bars and on a handheld that still needs its back
 * gesture, so it is set here rather than on the layout.
 */
const NAV_BARS: { value: NavBarsMode; label: string }[] = [
  { value: 'respected', label: 'bars shown' },
  { value: 'hidden', label: 'full screen' },
  { value: 'on_tap', label: 'bars on tap' },
]
/** One row of an ordered tab list. `name` is the screen's own name, joined server-side. */
interface DeviceTab { screen_id: string; position: number; label: string | null; name: string }

interface Device {
  id: string; name: string; online: boolean; battery: number | null; last_seen_at: number | null
  /** Derived compat field (tab 0, or null with no tabs) — `tabs` is the editable truth now. */
  screen_id: string | null
  tabs: DeviceTab[]
  nav_bars: NavBarsMode
  /** What the device last reported it draws into, in CSS px (schema v8). Null until it connects. */
  viewport_w: number | null; viewport_h: number | null; viewport_dpr: number | null
  rendering: {
    state: 'ok' | 'pending' | 'warning'
    acked_screen_id: string | null
    /** Last TAB receipt — which tab the device is actually showing right now. Client-local, so
     *  only meaningful while the device is online (see TabsEditor's `▶`). */
    active_screen_id: string | null
  } | null
}
interface ScreenRow { id: string; name: string; orientation: Orientation }


/**
 * The box a layout actually gets, which is not the panel's spec sheet: an A05 is a 720x1600 panel
 * that reports 853x384 CSS px in landscape at dpr 1.875. The editor designs against this number,
 * so the operator should be able to read it without opening the editor.
 */
const size = (d: Device) =>
  d.viewport_w && d.viewport_h
    ? `${d.viewport_w}×${d.viewport_h}${d.viewport_dpr ? ` @${d.viewport_dpr}x` : ''}`
    : '—'

/**
 * The Screen COLUMN is read-only now: the live tab list with the ▶ "now showing" marker,
 * compact enough that an eleven-tab wall panel doesn't stretch its row eleven lines tall.
 * Editing — order, labels, add/remove — lives in [TabsDialog], behind the row's Screens… button:
 * a table cell was never a good home for four kinds of button per tab.
 */
function TabsSummary({ device }: { device: Device }) {
  // `active_screen_id` is the last TAB receipt the socket saw — only trustworthy while the device
  // is actually connected, or it would point at wherever the device happened to be before it went
  // dark.
  const activeId = device.online ? (device.rendering?.active_screen_id ?? null) : null
  if (device.tabs.length === 0) return <span style={{ color: 'var(--ink-soft)' }}>Default layout</span>
  return (
    // One line per tab — a dot-joined single line put an eleven-tab device several screens wide.
    // The 14px indent keeps names column-aligned whether or not they carry the ▶ marker.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {device.tabs.map((t) => (
        <span key={t.screen_id} style={{ whiteSpace: 'nowrap', paddingLeft: activeId === t.screen_id ? 0 : 14 }}>
          {activeId === t.screen_id && <span aria-label={`${t.name} is active on ${device.name}`}>▶ </span>}
          {t.label ?? t.name}
        </span>
      ))}
    </div>
  )
}

/**
 * The device's ordered tab list, replacing the single screen `<select>`. A single-tab
 * device renders exactly one row through this same editor — there is no separate "one screen"
 * mode, because the PATCH contract itself has none: `tabs` is always a replace-all array, whether
 * it holds zero, one, or sixteen rows.
 *
 * Every button here sends the *whole* array back (add/move/remove/relabel all build the next
 * `tabs` list client-side, then PATCH it), matching the page's existing one-field-per-request
 * idiom (e.g. the system-bars `<select>` below) scaled up to a list.
 *
 * A modal rather than an inline cell since the Screens… button landed: each tab carries a name,
 * a label input, two order buttons and a remove — a grid with labelled columns is the smallest
 * layout where those read as one row each, and the page's table row stays scannable.
 */
function TabsDialog({ device, screens, refresh, onClose }: {
  device: Device; screens: ScreenRow[]; refresh: () => void; onClose: () => void
}) {
  const tabs = device.tabs
  // `active_screen_id` is the last TAB receipt the socket saw — only trustworthy while the device
  // is actually connected, or it would point at wherever the device happened to be before it went
  // dark.
  const activeId = device.online ? (device.rendering?.active_screen_id ?? null) : null

  const commit = async (next: { screen_id: string; label: string | null }[]) => {
    try {
      await api(`/admin/api/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify({ tabs: next }) })
    } catch (err) {
      // Orientation mismatch, unknown screen, duplicate — surfaced, not swallowed, same as the
      // screen-assignment select's own error handling.
      alert((err as Error).message)
    } finally {
      refresh()
    }
  }
  const asPayload = (rows: DeviceTab[]) => rows.map((t) => ({ screen_id: t.screen_id, label: t.label }))

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= tabs.length) return
    const next = [...tabs]
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(asPayload(next))
  }
  const remove = (i: number) => commit(asPayload(tabs.filter((_, idx) => idx !== i)))
  const relabel = (i: number, label: string) => {
    const trimmed = label.trim()
    commit(asPayload(tabs.map((t, idx) => (idx === i ? { ...t, label: trimmed === '' ? null : trimmed } : t))))
  }
  const add = (screenId: string) => {
    if (!screenId) return
    const screen = screens.find((s) => s.id === screenId)
    commit(asPayload([...tabs, { screen_id: screenId, position: tabs.length, label: null, name: screen?.name ?? screenId }]))
  }

  const available = screens.filter((s) => !tabs.some((t) => t.screen_id === s.id))

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Screens on ${device.name}`}
        style={{ minWidth: 460 }}>
        <h2>Screens on {device.name}</h2>
        <p>Tabs in the order the panel shows them. ▶ marks what the glass is showing right now.</p>
        {tabs.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>No screens yet — this device shows the default layout. Build one in the Screens tab, then add it here.</p>}
        {tabs.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: '18px 1fr 1fr auto auto auto',
            gap: '6px 8px', alignItems: 'center', marginBottom: 14,
          }}>
            <span />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>Screen</span>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>Tab label (optional)</span>
            <span style={{ color: 'var(--muted)', fontSize: 12, gridColumn: 'span 2' }}>Order</span>
            <span />
            {tabs.map((t, i) => (
              <Fragment key={t.screen_id}>
                <span>{activeId === t.screen_id ? <span aria-label={`${t.name} is active on ${device.name}`}>▶</span> : null}</span>
                <span>{t.name}</span>
                <input
                  aria-label={`Label for ${t.name} on ${device.name}`}
                  defaultValue={t.label ?? ''}
                  placeholder={t.name}
                  maxLength={40}
                  onBlur={(e) => {
                    const value = e.target.value
                    if ((t.label ?? '') !== value.trim()) relabel(i, value)
                  }}
                />
                <button type="button" aria-label={`Move ${t.name} up on ${device.name}`} disabled={i === 0}
                  onClick={() => move(i, -1)}>↑</button>
                <button type="button" aria-label={`Move ${t.name} down on ${device.name}`} disabled={i === tabs.length - 1}
                  onClick={() => move(i, 1)}>↓</button>
                <button type="button" aria-label={`Remove ${t.name} from ${device.name}`} onClick={() => remove(i)}>✕</button>
              </Fragment>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {tabs.length < 16 && available.length > 0 && (
            <select aria-label={`Add screen to ${device.name}`} value="" onChange={(e) => add(e.target.value)}>
              <option value="">Add screen…</option>
              {available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{tabs.length} of 16 tabs</span>
        </div>
        <div className="modal-actions" style={{ marginTop: 18 }}>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

export default function Devices({ publicUrl }: { publicUrl: string }) {
  const [devices, setDevices] = useState<Device[]>([])
  const [screens, setScreens] = useState<ScreenRow[]>([])
  const [name, setName] = useState('')
  const [pairing, setPairing] = useState<{ code: string; qr: string } | null>(null)
  // The device whose tabs dialog is open, by id rather than by object: the 5 s refresh replaces
  // the `devices` array, and holding the id means the open dialog re-renders against the FRESH
  // row — so its ▶ marker stays live and a tab edit made elsewhere shows up, instead of the
  // dialog pinning a snapshot from whenever it was opened.
  const [tabsFor, setTabsFor] = useState<string | null>(null)
  const [ask, confirmDialog] = useConfirm()

  const refresh = () => {
    api<Device[]>('/admin/api/devices').then(setDevices).catch(() => {})
    api<ScreenRow[]>('/admin/api/screens').then(setScreens).catch(() => {})
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [])

  return (
    <section>
      <form className="add-form" onSubmit={async (e) => {
        e.preventDefault()
        const { code } = await api<{ code: string }>('/admin/api/devices/pairing-codes', {
          method: 'POST', body: JSON.stringify({ name }),
        })
        const qr = await QRCode.toDataURL(JSON.stringify({ hub: publicUrl, code }))
        setPairing({ code, qr }); setName(''); refresh()
      }}>
        <input placeholder="New device name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit"><IconPlus />Add device</button>
      </form>
      {pairing && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 12, margin: '12px 0' }}>
          <p>Scan with the app, or enter code <strong>{pairing.code}</strong> at {publicUrl}/device — valid 10 minutes.</p>
          <img src={pairing.qr} alt={`Pairing QR ${pairing.code}`} width={180} />
          <button onClick={() => setPairing(null)}>Done</button>
        </div>
      )}
      <table cellPadding={6}>
        <thead><tr><th>Name</th><th>Status</th><th>Battery</th><th>Size</th><th>Screen</th><th>System bars</th><th>Rendering</th><th></th></tr></thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{d.online ? '🟢 online' : '⚪ offline'}</td>
              <td>{d.battery === null ? '—' : `${d.battery}%`}</td>
              <td>{size(d)}</td>
              <td>
                <TabsSummary device={d} />
              </td>
              <td>
                <select aria-label={`System bars for ${d.name}`} value={d.nav_bars ?? 'respected'}
                  onChange={async (e) => {
                    try { await api(`/admin/api/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ nav_bars: e.target.value }) }) }
                    finally { refresh() }
                  }}>
                  {NAV_BARS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
                </select>
              </td>
              <td>{d.rendering === null ? '—' : d.rendering.state === 'ok' ? '✓' : d.rendering.state === 'pending' ? '…' : '⚠'}</td>
              <td>
                <div className="row-actions">
                  <button aria-label={`Screens for ${d.name}`} onClick={() => setTabsFor(d.id)}>
                    <IconScreens />Screens
                  </button>
                  <button onClick={async () => {
                    const newName = prompt('Rename device', d.name)
                    if (newName) { await api(`/admin/api/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) }); refresh() }
                  }}><IconEdit />Rename</button>
                  {/* Remote page reload (RELOAD frame) — the unstick for a board holding stale JS.
                      Online only: the route 409s an offline device, and an offline board loads
                      fresh code on its next connect anyway. */}
                  <button aria-label={`Reload page on ${d.name}`} disabled={!d.online}
                    onClick={async () => {
                      try { await api(`/admin/api/devices/${d.id}/reload`, { method: 'POST' }) }
                      finally { refresh() }
                    }}><IconReload />Reload page</button>
                  <button onClick={() => ask(
                    { title: `Revoke ${d.name}?`, body: 'Its token stops working immediately and the panel drops back to the pairing screen.', confirmLabel: 'Revoke' },
                    async () => { await api(`/admin/api/devices/${d.id}`, { method: 'DELETE' }); refresh() },
                  )}><IconTrash />Revoke</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(() => {
        // Resolved per render from the live list: a revoke (or any refresh that drops the
        // device) closes the dialog by construction instead of editing a ghost.
        const open = tabsFor === null ? undefined : devices.find((d) => d.id === tabsFor)
        return open
          ? <TabsDialog device={open} screens={screens} refresh={refresh} onClose={() => setTabsFor(null)} />
          : null
      })()}
      {confirmDialog}
    </section>
  )
}
