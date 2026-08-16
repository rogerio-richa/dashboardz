import { describe, expect, it } from 'vitest'
import { newListRow, optionFields, seedItemValue } from './widget-options'

const design = {
  meta: {
    id: 'ring', widget: 'gauge', label: 'Ring',
    options: {
      show_value: { type: 'boolean', label: 'Show the number', default: true },
      thickness: { type: 'number', label: 'Ring thickness', default: 12, min: 4, max: 40 },
    },
  },
}

describe('widget option forms', () => {
  it('lists declared options in declaration order', () => {
    expect(optionFields(design).map((f) => f.name)).toEqual(['show_value', 'thickness'])
  })

  it('carries the human label, never the property name', () => {
    expect(optionFields(design)[0].label).toBe('Show the number')
  })

  it('produces no fields for a design that declares none', () => {
    expect(optionFields({ meta: { id: 'digital', widget: 'clock', label: 'Digital' } })).toEqual([])
  })

  // Invariant: an option may omit `default` entirely — the
  // honest declaration for a knob whose unset meaning (e.g. `value_tile`'s `decimals`, "raw,
  // unrounded") is not itself a value of the option's own type.
  // Deliberately a made-up design and a made-up knob. An earlier version of this fixture called
  // itself `{ id: 'tile', widget: 'value_tile' }` with `decimals: { max: 10 }` — borrowing the real
  // design's identity while declaring a bound the server rejects (`admin.ts` caps decimals at 3).
  // Nothing broke, because `optionFields` is pure pass-through, but it read as documentation of a
  // bound that would 400 on save. A fixture testing generic pass-through should not impersonate a
  // shipped design; `option-bounds.test.ts` is where the real bounds are pinned against the schema.
  it('carries an option through with default left undefined when the design omits it', () => {
    const noDefault = {
      meta: {
        id: 'fixture', widget: 'fixture_widget', label: 'Fixture',
        options: { amount: { type: 'number', label: 'Amount', min: 0, max: 10 } },
      },
    }
    const fields = optionFields(noDefault)
    expect(fields).toHaveLength(1)
    expect(fields[0].default).toBeUndefined()
    expect(fields[0].min).toBe(0)
    expect(fields[0].max).toBe(10)
  })

  it('ignores an option entry that does not look like a valid spec, rather than crashing the form', () => {
    const malformed = { meta: { id: 'x', widget: 'x', label: 'X', options: { broken: 'not an object' } } }
    expect(optionFields(malformed)).toEqual([])
  })
})

/**
 * `path`. The field carries WHERE its value lives, and it is always a string here even
 * though the declaration is optional, because "no path" and "the flat key named after the option"
 * are the same location. A consumer (`CellConfig.tsx`) then has one shape to read and write
 * instead of a present/absent branch at every call site.
 */
describe('an option that declares where its value lives', () => {
  const withPath = (spec: Record<string, unknown>) =>
    optionFields({ meta: { id: 'f', widget: 'w', label: 'F', options: { warn: spec } } })[0]

  it('carries a declared dotted path through unchanged', () => {
    expect(withPath({ type: 'number', label: 'Warn', path: 'thresholds.warn' }).path).toBe('thresholds.warn')
  })

  it('defaults an undeclared path to the option\'s own name — today\'s flat behaviour, spelled out', () => {
    expect(withPath({ type: 'number', label: 'Warn' }).path).toBe('warn')
  })

  it('falls back to the name for a path the registry would never have accepted', () => {
    // Unreachable in practice — `validateOptions` throws at registration for both of these, so no
    // such design reaches this bundle. The fallback exists so the form cannot silently DROP a
    // field, which is the one direction the drift guard below forbids.
    expect(withPath({ type: 'number', label: 'Warn', path: '' }).path).toBe('warn')
    expect(withPath({ type: 'number', label: 'Warn', path: 42 }).path).toBe('warn')
  })
})

