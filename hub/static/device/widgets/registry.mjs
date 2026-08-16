/**
 * Every widget design registers here. `lookup` never returns undefined for a widget that has
 * designs: an unknown id resolves to the widget's default, because a client older than a design
 * WILL meet themes that name it (degradation contract) and a blank cell is not acceptable.
 *
 * A design is `{ meta, draw(g, ctx, elapsedMs), isAnimating?(ctx) }`.
 *
 * `isAnimating(ctx)` is OPTIONAL and deliberately absent from REQUIRED_META: most designs never
 * animate, and a required predicate would make every one of them write `() => false`. It answers
 * "am I animating for THIS ctx, right now" — not "do I animate in principle", which is what
 * `meta.animations` already says. paintWidgets hands a design frames only while it returns true,
 * and the board loop drops it the moment it stops (see index.mjs). A design that omits it is never
 * handed a frame at all, so a design that DOES animate must define it or it will simply sit at its
 * resting state. A design must never start its own timer to compensate (contract): derive
 * the answer from `ctx`, as clock/segment.mjs derives its window from `ctx.now`.
 */
/*
 * There is no `distorts` metadata. Nothing reads that value, and only two designs (flip, nixie)
 * actually letterbox — a required field would describe an intention the runtime cannot enforce
 * and most designs would not need. A field that means nothing is the worst thing to freeze into a
 * contract outside authors will copy.
 * A design that wants to keep its aspect does what flip and nixie do: letterbox inside `ctx.box`.
 */
const REQUIRED_META = ['id', 'widget', 'label', 'suggested_ratio', 'tokens', 'animations']

/** The four one-value types. A `list` is built out of these and is not one of them. */
const SCALAR_TYPES = ['text', 'number', 'boolean', 'select']
/** Declarable at the top level of `meta.options`. */
const OPTION_TYPES = new Set([...SCALAR_TYPES, 'list'])
/**
 * Declarable inside a `list`'s `item`. `feed` is here and NOT in `OPTION_TYPES` on purpose: a
 * cell's own `config.feed` is a required, hand-built binding every data widget already draws
 * (`CellConfig.tsx`'s `renderFeedSelect`), so a design declaring it would put a second control on
 * the same key — the bug `image.fit` and `alert_feed.min_severity` each shipped once. A feed
 * INSIDE a repeating row has no such control, because `chart`'s series is the only per-row binding
 * there is (`bindings.mjs`: `chart` is the one entry with `per_series: true`), and the admin
 * renders it with the same `DataSourcePicker` — filtered by the HOST WIDGET's declared modes, so a
 * design never restates which feed kinds it accepts.
 */
const ITEM_TYPES = new Set([...SCALAR_TYPES, 'feed'])
const DEFAULT_OK = {
  text: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  select: (v) => typeof v === 'string',
}

/**
 * A path segment is an ordinary property name: a letter or `_` followed by letters, digits or `_`.
 *
 * An ALLOWLIST, not a denylist, because these segments become object KEYS on board-authored config
 * — the admin's generated field builds `{ thresholds: { warn: 70 } }` from `'thresholds.warn'` —
 * and board config is attacker-adjacent by this codebase's house rule (see text/block.mjs's
 * `ownData`). Anything that is not plainly a property name is refused rather than reasoned about:
 * that rules out the empty segment (`'a..b'`, `'.a'`, `'a.'`), whitespace, bracket syntax
 * (`'columns[0]'`) and array indices (`'columns.0'`) in one rule.
 *
 * Array indices stay refused now that `list` exists, and for a better reason than before. A repeating
 * structure is declared as a `list` — the whole array in one option, with the admin owning the row
 * count — so `columns.0.header` is not an unreachable knob any more, it is the WRONG SPELLING of a
 * reachable one: it would pin an author's knob to row 0 of an array whose length the operator
 * changes. One position in a repeating group is not a location.
 */
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * Segments that are never a config key, whatever they look like. Writing through `__proto__` (or
 * assigning `constructor`/`prototype`) on a plain object is prototype pollution, and the value
 * being written is whatever an operator typed into a form field. Refused at REGISTRATION, where
 * every other meta error is caught, so no such path ever reaches the admin or a device.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A design's declared knobs, checked at registration rather than at draw time.
 *
 * Refusing here is the same discipline `validateProviderDefinitions` applies to a provider at boot:
 * a malformed declaration is a build fault, and a form generated from a broken schema is worse than
 * no form. Absent options is valid — most designs have none.
 *
 * `path` (optional, dotted) is where the option's value LIVES on `cell.config`. Absent means what
 * it has always meant: one property directly on `cell.config`, named after the option. Present
 * means the generated field reads and writes that nested location instead —
 * `warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' }` is `config.thresholds.warn`,
 * the shape `hub/src/routes/admin.ts`'s `gauge` branch has always required.
 *
 * `list` is the one type that is not a single value: it declares a REPEATING GROUP — `min`/`max`
 * rows, each row an object built from the `item` fields — and it is what `table`'s `columns` and
 * `chart`'s `series` are. It was the contract's last stated limitation, and it cost each of those
 * two knobs a hand-written admin editor.
 */
