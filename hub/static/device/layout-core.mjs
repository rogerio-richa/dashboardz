// Shared layout contract (fit & overflow semantics). These rules had a hand-maintained
// Kotlin twin in the Android app until the Compose board was retired (web-renderer boundary); this file is now the
// only implementation, and the vectors it is tested against are the contract.

import { WIDGET_DEFINITIONS } from './widgets/definitions.mjs'

const RANK = { info: 0, warn: 1, critical: 2 }

export const CLOCK_RAMP = { full: { time: 120, date: 16 }, half: { time: 72, date: 14 }, quadrant: { time: 48, date: 12 } }
export const FEED_CARD = 132
export const FEED_COUNTER = 28

export function feedPlan(cellHeight, count, counterEnabled) {
  const fit = Math.floor(cellHeight / FEED_CARD)
  if (count <= fit) return { visible: count, hidden: 0 }
  const visible = counterEnabled ? Math.max(0, Math.floor((cellHeight - FEED_COUNTER) / FEED_CARD)) : fit
  return { visible, hidden: count - visible }
}

export function feedConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const clamp = c.clamp && typeof c.clamp === 'object' ? c.clamp : {}
  const overflow = c.overflow && typeof c.overflow === 'object' ? c.overflow : {}
  return {
    minSeverity: c.min_severity === 'warn' || c.min_severity === 'critical' ? c.min_severity : 'info',
    titleLines: Number.isInteger(clamp.title_lines) ? clamp.title_lines : 1,
    bodyLines: Number.isInteger(clamp.body_lines) ? clamp.body_lines : 2,
    counter: overflow.counter !== false,
    scale: typeof c.scale === 'number' ? c.scale : 1,
  }
}

export function feedAlerts(alerts, minSeverity) {
  const min = RANK[minSeverity] ?? 0
  return alerts
    .filter((a) => (RANK[a.severity] ?? 0) >= min)
    .sort((a, b) => b.updated_at - a.updated_at)
}

