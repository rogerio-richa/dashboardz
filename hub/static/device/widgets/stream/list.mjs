/**
 * `stream_list` — recent rows off a stream feed, shown as titled cards, newest first.
 *
 * The sixth design migrated off the hand-written DOM branch (device.js) and the first to consume
 * `ctx.rows` (part of the widget contract): a stream-bound cell's rows as
 * `{payload, pushed_at}`, newest first, so a design can draw a per-row age chip without also
 * needing `ctx.data`'s flattened payload-only array. Structurally this follows `value/tile.mjs`
 * and `text/block.mjs`: a pure `normalizeStream(rows, feed, config, now)` doing every read-path/age
 * decision, and a `draw` that only paints what normalize decided.
 *
 * `streamListConfig`/`cardPlan`/`resolvePath`/`displayValue`/`STREAM_RAMP`/`STREAM_CARD_TITLE`/
 * `STREAM_CARD_BODY` are imported from `../../layout-core.mjs` rather than reimplemented — same
 * rule `value/tile.mjs`'s docstring gives for `resolvePath`/`displayValue`: they are already
 * pure browser ESM with no DOM dependency, and restating them a second time is exactly the kind of
 * copy the widget contract exists to avoid. `formatAge`/`paintText` still come from `../text-fit.mjs`
 * per the shared contract (contract) — this design does NOT restate `ageChip`'s wording a
 * second time; `formatAge` is byte-identical to it by construction.
 *
 * `wrapClamped` was defined here until `alert_feed` needed the same `-webkit-line-clamp`
 * translation for its own `clamp.title_lines`/`body_lines`. It now lives in `../text-fit.mjs`
 * alongside the other shared text helpers, on the same reasoning the paragraph above gives: a
 * second byte-identical copy is what that module exists to prevent.
 *
 * THE ONE RULE, stated once (docs/architecture/widgets.md's own statement of it, and
 * `table/grid.mjs`'s `normalizeTable`, which this follows exactly): a design is LOUD when the
 * binding is WRONG, and QUIET when the binding is RIGHT but the feed is simply empty. Three
 * distinct states result, preserved exactly as the DOM branch drew the first and third:
 *   - `ctx.rows` has entries → cards, one per visible row, overflow planned by `cardPlan` exactly
 *     as the DOM branch planned it.
 *   - the binding is WRONG — no feed is bound (`ctx.feed === null`), the bound id does not resolve
 *     (`ctx.feed.missing`), or it resolves to a feed of a mode this widget cannot read (a VALUE
 *     feed; `widgetAcceptsMode`, `../bindings.mjs`) — → the LOUD "Feed missing" notice, same
 *     severity `value_tile`'s "No value" gets. This is the one notice that tells an operator they
 *     bound the wrong KIND of feed, or no feed at all, and it does not soften for any of the three.
 *   - the binding is RIGHT — the feed exists, is a mode this widget CAN read, but has never been
 *     pushed to (`ctx.feed.pushed_at === null`) — → the QUIET `— no rows yet` line, matching the
 *     old DOM branch's `<div class="clock-date">` treatment verbatim — never-pushed is quiet, not a
 *     failure (layout-core.mjs's own staleness section).
 *
 * `ctx.rows` alone cannot always tell the last two apart: `rowsForCell` (widgets/index.mjs) already
 * degrades a well-formed, never-pushed stream feed to `[]` (quiet) and a wrong-mode or unresolvable
 * one to `null`, but it also degrades to `null` on a malformed wire (e.g. one bad row, or a host
 * that never attached a `rows` key at all) that `ctx.feed` can still tell is a correctly-moded feed
 * nobody has pushed to. `ctx.feed` is read for exactly that gap — the same reason `table` reads it
 * — so a stream cell degrades toward the quiet line whenever the delivery facts say the binding is
 * right, rather than toward the loud one whenever the row shaping alone comes back empty-handed.
 *
 * `scale` moves TEXT ONLY (contract, and layout-core.mjs's own rule comment above
 * `STREAM_CARD_TITLE`): `STREAM_CARD_TITLE`/`STREAM_CARD_BODY` are inputs to `cardPlan`'s vectored
 * overflow arithmetic on BOTH renderers and are never scaled here, even though they read like a
 * size a design would naturally scale. A big `scale` can therefore paint text taller than its own
 * row band — accepted, per the same rule, rather than "finishing the job" and quietly moving
 * which rows fit.
 *
 * The per-row age caption paints at a fixed size (`AGE_CHIP_PX`, unscaled) rather than through
 * `STREAM_RAMP`+`applyScale` the way title/body do — the DOM branch's own `.age-chip` CSS rule
 * (`index.html`) has always hardcoded `font-size: 10px` with no inline override, unlike
 * `.stream-title`/`.stream-body`, which device.js set inline from the scaled ramp. Scaling it here
 * would be a behavior CHANGE, not a preserved default (contract).
 */