export function validateOptions(meta) {
  const options = meta?.options
  if (options === undefined) return null
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return 'options must be an object'
  }
  for (const [name, spec] of Object.entries(options)) {
    if (!spec || typeof spec !== 'object') return `options.${name} must be an object`
    const error = spec.type === 'list'
      ? validateList(`options.${name}`, spec)
      : validateField(`options.${name}`, spec, false)
    if (error) return error
  }
  return null
}

/**
 * One option spec, top-level or inside a `list`'s `item` — the SAME rules either way, which is the
 * point: an author who has written a top-level option already knows how to write an item field.
 * `inItem` narrows the type set at both ends (no `list` inside a `list`, no `feed` outside one) and
 * turns on the two keys only a repeating row can mean anything by, `required` and `unique`.
 */
function validateField(where, spec, inItem) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return `${where} must be an object`
  const allowed = inItem ? ITEM_TYPES : OPTION_TYPES
  // Both of these are `type` errors, but a bare "must be one of …" would leave an author guessing
  // at WHY the type they just read about in the contract is refused here.
  if (inItem && spec.type === 'list') {
    return `${where}.type must not be list: a list cannot contain another list`
  }
  if (!inItem && spec.type === 'feed') {
    return `${where}.type must not be feed outside a list item: a cell's own feed binding already has a control`
  }
  if (!allowed.has(spec.type)) return `${where}.type must be one of ${[...allowed].join(', ')}`
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    return `${where}.label must be a non-empty string`
  }
  if (spec.type === 'select' && (!Array.isArray(spec.choices) || spec.choices.length === 0)) {
    return `${where}.choices must be a non-empty array`
  }
  // `default` is OPTIONAL (an explicit invariant): a knob whose real runtime meaning when unset is not
  // expressible as a concrete value of its own type — its
  // `value_tile`'s `decimals` is the first ("raw, unrounded" is not a number) — must be allowed
  // to declare no default at all rather than a placebo one the admin's generated field would show
  // as if it meant something. A PRESENT default is still checked against its declared type: this
  // only widens "absent" from an error to a no-op, it does not weaken the check on anything a
  // design actually wrote down.
  if ('default' in spec && spec.default !== undefined) {
    // A feed id is a board's binding to a data source that exists on THAT hub. A design shipping
    // one as a default would be naming a row in somebody else's database.
    if (spec.type === 'feed') return `${where}.default is not accepted on a feed field: a feed id belongs to a board, not to a design`
    if (!DEFAULT_OK[spec.type](spec.default)) return `${where}.default must match its type`
  }
  if ('path' in spec && spec.path !== undefined) {
    // An item field writes a property directly on its own row. Both save schemas for a repeating
    // group today (`columns[]`, `series[]`) are flat and `additionalProperties: false`, so a nested
    // item path has nothing to write into — and a capability with no consumer is the thing this
    // contract has twice removed rather than frozen (see `distorts` above).
    if (inItem) return `${where}.path is not accepted inside a list item: an item field writes a property directly on its row`
    const pathError = validatePath(where, spec.path)
    if (pathError) return pathError
  }
  if ('required' in spec && spec.required !== undefined) {
    if (!inItem) return `${where}.required is only accepted on a list item field`
    if (typeof spec.required !== 'boolean') return `${where}.required must be a boolean`
  }
  if ('unique' in spec && spec.unique !== undefined) {
    if (!inItem) return `${where}.unique is only accepted on a list item field`
    if (spec.type !== 'select') return `${where}.unique is only accepted on a select item field, which is the only one with a set of values to pick an unused one from`
    if (typeof spec.unique !== 'boolean') return `${where}.unique must be a boolean`
  }
  return null
}