/**
 * The drift guard between the two places option specs are understood.
 *
 * `registry.mjs`'s `validateOptions` decides whether a design may REGISTER. The admin's own
 * `asOptionField` decides whether a declared option becomes a FORM FIELD. They are separately
 * written, in separately-built bundles, and nothing tied them together — so a rule added to one and
 * not the other would produce a design that registers cleanly and then silently loses controls in
 * the editor. No error, just missing UI.
 *
 * The invariant is deliberately one-directional, not equality. `asOptionField` being MORE
 * permissive is harmless: it can only mean the form renders something the registry would have
 * refused, and the registry throws first at load, so such a spec never reaches the admin. What must
 * never happen is the reverse — a spec the registry ACCEPTS that the form then drops.
 */
describe('registry and admin agree on option specs', () => {
  const ACCEPTED: Record<string, unknown>[] = [
    { a: { type: 'text', label: 'A', default: '' } },
    { a: { type: 'text', label: 'A' } },
    { a: { type: 'number', label: 'A', default: 2 } },
    { a: { type: 'number', label: 'A', min: 0, max: 3 } },
    { a: { type: 'boolean', label: 'A', default: true } },
    { a: { type: 'boolean', label: 'A', default: false } },
    { a: { type: 'select', label: 'A', default: 'x', choices: ['x', 'y'] } },
    { a: { type: 'select', label: 'A', choices: ['x'] } },
    { a: { type: 'number', label: 'A', path: 'thresholds.warn' } },
    { a: { type: 'boolean', label: 'A', default: true, path: 'overflow.counter' } },
    { a: { type: 'text', label: 'A', path: 'a.b.c' } },
    // A repeating group, and every item field type only a row may have.
    { a: { type: 'list', label: 'row', min: 1, max: 4, item: { b: { type: 'text', label: 'B' } } } },
    {
      a: {
        type: 'list', label: 'row', min: 0, max: 2,
        item: {
          b: { type: 'text', label: 'B', required: true },
          c: { type: 'feed', label: 'C', required: true },
          d: { type: 'select', label: 'D', choices: ['x', 'y'], unique: true },
          e: { type: 'boolean', label: 'E', default: true },
          f: { type: 'number', label: 'F', min: 0, max: 3 },
        },
      },
    },
    {
      first: { type: 'text', label: 'First', default: '' },
      second: { type: 'number', label: 'Second', default: 1, min: 0, max: 3 },
      third: { type: 'select', label: 'Third', default: 'a', choices: ['a', 'b'] },
    },
  ]

  it('renders a form field for every option the registry is willing to register', async () => {
    // @ts-expect-error plain JS module without types
    const { validateOptions } = await import('../../static/device/widgets/registry.mjs')

    for (const options of ACCEPTED) {
      const meta = { id: 'fixture', widget: 'fixture_widget', label: 'Fixture', options }
      expect(validateOptions(meta), `registry should accept ${JSON.stringify(options)}`).toBeNull()

      const names = optionFields({ meta } as never).map((f) => f.name)
      expect(names, `admin dropped an option the registry accepted: ${JSON.stringify(options)}`)
        .toEqual(Object.keys(options))
    }
  })

  it('proves the guard can fail, rather than passing because both sides do nothing', async () => {
    // @ts-expect-error plain JS module without types
    const { validateOptions } = await import('../../static/device/widgets/registry.mjs')
    // A spec the registry refuses — so the one-directional invariant says nothing about it, and the
    // loop above would never have exercised it. This pins that the corpus above is not vacuous.
    const refused = { a: { type: 'colour', label: 'A', default: '#fff' } }
    expect(validateOptions({ id: 'x', widget: 'x', label: 'X', options: refused })).not.toBeNull()
  })
})

/**
 * `list`. A repeating group carried through as a field with its ROW BOUNDS and the item
 * fields one row is built from, plus the two things a hand-written editor needs: which keys a new
 * row must carry, and what they start as.
 *
 * The seeding rules are not cosmetic. Both save schemas for a repeating knob are
 * `additionalProperties: false` with required item keys, and the grid is PATCHed WHOLE — so a row
 * missing `header`, or carrying a stray key, 400s every unsaved edit on the screen with a message
 * about a key the operator never touched.
 */