export function stateAck(rev, screenId, screenIds) {
  const ack = { type: 'STATE_ACK', rev }
  if (screenId != null) ack.screen_id = screenId
  // `screenIds` (tab-bar behavior, tab-aware client) is the full set of tab screen ids currently rendered —
  // optional third arg so a caller that still passes only (rev, screenId) keeps the exact two-key
  // shape the pre-tabs vectors above pin. Included whenever the caller HAS a list, even `[]` (a
  // device with zero tabs), because an empty array is what tells the hub "set ack, zero screens"
  // rather than "legacy client" — see deviceSocket.ts's `Array.isArray(msg.screen_ids)` check.
  if (Array.isArray(screenIds)) ack.screen_ids = screenIds
  return ack
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// DATA WIDGETS — shared binding / format / scale / plan core
//
// Every rule below is implemented by this browser module and pinned by the browser vector suite
// (data widgets design). The vectors remain the contract — hub/test/fixtures/data-widget-vectors.json
// — and a rule change still means this implementation and vectors move together; a vector is never
// edited to match a convenient result.
//
// ── Binding & path resolution (`resolvePath(value, path)` — browser implementation, vector contract):
//   - `path` is dot-separated segments; `''` (empty) resolves to the whole payload.
//   - Per segment: if current is an **array** and the segment is all digits → index (out of range
//     → undefined). Else if current is a **non-null object** with that own key → member. Else →
//     **undefined**.
//   - Resolution NEVER throws. `undefined` anywhere → the widget's em-dash placeholder state.
//
// ── Display of a resolved value (`displayValue(v, format, decimals)`):
//   - number → formatted (below); string → as-is; boolean → `"true"`/`"false"`; null/undefined →
//     `"—"` (em dash); object/array → compact single-line JSON (`JSON.stringify`, no spaces),
//     clamped by the widget's line rules.
//   - `format: 'raw'` (default): integral numbers (|v| < 1e15, v % 1 === 0) render with **no
//     decimal point** (`5` never `5.0`); else `decimals` set → fixed(decimals), else the JS
//     `String(v)` form. The shared vectors pin each result.
//   - `format: 'abbrev'`: |v| ≥ 1e9 → `fixed(decimals ?? 1)` of v/1e9 + `"B"`; ≥ 1e6 → `"M"`;
//     ≥ 1e3 → `"K"`; below 1e3 → raw rule. No zero-stripping: `1000` → `"1.0K"`.
//   - Numerals render **tabular**: the browser uses CSS `font-variant-numeric: tabular-nums`.
//
// ── Scale (`applyScale(px, scale, floor)` = `max(floor, round(px * clampedScale))`,
//    `clampedScale = min(2.0, max(0.5, scale ?? 1))`):
//   - `SCALE_MIN 0.5`, `SCALE_MAX 2.0`. Floors: `FLOOR_VALUE 16` (primary value/text sizes),
//     `FLOOR_LABEL 10` (labels, units, meta, age chips). Every ramp size below passes through
//     `applyScale`.
//
// ── Type ramps (px in the browser; per cell fraction FULL/HALF/QUADRANT, same order as
//    `CLOCK_RAMP`) — see the tables below the comment.
//
//    `VALUE_RAMP`, `GAUGE_RAMP` and `TEXT_RAMP` were removed with the tile DOM branch (widget
//    contract): `value_tile`, `gauge` and `text_block` are canvas designs now, and a
//    design sizes itself continuously off `ctx.box` rather than stepping through a discrete
//    full/half/quadrant bucket, so nothing read them any more. Several rationale notes below still
//    NAME them — they are the historical calibration reference the surviving ramps were set
//    against, not tables you can still import.
//
// ── rule (`scale` on stream_list and table): the design contract
//    promises `scale` on all seven widgets and admin.ts has always accepted it for these two, but
//    the original contract defined no ramp for stream/table row text, so those sizes were fixed at
//    14/12 px for stream title/body and 13 px for table header+cell, and the knob did nothing —
//    an operator could save scale 2.0 on a table and see no change and no error. `STREAM_RAMP`
//    and `TABLE_RAMP` below close that gap; they are plain per-fraction constant tables with the
//    same status as VALUE_RAMP/GAUGE_RAMP/TEXT_RAMP/CHART_RAMP (pinned by an exact-values
//    assertion in layout-core.test.ts, not vectored — a raw table has no input/output to vector).
//      - FULL is seeded from exactly what each renderer hardcoded before, so scale 1 on a 1x1
//        cell renders byte-identically to the previous release; HALF/QUADRANT step down 1px per
//        fraction, matching CHART_RAMP's step for small text rather than VALUE_RAMP's, which is
//        calibrated for 96px display type.
//      - Both ramps floor at `FLOOR_LABEL` (10), NOT `FLOOR_VALUE` (16): this is dense list/table
//        text in the same 10..14 band as the existing label/meta ramp entries. A 16 floor would
//        RAISE the unscaled default (14 -> 16) and flatten scale 0.5 onto scale 1.0, i.e. the
//        knob still would not shrink — the same dead-knob bug, one step further along.
//      - TABLE_RAMP is a SCALAR per fraction (like TEXT_RAMP), not a {header, cell} pair: both
//        renderers already drew header and cell at the same size and distinguish the header by
//        color/weight, so a second member would be duplicated data with no distinction.
//      - SCOPE, deliberately: `scale` moves TEXT ONLY. The card/row HEIGHT constants
//        (STREAM_CARD_TITLE / STREAM_CARD_BODY / TABLE_ROW / TABLE_HEADER, below) are INPUTS to
//        the vectored `cardPlan` overflow arithmetic — scaling them would change which rows fit
//        and how many "and N more" reports, i.e. it would silently move behavior the vectors pin
//        in the browser layout. Do NOT "finish the job" by scaling them here; that is a contract
//        change and needs its own vectors, not a routine tidy-up. At scale 2 the text is
//        therefore taller than its unscaled row box and clips (cells are `overflow: hidden` /
//        `clipToBounds`) — accepted, and strictly better than the knob doing nothing at all.
//
//   - **value_tile:** label above value+unit; the value must fit ONE line — shrink below its
//     scaled ramp size until it fits or hits `FLOOR_VALUE`, then platform-native ellipsis. Never
//     wraps. (The shrink search is renderer-native; the RULE — one line, floor, ellipsis — is the
//     contract.)
//   - **gauge:** fill fraction = `(clamp(v, min, max) - min) / (max - min)`; `max > min`
//     guaranteed by save-time validation. Fill color: base accent; ≥ `thresholds.warn` → warn
//     color; ≥ `thresholds.crit` → critical color (thresholds in VALUE units, optional, crit ≥
//     warn not enforced — each checked independently). Non-numeric value → placeholder, empty
//     track.
//   - **Overflow plans** (vector-pinned arithmetic — the alert_feed discipline generalized):
//       cardPlan(cellHeight, count, counterEnabled, cardHeight):   # counter height = FEED_COUNTER (28)
//         fit = floor(cellHeight / cardHeight)
//         if count <= fit:        visible = count, hidden = 0
//         elif counterEnabled:    visible = max(0, floor((cellHeight - FEED_COUNTER) / cardHeight)), hidden = count - visible
//         else:                   visible = fit, hidden = count - visible
//       stream_list: cardPlan(cellHeight, rows, overflow.counter, body_path ? STREAM_CARD_BODY : STREAM_CARD_TITLE)
//       table:       cardPlan(cellHeight - (headers ? TABLE_HEADER : 0), rowCount, overflow.counter, TABLE_ROW)
//     Counter text: `and N more`. Counter space reserved BEFORE deciding what fits. Nothing scrolls.
//   - **text_block:** wraps; `maxLines = max(1, floor((cellHeight - 2*CELL_PAD) / lineHeight))`;
//     ellipsis at the last line.
//   - **Scalar widgets on stream feeds** (`feedScalarSource(feedWire)`): value_tile/gauge/text_block
//     bound to a **value** feed resolve against `payload`; bound to a **stream** feed they resolve
//     against the NEWEST row's payload (`rows[0].payload`) — "the latest reading". Empty stream →
//     undefined → placeholder. An **image** feed is not bindable by the current widget set (save-time
//     rejection).
//
// ── Staleness: Stale ⇔ `stale_after_s != null && age > stale_after_s * 1000`. Age chip text
//    (`formatAge(ageMs)`, `widgets/text-fit.mjs`): `< 60s` → `now`; `< 60m` → `${floor(m)}m ago`;
//    `< 24h` → `${floor(h)}h ago`; else `${floor(d)}d ago`. Never-pushed (`payload null` /
//    `rows: []`): em-dash placeholder + feed name, NOT stale styling.
//
// Implementation details beyond the contract text (all pinned by vectors or unit tests):
//   - resolvePath treats arrays as index-only: a non-digit segment on an array misses rather than
//     reaching array properties like `length`, because array paths accept numeric indexes only.
//     Own keys only — inherited names (`toString`) never resolve.
//   - displayValue ignores a `decimals` that is not an integer in 0..10 (a corrupt row must not
//     make toFixed throw); the config normalizers already type-check it.
//   - The normalizers below follow feedConfig's guarded style: garbage in → defaults out, never
//     throw. Renderers call ONLY these — never the raw config.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const SCALE_MIN = 0.5
export const SCALE_MAX = 2
export const FLOOR_VALUE = 16
export const FLOOR_LABEL = 10

// The age chip's own fixed, NEVER-scaled font size — `.age-chip`'s CSS `font-size: 10px`
// (index.html; the rule itself is gone with the DOM branch, but canvas designs still paint at its
// value). Coincidentally also 10, but a different meaning from FLOOR_LABEL: FLOOR_LABEL is the
// floor SCALED text shrinks to, this is a literal size nothing ever scales. `stream_list`,
// `image_frame` and `chart_plot` use AGE_CHIP_PX for their own age chip — changing FLOOR_LABEL (a
// text floor, tuned for labels/units/meta) must not resize them merely because the constants share
// a value today. Named separately so
// the two can vary independently, the way they always semantically could.
export const AGE_CHIP_PX = 10

// stream_list row text and table header+cell text (rule above). Every member floors at
// FLOOR_LABEL, never FLOOR_VALUE.
export const STREAM_RAMP = { full: { title: 14, body: 12 }, half: { title: 13, body: 11 }, quadrant: { title: 12, body: 10 } }
export const TABLE_RAMP = { full: 13, half: 12, quadrant: 11 }

// Card/row HEIGHTS — NOT scaled by `scale` (see the scope note in the rule above): these feed
// cardPlan's vectored overflow arithmetic, so scaling them would move pinned fit/overflow behavior.
export const STREAM_CARD_TITLE = 48
export const STREAM_CARD_BODY = 96
export const TABLE_ROW = 44
export const TABLE_HEADER = 36
export const CELL_PAD = 16

const PLACEHOLDER = '—'
const DIGITS = /^\d+$/

const isObj = (v) => v !== null && typeof v === 'object'
const asString = (v) => (typeof v === 'string' ? v : null)
const asNumber = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

// ═══════════════════════════════════════════════════════════════════════════════════════════
// FREE LAYOUT — rect geometry ("Shared display rules").
//
// A cell carries {x,y,w,h} as FRACTIONS of the screen, replacing the `template` grid. safeRect and
// safeRect and rectToPx are covered by the browser vectors below.
//
// Numeric contract: x,y in [0,1]; w,h in [RECT_MIN,1]; x+w <= 1; y+h <= 1; every value an exact
// multiple of 0.001. rectValid/rectsOverlap are VALIDATION-ONLY: the hub validates them, while
// admin.ts keeps its own copy (it cannot import this file — see
// admin.ts:18) and layout-core.test.ts asserts the two agree, the CHART_ICONS precedent.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const RECT_MIN = 0.05

/** 3dp is sub-pixel on every target (0.72px at 720 wide); quantizing kills editor drift. */
export function quantize(v) {
  return Math.round(v * 1000) / 1000
}

/** Quantized to 0.001. Math.round always returns an integer, so the ONLY real check is the
 *  distance from v*1000 to its own rounding — do not add an isInteger test, it can never fail. */
const isFrac = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-9

export function rectValid(rect) {
  if (!isObj(rect)) return false
  const { x, y, w, h } = rect
  if (![x, y, w, h].every(isFrac)) return false
  if (x < 0 || y < 0 || w < RECT_MIN || h < RECT_MIN || w > 1 || h > 1) return false
  // Sums compared in integer thousandths — 0.7 + 0.3 > 1 is true in float, false here.
  return Math.round(x * 1000) + Math.round(w * 1000) <= 1000
    && Math.round(y * 1000) + Math.round(h * 1000) <= 1000
}

/**
 * Half-open intervals in INTEGER thousandths: two cards sharing an edge (0.5|0.5) are disjoint,
 * which is the common case for a full-cover board and must never be reported as an overlap.
 */
export function rectsOverlap(a, b) {
  const k = (v) => Math.round(v * 1000)
  const ax = k(a.x), ay = k(a.y), aw = k(a.w), ah = k(a.h)
  const bx = k(b.x), by = k(b.y), bw = k(b.w), bh = k(b.h)
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah
}

/**
 * Read-path coercion (house rule: bad data in the DB never crashes a read path). A hand-edited or
 * legacy row renders a real card rather than blanking the board. Clamps rather than rejects.
 *
 * Clamp in INTEGER thousandths throughout — the same trick rectValid/rectsOverlap use — and divide
 * back by 1000 once at the end, rather than clamping in float and quantizing the result after.
 * Floats can't land on every 0.001 grid point (1 - 0.8 === 0.19999999999999996 in IEEE 754), and a
 * first version that quantized only w/h let an off-grid x (e.g. 0.1234, never itself snapped to the
 * grid) push x+w up to half a thousandth past 1 — a card drawn past the screen edge. Working in
 * integers end to end makes x+w <= 1000 an exact comparison instead of a float hope, and snaps every
 * output value onto the grid by construction, x/y included.
 */
export function safeRect(rect) {
  const r = isObj(rect) ? rect : {}
  const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
  const k = (v) => Math.round(v * 1000)
  const MIN = k(RECT_MIN)
  // x/y cap at 1000 - MIN, NOT at 1000: capping at 1000 would leave room for only a zero-width
  // card, which the MIN floor then pushes off the right/bottom edge entirely — an invisible card,
  // i.e. exactly the blank this function exists to prevent. Capping here makes 1000-x >= MIN hold
  // by construction, so w/h derive their upper bound FROM x/y (below) rather than being capped
  // independently against a separate 1000 — the two bounds can never disagree, lower or upper.
  const xi = Math.min(1000 - MIN, Math.max(0, k(num(r.x, 0))))
  const yi = Math.min(1000 - MIN, Math.max(0, k(num(r.y, 0))))
  const wi = Math.min(1000 - xi, Math.max(MIN, k(num(r.w, 1))))
  const hi = Math.min(1000 - yi, Math.max(MIN, k(num(r.h, 1))))
  return { x: xi / 1000, y: yi / 1000, w: wi / 1000, h: hi / 1000 }
}

/**
 * Rect -> pixels. BOTH edges are rounded and subtracted, never `round(w * W)`: two cards sharing
 * the value 0.5 both compute round(0.5 * 721) = 361 for that boundary, so one ends exactly where
 * the other begins — no 1px seam, no 1px overlap, at any screen size. All inputs are non-negative,
 * where JS Math.round and Kotlin roundToInt agreed (both round half up) — a constraint inherited
 * from the retired Kotlin twin, kept because the vectors encode it.
 */
export function rectToPx(rect, screenW, screenH) {
  const left = Math.round(rect.x * screenW)
  const top = Math.round(rect.y * screenH)
  const right = Math.round((rect.x + rect.w) * screenW)
  const bottom = Math.round((rect.y + rect.h) * screenH)
  return { left, top, width: right - left, height: bottom - top }
}

// ── Continuous size scalar ───────────────────────────────────────────────────────────────────
//
// Replaces cellFraction's full|half|quadrant buckets. The three existing ramp steps become
// ANCHORS on this scalar: quadrant 0.5, half 0.75, full 1.0. That is not a fitted curve — it is
// where the four old templates already sat:
//     1x1 (1,1)   -> 1.0    2x1 (0.5,1) -> 0.75
//     1x2 (1,0.5) -> 0.75   2x2 (.5,.5) -> 0.5
// so every migrated board renders BYTE-IDENTICALLY and all pre-existing vectors keep their values.
// 0.5/0.75/1.0 are exact in IEEE-754, so this holds bit-for-bit, not approximately.
//
// Arithmetic mean, NOT area: a full-width clock banner is (1 + 0.17)/2 = 0.585, comfortably above
// the quadrant anchor, where area (0.17) would have put it below and drawn 48px type in a 272px
// box. That is exactly the bug layout clamp was raised against.

export function sizeT(w, h) {
  return (asNumber(w, 0) + asNumber(h, 0)) / 2
}

const ANCHOR_QUADRANT = 0.5
const ANCHOR_HALF = 0.75

/**
 * Piecewise-linear between the three anchors, clamped outside them. Returns an UNROUNDED float and
 * feeds straight into applyScale, so the whole chain has exactly ONE rounding point — a function
 * already covered by vectors. Scalar in, scalar out: no polymorphism here, see rampValues.
 */
export function rampAt(full, half, quadrant, t) {
  const v = asNumber(t, ANCHOR_QUADRANT)
  if (v <= ANCHOR_QUADRANT) return quadrant
  if (v >= 1) return full
  if (v <= ANCHOR_HALF) return quadrant + ((v - ANCHOR_QUADRANT) / (ANCHOR_HALF - ANCHOR_QUADRANT)) * (half - quadrant)
  return half + ((v - ANCHOR_HALF) / (1 - ANCHOR_HALF)) * (full - half)
}

/**
 * The polymorphic wrapper over rampAt. Scalar tables (TABLE_RAMP) return a number; object tables
 * (CLOCK/STREAM/CHART) are interpolated PER MEMBER, one rampAt call per key. Per-member matters:
 * the ramps are not proportional to each other (CHART_RAMP.icon steps 6->5->4 while
 * CLOCK_RAMP.time steps 120->72->48), and interpolating members independently keeps those
 * hand-calibrated relationships intact at every intermediate size.
 */
export function rampValues(ramp, t) {
  if (typeof ramp.full === 'number') return rampAt(ramp.full, ramp.half, ramp.quadrant, t)
  const out = {}
  for (const key of Object.keys(ramp.full)) out[key] = rampAt(ramp.full[key], ramp.half[key], ramp.quadrant[key], t)
  return out
}

/**
 * The vectorable core of shrink-to-fit. Measurement is browser-specific, so the loop itself cannot
 * be vectored — the CANDIDATE SEQUENCE can. The sequence is pinned by vector rather than by
 * inspection, so a given measurement always reaches the same answer.
 * 2px steps and the floor match the shrinkTileValues loop this replaces.
 */
export function fitSteps(start, floor) {
  const steps = []
  for (let s = Math.round(start); s > floor; s -= 2) steps.push(s)
  steps.push(floor)
  return steps
}

/**
 * THE SMALLEST BOX EACH WIDGET RENDERS PROPERLY IN, in CSS pixels.
 *
 * "If it's too small then it's too small." A widget below its minimum is an AUTHORING mistake, not
 * a rendering condition to cope with — the same class of thing as a cell bound to a feed that does
 * not exist, and it gets the same loud dashed placeholder rather than a quietly worse widget.
 *
 * This is what the fit plan is not. Shrinking type and dropping an age chip are reasonable answers
 * to "a bit tight"; they are not an answer to a gauge with no room for its own label, which is how
 * a board ends up showing four anonymous rings. Degrading that far silently produces something that
 * LOOKS deliberate and is unreadable, and nothing tells the operator why.
 *
 * PIXELS, NOT FRACTIONS — deliberately. A minimum expressed as a share of the board says nothing
 * about whether text fits, which is the flaw this fit model fixes. It also means the
 * editor cannot enforce these honestly until devices report their real viewport; until then
 * it can only check against the previewed target shape.
 *
 * Heights are derived from what each widget actually stacks at the smallest ramp tier — a gauge is
 * label 14 + ring 36 + value 29 + chip 12 + gaps 12 + padding 8 ~ 111. Widths are the narrowest a
 * typical label reads at without ellipsis.
 */
export const WIDGET_MIN_PX = Object.freeze(Object.fromEntries(
  WIDGET_DEFINITIONS.map((definition) => [definition.id, definition.minimum_px]),
))

/**
 * Is this box too small for this widget? Unknown widgets have no opinion and are never blocked —
 * a client older than a widget type must not refuse to draw something it simply does not know
 * about, the same degradation rule an unknown design id follows.
 *
 * `designMin` is an optional per-DESIGN floor (a design's `meta.minimum_px`, resolved by the
 * caller through `designMinimum` in the catalogue). The widget table is the right default and the
 * wrong answer for a design built for a shape its widget normally cannot use: `stream/ticker` is a
 * one-line crawl, and stream_list's floor is a two-line card, so the first ticker band placed on a
 * real panel rendered as "stream_list needs 160×110". The guard was right about the widget and
 * wrong about that design. A malformed override is IGNORED rather than trusted — this value
 * originates in a design's own meta, and a floor that reads `{w: 'nope'}` must not disable a
 * guard whose whole job is refusing to draw a cell too small to read.
 */
export function belowMinimum(widget, widthPx, heightPx, designMin) {
  const table = WIDGET_MIN_PX[widget]
  const usable = designMin && typeof designMin.w === 'number' && typeof designMin.h === 'number'
    && Number.isFinite(designMin.w) && Number.isFinite(designMin.h)
  const min = usable ? designMin : table
  if (!min) return false
  const w = asNumber(widthPx, 0)
  const h = asNumber(heightPx, 0)
  return w < min.w || h < min.h
}

export function clockTimePx(t, scale) {
  return applyScale(rampAt(CLOCK_RAMP.full.time, CLOCK_RAMP.half.time, CLOCK_RAMP.quadrant.time, t), scale, FLOOR_VALUE)
}

export function clockDatePx(t, scale) {
  return applyScale(rampAt(CLOCK_RAMP.full.date, CLOCK_RAMP.half.date, CLOCK_RAMP.quadrant.date, t), scale, FLOOR_LABEL)
}

export function resolvePath(value, path) {
  if (typeof path !== 'string' || path === '') return value
  let cur = value
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) {
      if (!DIGITS.test(seg)) return undefined
      const i = Number(seg)
      if (i >= cur.length) return undefined
      cur = cur[i]
    } else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg]
    } else {
      return undefined
    }
  }
  return cur
}

