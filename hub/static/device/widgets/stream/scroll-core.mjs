/**
 * The pure state machine behind `stream/scroll.mjs` — every scroll/badge decision, none of the
 * painting and none of the DOM. Split out the way `device-core.mjs` splits tab logic out of
 * device.js, and for the same reason: this is the part that has invariants worth pinning in a
 * test (follow lock, unseen counting, anchor arithmetic), and a test should not need a canvas
 * to reach them.
 *
 * The model, in the design's own words:
 *   - Rows are NEWEST FIRST, the wire order `ctx.rows` has always carried. `offset` is how many
 *     CSS pixels the column is scrolled DOWN the queue: 0 means pinned to the newest row.
 *   - `offset === 0` IS follow mode — "lock on the latest" is not a separate flag that can drift
 *     from the position it describes. At 0, every arriving row is considered seen and the column
 *     stays pinned; anywhere else, arriving rows accumulate as `unseen` and light the up arrow.
 *   - While scrolled away, new rows arriving at the top would visually shove the rows being read
 *     down the viewport. `reconcile` counters that by growing `offset` by exactly the height of
 *     what arrived — the reader's rows hold still, which is the whole point of having scrolled.
 *
 * `reconcile` runs on EVERY draw (a full render happens on every DATA push and alert change), so
 * everything here is idempotent: `unseen` is recomputed from `newestSeenAt` each time, never
 * incremented, and the anchor adjustment keys off `lastNewestAt` — the newest timestamp this
 * state has ever reconciled against — so the same rows reconciled twice move nothing twice.
 *
 * State persisted between draws (the design keeps it in a module Map keyed by feed id):
 *   `offset`        px scrolled down the queue, clamped to [0, maxScroll]
 *   `newestSeenAt`  newest `pushed_at` the viewer is considered to have seen
 *   `lastNewestAt`  newest `pushed_at` ever reconciled — the anchor baseline
 * Everything else on the returned object (`unseen`, `max`, `follow`) is derived per draw.
 *
 * Timestamps go through `at()` (non-finite → 0) because board payloads are attacker-adjacent by
 * house rule and a malformed `pushed_at` must degrade to "old", never to NaN arithmetic.
 */

const at = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : 0)
const clamp = (v, max) => Math.min(Math.max(0, v), max)

/**
 * Idle time before a scrolled-away column snaps back to follow mode. The anchor exists for a
 * reader; on a WALL, without this timeout, an accidental nudge (a settings swipe leaking through
 * the WebView, a cleaning wipe) would become a permanent ratchet: every arrival would grow the
 * offset and keep the newest row behind the badge. Sixty seconds without interaction means nobody
 * is reading; a wall display's job is to be live.
 */
export const REFOLLOW_MS = 60_000

/** Content height beyond the viewport, in px — 0 means the column fits and cannot scroll. */
export function maxScroll(rowCount, cardH, viewH) {
  return Math.max(0, rowCount * cardH - viewH)
}

export function freshState(newestAt = null) {
  // `newestSeenAt` starts at the newest row already there: history present before this feed was
  // ever drawn is not "new" — the badge announces arrivals, it does not scold about the backlog.
  // `awayAt` is when reconcile first OBSERVED the column scrolled away (the idle clock);
  // `reconciledOffset` is the offset reconcile last returned, so the next call can tell a
  // pointer interaction (offset changed between reconciles) from its own anchor growth.
  return { offset: 0, newestSeenAt: newestAt, lastNewestAt: newestAt, awayAt: null, reconciledOffset: 0 }
}

/**
 * Fold this draw's rows into the state. `pushedAts` is the newest-first `pushed_at` list off
 * `ctx.rows`; `null` (no prior state) starts fresh. Returns the full view (state + derived).
 *
 * `now` (the design's ctx clock) arms the idle auto-refollow; a clockless caller keeps the
 * anchor forever, exactly the pre-refollow behavior.
 */
