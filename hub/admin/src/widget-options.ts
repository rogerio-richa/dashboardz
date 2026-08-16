/** The four one-value types a design can declare. A `list` is built out of these; it is not one. */
export type ScalarType = 'text' | 'number' | 'boolean' | 'select'
/**
 * What a `list`'s row may be built from. `feed` is an item type and NOT a top-level one: a cell's
 * own `config.feed` already has a hand-built control, and a design declaring it would draw the same
 * knob twice. `registry.mjs`'s `validateOptions` refuses `feed` outside a list item for exactly
 * that reason.
 */
export type ItemType = ScalarType | 'feed'

/** One field of a `list`'s repeating row. */
export type ItemField = {
  name: string
  type: ItemType
  label: string
  default?: unknown
  min?: number
  max?: number
  choices?: string[]
  /**
   * This key is in the save schema's `items.required`, so every row must carry it. An added row is
   * seeded with it; clearing its input falls back to that seed rather than deleting the key, since
   * a row missing a required key 400s the WHOLE grid PATCH.
   */
  required: boolean
  /**
   * An added row must not reuse a value another row already has. `chart`'s `icon` is the only one:
   * the save service refuses duplicate icons within one chart (`chart series icons must be
   * unique`), so a second row seeded with the first row's glyph is an undiagnosable 400.
   */
  unique: boolean
}

export type OptionField = {
  name: string
  /**
   * Where this option's value LIVES on `cell.config`, dotted. Always a string here even though
   * `meta.options[name].path` is optional: an absent declaration resolves to the option's own
   * name, which IS the flat top-level key the mechanism has always written, so a consumer has one
   * shape to handle instead of two. `registry.mjs`'s `validateOptions` has already refused any
   * path that is not dot-separated property names (no array indices, no `__proto__`) by the time a
   * design is registered — and refuses `path` outright on a `list`, which always writes its array
   * at its own name.
   */
  path: string
  type: ScalarType | 'list'
  label: string
  // Optional (explicit invariant): a knob whose unset meaning is
  // not itself a value of the declared type — `value_tile`'s `decimals`, "raw, unrounded" — must
  // be declarable with no default at all, rather than a placebo default the generated field would
  // show as if an operator had chosen it. `registry.mjs`'s `validateOptions` enforces the same
  // rule at design registration: a PRESENT default is still checked against `type`.
  default?: unknown
  /** A numeric bound on a scalar; the ROW COUNT bounds on a `list` (`minItems`/`maxItems`). */
  min?: number
  max?: number
  choices?: string[]
  /** Present exactly when `type === 'list'`: the fields one row is built from, in declaration order. */
  item?: ItemField[]
}

const OPTION_TYPES = new Set<OptionField['type']>(['text', 'number', 'boolean', 'select', 'list'])
const ITEM_TYPES = new Set<ItemType>(['text', 'number', 'boolean', 'select', 'feed'])

/** The keys every spec shares, narrowed off a raw declaration. */
function carryCommon(spec: Record<string, unknown>, field: { default?: unknown; min?: number; max?: number; choices?: string[] }) {
  if ('default' in spec) field.default = spec.default
  if (typeof spec.min === 'number') field.min = spec.min
  if (typeof spec.max === 'number') field.max = spec.max
  if (Array.isArray(spec.choices)) field.choices = spec.choices as string[]
}

function asItemField(name: string, raw: unknown): ItemField | null {
  if (!raw || typeof raw !== 'object') return null
  const spec = raw as Record<string, unknown>
  if (typeof spec.type !== 'string' || !ITEM_TYPES.has(spec.type as ItemType)) return null
  if (typeof spec.label !== 'string') return null
  const field: ItemField = {
    name, type: spec.type as ItemType, label: spec.label,
    required: spec.required === true, unique: spec.unique === true,
  }
  carryCommon(spec, field)
  return field
}

/**
 * A design's `meta.options[name]`, narrowed from `unknown` into an `OptionField` the form can
 * trust — the browser design modules this ultimately reads from (`catalogue.mjs`'s designs) carry
 * no static types (every import of them is `// @ts-expect-error plain JS module`), so an
 * admin-side consumer has to earn its own typed shape at the boundary rather than assume the raw
 * JS object already has it. This mirrors `registry.mjs`'s own `validateOptions`, which enforces
 * this same shape at design registration time — a design that failed this check would already
 * have thrown before `CATALOGUE` finished loading, so in practice this narrowing only ever
 * confirms what registration already guaranteed. It exists anyway rather than an `as`/
 * `@ts-expect-error` on the call site, because "trust the JS object's shape" is exactly the kind
 * of assumption that should not be papered over.
 */