export function displayValue(v, format, decimals) {
  if (v === null || v === undefined) return PLACEHOLDER
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return PLACEHOLDER
    }
  }
  if (typeof v !== 'number') return String(v)
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 10 ? decimals : null
  if (format === 'abbrev') {
    const abs = Math.abs(v)
    const tier = abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : null
    if (tier) return (v / tier[1]).toFixed(d ?? 1) + tier[0]
  }
  if (Number.isInteger(v) || (Math.abs(v) < 1e15 && v % 1 === 0)) return String(v)
  return d !== null ? v.toFixed(d) : String(v)
}

/**
 * A chart y-axis bound, formatted for the gutter it has to fit in.
 *
 * NOT displayValue. A feed value is authored — an operator picked its `decimals` and knows what the
 * number means. An axis bound is DERIVED: it is the min or max of whatever points happened to
 * arrive, so it carries the full float that fell out of the arithmetic. `displayValue(v, 'raw',
 * null)` prints all of it, and the label is right-aligned into a gutter `axisFontPx * 3.5` wide, so
 * `74.38263382999288` was drawn from x=plotX-4 leftwards and the board showed `99288` — the tail of
 * a number, looking exactly like a number. Wrong values that look wrong get noticed; this one did
 * not, for a whole session.
 *
 * Precision comes from the SPAN rather than the value, because the span is what the two labels have
 * to resolve between: a 0-100 axis gains nothing from decimals, and a 3.7-4.2 battery axis is
 * useless without them. Trailing zeros are then stripped, so the two ends read `3.7` and `4.2`
 * rather than `3.70` and `4.20`.
 *
 * Formats only — the caller keeps the exact bounds for `yOf`, so rounding a label never moves a
 * plotted point.
 */
