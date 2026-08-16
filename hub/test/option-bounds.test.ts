import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cellSchema } from '../src/screens/cellSchema.js'

/**
 * A design's declared numeric option bounds must fit INSIDE what the grid PATCH schema accepts.
 *
 * The bug this pins: `value_tile`, `gauge/ring` and
 * `gauge/bar` each declared `decimals: { min: 0, max: 10 }`, while `cellSchema.ts` has long
 * accepted `decimals` only as `integer, minimum 0, maximum 3`. Since tab state the admin GENERATES its
 * form field straight from `meta.options` — `min={field.min} max={field.max}` in `CellConfig.tsx` —
 * so the widened bound put four values (4..10) in front of an operator that the server rejects with
 * a 400. The rejection is not scoped to the offending cell either: the grid is PATCHed whole, so
 * one bad `decimals` loses every unsaved edit on the screen. The hand-built field this generated
 * one replaced used `max={3}` and had always agreed with the server; the disagreement arrived with
 * the generated form.
 *
 * Both sides are READ, never restated. Hard-coding `3` in this file would just be a third place for
 * the number to live and a third place for it to drift — the point is that the design and the route
 * are compared to each other, so moving either one alone fails here. `cellSchema.ts` exports the
 * schema as a plain object, so these checks walk the object directly and no text region can
 * silently stop matching a reshape. The designs remain imported for discovery, using the same
 * approach as `portable-subset.test.ts`.
 */

type Bounds = { minimum?: number; maximum?: number }

/**
 * Every numeric leaf (`{ type: 'integer'|'number', minimum?, maximum? }`) reachable from a schema
 * node, keyed by property name — walked recursively so a nested knob (`clamp.body_lines`) is found
 * the same as a top-level one. Only numeric leaves are of interest: a design's `min`/`max` option
 * bounds are numeric by construction, and `maxLength`/`minLength` (strings) and `minItems`/
 * `maxItems` (arrays) are deliberately NOT matched — they bound a different thing and pairing them
 * with an option's numeric range would be a false equivalence.
 *
 * No separate "shared props" pass is needed here, unlike the old text reader: `scaleProp` and
 * friends were spread into every branch's `properties` object AT SCHEMA-CONSTRUCTION TIME
 * (`...scaleProp`), so by the time this walks the resolved `cellSchema` object, `scale`'s bound is
 * already sitting on every widget's own `config.properties` — there is no separate region to merge.
 */
function numericBounds(node: unknown): Map<string, Bounds> {
  const found = new Map<string, Bounds>()
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const properties = record.properties as Record<string, Record<string, unknown>> | undefined
    if (properties) {
      for (const [name, spec] of Object.entries(properties)) {
        if (!spec || typeof spec !== 'object') continue
        if (spec.type !== 'integer' && spec.type !== 'number') continue
        const minimum = spec.minimum as number | undefined
        const maximum = spec.maximum as number | undefined
        if (minimum === undefined && maximum === undefined) continue
        // A name appearing in several branches keeps the STRICTEST bound seen. `decimals` appears
        // twice (value_tile, gauge) at the same 0..3; taking the tightest is the safe direction
        // regardless, since a design must fit inside every branch that could carry it.
        const prev = found.get(name) ?? {}
        const next: Bounds = { ...prev }
        if (minimum !== undefined) next.minimum = Math.max(prev.minimum ?? -Infinity, minimum)
        if (maximum !== undefined) next.maximum = Math.min(prev.maximum ?? Infinity, maximum)
        found.set(name, next)
      }
    }
    for (const value2 of Object.values(record)) walk(value2)
  }
  walk(node)
  return found
}

/**
 * The `cellSchema.oneOf` branches, sliced per widget type on their own `widget: { const: 'x' }`
 * discriminator — the same key a design's `meta.widget` names. Slicing per widget rather than
 * flattening the whole schema keeps two different widgets' same-named knobs from being conflated.
 */
function schemaByWidget(): Map<string, Map<string, Bounds>> {
  const byWidget = new Map<string, Map<string, Bounds>>()
  for (const branch of cellSchema.oneOf as { properties: { widget: { const: string }; config: unknown } }[]) {
    byWidget.set(branch.properties.widget.const, numericBounds(branch.properties.config))
  }
  return byWidget
}

function mjsUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? mjsUnder(p) : p.endsWith('.mjs') ? [p] : []
  })
}

type OptionSpec = {
  type?: string
  min?: number
  max?: number
  required?: boolean
  item?: Record<string, OptionSpec>
}
type Declared = { design: string; widget: string; option: string; spec: OptionSpec }
type DeclaredList = Declared & { spec: OptionSpec & { item: Record<string, OptionSpec> } }

