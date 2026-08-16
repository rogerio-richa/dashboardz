/**
 * What an ORDINARY widget needs at the path an operator binds — the half of the widget contract
 * semantic widgets already had and generic ones did not.
 *
 * A semantic widget's contract is a canonical payload SHAPE: `weather_forecast` consumes
 * `dashboardz.weather.daily-forecast/v1` and nothing else, so `compatibleOutput` can answer
 * compatibility from a contract id plus a capability list. The nine generic widgets are
 * path-parameterised instead — a gauge does not care what the payload looks like, only that
 * `config.path` reaches a finite number. So their contract cannot be a shape; it is a TYPE
 * REQUIREMENT AT A BOUND PATH, which is what this module's vocabulary expresses.
 *
 * The vocabulary is deliberately four types and three scopes. Its smallness is the asset: every
 * addition is a decision about what the product promises, not an implementation detail, and
 * `data-needs.test.ts` pins both lists so a fifth cannot arrive by accident.
 *
 * WHY THE NEEDS TABLE IS DUPLICATED HERE. `WIDGET_NEEDS` below restates what
 * `static/device/widgets/bindings.mjs` declares, for the same reason `WIDGET_FEED_MODES` and
 * `CHART_ICONS` are restated: `hub/tsconfig.json` sets `rootDir: src`, so an import of
 * `../static/...` from server code is outside the compilation root and breaks `npm run build`.
 * `bindings.mjs` is the declaration a human reads and the admin bundles; this is the copy the
 * server enforces, and `widget-bindings.test.ts` imports BOTH and asserts they are equal. A
 * comment cannot catch drift — the two mode tables here drifted once already — only a test that
 * reads both sources can.
 */

/** What the resolved value must be. Adding a fifth is a product decision; see the module note. */
export const NEED_TYPES = ['number', 'scalar', 'array<object>', 'binary'] as const
export type NeedType = typeof NEED_TYPES[number]

/**
 * What the path resolves AGAINST:
 *   - `scalar`     — `feedScalarSource(wire)`: a value feed's payload, or a stream feed's NEWEST
 *                    row's payload (layout-core.mjs's `feedScalarSource`).
 *   - `row`        — each stream row's `payload`, one resolution per row (chart plots all of them).
 *   - `collection` — each element of the array found at `collection_from`'s own configured path.
 */
export const NEED_SCOPES = ['scalar', 'row', 'collection'] as const
export type NeedScope = typeof NEED_SCOPES[number]

/** The feed modes a need can be conditioned on. Mirrors `FeedMode`, restated to keep this pure. */
export type NeedMode = 'value' | 'stream' | 'image'

export interface WidgetNeed {
  /**
   * The CONFIG KEY holding the path, not the path itself — `'path'`, `'title_path'`, or a list
   * form (`'columns[].path'`, `'series[].y_path'`) meaning "this key on every element of that
   * list". Absent when the need resolves no path at all, which is only `image`'s `binary`.
   */
  path_from?: string
  scope: NeedScope
  type: NeedType
  /** For `collection` scope: the config key whose own path locates the array to resolve within. */
  collection_from?: string
  /**
   * Which bound feed modes this need applies to. Omitted means every mode the widget accepts,
   * which is the normal case — a gauge reads `config.path` the same way whether the feed is a
   * value or a stream, because `feedScalarSource` hands it the newest row's payload either way.
   *
   * `table` is the exception, and the reason this field exists: `normalizeTable` uses `cfg.path`
   * ONLY when the cell is not stream-bound (table/grid.mjs's `isArray(rows)` branch never reads
   * it). On a stream feed the rows ARE the array, so the array-at-a-path need does not apply and
   * the columns resolve against each row's payload rather than inside a collection. Without this
   * the contract would reject every stream-bound table — a binding the widget has always accepted.
   */
  modes?: readonly NeedMode[]
}

/** True when this need governs a binding to a feed of this mode. */
export function needAppliesTo(need: WidgetNeed, mode: NeedMode): boolean {
  return need.modes === undefined || need.modes.includes(mode)
}

const isObject = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Does this value satisfy this type? Each arm mirrors the normalizer that really tests it, so a
 * declaration cannot promise something the renderer then rejects:
 *   - `number` is FINITE — `gauge/shared.mjs`'s `typeof raw === 'number' && Number.isFinite(raw)`
 *     and `layout-core.mjs`'s `chartPoints` filter both drop NaN and Infinity.
 *   - `scalar` is a non-null primitive, which is what `displayValue` can print.
 *   - `array<object>` needs rows, not values — `table/grid.mjs` paints the loud "Not an array"
 *     notice otherwise, and an array of scalars has no columns to address.
 *   - `binary` is never path-resolved: an image feed's bytes are reached by revision, not by
 *     `resolvePath`, so nothing about a VALUE can satisfy it and only the feed's mode can.
 */