export function axisLabel(value, span) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PLACEHOLDER
  // Six figures do not fit whatever we do with the decimals, so they abbreviate instead. Below
  // that an exact number always fits, and exact is better than rounded on an axis.
  if (Math.abs(value) >= 1e5) return displayValue(value, 'abbrev', 1)
  const s = typeof span === 'number' && Number.isFinite(span) ? Math.abs(span) : 0
  const magnitude = Math.abs(value)
  const decimals = s === 0
    // A flat line: both labels are the same number, so it is the value's own size that decides.
    ? (magnitude >= 100 ? 0 : magnitude >= 1 ? 1 : 3)
    : s >= 10 ? 0 : s >= 1 ? 1 : s >= 0.1 ? 2 : 3
  const fixed = value.toFixed(decimals)
  // `-0` is a real toFixed output (value -0.004 at 0 decimals) and must not be shown as a negative
  // zero on an axis.
  const stripped = decimals === 0 ? fixed : fixed.replace(/\.?0+$/, '')
  return stripped === '-0' ? '0' : stripped
}

export function applyScale(px, scale, floor) {
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, asNumber(scale, 1)))
  return Math.max(floor, Math.round(px * clamped))
}

export function cardPlan(cellHeight, count, counterEnabled, cardHeight) {
  const fit = Math.floor(cellHeight / cardHeight)
  if (count <= fit) return { visible: count, hidden: 0 }
  const visible = counterEnabled ? Math.max(0, Math.floor((cellHeight - FEED_COUNTER) / cardHeight)) : fit
  return { visible, hidden: count - visible }
}