/** Every design's `meta.options`, flattened to `(design, widget, option name, spec)` rows. */
async function declaredOptions(): Promise<Declared[]> {
  const out: Declared[] = []
  for (const file of mjsUnder('static/device/widgets')) {
    const mod = await import(pathToFileURL(resolve(file)).href)
    const meta = mod?.default?.meta
    if (!meta?.widget) continue
    for (const [option, raw] of Object.entries(meta.options ?? {})) {
      out.push({ design: `${meta.widget}/${meta.id}`, widget: meta.widget, option, spec: raw as OptionSpec })
    }
  }
  return out
}

/**
 * Numeric options, from the top level AND from inside a `list`'s rows. An item field's `min`/`max`
 * are the same `min={…} max={…}` attributes on the same generated control, so a widened bound there
 * puts the same unsaveable value in front of the same operator; the schema side already walks the
 * whole widget branch as an object, so a nested numeric property is found by name like any other.
 */
function numericOptions(all: Declared[]): Declared[] {
  const out: Declared[] = []
  for (const row of all) {
    const nested = row.spec?.type === 'list' ? Object.entries(row.spec.item ?? {}) : []
    for (const [option, spec] of [[row.option, row.spec] as const, ...nested]) {
      if (spec?.type !== 'number') continue
      if (typeof spec.min !== 'number' && typeof spec.max !== 'number') continue
      out.push({ ...row, option, spec })
    }
  }
  return out
}

type ArraySchema = { minItems?: number; maxItems?: number; required: string[]; properties: string[] }

/**
 * Every `{ type: 'array', minItems, maxItems, items }` leaf reachable from a schema node, keyed by
 * property name — walked recursively, same shape as `numericBounds` above.
 *
 * `items: boundOrPending(visual, [required])` — chart's series, whose item is a feed id OR a
 * promise about a source that does not exist yet — is read as its STORED branch, `items.oneOf[0]`
 * (`boundOrPending`'s first oneOf entry is exactly that branch: `required: ['feed', ...alsoRequired]`,
 * `properties: {...visual, feed}`). That is the branch a generated control writes: the admin's
 * repeating row is built from `meta.options`, which has no way to express "pick a draft", so a row
 * it adds always carries `feed`. Reading the pending branch instead would demand the design declare
 * `source_draft_id` as a list field, which would be a knob no operator should ever be typing into.
 */
function arraySchemas(node: unknown): Map<string, ArraySchema> {
  const found = new Map<string, ArraySchema>()
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const properties = record.properties as Record<string, Record<string, unknown>> | undefined
    if (properties) {
      for (const [name, spec] of Object.entries(properties)) {
        if (!spec || typeof spec !== 'object' || spec.type !== 'array') continue
        const arr = spec as { minItems?: number; maxItems?: number; items?: unknown }
        const rawItem = arr.items as { oneOf?: unknown[] } | undefined
        const item = (rawItem?.oneOf ? rawItem.oneOf[0] : rawItem) as
          { required?: string[]; properties?: Record<string, unknown> } | undefined
        found.set(name, {
          minItems: arr.minItems, maxItems: arr.maxItems,
          required: item?.required ?? [],
          properties: item?.properties ? Object.keys(item.properties) : [],
        })
      }
    }
    for (const value2 of Object.values(record)) walk(value2)
  }
  walk(node)
  return found
}

/**
 * The array schemas of each widget's own `oneOf` branch, sliced on the same discriminator as
 * `schemaByWidget` above. Walking each branch's `config` alone — rather than the whole `cellSchema`
 * — is what keeps `gridSchema.cells` (an array that belongs to no widget) out of every widget's map;
 * that property lives on `gridSchema`, a different exported object this file never touches.
 */
function arraysByWidget(): Map<string, Map<string, ArraySchema>> {
  const byWidget = new Map<string, Map<string, ArraySchema>>()
  for (const branch of cellSchema.oneOf as { properties: { widget: { const: string }; config: unknown } }[]) {
    byWidget.set(branch.properties.widget.const, arraySchemas(branch.properties.config))
  }
  return byWidget
}

const schema = schemaByWidget()
const arrays = arraysByWidget()
const allDeclared = await declaredOptions()
const declared = numericOptions(allDeclared)
const declaredLists = allDeclared.filter(
  (d): d is DeclaredList => d.spec?.type === 'list' && !!d.spec.item,
)

describe('a design never offers a number the grid schema will reject', () => {
  for (const { design, widget, option, spec } of declared) {
    const bounds = schema.get(widget)?.get(option)
    if (!bounds) continue
    it(`${design}: ${option} stays inside the ${widget} schema branch`, () => {
      if (typeof spec.max === 'number' && bounds.maximum !== undefined) {
        expect(
          spec.max,
          `${design} declares ${option} max ${spec.max}, but cellSchema.ts accepts at most ` +
            `${bounds.maximum} — the admin generates this field from meta.options, so an operator ` +
            'can type a value the grid PATCH rejects with a 400.',
        ).toBeLessThanOrEqual(bounds.maximum)
      }
      if (typeof spec.min === 'number' && bounds.minimum !== undefined) {
        expect(
          spec.min,
          `${design} declares ${option} min ${spec.min}, below the schema's ${bounds.minimum}.`,
        ).toBeGreaterThanOrEqual(bounds.minimum)
      }
    })
  }
})

