/**
 * `stream_list` / `scroll` — the same titled cards as `list`, in a column the viewer can move
 * through instead of a fixed window with an overflow counter. Built for journal-style feeds
 * (the netdata boards) where "the last two lines" is not enough context and the operator wants
 * to read back through the queue.
 *
 * What it adds over `list`:
 *   - Drag (or mouse wheel) to scroll the column. Rows are newest-first, exactly the wire
 *     order; scrolling down the queue is scrolling back in time.
 *   - An arrow rail on the right edge: tap ▲ to jump to the newest row, ▼ to jump to the
 *     oldest. The rail reserves `RAIL_W` off the card text so arrows never sit on words.
 *   - Follow lock: at the top (`offset === 0`) the column is pinned to the newest row and every
 *     arriving row is considered seen. Scrolled anywhere else, arriving rows accumulate as a
 *     count on the ▲ arrow — the "something new is waiting above" signal — and the column holds
 *     still (the offset grows by exactly the height that arrived, so the rows being read do not
 *     get shoved down the screen). Tapping ▲, or dragging back to the top, re-enters the lock
 *     and clears the badge. All of that lives in `scroll-core.mjs`, pure and pinned by test.
 *
 * INTERACTION is routed by the host, not listened for here (portable drawing subset: a design must run on a
 * recording surface with no DOM under it, so it can never call addEventListener). The design
 * declares a `pointer` group — `move(cell, dy)`, `tap(cell, x, y)`, `wheel(cell, deltaY)` —
 * and device.js's grid-level gesture code calls them with CELL-RELATIVE CSS px, repainting the
 * cell whenever a handler returns true. See docs/architecture/widgets.md ("Pointer input").
 *
 * STATE lives in a module-level Map keyed by the bound feed id — deliberately NOT `ctx.state`
 * (a fresh `{}` every paint) and deliberately not per cell index: a feed's scroll position and
 * seen-mark survive full renders, tab switches away and back, and even a screen edit that moves
 * the cell. Two cells binding the same feed on one wall share a position; that is a corner
 * nobody has built and an acceptable trade for a key the pointer path can derive from the cell
 * alone. The Map is never evicted: a hub has tens of feeds, not thousands, and these panels run
 * for weeks — the same reasoning behind the `feeds` map in device.js.
 *
 * Read-path decisions (missing vs empty vs ready) are `normalizeStream`'s, imported from
 * `list.mjs` — same rule, same wording, one implementation. Card painting is `paintCard`,
 * exported by `list.mjs` for exactly this reuse. The overflow counter and `overflow.counter`
 * knob do NOT apply here: scrolling IS this design's answer to overflow, and drawing "and N
 * more" under a scrollable column would claim a limitation the design does not have.
 */
import {
  applyScale, rampValues,
  STREAM_RAMP, STREAM_CARD_TITLE, STREAM_CARD_BODY, FLOOR_LABEL,
} from '../../layout-core.mjs'
import { centredNotice, paintText, quietLine } from '../text-fit.mjs'
import { normalizeStream, paintCard } from './list.mjs'
import { RAIL_W, arrowLayout, dragBy, hitArrow, jumpBottom, jumpTop, reconcile } from './scroll-core.mjs'

const meta = {
  id: 'scroll',
  widget: 'stream_list',
  label: 'Stream scroll',
  suggested_ratio: 3 / 4,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    // The ▲ badge when unseen rows are waiting — warn, not accent: it is a "you are missing
    // something" signal, the same register as a stale gauge, not a decoration.
    badge: { type: 'color', default: '@warn' },
  },
  options: {
    // The same four knobs `list` declares, minus `counter` — see this file's docstring for why
    // the overflow counter has no meaning under a scrollable column.
    title_path: { type: 'text', label: 'Title path', default: 'title' },
    body_path: { type: 'text', label: 'Body path', default: '' },
    title_lines: { type: 'number', label: 'Title lines', default: 1, min: 1, max: 10, path: 'clamp.title_lines' },
    body_lines: { type: 'number', label: 'Body lines', default: 2, min: 1, max: 10, path: 'clamp.body_lines' },
  },
  animations: { transition: [], persistent: [] },
}

/** feed id → scroll state (scroll-core's shape, plus the geometry the pointer path needs). */
const states = new Map()

/** Test seam, mirroring loop.mjs's `_reset`: state that outlives a draw needs a way to not
 *  outlive a test. */
export function _resetScrollState() {
  states.clear()
}

const feedOf = (cell) => {
  const id = cell?.config?.feed
  return typeof id === 'string' && id ? id : null
}