export function isStale(feedWire, hubNow) {
  if (!isObj(feedWire)) return false
  const pushedAt = feedWire.pushed_at
  const window = feedWire.stale_after_s
  if (typeof pushedAt !== 'number' || typeof window !== 'number' || typeof hubNow !== 'number') return false
  return hubNow - pushedAt > window * 1000
}

export function feedScalarSource(feedWire) {
  if (!isObj(feedWire)) return undefined
  if (feedWire.mode === 'value') return feedWire.payload
  if (feedWire.mode === 'stream') {
    const rows = Array.isArray(feedWire.rows) ? feedWire.rows : []
    return isObj(rows[0]) ? rows[0].payload : undefined
  }
  return undefined
}

export function gaugeFraction(v, min, max) {
  const value = asNumber(v, null)
  const lo = asNumber(min, null)
  const hi = asNumber(max, null)
  if (value === null || lo === null || hi === null || !(hi > lo)) return 0
  return (Math.min(hi, Math.max(lo, value)) - lo) / (hi - lo)
}

export function gaugeSeverity(v, warn, crit) {
  const value = asNumber(v, null)
  if (value === null) return 'info'
  if (typeof crit === 'number' && value >= crit) return 'critical'
  if (typeof warn === 'number' && value >= warn) return 'warn'
  return 'info'
}

