import { useEffect, useState, type ReactElement } from 'react'
import { api, setOnUnauthorized } from './api'
import Login from './pages/Login'
import Senders from './pages/Senders'
import Devices from './pages/Devices'
import Screens from './pages/Screens'
import Feeds from './pages/Feeds'
import Themes from './pages/Themes'
import Widgets from './pages/Widgets'
import Agents from './pages/Agents'
import { IconDevices, IconScreens, IconWidgets, IconFeeds, IconThemes, IconSenders, IconAgents, IconAlerts, IconActivity, IconStorage } from './icons'
import Activity from './pages/Activity'
import Alerts from './pages/Alerts'
import Storage from './pages/Storage'
import RelayBadge from './RelayBadge'

export interface AdminConfig { public_url: string; brand: string }
type Tab = 'Devices' | 'Alerts' | 'Screens' | 'Widgets' | 'Feeds' | 'Themes' | 'Senders' | 'Agents' | 'Activity' | 'Storage'

/**
 * Alerts sits second, next to Devices, because it is about the same thing they are: what the glass
 * in the house is doing right now. Everything after it is about what the glass will show later.
 */
const TABS: Tab[] = ['Devices', 'Alerts', 'Screens', 'Widgets', 'Feeds', 'Themes', 'Senders', 'Agents', 'Activity', 'Storage']

/**
 * An icon per tab, for shape recognition — you find a tab by its silhouette long before you read
 * it. Line art rather than emoji: this console reserves colour for themes and severity, and the
 * active tab is solid ink, which an emoji cannot invert against but `currentColor` follows.
 */
/**
 * What a tab is CALLED, where that differs from what it is. Only one does: "Feeds" is the schema's
 * word, and the schema's words were the whole complaint (schema wording) — a person wants the weather on their
 * kitchen screen, not a feed. The tab now lists persistent CONNECTIONS and keeps raw push feeds
 * behind a disclosure, which makes "Data sources" the accurate name as well as the friendlier one.
 *
 * The tab id, the route and the remembered-tab key all stay `Feeds`, so an admin left open on this
 * tab across the upgrade is still on it afterwards.
 */
const TAB_LABEL: Partial<Record<Tab, string>> = { Feeds: 'Data sources' }

const TAB_ICON: Record<Tab, () => ReactElement> = {
  Devices: IconDevices,
  Alerts: IconAlerts,
  Screens: IconScreens,
  Widgets: IconWidgets,
  Feeds: IconFeeds,
  Themes: IconThemes,
  Senders: IconSenders,
  Agents: IconAgents,
  Activity: IconActivity,
  Storage: IconStorage,
}

/**
 * The tab survives a reload.
 *
 * localStorage rather than a cookie: this is a UI preference the server has no use for, and a
 * cookie would ride along on every single request to say which tab a browser had open. Same
 * persistence, none of the traffic. Guarded because storage can be absent or throw (privacy mode,
 * a WebView with DOM storage off) and a console that will not load because it could not read a
 * preference would be a far worse bug than forgetting the tab.
 */
const TAB_KEY = 'dbz.admin.tab'
const rememberedTab = (): Tab => {
  try {
    const t = localStorage.getItem(TAB_KEY)
    return TABS.includes(t as Tab) ? (t as Tab) : 'Devices'
  } catch { return 'Devices' }
}

export default function App() {
  const [config, setConfig] = useState<AdminConfig | null>(null)
  const [authed, setAuthed] = useState(false)
  const [tab, setTab] = useState<Tab>(rememberedTab)

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab) } catch { /* preference only — never fatal */ }
  }, [tab])

  useEffect(() => {
    setOnUnauthorized(() => setAuthed(false))
    return () => setOnUnauthorized(null)
  }, [])

  useEffect(() => {
    api<AdminConfig>('/admin/api/config')
      .then((c) => { setConfig(c); setAuthed(true) })
      .catch(() => setAuthed(false))
  }, [authed])

  if (!authed) return <Login onLogin={() => setAuthed(true)} />
  return (
    <main>
      <header className="masthead">
        <h1>{config?.brand ?? ''} admin</h1>
        <RelayBadge />
      </header>
      <nav>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} disabled={t === tab}>
            {(() => { const Icon = TAB_ICON[t]; return <Icon /> })()}{TAB_LABEL[t] ?? t}
          </button>
        ))}
      </nav>
      {tab === 'Devices' && config && <Devices publicUrl={config.public_url} />}
      {tab === 'Alerts' && <Alerts />}
      {tab === 'Screens' && <Screens />}
      {tab === 'Widgets' && <Widgets />}
      {tab === 'Feeds' && <Feeds />}
      {tab === 'Themes' && <Themes />}
      {tab === 'Senders' && <Senders />}
      {tab === 'Agents' && config && <Agents publicUrl={config.public_url} />}
      {tab === 'Activity' && <Activity />}
      {tab === 'Storage' && <Storage />}
    </main>
  )
}