import {
  streamListConfig, cardPlan, resolvePath, displayValue, applyScale, rampValues,
  STREAM_RAMP, STREAM_CARD_TITLE, STREAM_CARD_BODY, FLOOR_LABEL, AGE_CHIP_PX,
} from '../../layout-core.mjs'
import { centredNotice, fitted, formatAge, paintText, quietLine, wrapClamped } from '../text-fit.mjs'
// A pure, import-free data module (bindings.mjs's own docstring) — the one home for which feed
// modes each widget may bind. See this file's state list above for why the quiet line is gated on
// it, exactly as `table/grid.mjs` and `value/tile.mjs` gate their own.
import { widgetAcceptsMode } from '../bindings.mjs'

const meta = {
  id: 'list',
  widget: 'stream_list',
  label: 'Stream list',
  // Matches definitions.mjs's own `stream_list` entry (suggested_ratio: 3/4) — same discipline
  // `value/tile.mjs` follows for its own widget type.
  suggested_ratio: 3 / 4,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    title_path: { type: 'text', label: 'Title path', default: 'title' },
    // '' (not omitted) matches `streamListConfig`'s own default resolution: an empty string and an
    // absent key both normalize to `bodyPath: null`/"no body line" (typeof check passes either
    // way, and `cfg.bodyPath ?` treats '' as falsy identically to null) — see streamListConfig.
    body_path: { type: 'text', label: 'Body path', default: '' },
    // Nested knobs, declarable through `meta.options`'s `path`. `clamp.title_lines`/
    // `clamp.body_lines`/`overflow.counter` had no admin control AT ALL before this — they were
    // unreachable from the editor and undiscoverable from the contract. The defaults restate
    // `streamListConfig`'s own (`title_lines` 1, `body_lines` 2, `counter` true), so an unset field
    // shows what the panel will actually draw; `min`/`max` restate the save schema's `integer,
    // 1..10` (`hub/src/routes/admin.ts`'s `stream_list` branch, pinned by option-bounds.test.ts).
    title_lines: { type: 'number', label: 'Title lines', default: 1, min: 1, max: 10, path: 'clamp.title_lines' },
    body_lines: { type: 'number', label: 'Body lines', default: 2, min: 1, max: 10, path: 'clamp.body_lines' },
    counter: { type: 'boolean', label: 'Overflow counter', default: true, path: 'overflow.counter' },
  },
  animations: { transition: [], persistent: [] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const isRecord = (value) => value !== null && typeof value === 'object'

/** Board payloads are attacker-adjacent; a JSON.stringify that throws (a circular payload) must
 *  not take the whole cell's paint down with it — matches `displayValue`'s own object branch. */
function jsonFallback(payload) {
  try {
    return JSON.stringify(payload ?? null)
  } catch {
    return '—'
  }
}

/**
 * The reasoning: every read-path decision and every row's age, none of the painting.
 *
 * `rows` is `ctx.rows` verbatim: `null` when this cell is not stream-bound (or
 * the feed is absent from the map, or the wire was malformed), `[]` for a well-formed empty stream,
 * else `{payload, pushed_at}[]` newest-first. `feed` is `ctx.feed` verbatim: `null` when this cell
 * binds no feed, `missing: true` when it binds one the device does not have, else the bound feed's
 * delivery facts. See this file's own docstring for the one rule and for which state `ctx.feed`
 * resolves that `rows` alone cannot.
 */
export function normalizeStream(rows, feed, config, now) {
  const cfg = streamListConfig(config)
  const at = finite(now) ? now : 0
  const base = {
    scale: cfg.scale,
    bodyPath: Boolean(cfg.bodyPath),
    titleLines: cfg.titleLines,
    bodyLines: cfg.bodyLines,
    counter: cfg.counter,
  }

  if (!isArray(rows)) {
    // `rows` is not an array: not stream-bound, wrong mode, unresolvable, or a malformed wire.
    // `ctx.feed` is the one channel that can still tell "this IS a stream feed nobody has pushed
    // to" apart from "this binding is wrong" here — a feed that is THERE, is a mode this widget
    // could actually read, and has never been pushed to. See this file's docstring for the rule,
    // and `table/grid.mjs`'s `normalizeTable` for the identical shape.
    const neverPushed = isRecord(feed) && feed.missing !== true &&
      widgetAcceptsMode(meta.widget, feed.mode) && feed.pushed_at === null
    return { ...base, state: neverPushed ? 'empty' : 'missing', rows: [] }
  }
  if (rows.length === 0) return { ...base, state: 'empty', rows: [] }

  const items = rows.map((row) => {
    const payload = row !== null && typeof row === 'object' ? row.payload : undefined
    const titleVal = resolvePath(payload, cfg.titlePath)
    // The renderer's fallback (contract): a `title_path` that
    // resolves to nothing shows the whole row as compact JSON rather than an em-dash — there is no
    // "no title" state for a stream row the way there is for value_tile's single value.
    const title = titleVal === undefined ? jsonFallback(payload) : displayValue(titleVal, 'raw', null)
    const bodyVal = cfg.bodyPath ? resolvePath(payload, cfg.bodyPath) : undefined
    const body = bodyVal === undefined ? null : displayValue(bodyVal, 'raw', null)
    const pushedAt = row !== null && typeof row === 'object' && typeof row.pushed_at === 'number' ? row.pushed_at : null
    const ageMs = pushedAt === null ? null : Math.max(0, at - pushedAt)
    return { title, body, ageMs }
  })
  return { ...base, state: 'ready', rows: items }
}

/**
 * ONE stream card — title lines, optional body lines, age caption — at vertical offset `y`.
 *
 * Split out of `draw` when `stream/scroll.mjs` arrived: the scrollable design paints the exact
 * same card at a translated `y`, and a second byte-identical copy of this block is what the
 * widget contract exists to prevent (same rule as `wrapClamped`'s move to `text-fit.mjs`).
 * `plan` carries `normalizeStream`'s decisions (`bodyPath`, `titleLines`, `bodyLines`); the
 * caller owns card height and overflow — this paints one card, it does not plan the column.
 */
export function paintCard(g, row, y, { pad, usableWidth, titlePx, bodyPx, tokens, stale, plan }) {
  const lineHeight = (px) => Math.round(px * 1.2)
  g.globalAlpha = stale ? 0.5 : 1
  let cursor = y + 4 // `.stream-row`'s own 4px top padding (index.html)
  for (const line of wrapClamped(g, row.title, titlePx, 600, usableWidth, plan.titleLines)) {
    paintText(g, line, pad, cursor, {
      px: titlePx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.ink, align: 'left', baseline: 'top', weight: 600,
    })
    cursor += lineHeight(titlePx)
  }
  if (plan.bodyPath && row.body !== null) {
    cursor += 2 // `.stream-body`'s own margin-top (index.html)
    for (const line of wrapClamped(g, row.body, bodyPx, 400, usableWidth, plan.bodyLines)) {
      paintText(g, line, pad, cursor, {
        px: bodyPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
        color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
      })
      cursor += lineHeight(bodyPx)
    }
  }
  if (row.ageMs !== null) {
    cursor += 2 // `.age-chip`'s own margin-top (index.html)
    // Fixed AGE_CHIP_PX, unscaled — see this file's own docstring on why the age caption does
    // not go through applyScale the way title/body do. Not FLOOR_LABEL: that constant is the
    // floor SCALED text shrinks to, a different meaning this fixed, never-scaled size only used
    // to borrow (layout-core.mjs's own docstring on AGE_CHIP_PX).
    paintText(g, formatAge(row.ageMs), pad, cursor, {
      px: AGE_CHIP_PX, floor: AGE_CHIP_PX, maxWidth: usableWidth,
      color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
    })
  }
  g.globalAlpha = 1
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
    // Verbatim the old DOM branch's own wording and quiet treatment (`.clock-date`) — a never-
    // pushed stream is not a failure (contract).
    quietLine(g, '— no rows yet', box, tokens, pad, n.scale)
    return
  }

  // Card height (unscaled — contract) is chosen once for the whole widget from whether a
  // body path is configured at all, exactly as `cardHeight = cfg.bodyPath ? STREAM_CARD_BODY :
  // STREAM_CARD_TITLE` did in the DOM branch — NOT per row, so a row whose own body happens not to
  // resolve still reserves body-sized space (the DOM branch's `<div style="height:${cardHeight}">`
  // was set once per row template, not per resolved value).
  const cardHeight = n.bodyPath ? STREAM_CARD_BODY : STREAM_CARD_TITLE
  const plan = cardPlan(box.h, n.rows.length, n.counter, cardHeight)
  // `plan.visible` can go NEGATIVE on a tiny cell (contract) — guarded exactly as the old
  // branch guarded it, so `slice(0, plan.visible)` can never render "all but the last row".
  const visibleCount = Math.max(0, plan.visible)
  const visible = n.rows.slice(0, visibleCount)

  const ramp = rampValues(STREAM_RAMP, box.t ?? 1)
  const titlePx = applyScale(ramp.title, n.scale, FLOOR_LABEL)
  const bodyPx = applyScale(ramp.body, n.scale, FLOOR_LABEL)
  const usableWidth = Math.max(0, box.w - pad * 2)
  const stale = ctx.stale === true

  let y = 0
  for (const row of visible) {
    paintCard(g, row, y, { pad, usableWidth, titlePx, bodyPx, tokens, stale, plan: n })
    y += cardHeight
  }

  if (plan.hidden > 0 && n.counter) {
    // `.feed-counter`'s own fixed 14px (index.html) — unscaled, same reasoning as the age caption.
    const counterFit = fitted(g, `and ${plan.hidden} more`, 14, FLOOR_LABEL, usableWidth, 400)
    paintText(g, counterFit.text, pad, y + 7, {
      px: counterFit.px, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
    })
  }
}

export default { meta, draw }