export function reconcile(state, pushedAts, cardH, viewH, now = null) {
  const times = pushedAts.map(at)
  const newest = times.length > 0 ? times[0] : null
  const prev = state ?? freshState(newest)
  const known = prev.lastNewestAt
  const added = known === null ? 0 : times.filter((t) => t > known).length
  const max = maxScroll(times.length, cardH, viewH)
  // A pointer function moved the column since the last reconcile — someone is reading. Detected
  // by comparison, not by threading a clock through the pointer contract.
  const interacted = prev.offset !== (prev.reconciledOffset ?? prev.offset)
  let offset = prev.offset
  // The anchor: only while actually scrolled away — at 0 the column is following, and growing
  // the offset there would silently unpin it on every arrival.
  if (offset > 0 && added > 0) offset += added * cardH
  offset = clamp(offset, max)
  // The idle auto-refollow (REFOLLOW_MS above). Interaction restarts the clock; the anchor's own
  // growth does not count as interaction, or a busy feed would keep a dead scroll alive forever.
  let awayAt = prev.awayAt ?? null
  if (offset === 0) {
    awayAt = null
  } else if (now !== null) {
    if (interacted || awayAt === null) awayAt = now
    else if (now - awayAt >= REFOLLOW_MS) {
      offset = 0
      awayAt = null
    }
  }
  const lastNewestAt = newest === null ? known : known === null ? newest : Math.max(known, newest)
  const follow = offset === 0
  const newestSeenAt = follow ? lastNewestAt : prev.newestSeenAt
  const unseen = newestSeenAt === null ? 0 : times.filter((t) => t > newestSeenAt).length
  return { offset, newestSeenAt, lastNewestAt, unseen, max, follow, awayAt, reconciledOffset: offset }
}

/**
 * A finger (or wheel) move of `dy` CSS px, content following the finger: dragging DOWN (dy > 0)
 * moves toward the newest row, dragging UP reveals older rows below. Landing on exactly 0
 * re-enters follow mode by construction — the next reconcile clears the badge.
 */
export function dragBy(state, dy, rowCount, cardH, viewH) {
  return { ...state, offset: clamp(state.offset - dy, maxScroll(rowCount, cardH, viewH)) }
}

/** The up arrow's jump: pin to the newest row and consider everything seen, immediately. */
export function jumpTop(state) {
  return { ...state, offset: 0, newestSeenAt: state.lastNewestAt }
}

/** The down arrow's jump: pin to the oldest row still on the wire. */
export function jumpBottom(state, rowCount, cardH, viewH) {
  return { ...state, offset: maxScroll(rowCount, cardH, viewH) }
}

/**
 * The arrow rail's geometry, computed here so the pointer hit test and the painter cannot
 * disagree about where an arrow is. `RAIL_W` is reserved off the card text width whenever the
 * rail shows — an arrow overlapping the words it navigates would be worse than narrower cards.
 *
 * The up arrow exists whenever there is anywhere to go up to or anything new to announce; the
 * down arrow only when the column overflows. (`unseen > 0` implies scrolled — and therefore
 * scrollable — so the OR never actually widens the condition; it stays because it states the
 * arrow's PURPOSE, and a future state where the implication breaks should show the arrow.)
 */
export const RAIL_W = 44
const ARROW_R = 16
const HIT_SLOP = 8

export function arrowLayout(w, h, scrollable, unseen) {
  const cx = w - RAIL_W / 2
  const up = scrollable || unseen > 0 ? { cx, cy: 26, r: ARROW_R } : null
  const down = scrollable ? { cx, cy: Math.max(26, h - 26), r: ARROW_R } : null
  return { up, down }
}

/** Which arrow a cell-relative tap at (x, y) hit, with finger-sized slop. `null` for neither. */
export function hitArrow(layout, x, y) {
  const hits = (a) => a && Math.hypot(x - a.cx, y - a.cy) <= a.r + HIT_SLOP
  if (hits(layout?.up)) return 'up'
  if (hits(layout?.down)) return 'down'
  return null
}
