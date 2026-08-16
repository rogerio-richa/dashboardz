import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { RECT_MIN } from '../static/device/layout-core.mjs'
import { WIDGET_FEED_MODES } from '../src/screens/save.js'
import { cellSchema, gridSchema } from '../src/screens/cellSchema.js'

/**
 * `docs/architecture/screens.md` is the published "how to build a screen" page — the one an
 * outside author, human or model, is meant to produce a saveable screen from without reading
 * `cellSchema.ts`. Its reader cannot tell a wrong doc from a right one; it will follow whatever the
 * page says. So the claims that rot silently are pinned against the code that enforces them, in the
 * spirit of `contract-doc.test.ts` next door.
 *
 * This project has twice shipped documentation that was wrong because it was written from memory,
 * each time caught only by somebody grepping the source before commit. A doc that has quietly
 * drifted is not a neutral loss: it is a confident, wrong answer, and it is published.
 *
 * Everything here reads BOTH sides. Hard-coding a widget list or a bound in this file would just
 * be a third place for it to live and a third place for it to drift — the point is that the page
 * and the schema are compared to each other, so moving either one alone fails here.
 *
 * The schema-side reader uses the exported plain object from `cellSchema.ts`, so a
 * `boundOrPending` reshape cannot silently move config properties outside a text-matching region.
 * The checks walk the object directly and therefore pin the complete schema.
 */
const DOC = readFileSync('../docs/architecture/screens.md', 'utf8')
const SCREEN_ROUTES_SRC = readFileSync('src/routes/admin/screens.ts', 'utf8')

/** The catalogue section only — widget names appear in prose all over the rest of the page. */
const CATALOGUE_SECTION = (() => {
  const from = DOC.indexOf('## The widget catalogue')
  expect(from, 'the doc must have a "## The widget catalogue" section').toBeGreaterThan(-1)
  const rest = DOC.slice(from + 1)
  const to = rest.indexOf('\n## ')
  return to === -1 ? rest : rest.slice(0, to)
})()

/** The widget enum, read off the real schema object instead of regexing admin.ts. */
function schemaWidgets(): string[] {
  return (cellSchema.properties.widget as { enum: string[] }).enum
}

/**
 * Every property name any config branch accepts — the same set the old text-reader produced
 * (a leaf is "a named property whose schema declares type or enum"), now read off the object.
 * The pinned doc is the referee: it has not changed in this commit, so a walk that extracts a
 * different set than the regex did fails the doc test rather than silently passing.
 */
function schemaConfigKeys(): string[] {
  const names = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const properties = record.properties as Record<string, Record<string, unknown>> | undefined
    if (properties) {
      for (const [name, value] of Object.entries(properties)) {
        if (value && typeof value === 'object' && ('type' in value || 'enum' in value)) names.add(name)
      }
    }
    for (const value of Object.values(record)) walk(value)
  }
  for (const branch of (cellSchema as { oneOf: { properties: { config: unknown } }[] }).oneOf) {
    walk(branch.properties.config)
  }
  return [...names].sort()
}

