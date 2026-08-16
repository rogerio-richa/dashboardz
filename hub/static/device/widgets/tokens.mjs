/**
 * Resolution order (degradation): widget token → palette → the design's own built-in.
 * Two null-coalescences, no colour maths. The design's declared vocabulary is authoritative:
 * a token it did not declare cannot be set, and every token it DID declare gets a value, so a
 * draw function never has to guard for undefined.
 *
 * `LAST_RESORT` exists because an `@palette` default can reference a palette key that a
 * malformed palette omits. Falling through to undefined would push the guard into every design.
 */
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const LAST_RESORT = { color: '#000000', number: 0 }

const valid = (type, v) =>
  type === 'color' ? typeof v === 'string' && COLOR_RE.test(v)
  : type === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : v !== undefined && v !== null

function builtin(spec, palette) {
  const d = spec.default
  if (typeof d === 'string' && d.startsWith('@')) {
    const fromPalette = palette?.[d.slice(1)]
    return valid(spec.type, fromPalette) ? fromPalette : LAST_RESORT[spec.type]
  }
  return valid(spec.type, d) ? d : LAST_RESORT[spec.type]
}

export function resolveTokens(meta, themeWidget, palette) {
  const out = {}
  for (const [name, spec] of Object.entries(meta.tokens ?? {})) {
    const fromTheme = themeWidget?.tokens?.[name]
    out[name] = valid(spec.type, fromTheme) ? fromTheme : builtin(spec, palette)
  }
  return out
}

/**
 * The built-in four-colour series ramp — `[palette.info, palette.warn, palette.critical,
 * palette.dim]` — used wherever a board declares no valid `series` ramp of its own (widgets/
 * index.mjs's `ctx.ramp`). Each entry degrades to `LAST_RESORT.color` the exact way `builtin()`
 * above does for an `@`-prefixed token default, so a malformed palette can never produce
 * `undefined` in the ramp.
 *
 * It had a second caller — `charts.mjs`'s DOM `drawChart` — until `chart` became a design
 * (`widgets/chart/plot.mjs`) and that file was deleted. One definition rather than
 * two copies of the same four keys and the same degradation rule was the point then and still is:
 * `ctx.ramp` is now the only way a chart's colours are chosen.
 */
export function builtinRamp(palette) {
  return ['info', 'warn', 'critical', 'dim'].map((key) => {
    const value = palette?.[key]
    return valid('color', value) ? value : LAST_RESORT.color
  })
}

/**
 * The theme's own series ramp, or `null` for "use `builtinRamp` instead" (theming: `board.series`).
 *
 * Lived in `charts.mjs` until `chart` became a design and that file was deleted;
 * it moved HERE rather than into `widgets/index.mjs` because this is where the other half of the
 * same decision already lives — `builtinRamp` is the fallback this function selects between, and
 * `valid('color', …)` is the very check its old private `COLOR_RE` copy duplicated. That third copy
 * of the colour shape is gone with the move: `theme.mjs` and this file are now the only two, which
 * is what `themeApply.test.ts`'s "one colour shape" guard pins.
 *
 * Every series-colour site cycles with `% ramp.length`, so a ramp of ANY length works — a
 * two-colour ramp alternates, a six-colour one never repeats across the four series a chart can
 * hold. That cycling is why the board block carries `series` at all: the built-in ramp is
 * info/warn/critical/dim, which paints a chart's THIRD series in alarm red for no semantic reason
 * (it is the third line, not a critical one). A theme that declares a real ramp — the seeded
 * `cypherpunk` theme does — was silently ignored until this existed.
 *
 * Validated ALL-OR-NOTHING, not per entry: a ramp with one bad string falls back whole rather than
 * being compacted, because dropping entry 2 of 4 would silently RE-ORDER the remaining colours
 * relative to what the operator authored — a wrong-looking chart is harder to diagnose than an
 * un-themed one. (`ctx.series` keeps a slot for a missing feed for exactly the same reason.)
 */
export function themeSeriesRamp(board) {
  const ramp = board?.series
  if (!Array.isArray(ramp) || ramp.length === 0) return null
  return ramp.every((c) => valid('color', c)) ? ramp : null
}
