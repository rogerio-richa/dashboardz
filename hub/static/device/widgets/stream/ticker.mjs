/**
 * `stream_list` / `ticker` — one line of rows scrolling sideways, the way a broadcast crawl reads.
 * The third `stream_list` design, after `list` (a fixed window of cards) and `scroll` (a column you
 * drag through): this one is for a strip too short to hold a card at all — a header band across the
 * top of a board, or a footer — where the only way to show ten rows is to move them past the eye.
 *
 * WHY IT IS A DESIGN AND NOT A WIDGET. It reads `ctx.rows` and nothing else, which is exactly
 * `stream_list`'s contract, so every stream feed already on a hub can wear it with no new server
 * type, no new save-schema branch beyond its own knobs, and no migration. A ticker of headlines and
 * a ticker of quotes are the same drawing with different rows.
 *
 * THE ONE RULE THIS DESIGN COULD BREAK. `loop.mjs`'s rule is that the board idles to ZERO frames
 * when nothing moves, because a panel that is on 24/7 pays for every frame it is asked for. A
 * marquee is the first design here with no natural end — left alone it would pin the loop at full
 * rate forever. Three things keep that honest:
 *   - `speed: 0` is a real setting, not a degenerate one: the strip lays out and paints once, and
 *     `isAnimating` says false, so a static ticker costs the same as a static label.
 *   - `motion: 'none'` (the viewer's reduced-motion preference) stops it for the same reason
 *     `clock/segment.mjs` stops easing its digits.
 *   - Nothing to scroll — an empty or unbound feed — is not animating either.
 *
 * `tickerOffset` is a pure function of elapsed-ms, speed and content width (animation contract
 * rule): resumable after a dropped frame, testable with no clock, and the reason a repaint that
 * lands late lands in the right PLACE rather than jumping back to where it left off.
 *
 * NO `clip()`. It is outside the portable subset (portable drawing subset) — and unnecessary: every cell paints onto
 * its own `canvas.widget-canvas[data-cell]`, sized to the cell, so the element clips what runs off
 * the ends. What the design must not do is paint an unbounded number of rows for the pixels that
 * would be off-screen anyway, which is what `VISIBLE_SCREENS` bounds below.
 */
import { resolvePath } from '../../layout-core.mjs'
import { centredNotice, quietLine } from '../text-fit.mjs'
import { widgetAcceptsMode } from '../bindings.mjs'

/** The canvas font stacks a panel can actually honour. */
const FAMILIES = Object.freeze({
  sans: 'system-ui, sans-serif',
  mono: 'ui-monospace, monospace',
  serif: 'ui-serif, serif',
})

const DEFAULTS = Object.freeze({ speed: 40, family: 'sans', text_px: 18, separator: '·', direction: 'left' })

/**
 * How much content to lay out, as a multiple of the cell's own width. Two screens are always
 * painted (the strip and the copy chasing it, which is what makes the wrap seamless); this caps
 * how many ROWS feed into that, so a 50-row feed on a narrow strip does not cost 150 `fillText`
 * calls every frame on an old phone.
 */
const VISIBLE_SCREENS = 3

