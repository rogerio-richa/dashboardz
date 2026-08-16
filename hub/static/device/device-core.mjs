const RANK = { critical: 0, warn: 1, info: 2 }

export function reduce(alerts, msg) {
  if (msg.type === 'STATE') return [...msg.alerts]
  if (msg.type === 'ALERT_ADD') return [...alerts.filter((a) => a.id !== msg.alert.id), msg.alert]
  if (msg.type === 'ALERT_REMOVE') return alerts.filter((a) => a.id !== msg.id)
  return alerts
}

export function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.updated_at - a.updated_at)
}

export function viewModel(alerts, capacity, silenced) {
  const sorted = sortAlerts(alerts)
  const criticals = sorted.filter((a) => a.severity === 'critical')
  const unsilenced = criticals.filter((a) => !silenced.has(a.id)).sort((a, b) => b.updated_at - a.updated_at)
  return {
    takeover: unsilenced[0] ?? null,
    extraCriticalCount: Math.max(criticals.length - 1, 0),
    cards: sorted.slice(0, capacity),
    chips: sorted.slice(capacity),
  }
}

/**
 * Whether the page should yield its takeover overlay and alarm when a native host owns that
 * surface. On the panel BOTH the shell's native TakeoverScreen and this page's
 * `#takeover` could be showing at once, and each sounds its own alarm (page WebAudio + native
 * ToneGenerator double-beeping) — the native side is the reliability surface (wake, ToneGenerator,
 * hardware-key silence), so once it is genuinely in charge the web copy must go dark.
 *
 * Both conditions are required, not just `driven`: an OLD shell hosts the page (driven === true)
 * but has no ownsTakeover() at all, and that shell's WebView is exactly the "browser device with
 * no native takeover" case the web fallback exists for. Only a shell that explicitly claims
 * ownership may switch it off.
 */
export function yieldTakeoverToHost(driven, hostOwns) {
  return !!driven && !!hostOwns
}

export function tabsFromState(msg) {
  return msg.screens ?? (msg.screen ? [msg.screen] : [])
}

export function resolveActiveTab(tabIds, storedId) {
  if (storedId && tabIds.includes(storedId)) return storedId
  return tabIds[0] ?? null
}

export function tabBarModel(tabs, tabStatus, activeId, unseenIds = new Set()) {
  return {
    visible: tabs.length > 1,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      text: tab.label ?? tab.name,
      active: tab.id === activeId,
      dot: tabStatus[tab.id] ?? null,
      // Unseen stream activity on a BACKGROUND tab pulses its dot; the active tab never blinks —
      // you are already looking at it, and switchTab clears its id from the set anyway.
      blink: tab.id !== activeId && unseenIds.has(tab.id),
    })),
  }
}

/**
 * Everything about the strip that the DOM depends on, as one string.
 *
 * `renderTabBar` runs on every render — every data push included — and rebuilding its innerHTML
 * throws away the scroll position. On a board with a 5s feed that was a teardown twelve times a
 * minute, each one snapping the strip back to the start and then being dragged back by the
 * auto-scroll: an unreadable, permanently-moving bar. Comparing this against the last one is how
 * the renderer knows it has nothing to do.
 *
 * Deliberately covers exactly what the markup reads — ids, text, active, dot, blink — so a change
 * that would alter a pixel changes the signature, and a re-render that would not, does not.
 */
export function tabBarSignature(model) {
  if (!model?.visible) return 'hidden'
  return model.tabs.map((t) => [t.id, t.text, t.active ? 1 : 0, t.dot ?? '', t.blink ? 1 : 0].join('\u0001')).join('\u0002')
}

/**
 * Scrolling the tab strip, as arithmetic.
 *
 * A device keeps as many tabs as its owner keeps adding screens, and the strip is one flex row.
 * Past the point where the row is wider than the bar the remainder was simply CLIPPED — no
 * affordance, no hint: a tab could be the ACTIVE one and still be invisible in its own strip.
 * These three functions are what the arrow controls in device.js decide with. They take sizes the
 * DOM already measured and return numbers; nothing here touches an element, which is what lets the
 * paging rules be pinned in a test with no browser (`tabs-core.test.ts`).
 *
 * One axis, not two: a bottom bar scrolls in x and a side bar in y, but the arithmetic is
 * identical, so the caller passes whichever pair of sizes its axis has.
 */

/** Sub-pixel slack. Layout sizes are fractional; an arrow live for 0.4px is a control that does nothing. */
const SCROLL_EPSILON = 1

export function tabScrollState({ scrollSize, viewport, offset }) {
  const max = Math.max(0, (scrollSize || 0) - (viewport || 0))
  const at = Math.min(Math.max(offset || 0, 0), max)
  return {
    overflowing: max > SCROLL_EPSILON,
    atStart: at <= SCROLL_EPSILON,
    atEnd: at >= max - SCROLL_EPSILON,
  }
}

/**
 * One arrow tap. 80% of a viewport rather than a full one: a tab straddling the edge is the whole
 * reason the arrow was tapped, and a full-viewport page would carry it straight past the far side.
 */
export function pageOffset(offset, viewport, direction, scrollSize) {
  const max = Math.max(0, (scrollSize || 0) - (viewport || 0))
  const step = (viewport || 0) * 0.8 * (direction < 0 ? -1 : 1)
  return Math.min(Math.max((offset || 0) + step, 0), max)
}

/**
 * The offset that brings one tab fully into view — used when a switch lands on a tab that is off
 * the edge, and on first render, where the restored active tab may sit anywhere in a long strip.
 * Scrolls the MINIMUM distance: a tab just off the far edge comes to the edge and no further, so
 * the strip keeps as much of its surrounding context as it can.
 */
export function offsetToShow({ itemStart, itemSize, offset, viewport, scrollSize }) {
  const max = Math.max(0, (scrollSize || 0) - (viewport || 0))
  const at = Math.min(Math.max(offset || 0, 0), max)
  if (max <= SCROLL_EPSILON) return 0
  const start = itemStart || 0
  const end = start + (itemSize || 0)
  if (start < at) return Math.min(Math.max(start, 0), max)
  if (end > at + viewport) return Math.min(Math.max(end - viewport, 0), max)
  return at
}

/**
 * Which BACKGROUND tabs just received stream rows: tabs (≠ active) carrying a stream_list/table
 * cell whose `feed` is among the pushed ids. Powers the tab-dot blink — deliberately broader than
 * the activity tick's `chime_activity` opt-in: a blink is silent, so every readable stream earns
 * one, while sound stays opt-in. Malformed cells/configs read as no-match, never throw.
 */
export function tabsWithStreamRows(tabs, pushedIds, activeId) {
  const out = []
  for (const tab of tabs) {
    if (!tab || tab.id === activeId) continue
    const cells = Array.isArray(tab.grid?.cells) ? tab.grid.cells : []
    const hit = cells.some((c) => c
      && (c.widget === 'stream_list' || c.widget === 'table')
      && typeof c.config?.feed === 'string' && pushedIds.includes(c.config.feed))
    if (hit) out.push(tab.id)
  }
  return out
}
