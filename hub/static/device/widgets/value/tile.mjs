/**
 * `value_tile` — a label above a big number (plus an optional unit), read off a feed. The second
 * design migrated off the hand-written DOM branch (device.js), after screen state's `text_block`
 * (`../text/block.mjs`) proved the widget contract (portable drawing subset). Structurally this follows that file: a
 * pure `normalizeValue(data, config)` doing every read-path/format decision, and a `draw` that only
 * paints what normalize decided, using the shared `fitted()`/`paintText()` shrink-to-fit helpers
 * from `../text-fit.mjs` — a pure helper module, which the contract permits (see
 * `docs/architecture/widgets.md`). Keeping the shared helpers in one module avoids byte-identical
 * copies with different justifications in each design.
 *
 * Unlike `text/block.mjs`, this file DOES import `resolvePath`/`displayValue` from
 * `../../layout-core.mjs` rather than reimplementing them — both
 * are already pure browser ESM with no DOM dependency, and `value_tile`'s formatting (`format`/
 * `decimals`) is exactly `displayValue`'s own contract, not worth restating a second time the way
 * `text_block`'s much simpler passthrough was.
 *
 * `ctx.stale`/`ctx.age_ms` (widget contract): `stale` alone drives the dimmed
 * treatment; the age caption renders whenever the bound feed has actually been pushed to
 * (`age_ms !== null`), fresh or stale alike. A bound-but-never-pushed feed, or no feed at all,
 * renders identically — quiet, no caption, no dimming. The age caption appears on every actual
 * push (device.js:284's "never-pushed is quiet, not stale" rule), matching the component contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THREE STATES: `ctx.feed` distinguishes the feed cases that `ctx.data` alone cannot.
 *
 * `normalizeValue`'s `available` check folded two opposite situations into one LOUD "No value":
 * a cell bound to nothing (or to a feed this device does not have) and a cell bound to a REAL feed
 * nobody has ever pushed to. Both arrive as `ctx.data === null`, because a never-pushed value
 * feed's `payload` is legitimately `null`, so this design could not tell them apart and picked the
 * scarier one. An operator with a correctly configured, simply empty feed was told the feed was
 * missing.
 *
 * `ctx.feed` (widgets/index.mjs's `feedSignalFor`) is the fact that separates them:
 *   - a resolvable value → `ready`, the tile.
 *   - nothing to show, and the feed EXISTS (`missing: false`), is a kind this widget can read, and
 *     `ctx.feed.pushed_at === null` → `pending`, the QUIET `— no value yet` line, in the same dim,
 *     centred treatment `stream_list`/`table` give their own `— no rows yet` and `image` gives
 *     `— no image yet`. Never-pushed is quiet, not a failure.
 *   - nothing to show otherwise → `missing`, the LOUD "No value" notice, unchanged.
 *
 * The third bullet is deliberately still loud, and it is what keeps the notice worth reading. It
 * covers three different mistakes, all of which a person has to go and fix:
 *   - `ctx.feed === null` — nothing bound. The channel calls that NOT APPLICABLE rather than wrong
 *     (`ctx.rows`/`ctx.series` say `null` the same way), because a `chart` or a literal-text
 *     `text_block` is perfectly correct with no feed; a value tile is not, so the rule is:
 *     design's, made here rather than read off the channel.
 *   - `ctx.feed.missing` — bound to a feed id the device does not have. The channel's own loud state.
 *   - a feed that HAS been pushed to but whose `path` resolves to nothing, or a feed of a kind this
 *     widget cannot read at all (an IMAGE feed — `widgetAcceptsMode`, ../bindings.mjs). A `path`
 *     typo, a payload shape that changed, a binding to the wrong sort of source: "No value / Bind a
 *     feed with a numeric path" is exactly the sentence that fixes all three. The mode half matters
 *     on its own — without it, a tile bound to a brand-new image feed drew the quiet line and only
 *     turned loud once somebody pushed a picture, telling the operator last.
 *
 * Only the never-pushed case, on a feed this widget could actually have read, moved.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { resolvePath, displayValue, FLOOR_VALUE, FLOOR_LABEL } from '../../layout-core.mjs'
import { centredNotice, fitted, formatAge, paintText } from '../text-fit.mjs'
// A pure, import-free data module (bindings.mjs's own docstring) — the one home for which feed
// modes each widget may bind, and the same set the hub enforces on save. See the state list above.
import { widgetAcceptsMode } from '../bindings.mjs'

const meta = {
  id: 'tile',
  widget: 'value_tile',
  label: 'Value',
  // Matches definitions.mjs's own `value_tile` entry (suggested_ratio: 3/2) — a design must not
  // silently disagree with the widget's own declared shape.
  suggested_ratio: 3 / 2,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    label: { type: 'text', label: 'Label', default: '' },
    unit: { type: 'text', label: 'Unit', default: '' },
    // A LIVE knob that had no way to be reached: the grid schema has always accepted
    // `format: { enum: ['raw', 'abbrev'] }` (`hub/src/routes/admin.ts`'s `value_tile` branch) and
    // `normalizeValue` below has always read it, but it was declared in neither `meta.options` nor
    // any hand-built admin field — so the only way to set it was to write the cell's JSON by hand.
    //
    // Unlike `decimals` just below, this one DOES declare a default, and the difference is the
    // point: `normalizeValue`'s own rule is `c.format === 'abbrev' ? 'abbrev' : 'raw'`, so `'raw'`
    // is a real value the knob holds and a select showing it is telling the truth about what an
    // unset cell renders — not a placebo standing in for an unset meaning that has no value of its
    // own type. `choices` equals the schema's enum exactly, in the same spirit as the `max: 3` note
    // below: a generated control must only ever offer a value the grid PATCH accepts, because the
    // 400 it earns fails the whole screen's save rather than just this cell.
    format: { type: 'select', label: 'Format', default: 'raw', choices: ['raw', 'abbrev'] },
    // No `default` (registry.mjs's `validateOptions` allows an
    // option to omit it): `valueConfig`'s own default (`decimals: null`, layout-core.mjs) has
    // always meant "no forced rounding — print the raw number", which is not a value `decimals`
    // could ever legitimately hold. A placebo numeric default (an earlier version of this file used
    // `0`) would have been indistinguishable, in the admin's generated field, from an operator who
    // actually typed 0 — this omission is the honest declaration instead.
    // `max: 3`, not 10: the grid PATCH schema (`hub/src/routes/admin.ts`, the `value_tile` branch)
    // has long accepted `decimals` only as `integer, minimum 0, maximum 3`, and saved data depends
    // on that bound. The hand-built admin field this design replaced used `max={3}` and agreed with
    // it; declaring 10 here made the GENERATED field offer four values (4..10) the server rejects
    // with a 400 that fails the whole grid save, not just this cell. `hub/test/option-bounds.test.ts`
    // now reads both sides and fails if a design's bound ever again exceeds the schema's.
    decimals: { type: 'number', label: 'Decimals', min: 0, max: 3 },
  },
  animations: { transition: [], persistent: [] },
}

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const record = (value) =>
  value !== null && typeof value === 'object' && !isArray(value) ? value : null

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * A design's `data` is `dataForCell`'s output: a value feed's payload unwrapped, or (on a stream
 * feed) every row's payload as an array. The newest row is what the old DOM branch read off a
 * stream feed via `feedScalarSource` (layout-core.mjs) — this is that same rule restated against
 * the new shape, same as `text/block.mjs`'s own `scalarSource`. A value feed's payload is used
 * as-is even when it happens to be an array itself — there is no feed-mode flag left in `data` to
 * tell the two apart.
 */