const normScale = (scale) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, asNumber(scale, 1)))

export function streamListConfig(config) {
  const c = isObj(config) ? config : {}
  const clamp = isObj(c.clamp) ? c.clamp : {}
  const overflow = isObj(c.overflow) ? c.overflow : {}
  return {
    feed: asString(c.feed),
    titlePath: typeof c.title_path === 'string' ? c.title_path : 'title',
    bodyPath: typeof c.body_path === 'string' ? c.body_path : null,
    titleLines: Number.isInteger(clamp.title_lines) ? clamp.title_lines : 1,
    bodyLines: Number.isInteger(clamp.body_lines) ? clamp.body_lines : 2,
    counter: overflow.counter !== false,
    scale: normScale(c.scale),
  }
}

export function tableConfig(config) {
  const c = isObj(config) ? config : {}
  const overflow = isObj(c.overflow) ? c.overflow : {}
  const columns = Array.isArray(c.columns) ? c.columns : []
  return {
    feed: asString(c.feed),
    // '' would mean "the payload itself is the array"; save-time validation rejects that, so an
    // empty path is normalized to "no array path" rather than to the whole payload.
    path: typeof c.path === 'string' && c.path !== '' ? c.path : null,
    columns: columns.filter((col) => isObj(col) && !Array.isArray(col)).map((col) => ({
      header: asString(col.header) ?? '',
      path: typeof col.path === 'string' ? col.path : '',
      align: col.align === 'right' ? 'right' : 'left',
    })),
    headers: c.headers !== false,
    counter: overflow.counter !== false,
    scale: normScale(c.scale),
  }
}

// ── Chart + image (chart behavior) ─────────────────────────────────────────────────────────────────
// Rules below mirror the shared data-widget contract and cover the chart's geometry invariants.
// These helpers live here with their vectors rather than in renderer code, so every renderer shares
// the same normalization behavior:
//
//   - chart config: {series:[{feed,y_path,icon,label?}] (1-4), style:'line'|'bar', window_s?,
//     y_min?, y_max?, scale?}. Series feeds must be stream mode and carry unique icons — both
//     enforced at save time (feedCheck / AJV), NOT here; this normalizer only guards against
//     already-bad data reaching a read path, same discipline as every other *Config function.
//   - seriesPoints(rows, yPath, windowS, hubNow): rows arrive newest-first (wire form); the
//     result is [{t,y}] OLDEST-first (x = pushed_at, y = numeric resolvePath(row.payload,
//     yPath)). A row whose y does not resolve to a finite number is SKIPPED, never zeroed — a
//     zeroed gap would be a lie on a metrics chart. windowS (seconds) != null drops rows with
//     t < hubNow - windowS*1000; a row exactly AT the cutoff is kept (not "older than").
//   - chartBounds(allPoints, yMin, yMax): explicit y bounds win over computed ones, independently
//     per bound (an explicit yMin with no yMax still lets yMax come from the points). rule
//     (this code): the same "degenerate span -> pad +-1" rule the contract states for y applies
//     identically to the computed t span — a chart whose points share one timestamp (or a
//     single-point chart) would otherwise divide by zero placing x pixels; padding both min and
//     max by 1 centers the point(s) instead, mirroring exactly how the y padding centers a flat
//     series. The check runs AFTER combining explicit+computed bounds, so an operator-supplied
//     y_min === y_max also gets padded, not left degenerate. No points and no explicit bounds
//     default both spans to 0 before padding, so the frame still draws (contract: a chart with
//     no resolvable points renders its frame + empty state, never a blank cell or a throw).
//   - markEvery(pointCount, maxMarks) = max(1, ceil(pointCount / maxMarks)): a dense series
//     shows its per-point icon glyph only on every k-th point so icons don't smear together;
//     CHART_MAX_MARKS gives the per-fraction ceiling (denser cells allow more marks).
//   - rule (this code: extracted to a pure, vectored function —
//     chartAllSeriesMissing): a chart series whose feed id is entirely absent from the device's
//     feed map (deleted while still referenced, or a race before the reference set catches up)
//     contributes zero points — same as any other never-pushed source — rather than blanking the
//     whole multi-series chart. Only when EVERY series resolves to no feed at all does the chart
//     fall back to the shared "feed missing" placeholder, matching the other widgets'
//     loud-placeholder behavior for a wholly unresolvable binding.
//   - rule (this code: extracted to pure, vectored functions — chartIsStale /
//     chartStaleAgeMs): chart staleness is the OR of every bound series' own
//     isStale(feedWire, hubNow) — a multi-series plot is only as fresh as its stalest input, so
//     ONE stale source is enough to dim the whole chart. The in-canvas age chip shows the OLDEST
//     (max) age among the currently-stale series — same "keep last value, 50% opacity, age chip
//     visible" treatment every other data widget gives a single stale feed, generalized to
//     "the stalest reading wins" across series.
//   - barWidth / barOffset: style:'bar' keeps each point's timestamp and offsets series side by side;
//     does NOT bucket points to a shared synthetic timestamp across series. Cron-pushed sources
//     rarely land on identical milliseconds, and a fuzzy-match tolerance would be one more
//     invented constant with no principled value; each bar is drawn at its OWN point's true t
//     (through the same xOf(t) as the line style), nudged sideways by barOffset's fixed
//     per-series offset so bars from different series landing at nearly the same instant fan out
//     instead of fully overlapping. barWidth clamps to [BAR_MIN_W, BAR_MAX_W] px so bars stay
//     visible when points are dense and don't balloon when points are sparse.
//   - rule (this code — chart `scale`): chart HONORS `scale`, via
//     CHART_RAMP below, exactly like every other visual data widget (VALUE_RAMP/GAUGE_RAMP/
//     TEXT_RAMP). CHART_RAMP is a plain per-fraction constant table (same shape/status as those
//     three — pinned by an exact-values assertion in layout-core.test.ts, NOT the vectors file,
//     matching how VALUE_RAMP/GAUGE_RAMP/TEXT_RAMP are pinned rather than vectored, since a raw
//     constant table has no input/output relationship to vector). `axisFont`/`legendFont`/`icon`
//     each pass through applyScale(·, cfg.scale, FLOOR_LABEL) except `icon`, whose floor is
//     CHART_ICON_FLOOR (3px radius) — FLOOR_LABEL (10) is calibrated for TEXT sizes; applied to an
//     icon RADIUS it would force an oversized 20px-diameter glyph at scale 0.5, so the icon glyph
//     gets its own, smaller floor (the smallest radius a filled shape still reads as a dot).
//     Derived (not separately ramped, same status as text_block's `lineHeight = ceil(size*1.4)`):
//     plot marginLeft = round(axisFontPx * 3.5) (room for the y-axis number labels), marginBottom
//     = round(axisFontPx * 1.4), legend row height = round(legendFontPx * 1.8); marginTop/
//     marginRight stay small fixed constants (6/8px) regardless of scale — they only ever need to
//     clear the frame's top-right corner, not fit growing text.
export const CHART_ICONS = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'heart', 'bolt', 'drop', 'sun', 'moon', 'flag']
export const CHART_MAX_MARKS = { full: 24, half: 12, quadrant: 8 }