describe('the published screen guide stays true', () => {
  /**
   * THE catalogue assertion. The page's whole value is that a reader can look up a widget and get
   * its real config; a widget the schema accepts but the catalogue never names is a hole the
   * reader cannot see, and a widget the catalogue names but the schema rejects sends them to a
   * guaranteed 400. Both directions, so adding a widget type without documenting it fails here.
   */
  it('the catalogue names EXACTLY the widget types the schema accepts', () => {
    const schema = schemaWidgets().sort()
    expect(schema.length).toBe(12)

    const documented = [...CATALOGUE_SECTION.matchAll(/^### `([a-z_]+)`/gm)].map((m) => m[1])
    // The three semantic widgets share one `###` heading, so they are named in it as a group;
    // pick those up from the heading text the same way.
    const grouped = [...CATALOGUE_SECTION.matchAll(/^### Semantic widgets: (.+)$/gm)]
      .flatMap((m) => [...m[1].matchAll(/`([a-z_]+)`/g)].map((w) => w[1]))

    expect([...new Set([...documented, ...grouped])].sort()).toEqual(schema)
  })

  /**
   * A widget's accepted feed modes are the difference between a screen that saves and a 400 the
   * author cannot explain, and the page states them in one summary table. Asserted from
   * `WIDGET_FEED_MODES` — the map the save service actually enforces — in both directions, so a
   * mode quietly added to or removed from a widget shows up here rather than on a wall.
   */
  it('the binding summary states each widget\'s real feed modes', () => {
    const ALL_MODES = ['value', 'stream', 'image'] as const
    for (const [widget, modes] of Object.entries(WIDGET_FEED_MODES)) {
      const row = new RegExp(`^\\| \`${widget}\` \\|([^|]*)\\|`, 'm').exec(CATALOGUE_SECTION)
      expect(row, `no binding-summary row for ${widget}`).not.toBeNull()
      const cell = row![1]
      for (const mode of ALL_MODES) {
        expect(
          cell.includes(`\`${mode}\``),
          `binding summary for ${widget} ${modes.includes(mode) ? 'omits' : 'wrongly claims'} \`${mode}\``,
        ).toBe(modes.includes(mode))
      }
    }
  })

  /**
   * Every config property the schema accepts must appear on the page. This is the dead-knob guard's
   * mirror image: `knob-coverage.test.ts` pins that a schema-accepted key reaches a renderer, this
   * pins that it reaches the reader. A key the page never mentions is one the author will never
   * use, and `additionalProperties: false` means guessing at it costs them the whole grid save.
   */
  it('names every config key the widget branches accept', () => {
    const keys = schemaConfigKeys()
    // Guard the guard: a regex that silently stopped matching would make every assertion below
    // vacuous. These four span the shared props, a nested container and an array item.
    expect(keys).toEqual(expect.arrayContaining(['feed', 'path', 'thresholds', 'y_path']))
    expect(keys.length).toBeGreaterThan(30)
    for (const key of keys) {
      // Inside a backtick span, as a whole word — a nested knob is documented at the location it
      // actually lives (`clamp.body_lines`), which is the spelling that saves, so demanding a bare
      // `body_lines` would push the page toward the flat spelling the schema rejects.
      const mentioned = new RegExp(`\`[^\`\\n]*\\b${key}\\b[^\`\\n]*\``).test(DOC)
      expect(mentioned, `the doc never mentions the config key \`${key}\``).toBe(true)
    }
  })

  /** Every design a cell may name in `config.design`, so a new design cannot ship undocumented. */
  it('names every design in the catalogue', () => {
    for (const design of CATALOGUE as { meta: { id: string; widget: string } }[]) {
      expect(
        DOC.includes(`\`${design.meta.id}\``),
        `the doc never mentions design ${design.meta.widget}/${design.meta.id}`,
      ).toBe(true)
    }
  })

  /**
   * The numbers an author computes a layout from. `RECT_MIN` is read off the renderer and the cell
   * count off the schema, because a page that states the wrong minimum produces rects the hub
   * refuses and a reader with no way to know why.
   */
  it('quotes the real rect minimum and cell count', () => {
    expect(DOC).toContain(`\`RECT_MIN = ${RECT_MIN}\``)
    const cells = (gridSchema.properties.cells as { minItems: number; maxItems: number })
    expect(DOC).toContain(`**${cells.minItems}–${cells.maxItems} entries**`)
  })

  /**
   * The two save-time refusals an author meets most, quoted exactly so the page's error section
   * can be matched against a real response body rather than paraphrased into something that never
   * appears.
   */
  it('quotes the rev guard\'s messages exactly as the route sends them', () => {
    for (const message of ['rev is required when saving a grid', 'screen changed elsewhere']) {
      expect(SCREEN_ROUTES_SRC).toContain(message)
      expect(DOC).toContain(message)
    }
  })

  /**
   * `rev` is accepted on PATCH and deliberately NOT on POST — admitting it on a create would let a
   * caller send a number that is silently ignored, which is the shape of bug the guard exists to
   * remove. A page that told an author to send it on create would teach exactly that mistake.
   */
  it('does not tell an author to send rev when creating a screen', () => {
    expect(DOC).toContain('**not accepted on\nPOST**')
  })
})