function scalarSource(data) {
  return isArray(data) ? data[0] : data
}

/**
 * Every knob `valueConfig` (layout-core.mjs) has ever read, carried over verbatim: `label`, `unit`,
 * `format`, `decimals`, `scale` (plus `path`, read against `data` rather than a raw feed wire —
 * `feed` itself is resolved upstream into `data` by `dataForCell`, same as every other migrated
 * design). `format` IS a declared option now (see `meta.options` above) — it was reachable only
 * through raw config until then, which is the bug that declaration fixes; `scale` still is not,
 * same as `text_block`'s own `scale`, because it is the shared knob no design declares.
 *
 * A non-numeric resolved value renders as `displayValue`'s own em-dash placeholder rather than
 * being echoed as text — the required, NEW behavior a value tile only ever shows a number
 * (matching the still-DOM `gauge` branch's `numeric ? displayValue(...) : '—'` rule) — the old
 * value_tile DOM branch did not have this guard, and would have echoed a string value verbatim.
 * this code's test pins this exact behavior as a deliberate
 * behavior change, not a preserved default.
 *
 * `feed` is `ctx.feed` verbatim — `null` when this cell binds no feed, `missing: true` when it binds
 * one the device does not have, else the bound feed's delivery facts. It decides only WHICH
 * unavailable state is drawn (see the state list in this file's docstring); it never contributes a
 * value.
 */