export function satisfiesNeed(type: NeedType, value: unknown): boolean {
  switch (type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'scalar': return (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'string' || typeof value === 'boolean'
    case 'array<object>': return Array.isArray(value) && value.every(isObject)
    case 'binary': return false
  }
}

/** The needs half of `bindings.mjs`'s `WIDGET_BINDINGS`. See the module note on why it is here. */
export const WIDGET_NEEDS: Readonly<Record<string, readonly WidgetNeed[]>> = Object.freeze({
  clock: [],
  alert_feed: [],
  value_tile: [{ path_from: 'path', scope: 'scalar', type: 'scalar' }],
  gauge: [{ path_from: 'path', scope: 'scalar', type: 'number' }],
  stream_list: [
    { path_from: 'title_path', scope: 'row', type: 'scalar' },
    { path_from: 'body_path', scope: 'row', type: 'scalar' },
  ],
  table: [
    { path_from: 'path', scope: 'scalar', type: 'array<object>', modes: ['value'] },
    { path_from: 'columns[].path', scope: 'collection', collection_from: 'path', type: 'scalar', modes: ['value'] },
    { path_from: 'columns[].path', scope: 'row', type: 'scalar', modes: ['stream'] },
  ],
  text_block: [{ path_from: 'path', scope: 'scalar', type: 'scalar' }],
  chart: [{ path_from: 'series[].y_path', scope: 'row', type: 'number' }],
  image: [{ scope: 'scalar', type: 'binary' }],
})

export function widgetNeeds(widget: string): readonly WidgetNeed[] {
  return Object.hasOwn(WIDGET_NEEDS, widget) ? WIDGET_NEEDS[widget]! : []
}

/**
 * The capability token a type is spelled with in `data.<token>@<path>`. `array<object>` shortens to
 * `array` because the angle brackets would have to be escaped everywhere a capability string is
 * matched, logged or put in a URL, and there is only one array type to name.
 */
const TYPE_TOKENS: Readonly<Record<NeedType, string>> = Object.freeze({
  number: 'number', scalar: 'scalar', 'array<object>': 'array', binary: 'binary',
})

/**
 * The capability a feed must produce to satisfy `type` at `path`.
 *
 * The `data.` prefix namespaces these away from semantic capabilities (`weather.daily.condition`)
 * so one `capabilities` array can carry both without collision — a source draft promising a legacy
 * value output and a semantic one writes them into the same list.
 */
export function needCapability(type: NeedType, path: string): string {
  return `data.${TYPE_TOKENS[type]}@${path}`
}

/**
 * Every capability that would satisfy `type` at `path` — the subsumption rule, in one place.
 *
 * Only one type subsumes another: a `number` IS a `scalar`, because every widget that needs a
 * scalar is going to print it and `displayValue` prints numbers. The reverse does not hold, and
 * that asymmetry is the entire point of having both — a gauge bound to a hostname is a mistake
 * worth catching, a value_tile bound to a CPU percentage is not.
 *
 * `binary` returns nothing: no capability can be produced for it, because an image feed's bytes
 * are never resolved out of a payload. Its satisfaction is the feed's mode, checked elsewhere.
 */
export function acceptableCapabilities(type: NeedType, path: string): string[] {
  if (type === 'binary') return []
  if (type === 'scalar') return [needCapability('scalar', path), needCapability('number', path)]
  return [needCapability(type, path)]
}

/**
 * How far into a payload the walk descends, and how many capabilities it will emit. Board payloads
 * arrive from senders over the network, so this walk runs on attacker-adjacent input on the save
 * path; unbounded recursion over a deeply-nested or very wide object is a hang, not a slow save.
 * The numbers are generous against anything a real dashboard pushes — nothing legible on a wall
 * panel is eight levels deep — and the point is that a bound exists, not where exactly it sits.
 */
const MAX_DEPTH = 8
const MAX_CAPABILITIES = 400
/** Enough rows to union the keys of a ragged collection; a table shows at most a screenful. */
const MAX_ELEMENTS_SAMPLED = 20

/**
 * What this payload demonstrably produces, as `data.<type>@<path>` capabilities.
 *
 * WHY INFERENCE, AND WHY IT IS A FALLBACK. A hand-pushed sender declares nothing — "push it
 * yourself, here is the curl line" stays one line, and asking an author to annotate what the
 * system can already see would be a tax on the simplest path in the product. So for feeds that
 * have been pushed, the data itself is the declaration. It cannot answer for a feed that has never
 * been pushed, which is exactly the case a source draft's promised capabilities exist to cover.
 *
 * A number emits BOTH `data.number@p` and `data.scalar@p`. `acceptableCapabilities` already widens
 * a scalar need to accept a number, so this is belt and braces — but it means a raw capability
 * list is readable on its own terms, without a matcher to interpret it, which is what makes it
 * worth storing on a source output and showing in a picker.
 */
export function capabilitiesForPayload(payload: unknown): string[] {
  const found = new Set<string>()
  /**
   * What a VALUE produces, which is the dual of `acceptableCapabilities` and not the same
   * function: that one widens a scalar NEED to accept a number, this one widens a number VALUE to
   * also announce itself as a scalar. Same subsumption, opposite direction — sharing one helper
   * between them silently made `{ x: 1 }` produce no `data.scalar@x` at all.
   */
  const emitValue = (value: unknown, path: string): void => {
    if (satisfiesNeed('number', value)) {
      found.add(needCapability('number', path))
      found.add(needCapability('scalar', path))
    } else if (satisfiesNeed('scalar', value)) {
      found.add(needCapability('scalar', path))
    }
  }

  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.size >= MAX_CAPABILITIES) return
    if (!isObject(value)) return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (found.size >= MAX_CAPABILITIES) return
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (Array.isArray(child)) {
        // Only an array of OBJECTS is offerable, because that is the only thing `table` can render
        // and the only shape whose elements have addressable paths. An array of scalars gets no
        // capability at all rather than a `data.array@` one a table would then fail on.
        if (!child.every(isObject)) continue
        found.add(needCapability('array<object>', path))
        // Keys are UNIONED across elements, not read off the first: a ragged collection whose
        // second row carries a field the first does not still makes that field offerable as a
        // column. Reading element 0 alone would hide it, and the operator would never be offered
        // a column their data really has.
        for (const element of child.slice(0, MAX_ELEMENTS_SAMPLED)) walk(element, `${path}[]`, depth + 1)
        continue
      }
      if (isObject(child)) {
        walk(child, path, depth + 1)
        continue
      }
      emitValue(child, path)
    }
  }

  walk(payload, '', 0)
  return [...found].sort()
}