/**
 * A `list` generates a REPEATING control, and every row it can build has to be a row the grid PATCH
 * schema accepts. That is a stricter thing than a numeric bound, because three separate parts of
 * the declaration can each produce a 400 the operator cannot diagnose:
 *
 *  - `min`/`max` are the row-count bounds the admin enforces (Remove disappears at `min`, Add at
 *    `max`). Disagree with `minItems`/`maxItems` and the UI happily builds a fifth column, and the
 *    grid is PATCHed WHOLE — so the rejection costs every unsaved edit on the screen and names an
 *    array length nothing in the editor ever showed.
 *  - an item field the schema does not have is a STRAY KEY. Both item schemas are
 *    `additionalProperties: false`.
 *  - a `required: true` item field is what an ADDED ROW is seeded with. Miss one the schema
 *    requires and every added row 400s; mark one it does not and a row carries a key the operator
 *    never chose.
 *
 * Both sides are read, never restated: the declaration comes from importing the designs, the schema
 * from `cellSchema.ts`'s own exported object, so moving either alone fails here.
 */
describe('a design never generates a repeating row the grid schema will reject', () => {
  for (const { design, widget, option, spec } of declaredLists) {
    const found = arrays.get(widget)?.get(option)
    it(`${design}: ${option} matches the ${widget} schema's array of the same name`, () => {
      expect(
        found,
        `${design} declares a list called ${option}, but the ${widget} branch of cellSchema.ts ` +
          'has no array property of that name — the generated control would write a key the schema rejects.',
      ).toBeDefined()
      const item = found as ArraySchema
      expect([spec.min, spec.max], `${design}'s ${option} row bounds must be the schema's minItems/maxItems`)
        .toEqual([item.minItems, item.maxItems])
      expect(
        Object.keys(spec.item).filter((name) => !item.properties.includes(name)),
        `${design}'s ${option} declares an item field the schema has no property for; ` +
          'the item schema is additionalProperties:false, so that row is a 400.',
      ).toEqual([])
      expect(
        Object.entries(spec.item).filter(([, f]) => f.required === true).map(([name]) => name).sort(),
        `${design}'s ${option} must mark exactly the item keys the schema requires — an added row ` +
          'is seeded from them.',
      ).toEqual([...item.required].sort())
    })
  }
})

/**
 * The guard above only asserts over pairings it actually FOUND, so a regex that silently stopped
 * matching would turn the whole suite green while pinning nothing. These pin that both readers
 * still see the real thing — including the `decimals` case, from each side independently.
 */
describe('both sides are actually being read', () => {
  it('reads a decimals bound out of the route schema for value_tile and gauge', () => {
    expect(schema.get('value_tile')?.get('decimals')).toEqual({ minimum: 0, maximum: 3 })
    expect(schema.get('gauge')?.get('decimals')).toEqual({ minimum: 0, maximum: 3 })
  })

  it('reads a decimals bound off the designs that declare one', () => {
    const decimals = declared.filter((d) => d.option === 'decimals')
    expect(decimals.map((d) => d.design).sort()).toEqual(['gauge/bar', 'gauge/battery', 'gauge/ring', 'value_tile/tile'])
  })

  it('would fail a design whose bound exceeded the schema', () => {
    // The check itself, run against a deliberately-wrong declaration: without this, a comparison
    // accidentally written between two identical values would look like a passing guard.
    const bound = schema.get('value_tile')?.get('decimals')?.maximum
    expect(bound).toBeDefined()
    expect(10 <= (bound as number)).toBe(false)
  })

  /**
   * The array reader, from the schema side. The two shipped repeating knobs are the only things
   * that prove `arraySchemas` descended into `items` at all rather than returning empty maps the
   * loop above would then assert nothing over.
   */
  it('reads both repeating knobs whole out of the route schema', () => {
    expect(arrays.get('table')?.get('columns')).toEqual({
      minItems: 1, maxItems: 4, required: ['header', 'path'], properties: ['header', 'path', 'align'],
    })
    expect(arrays.get('chart')?.get('series')).toEqual({
      minItems: 1, maxItems: 4, required: ['feed', 'y_path', 'icon'],
      // `feed` sorts last: it comes from `{...visual, feed: bindProps.feed}`'s object key order,
      // not the old text reader's hand-built ['feed', ...visual] ordering.
      properties: ['y_path', 'icon', 'label', 'feed'],
    })
  })

  it('reads a list off the designs that declare one', () => {
    expect(declaredLists.map((d) => `${d.design}.${d.option}`).sort())
      .toEqual(['chart/plot.series', 'table/grid.columns'])
  })
})