export function normalizeValue(data, feed, config) {
  const c = record(config) ?? {}
  const label = typeof c.label === 'string' ? c.label : ''
  const unit = typeof c.unit === 'string' ? c.unit : ''
  const format = c.format === 'abbrev' ? 'abbrev' : 'raw'
  const decimals = Number.isInteger(c.decimals) ? c.decimals : null
  const scale = finite(c.scale) ? Math.min(2, Math.max(0.5, c.scale)) : 1
  const path = typeof c.path === 'string' ? c.path : ''

  const raw = resolvePath(scalarSource(data), path)
  // `null` counts as "nothing to show" alongside `undefined` — the same rule `text/block.mjs`'s
  // `boundText` applies (a resolved-but-null value is treated as absent, not a literal value to
  // print). It matters specifically for an EMPTY `path` (the widget's own default): `resolvePath`
  // short-circuits an empty path to the value itself rather than walking into it, so an unbound
  // cell (`data: null`, no path configured) resolves to `null`, not `undefined` — without this
  // check that cell would render a bare em-dash tile instead of the "No value" notice every other
  // unbound cell gets.
  const available = raw !== undefined && raw !== null
  // A feed that is THERE, is a kind this widget could actually read, and has never been pushed to —
  // the one combination that tells the QUIET state from the LOUD one (see this file's docstring). A
  // `ctx.feed` that is absent altogether (an older host, a hand-built context) reads as "no feed",
  // the direction this design has always degraded in.
  const neverPushed = record(feed) !== null && feed.missing !== true &&
    widgetAcceptsMode(meta.widget, feed.mode) && feed.pushed_at === null
  const state = available ? 'ready' : (neverPushed ? 'pending' : 'missing')
  const numeric = typeof raw === 'number' && Number.isFinite(raw)
  // `displayValue(undefined, ...)` is the SAME em-dash placeholder a truly-missing value gets
  // (layout-core.mjs's PLACEHOLDER) — reusing the imported formatter for that placeholder rather
  // than hand-rolling the character keeps this file from reimplementing `displayValue`'s own
  // contract, matching the renderer's shared behavior.
  const value = displayValue(numeric ? raw : undefined, format, decimals)

  // `state`, not the old boolean `available`: there are three answers now, and a boolean plus a
  // second flag beside it is two fields for one fact — the shape every other migrated design
  // (`normalizeStream`/`normalizeTable`/`normalizeImage`) already rejected in favour of one `state`.
  return { state, value, label, unit, scale }
}