/**
 * A `list`'s own rules.
 *
 * `min`/`max` are REQUIRED, unlike everything else here. They are not decoration: the admin refuses
 * to remove below `min` or add above `max`, and the grid PATCH schema's `minItems`/`maxItems` is
 * what it is refusing on behalf of. A list with no bounds would generate a control that can build a
 * five-column table, and the 400 lands on the whole grid — every unsaved edit on the screen, with a
 * message about an array length the operator never saw a number for.
 *
 * `path` is REFUSED. A list writes its array at its own name, which is where both shipped repeating
 * knobs live (`config.columns`, `config.series`). Making it nest would be a few characters in the
 * admin's patch builder and zero consumers anywhere — the shape of declaration this contract has
 * twice deleted for meaning nothing. It is a narrowing that can be widened later without breaking
 * a design; the reverse is not true.
 */
function validateList(where, spec) {
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    return `${where}.label must be a non-empty string`
  }
  if ('path' in spec && spec.path !== undefined) {
    return `${where}.path is not accepted on a list: a list writes its array at its own name`
  }
  if ('default' in spec && spec.default !== undefined) {
    return `${where}.default is not accepted on a list: an added row is built from the item fields' own defaults`
  }
  if (!Number.isInteger(spec.min) || spec.min < 0) return `${where}.min must be a non-negative integer`
  if (!Number.isInteger(spec.max) || spec.max < 1) return `${where}.max must be an integer of at least 1`
  if (spec.max < spec.min) return `${where}.max must not be below ${where}.min`
  const item = spec.item
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return `${where}.item must be an object of option specs`
  }
  const names = Object.keys(item)
  if (names.length === 0) return `${where}.item must declare at least one field`
  for (const key of names) {
    const error = validateField(`${where}.item.${key}`, item[key], true)
    if (error) return error
  }
  return null
}

/** `path`'s own rules, split out only so `validateOptions` stays one screen long. */
function validatePath(where, path) {
  if (typeof path !== 'string' || path === '') return `${where}.path must be a non-empty string`
  const segments = path.split('.')
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return `${where}.path must not contain the segment ${segment}`
    }
    if (!PATH_SEGMENT.test(segment)) {
      return `${where}.path segments must be property names (no empty segments, no array indices)`
    }
  }
  return null
}

const byWidget = new Map()

export function register(design) {
  const meta = design?.meta
  const missing = REQUIRED_META.filter((k) => meta?.[k] === undefined)
  if (missing.length) throw new Error(`incomplete meta: missing ${missing.join(', ')}`)
  if (typeof design.draw !== 'function') throw new Error('incomplete meta: draw is not a function')
  const optionsError = validateOptions(design.meta)
  if (optionsError) throw new Error(`design ${design.meta?.id}: ${optionsError}`)
  if (!byWidget.has(meta.widget)) byWidget.set(meta.widget, new Map())
  byWidget.get(meta.widget).set(meta.id, design)
}

export function registered(widget) {
  return [...(byWidget.get(widget)?.values() ?? [])]
}

export function defaultDesignFor(widget) {
  const all = registered(widget)
  return all.find((d) => d.meta.default) ?? all[0] ?? null
}

export function lookup(widget, designId) {
  const found = byWidget.get(widget)?.get(designId)
  return found ?? defaultDesignFor(widget)
}

/**
 * Whether THIS build can draw `designId` — the question `lookup` deliberately refuses to answer.
 *
 * `lookup` degrades silently by design: an unknown id becomes the widget's default, because a
 * client older than a design will meet themes that name it and a blank cell is not acceptable.
 * That is right for rendering and useless for noticing, and this path is entirely about noticing — a
 * design added to the catalogue never appeared on a wall panel until somebody walked over and
 * reloaded it, and nothing anywhere could tell "this page is old" from "that id is wrong".
 *
 * An absent or empty id is false: it is not a failure to resolve anything, it is a board that
 * named no design and will use the default on purpose.
 */
export function knows(widget, designId) {
  return Boolean(designId) && byWidget.get(widget)?.has(designId) === true
}

/** Test-only: the registry is module-global, so suites must be able to start clean. */
export function _reset() {
  byWidget.clear()
}
