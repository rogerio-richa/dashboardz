/**
 * `gauge` — shared normalize logic between its two portable designs, `bar` (default, first in
 * catalogue order — matching `gaugeConfig`'s own unbroken `style` default below) and `ring`
 * (following text_block/value_tile's portable drawing subset precedent). Both
 * designs import `normalizeGauge` from here rather than each restating the read-path/threshold
 * maths. This module is per-WIDGET: it holds what two designs of the same widget type must not
 * decide differently. Generic text fitting is not that, and lives in `../text-fit.mjs` — which is
 * where `fitted`/`paintText` moved once five designs held byte-identical copies of them.
 *
 * Ports `gaugeFraction`/`gaugeSeverity` from `../../layout-core.mjs` by IMPORTING them, not
 * restating the maths (component contract) — the old DOM branch's `gaugeConfig` read
 * every knob this reads: `label`, `unit`, `min`, `max`, `decimals`, `thresholds.{warn,crit}`,
 * `scale` (plus `path`, read against `data` rather than a raw feed wire — `feed` itself is
 * resolved upstream into `data` by `dataForCell`, same as every other migrated design). Unlike
 * `value_tile`, gauge has never had a `format` knob — the old DOM branch always called
 * `displayValue(raw, 'raw', cfg.decimals)` with a literal `'raw'`, never `'abbrev'` — so `format`
 * is not read here either; carrying over a knob the widget never had would be a new feature, not
 * a migration.
 *
 * `available` here means "numeric" — a genuine number this cell's range can plot — NOT merely
 * "some value resolved", unlike `value_tile`'s own `available` (which treats any resolved
 * string/boolean/object as displayable, just not as a number). A gauge's core visual IS its
 * track: the old DOM branch drew the ring/bar unconditionally whenever a wire was bound — even
 * for a resolved-but-non-numeric payload — and only fell back to `feedMissingHtml()`'s loud
 * dashed placeholder when the wire itself was entirely absent. This design goes one step further
 * (matching text_block/value_tile's own softer "no feed" treatment) and always draws its track,
 * whether the cell binds nothing at all or resolves to something non-numeric: both collapse into
 * the SAME documented rule contract preserves — an EMPTY track (`fraction: 0`), forced
 * `severity: 'info'`, never a coloured one. The distinction between "nothing bound" and "bound but
 * not a number" was never meaningfully different to an operator looking at the panel; both mean
 * "this gauge has nothing to plot right now."
 */
import { resolvePath, displayValue, gaugeFraction, gaugeSeverity } from '../../layout-core.mjs'

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
 * the new shape, same as `text/block.mjs`'s and `value/tile.mjs`'s own `scalarSource`.
 */
function scalarSource(data) {
  return isArray(data) ? data[0] : data
}

/**
 * Every knob `gaugeConfig` (layout-core.mjs) has ever read, carried over verbatim, with the SAME
 * defaults: `min` 0, `max` 100, `label`/`unit` `''`, `decimals` `null` (no forced rounding — the
 * raw number prints in full, exactly `displayValue`'s own contract), `thresholds.warn`/`.crit`
 * `null` (no threshold ⇒ `gaugeSeverity` can never report anything but `'info'`), `scale` clamped
 * 0.5-2 default 1.
 *
 * Contract, preserved from the old DOM branch's own comment: a non-numeric resolved value ⇒
 * EMPTY track (`fraction` forced to 0 here rather than trusting `gaugeFraction`'s own non-numeric
 * fallback), `severity` forced to `'info'` — so the severity colour computation downstream can't
 * accidentally colorize an empty track either.
 */
export function normalizeGauge(data, config) {
  const c = record(config) ?? {}
  const thresholds = record(c.thresholds) ?? {}
  const label = typeof c.label === 'string' ? c.label : ''
  const unit = typeof c.unit === 'string' ? c.unit : ''
  const min = finite(c.min) ? c.min : 0
  const max = finite(c.max) ? c.max : 100
  const decimals = Number.isInteger(c.decimals) ? c.decimals : null
  const warn = finite(thresholds.warn) ? thresholds.warn : null
  const crit = finite(thresholds.crit) ? thresholds.crit : null
  const scale = finite(c.scale) ? Math.min(2, Math.max(0.5, c.scale)) : 1
  const path = typeof c.path === 'string' ? c.path : ''

  const raw = resolvePath(scalarSource(data), path)
  const numeric = typeof raw === 'number' && Number.isFinite(raw)
  const fraction = numeric ? gaugeFraction(raw, min, max) : 0
  const severity = numeric ? gaugeSeverity(raw, warn, crit) : 'info'
  // `displayValue(undefined, ...)` is the SAME em-dash placeholder a truly-missing value gets —
  // reusing the imported formatter for that placeholder rather than hand-rolling the character,
  // matching `value/tile.mjs`'s identical behavior.
  const value = displayValue(numeric ? raw : undefined, 'raw', decimals)

  return { available: numeric, fraction, severity, value, label, unit, scale }
}