/** Exact width `text` renders at `px`/`weight`, for centring the value+unit group as one unit. */
function textWidth(g, text, px, weight) {
  g.font = `${weight} ${px}px system-ui`
  return g.measureText(text).width
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeValue(data, ctx.feed ?? null, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (n.state === 'missing') {
    centredNotice(g, 'No value', 'Bind a feed with a numeric path', box, tokens, pad, n.scale)
    return
  }
  if (n.state === 'pending') {
    // The QUIET never-pushed line — `stream_list`/`table`'s `— no rows yet` and `image`'s
    // `— no image yet` in this widget's own words, at the same dim, centred, mid-cell treatment
    // (`.clock-date`). Sized exactly as `table`'s own quiet line is, so a board of half-empty cells
    // reads as one voice rather than four.
    const px = Math.max(FLOOR_LABEL, Math.round(Math.min(16, box.w * 0.04) * n.scale))
    paintText(g, '— no value yet', box.w / 2, box.h / 2, {
      px, floor: FLOOR_LABEL, maxWidth: Math.max(0, box.w - pad * 2),
      color: tokens.dim, align: 'center', baseline: 'middle', weight: 400,
    })
    return
  }

  // `ctx.stale`/`ctx.age_ms` — see this file's docstring and `../text/block.mjs`'s (the contract's
  // origin, refined across earlier implementations). `stale` drives only the dimmed treatment; the age
  // caption shows whenever the bound feed has actually been pushed to, independent of staleness.
  const stale = ctx.stale === true
  const ageMs = typeof ctx.age_ms === 'number' ? ctx.age_ms : null
  const showAge = ageMs !== null
  const valueColor = stale ? tokens.dim : tokens.ink

  const usableWidth = Math.max(0, box.w - pad * 2)
  const usableHeight = Math.max(0, box.h - pad * 2)
  const showLabel = n.label !== ''
  const showUnit = n.unit !== ''

  // Sized off the smaller box axis, same proportion the old VALUE_RAMP gave the value versus its
  // label/unit/age chip (value biggest, everything else a fraction of it) — restated continuously
  // against `box` since a design has no discrete full/half/quadrant bucket to ramp through.
  const valuePx = Math.max(FLOOR_VALUE, Math.round(Math.min(usableHeight * 0.55, box.w * 0.24) * n.scale))
  const labelPx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.24))
  const unitPx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.32))
  const agePx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.24))
  const gap = Math.max(2, Math.round(valuePx * 0.1))

  // Value + unit paint as one horizontally-centred group, unit trailing at its own smaller size —
  // the canvas equivalent of the DOM's `<span class="tile-unit">` sitting right after `.tile-
  // value`'s text. The unit's width is reserved up front so the value's own fit pass never
  // overlaps it.
  const unitGap = showUnit ? Math.max(2, Math.round(unitPx * 0.2)) : 0
  const unitWidth = showUnit ? textWidth(g, n.unit, unitPx, 400) : 0
  const valueMaxWidth = Math.max(0, usableWidth - unitWidth - unitGap)
  const valueFit = fitted(g, n.value, valuePx, FLOOR_VALUE, valueMaxWidth > 0 ? valueMaxWidth : usableWidth, 700)
  const valueWidth = valueFit.text ? textWidth(g, valueFit.text, valueFit.px, 700) : 0
  const groupWidth = valueWidth + (showUnit && valueFit.text ? unitGap + unitWidth : 0)

  // Vertical stack: label?, value+unit group, age caption? — centred as a whole, same idea as
  // `text/block.mjs`'s main-line+caption pair.
  const labelBlock = showLabel ? labelPx + gap : 0
  const ageBlock = showAge ? gap + agePx : 0
  const totalHeight = labelBlock + valueFit.px + ageBlock
  let y = box.h / 2 - totalHeight / 2

  if (showLabel) {
    paintText(g, n.label, box.w / 2, y, {
      px: labelPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 500,
    })
    y += labelPx + gap
  }

  const groupX = box.w / 2 - groupWidth / 2
  paintText(g, valueFit.text, groupX, y, {
    px: valueFit.px, floor: FLOOR_VALUE, maxWidth: valueMaxWidth > 0 ? valueMaxWidth : usableWidth,
    color: valueColor, align: 'left', baseline: 'top', weight: 700,
  })
  if (showUnit && valueFit.text) {
    paintText(g, n.unit, groupX + valueWidth + unitGap, y + Math.max(0, valueFit.px - unitPx),
      { px: unitPx, floor: FLOOR_LABEL, maxWidth: usableWidth, color: tokens.dim, align: 'left', baseline: 'top', weight: 400 })
  }
  y += valueFit.px

  if (showAge) {
    y += gap
    paintText(g, formatAge(ageMs), box.w / 2, y, {
      px: agePx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 400,
    })
  }
}

export default { meta, draw }
