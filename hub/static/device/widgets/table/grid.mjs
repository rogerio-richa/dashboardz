/**
 * `table` — rows organised into named columns, read off either feed mode. The seventh design
 * migrated off the hand-written DOM branch (device.js) and the second (after `stream/list.mjs`) to
 * consume `ctx.rows` (an addition to the widget contract) — but the first to also read
 * `ctx.data`, because this is the one widget that has always accepted BOTH a stream feed and a
 * value feed. Structurally this follows `value/tile.mjs` and `stream/list.mjs`: a pure
 * `normalizeTable(data, rows, config)` doing every read-path/format decision, and a `draw` that
 * only paints what normalize decided, using the shared `fitted()`/`paintText()` from
 * `../text-fit.mjs` (contract). `tableConfig`/`cardPlan`/`resolvePath`/`displayValue`/
 * `applyScale`/`rampValues`/`TABLE_RAMP`/`TABLE_ROW`/`TABLE_HEADER` are imported from
 * `../../layout-core.mjs` rather than reimplemented, same rule `value/tile.mjs`'s docstring gives.
 *
 * WHICH CHANNEL, FOR WHICH MODE — the one genuinely new question this widget asks that no earlier
 * migration had to answer:
 *   - A cell bound to a STREAM feed reads `ctx.rows`. `rowsForCell` (widgets/index.mjs) is `null`
 *     for exactly "not stream-bound" (unbound cell, value-mode feed, image feed, or the feed absent
 *     from the map entirely) — the SAME test `stream_list` already uses to tell "this is a stream"
 *     from "this is something else". `ctx.rows !== null` is therefore read as the authoritative
 *     "stream mode" signal, and the row payloads are read off `ctx.rows` (not `ctx.data`) so the
 *     decision and the data come from the one channel that actually proves the mode — `ctx.data`
 *     alone cannot: a value-mode payload that happens to itself be an array (a legitimate table
 *     source, see below) is indistinguishable from a stream's mapped-payload array by shape.
 *   - A cell NOT in stream mode reads `ctx.data` — a value feed's payload UNRESOLVED (`dataForCell`
 *     does not apply `config.path`; every design that reads `path` off a value feed resolves it
 *     itself, same as `value/tile.mjs`'s own `resolvePath(scalarSource(data), path)`) — and resolves
 *     `cfg.path` against it here, exactly as the DOM renderer's
 *     `resolvePath(wire.payload, cfg.path ?? '')` did. The result MUST be an array or the cell shows
 *     the loud "Not an array" notice — the component contract preserves this distinction.
 *
 * FOUR STATES, and `ctx.feed` is what finally makes the first two of them honest.
 *
 * `dataForCell` returns `null` for BOTH "no such feed" and "a bound value feed whose payload has
 * never been pushed" (`feed.payload` is legitimately `null`). `ctx.feed` separates them so a real,
 * correctly configured feed that nobody has pushed to yet stays quiet instead of saying MISSING.
 *
 * `ctx.feed` (widgets/index.mjs's `feedSignalFor`) answers the question the two data channels
 * cannot, and the fold is gone:
 *   - `ctx.feed === null` (the cell names no feed) or `ctx.feed.missing` (it names one this device
 *     does not have) → the LOUD "Feed missing" notice. `null` is the channel saying "not
 *     applicable", not "something is wrong" — but a table with nothing bound is an authoring
 *     mistake no push can fix, so this design rules it loud on its own account. `missing: true` is
 *     the channel's own loud state, and the two share a notice here because the sentence that fixes
 *     them is the same one.
 *   - the feed EXISTS, is a kind this widget can read, and `ctx.feed.pushed_at === null` (nothing
 *     has ever been sent to it) → the QUIET `— no rows yet` line. **THIS IS A DELIBERATE BEHAVIOUR
 *     CHANGE**: before `ctx.feed` existed this case painted the loud notice. It is the entire point
 *     of the channel — a feed with nothing in it yet is not a misconfiguration, and never-pushed is
 *     quiet, not a failure (the same rule `ctx.age_ms` has always stated).
 *   - the feed exists but is a kind this widget CANNOT read — an IMAGE feed bound to a table cell,
 *     or a mode this build cannot name → the LOUD notice, pushed or not. `widgetAcceptsMode`
 *     (../bindings.mjs) is the gate, read rather than restated: it is the same mode set the hub
 *     enforces when the binding is saved (`feedCheck`, hub/src/routes/admin.ts, cross-checked by
 *     widget-bindings.test.ts), so this design cannot quietly disagree with what the admin allows.
 *     Without the gate a table bound to a brand-new image feed drew the quiet line and only went
 *     loud once somebody pushed a picture to it — the operator got the honest notice last, when the
 *     binding had been wrong all along. This is what `ctx.feed.mode` is FOR:
 *     A channel field nothing reads does not survive a freeze.
 *   - not stream-bound, `ctx.data` present, `resolvePath(ctx.data, cfg.path)` not an array → the
 *     LOUD "Not an array" notice — textually distinct from "Feed missing" so an operator can tell
 *     "wrong path" from "no feed" (component contract).
 *   - resolved (either mode) to an array of length 0 → the QUIET `— no rows yet` line, matching
 *     `stream_list`'s own wording for the same "nothing pushed yet" state verbatim.
 *   - otherwise → rows, with overflow planned by `cardPlan`.
 *
 * WHAT DID NOT MOVE, and it is the case that keeps the loud state worth reading: a feed this widget
 * cannot use at all — an image feed, or a value feed that HAS been pushed and whose payload really
 * is `null` — still paints the LOUD notice. Either something arrived and this cell cannot show it,
 * or nothing this cell could ever show was bound in the first place; both are a person's problem to
 * fix, not an empty feed. Exactly one case moved from loud to quiet: a never-pushed feed of a mode
 * this widget reads.
 *
 * HEADER ARITHMETIC (contract): `TABLE_HEADER` is reserved off the cell height BEFORE
 * `cardPlan` divides what is left by `TABLE_ROW` — `cardPlan(box.h - (n.headers ? TABLE_HEADER : 0),
 * n.rows.length, n.counter, TABLE_ROW)`, the exact shape `layout-core.mjs`'s own rule comment
 * spells out for `table`. Both height constants stay UNSCALED (contract): they are inputs
 * to `cardPlan`'s vectored overflow arithmetic, and `scale` moves text only — `TABLE_RAMP` is a
 * SCALAR per fraction (not a {header, cell} pair) because header and cell have always drawn at the
 * same size and are told apart by colour/weight, never size, matching the renderer's single
 * `font-size` set once on the `<table>` and inherited by every `th`/`td`.
 *
 * `plan.visible` can go NEGATIVE on a tiny cell (contract) — guarded exactly as
 * `stream_list` guards its own overflow plan, so a `slice(0, plan.visible)` bug can never render
 * "all rows but the last".
 *
 * Cell values print through `displayValue(resolvePath(rowPayload, col.path), 'raw', null)` — the
 * renderer's formatting rule, reused rather than reimplemented (contract).
 *
 * `columns` was an array of objects and therefore outside `meta.options` (contract): a
 * generated field wrote ONE location — a flat key or a nested one named by a dotted
 * `path` — and `columns` is a repeating structure, not a location. The list option removes that reason
 * rather than working around it: `type: 'list'` declares a repeating group, and `columns` is a
 * declared option below. `CellConfig.tsx`'s hand-built column editor is deleted with it, so the
 * generated block is the only thing that draws a column. What is still hand-built for this widget
 * is `feed`/`path`/`scale`, which every data widget shares.
 *
 * `headers` and `overflow.counter` were excluded for the same family of reasons and went first.
 * `overflow.counter` was excluded because it nested and could not be written; `headers` only for
 * parity with it, so an operator would not find half the table's knobs in a "Design options" block.
 * `path` removed the first reason, and with it the second — every table knob is a generated field
 * now, which is what the parity argument was asking for all along.
 */