const meta = {
  id: 'ticker',
  widget: 'stream_list',
  label: 'Ticker',
  // A crawl is a band: drawn for a cell far wider than it is tall.
  suggested_ratio: 8 / 1,
  // Its own floor, below `stream_list`'s 160×110. That table is sized for a two-line CARD, which
  // is the one thing this design never draws — a band 28px tall is a legible crawl and an
  // illegible card, and the guard has to be able to tell those apart.
  minimum_px: { w: 120, h: 28 },
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    // A gain and a loss are the one thing a finance strip must not hardcode: `@info`/`@critical`
    // are the board's own vocabulary, so a theme that recolours severity recolours the ticker too.
    up: { type: 'color', default: '@info' },
    down: { type: 'color', default: '@critical' },
  },
  options: {
    // The two paths `stream_list` has always had; restated so the generated form offers them here.
    title_path: { type: 'text', label: 'Title path', default: 'title' },
    body_path: { type: 'text', label: 'Body path', default: '' },
    // The design's own knobs live under one `ticker` object rather than five loose properties, the
    // way `clamp` and `overflow` already nest theirs — one place to add to the save schema, and a
    // cell's ticker settings stay legible next to another design's.
    speed: { type: 'number', label: 'Scroll speed (px/s, 0 = still)', default: DEFAULTS.speed, path: 'ticker.speed' },
    family: { type: 'select', label: 'Font', choices: ['sans', 'mono', 'serif'], default: DEFAULTS.family, path: 'ticker.family' },
    text_px: { type: 'number', label: 'Text size (px)', default: DEFAULTS.text_px, path: 'ticker.text_px' },
    separator: { type: 'text', label: 'Separator', default: DEFAULTS.separator, path: 'ticker.separator' },
    direction: { type: 'select', label: 'Direction', choices: ['left', 'right'], default: DEFAULTS.direction, path: 'ticker.direction' },
  },
  animations: { transition: [], persistent: ['crawl'] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const text = (value) => (value === null || value === undefined ? '' : String(value))

/** The design's own settings, defaulted the same way the option declarations above promise. */
export function tickerConfig(config) {
  // Aliased with `&&`/ternary rather than `?.`/`??` deliberately: this is the idiom
  // `layout-core.mjs`'s own `streamListConfig` uses for `clamp`, and it is the one the
  // knob-coverage analyser can follow, and the local is NAMED for the container it holds because
  // that analyser resolves aliases by name (its CONTAINERS set, where `clamp` and `thresholds`
  // already sit for the same reason). Written with optional chaining, every knob below reports as
  // a dead knob — schema-accepted, renderer-never-reads — which is exactly the bug that test exists
  // to catch, so the shape of the read matters as much as the read.
  const c = config && typeof config === 'object' ? config : {}
  const ticker = c.ticker && typeof c.ticker === 'object' ? c.ticker : {}
  const speed = finite(ticker.speed) && ticker.speed >= 0 ? ticker.speed : DEFAULTS.speed
  const textPx = finite(ticker.text_px) && ticker.text_px > 0 ? ticker.text_px : DEFAULTS.text_px
  return {
    speed,
    textPx: Math.max(8, Math.min(96, textPx)),
    family: FAMILIES[ticker.family] ? ticker.family : DEFAULTS.family,
    // '' is a legitimate choice — run the rows together with only the gap between them.
    separator: typeof ticker.separator === 'string' ? ticker.separator : DEFAULTS.separator,
    direction: ticker.direction === 'right' ? 'right' : 'left',
  }
}

/**
 * How far the strip has travelled, wrapped into one content length.
 *
 * Pure by contract: same elapsed in, same pixels out, no clock read and no state kept. The modulo
 * is what makes the wrap invisible — at exactly one content width the second copy sits where the
 * first began, so resetting to 0 there changes nothing on the glass.
 */
export function tickerOffset(elapsedMs, speed, contentW) {
  if (!(speed > 0) || !(contentW > 0) || !finite(elapsedMs)) return 0
  const travelled = (elapsedMs / 1000) * speed
  return ((travelled % contentW) + contentW) % contentW
}

/**
 * Where each feed's crawl currently is: `feed id -> { clock, offset, contentW }`.
 *
 * Module-level, keyed by the bound feed, deliberately — the same shape `stream/scroll.mjs` keeps
 * its scroll position in, and for the same reason: this is view state that must survive a repaint
 * but means nothing to anyone else. `ctx.state` is per-paint and would not.
 */
const anchors = new Map()

/** Test seam: a suite must not inherit a crawl position from the test before it. */
export function _resetTickerAnchors() {
  anchors.clear()
}

/**
 * The crawl's offset, advanced from its anchor rather than recomputed from the clock.
 *
 * `clock % contentW` looks equivalent and is not: a crawl wraps at its CONTENT width, so the
 * moment the rows change — a new symbol, or merely a digit more in a percentage — the wrap point
 * moves and the strip visibly snaps. That is geometry, not timing, so no amount of clock
 * continuity fixes it (the clock fix came first and the snap survived it, on a real board).
 *
 * Anchoring solves it: the offset advances at exactly `speed` px/s from the last anchor, and when
 * `contentW` changes the anchor is RE-TAKEN at the current pixel position. The strip carries on
 * from where it is while the text underneath it changes.
 *
 * `state` is passed in rather than closed over so the arithmetic can be tested without the module's
 * own map — the same seam `_setRaf` gives `loop.mjs`.
 */
export function anchoredOffset(state, key, clock, speed, contentW) {
  if (!(contentW > 0)) return 0
  const wrap = (value) => ((value % contentW) + contentW) % contentW
  const prev = state.get(key)
  if (!prev) {
    state.set(key, { clock, offset: 0, contentW })
    return 0
  }
  // Never negative: a crawl must not reverse. `ctx.now` carries the hub's clock offset, which a
  // STATE can nudge backwards, and a reversing marquee reads as broken rather than as re-synced.
  const dt = Math.max(0, clock - prev.clock)
  const travelled = wrap(prev.offset + (dt / 1000) * (speed > 0 ? speed : 0))
  // The anchor moves on EVERY call, not only when the content changes: this is an integrator, and
  // one that re-derives from a fixed origin is not one. Leaving it fixed meant a clock that stepped
  // backwards recomputed a smaller offset and the crawl rewound — the guard above did nothing.
  state.set(key, { clock, offset: travelled, contentW })
  return travelled
}

/**
 * Rows → the flat run of pieces to paint, in wire order: title, body, separator, per row.
 *
 * The separator trails every row INCLUDING the last, which is what leaves a gap between the end of
 * the strip and the copy chasing it — without it the last row would butt against the first.
 *
 * Tone is read off the text itself rather than a configured "change" path, so the rule works for
 * any feed that already formats a signed number: `+1.2%` is a gain, `-0.8%` and `−0.4%` (U+2212,
 * which is what a formatter that knows typography emits) are losses, everything else is ink.
 */
export function tickerPlan(rows, config, ticker) {
  const titlePath = typeof config?.title_path === 'string' && config.title_path !== '' ? config.title_path : 'title'
  const bodyPath = typeof config?.body_path === 'string' && config.body_path !== '' ? config.body_path : null
  const separator = ticker?.separator ?? DEFAULTS.separator
  const pieces = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = row?.payload ?? row
    const title = text(resolvePath(payload, titlePath)).trim()
    if (title !== '') pieces.push({ text: title, tone: 'ink' })
    if (bodyPath) {
      const body = text(resolvePath(payload, bodyPath)).trim()
      if (body !== '') pieces.push({ text: body, tone: tone(body) })
    }
    if (separator !== '') pieces.push({ text: separator, tone: 'dim' })
  }
  return pieces
}