/** Mark budget is a COUNT, not a size — it rounds here rather than passing through applyScale. */
export function chartMaxMarksAt(t) {
  return Math.max(1, Math.round(rampAt(CHART_MAX_MARKS.full, CHART_MAX_MARKS.half, CHART_MAX_MARKS.quadrant, t)))
}

export const CHART_RAMP = { full: { axisFont: 12, legendFont: 12, icon: 6 }, half: { axisFont: 11, legendFont: 11, icon: 5 }, quadrant: { axisFont: 10, legendFont: 10, icon: 4 } }
export const CHART_ICON_FLOOR = 3
export const BAR_MIN_W = 2
export const BAR_MAX_W = 10

export function chartConfig(config) {
  const c = isObj(config) ? config : {}
  const rawSeries = Array.isArray(c.series) ? c.series : []
  const series = rawSeries
    .filter((s) => isObj(s) && !Array.isArray(s))
    .slice(0, 4)
    .map((s) => ({
      feed: asString(s.feed),
      yPath: typeof s.y_path === 'string' ? s.y_path : '',
      icon: CHART_ICONS.includes(s.icon) ? s.icon : CHART_ICONS[0],
      label: asString(s.label),
    }))
  return {
    series,
    style: c.style === 'bar' ? 'bar' : 'line',
    windowS: Number.isInteger(c.window_s) ? c.window_s : null,
    yMin: asNumber(c.y_min, null),
    yMax: asNumber(c.y_max, null),
    scale: normScale(c.scale),
  }
}

export function seriesPoints(rows, yPath, windowS, hubNow) {
  const arr = Array.isArray(rows) ? rows : []
  const cutoff = typeof windowS === 'number' && typeof hubNow === 'number' ? hubNow - windowS * 1000 : null
  const out = []
  for (const row of arr) {
    if (!isObj(row)) continue
    const t = row.pushed_at
    if (typeof t !== 'number') continue
    if (cutoff !== null && t < cutoff) continue
    const y = resolvePath(row.payload, yPath)
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    out.push({ t, y })
  }
  return out.reverse()
}

export function chartBounds(allPoints, yMin, yMax) {
  const points = Array.isArray(allPoints) ? allPoints : []
  const ts = points.map((p) => p.t)
  const ys = points.map((p) => p.y)
  let tMin = ts.length ? Math.min(...ts) : 0
  let tMax = ts.length ? Math.max(...ts) : 0
  if (tMin === tMax) { tMin -= 1; tMax += 1 }
  let loY = typeof yMin === 'number' ? yMin : (ys.length ? Math.min(...ys) : 0)
  let hiY = typeof yMax === 'number' ? yMax : (ys.length ? Math.max(...ys) : 0)
  if (loY === hiY) { loY -= 1; hiY += 1 }
  return { tMin, tMax, yMin: loY, yMax: hiY }
}

export function markEvery(pointCount, maxMarks) {
  const n = asNumber(pointCount, 0)
  const max = asNumber(maxMarks, 1)
  return Math.max(1, Math.ceil(n / (max > 0 ? max : 1)))
}

/**
 * Chart "loud placeholder vs partial data" rule (rule above). Pure over the series list and
 * the set of feed ids the device currently has ANY wire-form entry for — the renderer supplies
 * `Object.keys(feeds)` as `availableFeedIds`. A series that isn't a plain object (garbage config)
 * counts as missing, same as a series with no matching feed.
 */
export function chartAllSeriesMissing(series, availableFeedIds) {
  const list = Array.isArray(series) ? series : []
  if (list.length === 0) return true
  const available = new Set(Array.isArray(availableFeedIds) ? availableFeedIds : [])
  return list.every((s) => !isObj(s) || !available.has(s.feed))
}