import {
  tableConfig, cardPlan, resolvePath, displayValue, applyScale, rampValues,
  TABLE_RAMP, TABLE_ROW, TABLE_HEADER, FLOOR_LABEL,
} from '../../layout-core.mjs'
import { centredNotice, fitted, paintText, quietLine } from '../text-fit.mjs'
// A pure, import-free data module (bindings.mjs's own docstring) — the one home for which feed
// modes each widget may bind. See this file's state table for why the quiet line is gated on it.
import { widgetAcceptsMode } from '../bindings.mjs'

const meta = {
  id: 'grid',
  widget: 'table',
  label: 'Table',
  // Matches definitions.mjs's own `table` entry (suggested_ratio: 3/2).
  suggested_ratio: 3 / 2,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    /**
     * The table's whole point, and the last knob on this design that needed a hand-written admin
     * editor. `type: 'list'` is a REPEATING GROUP: `min`/`max` are the save schema's own
     * `minItems: 1, maxItems: 4` (`hub/src/routes/admin.ts`'s `table` branch), and the four keys
     * under `item` are exactly that schema's `items.properties` — it is
     * `additionalProperties: false`, so a fifth would 400 the whole grid PATCH, and `required`
     * marks the two in its `items.required` so an added row can never be missing one.
     *
     * `label` names ONE entry, not the group: the admin builds `Add column`, `Remove column` and
     * each row's field labels out of it, and there is no way to go from a plural back to a singular.
     */
    columns: {
      type: 'list',
      label: 'column',
      min: 1,
      max: 4,
      item: {
        header: { type: 'text', label: 'header', required: true },
        path: { type: 'text', label: 'path', required: true },
        // `left` restates `tableConfig`'s own read (`col.align === 'right' ? 'right' : 'left'`), so
        // an unset select shows what the panel actually draws. Not `required`: the schema leaves
        // `align` out of `items.required`, and an added column omitting it renders left either way.
        align: { type: 'select', label: 'align', default: 'left', choices: ['left', 'right'] },
      },
    },
    // Both default ON, restating `tableConfig`'s own reads (`c.headers !== false`,
    // `overflow.counter !== false`), so an unset generated control renders CHECKED and matches what
    // the panel draws. `counter` writes `config.overflow.counter` — the shape
    // `hub/src/routes/admin.ts`'s `table` branch accepts (`overflow`, `additionalProperties: false`,
    // one boolean property); a flat `overflow_counter` would look fine in the editor and 400 on
    // save.
    headers: { type: 'boolean', label: 'Headers', default: true },
    counter: { type: 'boolean', label: 'Overflow counter', default: true, path: 'overflow.counter' },
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

const isRecord = (value) => value !== null && typeof value === 'object'

/**
 * Every read-path decision this widget makes, none of the painting.
 *
 * `data` is `ctx.data` verbatim (a value feed's UNRESOLVED payload, or a stream feed's own mapped-
 * payload array — see this file's docstring for why `path` is resolved here rather than upstream).
 * `rows` is `ctx.rows` verbatim: `null` when this cell is not stream-bound, `[]` for a well-formed
 * empty stream, else `{payload, pushed_at}[]`. `feed` is `ctx.feed` verbatim: `null` when this cell
 * binds no feed, `missing: true` when it binds one the device does not have, else the bound feed's
 * delivery facts. See this file's own docstring for the state table, and for which state moved when
 * `ctx.feed` arrived.
 */
export function normalizeTable(data, rows, feed, config) {
  const cfg = tableConfig(config)
  const base = { scale: cfg.scale, headers: cfg.headers, counter: cfg.counter, columns: cfg.columns }
  // A feed that is THERE, is a kind this widget could actually read, and has never been pushed to.
  // The one combination that separates the loud state from the quiet one — see this file's
  // docstring. A `ctx.feed` that is absent altogether (an older host, a hand-built context) reads
  // as "no feed", which is the direction this design has always degraded in.
  const neverPushed = isRecord(feed) && feed.missing !== true &&
    widgetAcceptsMode(meta.widget, feed.mode) && feed.pushed_at === null

  let items
  if (isArray(rows)) {
    items = rows.map((r) => (r !== null && typeof r === 'object' ? r.payload : undefined))
  } else if (data === null || data === undefined) {
    return { ...base, state: neverPushed ? 'empty' : 'missing', rows: [] }
  } else {
    const arr = resolvePath(data, cfg.path ?? '')
    if (!isArray(arr)) return { ...base, state: 'not-array', rows: [] }
    items = arr
  }

  if (items.length === 0) return { ...base, state: 'empty', rows: [] }

  const formatted = items.map((rowPayload) =>
    cfg.columns.map((col) => displayValue(resolvePath(rowPayload, col.path), 'raw', null)))
  return { ...base, state: 'ready', rows: formatted }
}

// Table-cell padding is unscaled because `scale` moves text only; the cell geometry remains fixed.
const CELL_PAD_X = 6

function draw(g, ctx) {
  const { box, tokens, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeTable(ctx.data, ctx.rows, ctx.feed ?? null, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (n.state === 'missing') {
    centredNotice(g, 'Feed missing', 'Bind this cell to a value or stream feed', box, tokens, pad, n.scale)
    return
  }
  if (n.state === 'not-array') {
    centredNotice(g, 'Not an array', 'config.path must resolve to an array', box, tokens, pad, n.scale)
    return
  }
  if (n.state === 'empty') {
    // Verbatim `stream_list`'s own wording and quiet treatment — a never-pushed/empty source is
    // not a failure (contract, and this file's own docstring).
    quietLine(g, '— no rows yet', box, tokens, pad, n.scale)
    return
  }

  const colCount = Math.max(1, n.columns.length)
  const colWidth = box.w / colCount

  // Header arithmetic (contract): TABLE_HEADER comes off the cell height BEFORE cardPlan
  // divides what's left by TABLE_ROW — see this file's own docstring and layout-core.mjs's rule.
  const headerHeight = n.headers ? TABLE_HEADER : 0
  const plan = cardPlan(box.h - headerHeight, n.rows.length, n.counter, TABLE_ROW)
  // plan.visible can go NEGATIVE (contract) — guarded exactly as stream_list guards its own.
  const visibleCount = Math.max(0, plan.visible)
  const visible = n.rows.slice(0, visibleCount)

  // TABLE_RAMP is a scalar per fraction (not {header, cell}) — one size for both, told apart by
  // colour/weight only (contract, this file's own docstring).
  const textPx = applyScale(rampValues(TABLE_RAMP, box.t ?? 1), n.scale, FLOOR_LABEL)
  const stale = ctx.stale === true

  const drawCellText = (text, ci, top, height, color, weight) => {
    const align = n.columns[ci].align === 'right' ? 'right' : 'left'
    const x = align === 'right' ? (ci + 1) * colWidth - CELL_PAD_X : ci * colWidth + CELL_PAD_X
    const maxWidth = Math.max(0, colWidth - CELL_PAD_X * 2)
    paintText(g, text, x, top + height / 2, {
      px: textPx, floor: FLOOR_LABEL, maxWidth, color, align, baseline: 'middle', weight,
    })
  }

  let y = 0
  if (n.headers) {
    n.columns.forEach((col, ci) => drawCellText(col.header, ci, y, TABLE_HEADER, tokens.dim, 500))
    y += TABLE_HEADER
  }

  for (const cells of visible) {
    // Whole-table staleness (ctx.stale, part of the contract) dims body rows only — the renderer's
    // own `class="stale"` sat on `<tr>` inside `<tbody>`, never on `<thead>`.
    g.globalAlpha = stale ? 0.5 : 1
    n.columns.forEach((col, ci) => drawCellText(cells[ci] ?? '', ci, y, TABLE_ROW, tokens.ink, 400))
    g.globalAlpha = 1
    y += TABLE_ROW
  }

  if (plan.hidden > 0 && n.counter) {
    const usableWidth = Math.max(0, box.w - pad * 2)
    const counterFit = fitted(g, `and ${plan.hidden} more`, 14, FLOOR_LABEL, usableWidth, 400)
    paintText(g, counterFit.text, pad, y + 7, {
      px: counterFit.px, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
    })
  }
}

export default { meta, draw }