function asOptionField(name: string, raw: unknown): OptionField | null {
  if (!raw || typeof raw !== 'object') return null
  const spec = raw as Record<string, unknown>
  if (typeof spec.type !== 'string' || !OPTION_TYPES.has(spec.type as OptionField['type'])) return null
  if (typeof spec.label !== 'string') return null
  // A non-string or empty `path` falls back to the option's own name rather than dropping the
  // field: `validateOptions` already refused both at registration, so this is the same
  // "confirm what registration guaranteed" narrowing the rest of this function does — and the
  // one-directional invariant `widget-options.test.ts` pins says the form must never DROP an
  // option the registry accepted. A `list` never has one: its array lives at its own name.
  const isList = spec.type === 'list'
  const path = !isList && typeof spec.path === 'string' && spec.path !== '' ? spec.path : name
  const field: OptionField = { name, path, type: spec.type as OptionField['type'], label: spec.label }
  carryCommon(spec, field)
  if (isList) {
    const item = spec.item
    // An empty `item` cannot happen — `validateList` refuses it — but the field is kept rather
    // than dropped either way, for the same one-directional reason as `path` above.
    field.item = item && typeof item === 'object' && !Array.isArray(item)
      ? Object.entries(item as Record<string, unknown>)
        .map(([key, raw]) => asItemField(key, raw))
        .filter((f): f is ItemField => f !== null)
      : []
  }
  return field
}

/**
 * What one field of a FRESHLY ADDED row starts as.
 *
 * Only the shape matters here, and it has to be exactly the one the save schema accepts —
 * `additionalProperties: false` with required item keys, so a row missing `header`, or carrying a
 * stray key, 400s the entire grid PATCH. Hence: a required field is seeded, an optional one is left
 * out entirely (the renderer's own fallback is what an absent optional key means, and writing a
 * placebo would be indistinguishable from an operator choosing it).
 */
export function seedItemValue(field: ItemField, rows: Record<string, unknown>[]): unknown {
  if (field.type === 'boolean') return field.default === true
  if (field.type === 'number') return typeof field.default === 'number' ? field.default : 0
  if (field.type === 'select') {
    const choices = field.choices ?? []
    if (field.unique) {
      // The first choice no other row is already using — the rule `ChartSeriesEditor`'s `nextIcon`
      // hand-wrote for chart icons, now declared. Falls back to the first choice once they are all
      // taken, which a `max` at or below `choices.length` makes unreachable anyway.
      const used = new Set(rows.map((row) => row[field.name]))
      return choices.find((choice) => !used.has(choice)) ?? choices[0] ?? ''
    }
    return typeof field.default === 'string' && choices.includes(field.default) ? field.default : (choices[0] ?? '')
  }
  // text, and `feed` — a fresh row binds nothing and the operator picks. `''` is what the
  // hand-built editors both wrote, and it is what an empty control shows.
  return typeof field.default === 'string' ? field.default : ''
}

/** A new row for this list: every required key, seeded; no optional key at all. */
export function newListRow(field: OptionField, rows: Record<string, unknown>[]): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const item of field.item ?? []) {
    if (item.required) row[item.name] = seedItemValue(item, rows)
  }
  return row
}

// `meta`'s own index signature (`[key: string]: unknown`) matches `design-registry.ts`'s
// `DesignEntry` structurally, so a real `DesignEntry` (extra keys: `id`, `widget`, `label`, …)
// satisfies this without a cast, and an inline test literal with those same extra keys does not
// trip TypeScript's excess-property check on the nested object literal either.
type DesignLike = { meta?: { options?: Record<string, unknown>; [key: string]: unknown } }

/** Declaration order is form order: the author decided what to read first. */
export function optionFields(design: DesignLike): OptionField[] {
  const options = design?.meta?.options
  if (!options) return []
  return Object.entries(options)
    .map(([name, spec]) => asOptionField(name, spec))
    .filter((field): field is OptionField => field !== null)
}