describe('a list option', () => {
  const columns = {
    meta: {
      id: 'grid', widget: 'table', label: 'Grid',
      options: {
        columns: {
          type: 'list', label: 'column', min: 1, max: 4,
          item: {
            header: { type: 'text', label: 'header', required: true },
            path: { type: 'text', label: 'path', required: true },
            align: { type: 'select', label: 'align', default: 'left', choices: ['left', 'right'] },
          },
        },
      },
    },
  }
  const field = () => optionFields(columns)[0]

  it('carries the row bounds and the item fields, in declaration order', () => {
    expect(field().type).toBe('list')
    expect([field().min, field().max]).toEqual([1, 4])
    expect(field().item?.map((f) => f.name)).toEqual(['header', 'path', 'align'])
  })

  /** A list writes its array at its own name; `validateOptions` refuses a `path` on one outright. */
  it('resolves its location to its own name', () => {
    expect(field().path).toBe('columns')
  })

  it('carries required and unique as booleans, defaulting to false when undeclared', () => {
    const item = field().item ?? []
    expect(item.map((f) => f.required)).toEqual([true, true, false])
    expect(item.map((f) => f.unique)).toEqual([false, false, false])
  })

  it('seeds a new row with every required key and no optional one', () => {
    // Exactly what `renderTableFields`'s hand-built "Add column" wrote: `align` is optional and the
    // renderer's own fallback is what its absence means.
    expect(newListRow(field(), [])).toEqual({ header: '', path: '' })
  })

  it('ignores an item entry that does not look like a valid spec, rather than crashing the form', () => {
    const malformed = {
      meta: {
        id: 'x', widget: 'x', label: 'X',
        options: { rows: { type: 'list', label: 'row', min: 1, max: 2, item: { broken: 'not an object' } } },
      },
    }
    expect(optionFields(malformed)[0].item).toEqual([])
  })
})

/**
 * `unique` — the rule `ChartSeriesEditor`'s `nextIcon` hand-wrote. `screens/save.ts` refuses two
 * chart series wearing the same glyph, so a row seeded with a value another row already holds is a
 * 400 on a key the operator never chose.
 */
describe('seeding a unique item field', () => {
  const icon = {
    name: 'icon', type: 'select' as const, label: 'icon',
    choices: ['circle', 'square', 'triangle'], required: true, unique: true,
  }

  it('picks the first choice no other row is using', () => {
    expect(seedItemValue(icon, [])).toBe('circle')
    expect(seedItemValue(icon, [{ icon: 'circle' }])).toBe('square')
    expect(seedItemValue(icon, [{ icon: 'circle' }, { icon: 'square' }])).toBe('triangle')
  })

  it('reuses the first choice only once every one of them is taken', () => {
    expect(seedItemValue(icon, [{ icon: 'circle' }, { icon: 'square' }, { icon: 'triangle' }])).toBe('circle')
  })

  it('a select that is NOT unique seeds its declared default, then its first choice', () => {
    const align = { name: 'align', type: 'select' as const, label: 'align', choices: ['left', 'right'], required: true, unique: false }
    expect(seedItemValue({ ...align, default: 'right' }, [{ align: 'right' }])).toBe('right')
    expect(seedItemValue(align, [])).toBe('left')
  })

  it('seeds the other types from their own declared default, or their type\'s empty value', () => {
    const base = { label: 'x', required: true, unique: false }
    expect(seedItemValue({ ...base, name: 'a', type: 'text' }, [])).toBe('')
    expect(seedItemValue({ ...base, name: 'a', type: 'text', default: 'hi' }, [])).toBe('hi')
    // A fresh row binds nothing and the operator picks — what the hand-built series editor wrote.
    expect(seedItemValue({ ...base, name: 'a', type: 'feed' }, [])).toBe('')
    expect(seedItemValue({ ...base, name: 'a', type: 'boolean' }, [])).toBe(false)
    expect(seedItemValue({ ...base, name: 'a', type: 'boolean', default: true }, [])).toBe(true)
    expect(seedItemValue({ ...base, name: 'a', type: 'number' }, [])).toBe(0)
    expect(seedItemValue({ ...base, name: 'a', type: 'number', default: 7 }, [])).toBe(7)
  })
})