function tone(value) {
  const first = value.charAt(0)
  if (first === '+') return 'up'
  if (first === '-' || first === '−') return 'down'
  return 'ink'
}

/**
 * Optional part of the design contract: is this design animating RIGHT NOW, for this ctx? The host
 * registers a frame callback only while this says true, and `loop.mjs` drops it when it stops.
 */
function isAnimating(ctx) {
  if (ctx?.motion === 'none') return false
  const set = tickerConfig(ctx?.config)
  if (!(set.speed > 0)) return false
  if (ctx?.feed?.missing) return false
  return Array.isArray(ctx?.rows) && ctx.rows.length > 0
}

function draw(g, ctx, elapsedMs) {
  const { box, tokens, config, feed } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))
  const scale = finite(config?.scale) && config.scale > 0 ? config.scale : 1

  // Unbound, or bound to a mode this widget cannot read: the loud notice, same as `list`.
  if (!config?.feed || feed?.missing) {
    centredNotice(g, 'Feed missing', 'Bind this cell to a stream feed', box, tokens, pad, scale)
    return
  }
  if (feed?.mode && !widgetAcceptsMode('stream_list', feed.mode)) {
    centredNotice(g, 'Wrong feed mode', `A ticker reads a stream, not ${feed.mode}`, box, tokens, pad, scale)
    return
  }

  const set = tickerConfig(config)
  const px = Math.max(8, Math.round(set.textPx * scale))
  g.font = `${px}px ${FAMILIES[set.family]}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'

  const pieces = tickerPlan(ctx.rows, config, set)
  if (pieces.length === 0) {
    // A never-pushed stream is not a failure (contract) — the quiet line, not the notice.
    quietLine(g, 'Nothing pushed yet', box, tokens, pad, scale)
    return
  }

  // Lay out only as much as can be seen while crawling, then measure what that came to.
  const gap = px * 0.6
  const limit = box.w * VISIBLE_SCREENS
  const laid = []
  let contentW = 0
  for (const piece of pieces) {
    const w = g.measureText(piece.text).width
    laid.push({ ...piece, x: contentW, w })
    contentW += w + gap
    if (contentW >= limit) break
  }
  if (!(contentW > 0)) return

  // `ctx.now`, and NOTHING else. The host re-reads its clock inside the frame callback
  // (`paintWidgets`: `const paint = (elapsed) => { const nowMs = hubNow() ... }`), so `ctx.now` is
  // already live on every frame — while `elapsedMs` restarts from zero each time the cell is
  // repainted, which is every data push. Driving a crawl from elapsed made it snap back to the
  // start; ADDING the two (the first attempt at a fix) was worse — it double-counted, and each
  // repaint dropped the clock by however much elapsed had accumulated, so the strip visibly
  // reversed a few pixels every few seconds. elapsedMs is for bounded transitions. This is not one.
  const clock = ctx.now || 0
  const offset = anchoredOffset(anchors, String(config?.feed ?? 'unbound'), clock, set.speed, contentW)
  // Left: the strip slides toward negative x. Right: the copy that entered from the left leads, so
  // the run starts one content width behind and the offset walks it forward.
  const base = set.direction === 'right' ? offset - contentW : -offset
  const y = box.h / 2

  // Tile the strip until the cell is COVERED, rather than assuming two copies is enough. Two is
  // right for content wider than the cell and leaves a hole for content narrower than it — and the
  // whole reason a width change can be absorbed invisibly is that whatever leaves one edge is
  // already entering the other. On a real board this was the residual "goes back a few positions":
  // the offset wrapped by one period correctly, and with only two copies the wrap was VISIBLE.
  const copies = Math.max(2, Math.ceil((box.w + offset) / contentW) + 1)
  for (let copy = 0; copy < copies; copy++) {
    const originX = base + copy * contentW
    for (const piece of laid) {
      // Named reads, not `tokens[piece.tone]`: a dynamic lookup hides which slots this design
      // actually paints with, and portable-subset.test.ts rightly reports a declared-but-unread
      // token as a broken declaration.
      let colour = tokens.ink
      if (piece.tone === 'up') colour = tokens.up
      else if (piece.tone === 'down') colour = tokens.down
      else if (piece.tone === 'dim') colour = tokens.dim
      g.fillStyle = colour
      g.fillText(piece.text, originX + piece.x, y)
    }
  }
}

export default { meta, draw, isAnimating }
