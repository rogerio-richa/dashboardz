import type { DB } from '../db/index.js'
import type { DeviceRegistry } from './registry.js'
import type { Severity } from '../db/alerts.js'
import { getScreen, listScreens, referencedFeedIds } from '../db/screens.js'
import { listDevices, listDeviceTabs } from '../db/devices.js'

const RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 }

/**
 * Feed id -> every sender whose alerts are attributable to it: the one it has been pushed by, plus
 * everyone it allows. This is the whole of the dot's attribution rule, defined once.
 *
 * Once, because two questions are asked of it from opposite directions — `computeTabStatus` asks
 * "what colour is this tab", `screensLitBySender` asks "which tabs is this alert colouring" — and
 * an operator reading the second to explain the first is only helped if they cannot disagree. A
 * hand-rolled second walk of `feeds` is exactly how they would.
 */
function feedSenderIndex(db: DB): Map<string, Set<string>> {
  const feeds = db.prepare('SELECT id, pushed_by, allowed_senders FROM feeds')
    .all() as { id: string; pushed_by: string | null; allowed_senders: string | null }[]
  const index = new Map<string, Set<string>>()
  for (const f of feeds) {
    const senders = new Set<string>()
    if (f.pushed_by) senders.add(f.pushed_by)
    if (f.allowed_senders) {
      try { for (const s of JSON.parse(f.allowed_senders) as string[]) senders.add(s) } catch { /* bad data never crashes a read */ }
    }
    index.set(f.id, senders)
  }
  return index
}

/**
 * Every screen this sender's alerts light up, in screen creation order.
 *
 * A screen only shows as a coloured TAB dot on devices that carry it in their tab strip; this
 * answers the attribution question, not the assignment one. That is the right half for an operator
 * asking "what is this alert touching" — a screen nobody has on a tab is still the screen this
 * alert would colour.
 */
export function screensLitBySender(db: DB, senderId: string): { id: string; name: string }[] {
  const index = feedSenderIndex(db)
  const out: { id: string; name: string }[] = []
  for (const screen of listScreens(db)) {
    let refs: string[]
    try { refs = referencedFeedIds(JSON.parse(screen.grid)) } catch { continue }
    if (refs.some((fid) => index.get(fid)?.has(senderId))) out.push({ id: screen.id, name: screen.name })
  }
  return out
}

// TabDot ('ok' | severity) is defined with the rest of the wire contract in protocol.ts.
export type { TabDot } from './protocol.js'
import type { TabDot } from './protocol.js'

/** Worst active-alert severity per screen — or 'ok' when monitored and quiet (derived attribution). */
export function computeTabStatus(db: DB, screenIds: string[]): Record<string, TabDot> {
  const alerts = db.prepare("SELECT sender_id, severity FROM alerts WHERE status = 'active'")
    .all() as { sender_id: string; severity: Severity }[]
  const feedSenders = feedSenderIndex(db)
  const out: Record<string, TabDot> = {}
  for (const screenId of screenIds) {
    const screen = getScreen(db, screenId)
    if (!screen) continue
    let refs: string[]
    try { refs = referencedFeedIds(JSON.parse(screen.grid)) } catch { continue }
    let worst: Severity | null = null
    for (const alert of alerts) {
      if (!refs.some((fid) => feedSenders.get(fid)?.has(alert.sender_id))) continue
      if (worst === null || RANK[alert.severity] > RANK[worst]) worst = alert.severity
    }
    if (worst) {
      out[screenId] = worst
    } else if (refs.some((fid) => (feedSenders.get(fid)?.size ?? 0) > 0)) {
      // Monitored and quiet — a positive all-clear, not merely the absence of a dot. Old clients
      // that predate 'ok' render an unknown dot class invisibly, which degrades to the old look.
      out[screenId] = 'ok'
    }
  }
  return out
}

/** Re-derives and sends TAB_STATUS to every online multi-tab device. Never fatal (house rule). */
export function pushTabStatus(db: DB, registry: DeviceRegistry): void {
  try {
    for (const device of listDevices(db)) {
      if (!registry.isOnline(device.id)) continue
      const tabs = listDeviceTabs(db, device.id)
      if (tabs.length < 2) continue
      registry.send(device.id, {
        type: 'TAB_STATUS',
        tab_status: computeTabStatus(db, tabs.map((t) => t.screen_id)),
      })
    }
  } catch (err) { console.warn('tab-status push failed:', err) }
}