function draw(g, ctx) {
  const { box, tokens, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeStream(ctx.rows, ctx.feed ?? null, config, now)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (n.state === 'missing') {
    centredNotice(g, 'Feed missing', 'Bind this cell to a stream feed', box, tokens, pad, n.scale)
    return
  }
  if (n.state === 'empty') {
    quietLine(g, '— no rows yet', box, tokens, pad, n.scale)
    return
  }

  const feedId = typeof config?.feed === 'string' && config.feed ? config.feed : null
  const cardHeight = n.bodyPath ? STREAM_CARD_BODY : STREAM_CARD_TITLE
  const pushedAts = ctx.rows.map((row) => (row !== null && typeof row === 'object' ? row.pushed_at : null))
  const state = reconcile(feedId ? states.get(feedId) : null, pushedAts, cardHeight, box.h, now)
  const layout = arrowLayout(box.w, box.h, state.max > 0, state.unseen)
  if (feedId) {
    // The geometry the pointer handlers below need to interpret a gesture without a ctx of
    // their own — stored WITH the state so hit test and painter share one answer.
    states.set(feedId, { ...state, layout, rowCount: ctx.rows.length, cardH: cardHeight, viewH: box.h })
  }

  const ramp = rampValues(STREAM_RAMP, box.t ?? 1)
  const titlePx = applyScale(ramp.title, n.scale, FLOOR_LABEL)
  const bodyPx = applyScale(ramp.body, n.scale, FLOOR_LABEL)
  const railShown = layout.up !== null || layout.down !== null
  const usableWidth = Math.max(0, box.w - pad * 2 - (railShown ? RAIL_W : 0))
  const stale = ctx.stale === true
  const cardOpts = { pad, usableWidth, titlePx, bodyPx, tokens, stale, plan: n }

  // Paint only rows that intersect the viewport; the canvas edge does the fine clipping (the
  // canvas IS the cell, and `clip()` is outside the portable subset anyway).
  const first = Math.max(0, Math.floor(state.offset / cardHeight))
  const last = Math.min(n.rows.length - 1, Math.ceil((state.offset + box.h) / cardHeight))
  for (let i = first; i <= last; i++) {
    paintCard(g, n.rows[i], i * cardHeight - state.offset, cardOpts)
  }

  if (layout.up) paintArrow(g, layout.up, 'up', tokens, state)
  if (layout.down) paintArrow(g, layout.down, 'down', tokens, state)
}

/**
 * One rail arrow: a quiet translucent disc with a chevron — unless it is the ▲ with unseen rows
 * behind it, which fills solid in the badge colour and carries the count. An arrow with nowhere
 * to go (▲ at the top, ▼ at the bottom) dims rather than disappears, so the rail's geometry —
 * and the muscle memory aimed at it — never shifts.
 */
export function paintArrow(g, a, dir, tokens, state) {
  const up = dir === 'up'
  const active = up ? state.offset > 0 || state.unseen > 0 : state.offset < state.max
  const announcing = up && state.unseen > 0

  g.beginPath()
  g.arc(a.cx, a.cy, a.r, 0, Math.PI * 2)
  g.fillStyle = announcing ? tokens.badge : tokens.dim
  g.globalAlpha = announcing ? 0.95 : active ? 0.28 : 0.12
  g.fill()

  // The chevron: a plain triangle, sized off the disc.
  const w = a.r * 0.75
  const h = a.r * 0.55
  const cy = a.cy + (announcing ? -3 : 0) - (up ? h / 2 : -h / 2)
  g.beginPath()
  if (up) {
    g.moveTo(a.cx, cy)
    g.lineTo(a.cx - w / 2, cy + h)
    g.lineTo(a.cx + w / 2, cy + h)
  } else {
    g.moveTo(a.cx, cy)
    g.lineTo(a.cx - w / 2, cy - h)
    g.lineTo(a.cx + w / 2, cy - h)
  }
  g.closePath()
  g.fillStyle = tokens.ink
  g.globalAlpha = active || announcing ? 0.9 : 0.35
  g.fill()

  if (announcing) {
    // The count, capped the way every badge caps — past two digits the number stops informing.
    const label = state.unseen > 99 ? '99+' : String(state.unseen)
    paintText(g, label, a.cx, a.cy + 4, {
      px: 9, floor: 9, maxWidth: a.r * 2,
      color: tokens.ink, align: 'center', baseline: 'top', weight: 600,
    })
  }
  g.globalAlpha = 1
}

/**
 * The host-routed input contract (docs/architecture/widgets.md, "Pointer input"). Every handler
 * receives the CELL (to derive the feed key) and cell-relative CSS px, returns whether the cell
 * needs repainting, and must never throw on a feed that has no state yet — a gesture can race a
 * first draw.
 */
/**
 * The pointer group over a given design's state Map — exported as a factory the way `list.mjs`
 * exports `paintCard`: `chat.mjs` scrolls the exact same way this design does, and a second
 * byte-identical pointer block is what these cross-design exports exist to prevent. Each design
 * passes its OWN Map (positions must not be shared across designs drawing the same feed — a
 * design switch would otherwise inherit an offset computed under another card height).
 */
export function pointerFor(states) {
  const pointer = {
    /** A drag step of `dy` px (positive = finger moving down the glass). */
    move(cell, dy) {
      const key = feedOf(cell)
      const s = key ? states.get(key) : null
      if (!s || typeof dy !== 'number' || !Number.isFinite(dy) || dy === 0) return false
      const next = dragBy(s, dy, s.rowCount, s.cardH, s.viewH)
      if (next.offset === s.offset) return false
      states.set(key, next)
      return true
    },
    /** A tap that never became a drag — the arrows are the only targets. */
    tap(cell, x, y) {
      const key = feedOf(cell)
      const s = key ? states.get(key) : null
      if (!s || !s.layout) return false
      const arrow = hitArrow(s.layout, x, y)
      if (arrow === 'up') states.set(key, jumpTop(s))
      else if (arrow === 'down') states.set(key, jumpBottom(s, s.rowCount, s.cardH, s.viewH))
      return arrow !== null
    },
    /** A wheel notch: positive deltaY (wheel down) scrolls toward older rows, matching every list
     *  a mouse has ever scrolled. */
    wheel(cell, deltaY) {
      return pointer.move(cell, -deltaY)
    },
  }
  return pointer
}

export default { meta, draw, pointer: pointerFor(states) }