/**
 * Chart-level staleness (rule above): OR of every bound series' own isStale. Takes the WIRE
 * objects directly (not series configs) — the renderer maps cfg.series to feeds[s.feed] first.
 * A missing wire (series feed absent from the map — JS `undefined` or, in the vectors, JSON
 * `null`) contributes no staleness vote, same null-safety isStale already has on its own.
 */
export function chartIsStale(seriesFeedWires, hubNow) {
  const wires = Array.isArray(seriesFeedWires) ? seriesFeedWires : []
  return wires.some((wire) => isStale(wire, hubNow))
}

/**
 * The oldest (largest) age among the currently-stale series, for the chart's in-canvas age chip
 * (rule above: "the stalest reading wins"). null when nothing is stale — the renderer's signal
 * not to draw a chip at all.
 */
export function chartStaleAgeMs(seriesFeedWires, hubNow) {
  const wires = Array.isArray(seriesFeedWires) ? seriesFeedWires : []
  const ages = wires.filter((wire) => isStale(wire, hubNow)).map((wire) => hubNow - wire.pushed_at)
  return ages.length > 0 ? Math.max(...ages) : null
}

/**
 * Bar width in px for style:'bar' (rule above — "how to bucket bar series"). Shrinks as more
 * points/series compete for the same plot width, clamped to [BAR_MIN_W, BAR_MAX_W] so bars stay
 * visible when dense and don't balloon when sparse. The `Math.max(8, …)` denominator floor keeps
 * a near-empty chart (0 or 1 point) from a division blowup — it hits BAR_MAX_W via the clamp
 * instead, same outcome as any other very-sparse chart.
 */
export function barWidth(plotWidthPx, pointCount, seriesCount) {
  const w = asNumber(plotWidthPx, 0)
  const n = Math.max(1, Math.floor(asNumber(seriesCount, 1)))
  const p = Math.max(0, Math.floor(asNumber(pointCount, 0)))
  return Math.max(BAR_MIN_W, Math.min(BAR_MAX_W, w / Math.max(8, p * n)))
}

/**
 * Horizontal nudge (px) for one series' bars within a style:'bar' chart (rule above). Centers
 * the whole series' group on zero: series are laid out symmetrically around the point's true x,
 * `barWidth + 1`px apart center-to-center (the +1 is a hairline gap so adjacent bars don't visually
 * fuse). A single series always offsets by 0 — nothing to fan out around.
 */
export function barOffset(seriesIndex, seriesCount, barW) {
  const i = asNumber(seriesIndex, 0)
  const n = Math.max(1, asNumber(seriesCount, 1))
  const bw = asNumber(barW, 0)
  return (i - (n - 1) / 2) * (bw + 1)
}

/**
 * Clamp a chart point's already-computed y PIXEL into the plot rect (rule,
 * An operator-set `y_min`/`y_max` bounds the AXIS, not the data — nothing stops a
 * reading from landing outside it — so before this existed a spike past `y_max` drew above the
 * plot rect (straight over the y-axis number labels and the stale age chip) and a dip past
 * `y_min` drew below the x axis. In bar style the two renderers additionally DISAGREED about the
 * result: the browser's `fillRect` happily took the resulting negative height (bar hung below the
 * axis). Pinning the point to the nearest plot edge keeps the drawing inside the plot and is the
 * honest rendering of "this reading is off the top of the scale you chose".
 *
 * Pure and vectored — every vector value is represented exactly. Clamping (rather than dropping)
 * also keeps the line continuous: a spike flat-tops at the edge instead of leaving a hole the eye
 * reads as missing data. `asNumber` guards mirror barWidth's for untyped vector input.
 */
export function clampPlotY(y, plotY, plotH) {
  const top = asNumber(plotY, 0)
  const bottom = top + Math.max(0, asNumber(plotH, 0))
  return Math.min(bottom, Math.max(top, asNumber(y, 0)))
}

export function imageConfig(config) {
  const c = isObj(config) ? config : {}
  return {
    feed: asString(c.feed),
    fit: c.fit === 'cover' ? 'cover' : 'contain',
  }
}

/**
 * Scale for alert_feed. (Clock's own scale story is
 * clockTimePx/clockDatePx above, alongside rampAt — it moved onto the continuous-`t` ramp
 * directly rather than keeping its own fraction-bucketed clockTimeSize/clockDateSize pair around
 * after tab-bar behavior retired that pair from both languages.)
 *
 * This widget predates the data-widget `scale` vocabulary, so its sizes were hardcoded: the
 * editor offered a scale control its save schema rejected outright (400), and even once accepted
 * it would have been a dead knob. These helpers are what makes it real.
 *
 * FEED_TITLE/BODY/META preserve the existing browser sizes, so scale 1 is pixel-identical to the
 * previous release on every cell size — alert_feed text does not vary by
 * cell size today and this change does not introduce that.
 *
 * Card HEIGHT scales too, and that is deliberate: text-only scaling would grow the type inside a
 * fixed 132px card and clip it at 2x. The scaled height is PASSED to cardPlan rather than baked
 * into FEED_CARD, so the vectored overflow arithmetic is unchanged — FEED_CARD stays the base
 * constant. Do NOT "finish the job" by scaling FEED_CARD itself.
 */
export const FEED_TITLE = 17
export const FEED_BODY = 13
export const FEED_META = 12
export const FEED_CARD_MIN = 48

export function feedTextSizes(scale) {
  return {
    title: applyScale(FEED_TITLE, scale, FLOOR_LABEL),
    body: applyScale(FEED_BODY, scale, FLOOR_LABEL),
    meta: applyScale(FEED_META, scale, FLOOR_LABEL),
  }
}

/** Scaled card height for cardPlan; floored so a tiny scale cannot make cards unreadable slivers. */
export function feedCardHeight(scale) {
  return applyScale(FEED_CARD, scale, FEED_CARD_MIN)
}
