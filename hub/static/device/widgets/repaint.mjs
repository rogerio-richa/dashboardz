/**
 * When, if ever, a board needs repainting on a timer.
 *
 * Animation is not this file's business — `loop.mjs` owns that and already idles to zero frames
 * when nothing moves. This is the other half: output that changes with the clock rather than with
 * data. A clock face moves every second; a relative time ("4m ago" on an alert card, "2h" on a
 * news item) moves once a minute at the fastest. Everything else — weather, gauges, tables, images
 * — is a pure function of data that arrives over the socket, and repainting it on a timer draws
 * the same pixels again.
 *
 * A board must not repaint every second unconditionally: rebuilding the whole grid's DOM costs
 * 30–45ms a pass on a panel that is on 24/7, even when nothing on it could have changed.
 */

/** Widget type -> how often its own output can change with no new data. Absent means never. */
export const REPAINT_MS = Object.freeze({
  clock: 1_000,
  alert_feed: 60_000,
  news_list: 60_000,
  // An agenda drops events as they finish and re-heads "TODAY" at midnight, both of which move on
  // their own with no new data.
  calendar_events: 60_000,
})

/**
 * The shortest repaint period this board actually needs, or `null` if it needs no timer at all.
 *
 * @param screenDef the assigned screen, or null/undefined for the default layout
 * @param alertCount how many alerts are showing, which is what the default layout renders
 */
export function boardRepaintPeriod(screenDef, alertCount = 0) {
  // No screen assigned: the default layout is alert cards, and their relative time is the only
  // thing on it that moves on its own. No alerts, nothing to move.
  if (!screenDef) return alertCount > 0 ? REPAINT_MS.alert_feed : null

  let shortest = null
  for (const { period } of timedCells(screenDef)) {
    if (shortest === null || period < shortest) shortest = period
  }
  return shortest
}

/** The cells whose own output moves with the clock, with the period each one moves on. */
function timedCells(screenDef) {
  const cells = Array.isArray(screenDef?.grid?.cells) ? screenDef.grid.cells : []
  const timed = []
  for (let index = 0; index < cells.length; index++) {
    const period = REPAINT_MS[cells[index]?.widget]
    if (typeof period === 'number') timed.push({ index, period })
  }
  return timed
}

/**
 * Which cells are due for a repaint right now — the per-cell answer to `boardRepaintPeriod`'s
 * per-board one.
 *
 * The board-level rule decides whether the tick happens at all; acting on it repaints everything,
 * because that is the only granularity it can express. A clock beside a five-day forecast makes the
 * board due every second, and the forecast is then redrawn 59 times a minute to produce identical
 * pixels — it is a pure function of data that arrives over the socket, and no amount of time passing
 * changes it.
 *
 * `lastPaintedAt` maps cell index to when that cell was last drawn. A cell with no entry is due:
 * nothing has painted it yet, which is the honest answer after a resize or a board swap.
 */
export function cellsDueForRepaint(screenDef, now, lastPaintedAt = {}) {
  const due = []
  for (const { index, period } of timedCells(screenDef)) {
    const painted = lastPaintedAt?.[index]
    if (typeof painted !== 'number' || now - painted >= period) due.push(index)
  }
  return due
}

/**
 * What one tick should do: nothing, repaint these cells, or render the whole board.
 *
 * Per-cell repainting only reaches cells that draw into a canvas, because repainting one is a
 * `paintWidgets` call and nothing else.
 *
 * Every widget type in `REPAINT_MS` now HAS a canvas design — `alert_feed` was the last holdout
 * and the reason this could fall back to a full board render on an ordinary tick (widget contract
 * screen state). The `'full'` branch below is therefore defensive rather than routine: it is
 * still reachable, but only when `hasCanvasDesign` is absent (device.js not passing it) or when a
 * due cell resolves to no design at all — an unknown widget type on a board built by a newer hub,
 * or a design id a theme names that this build does not ship. Both are real, and both want the
 * safe direction, so the branch stays.
 *
 * `hasCanvasDesign` is injected rather than imported: resolving a cell's design needs the live theme
 * (a theme can name a design per widget type), which is device.js's business and not this rule's.
 * Absent it, the answer is a full render — the safe direction, since drawing too much is a cost and
 * drawing too little is a bug.
 */
export function repaintPlan(screenDef, now, lastPaintedAt = {}, hasCanvasDesign) {
  const due = cellsDueForRepaint(screenDef, now, lastPaintedAt)
  if (due.length === 0) return { kind: 'none', cells: [] }
  const cells = Array.isArray(screenDef?.grid?.cells) ? screenDef.grid.cells : []
  const perCell = typeof hasCanvasDesign === 'function' && due.every((index) => hasCanvasDesign(cells[index], index))
  return { kind: perCell ? 'cells' : 'full', cells: due }
}
