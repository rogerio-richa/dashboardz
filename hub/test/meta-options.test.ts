import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { validateOptions } from '../static/device/widgets/registry.mjs'

const design = (options: unknown) => ({ id: 'x', widget: 'gauge', label: 'X', options })

describe('meta.options validation', () => {
  it('accepts a design with no options at all', () => {
    expect(validateOptions({ id: 'x', widget: 'gauge', label: 'X' })).toBeNull()
  })

  it('accepts the four supported field types', () => {
    expect(validateOptions(design({
      a: { type: 'text', label: 'A', default: '' },
      b: { type: 'number', label: 'B', default: 1, min: 0, max: 2 },
      c: { type: 'boolean', label: 'C', default: true },
      d: { type: 'select', label: 'D', default: 'x', choices: ['x', 'y'] },
    }))).toBeNull()
  })

  it('refuses a fifth field type', () => {
    expect(validateOptions(design({ a: { type: 'colour', label: 'A', default: '#fff' } })))
      .toMatch(/type/)
  })

  it('refuses an option with no human label, because the form has nothing to print', () => {
    expect(validateOptions(design({ a: { type: 'text', default: '' } }))).toMatch(/label/)
  })

  it('refuses a select with no choices', () => {
    expect(validateOptions(design({ a: { type: 'select', label: 'A', default: 'x' } })))
      .toMatch(/choices/)
  })

  it('refuses a default that does not match its own declared type', () => {
    expect(validateOptions(design({ a: { type: 'number', label: 'A', default: 'not a number' } })))
      .toMatch(/default/)
  })

  // Invariant: a knob whose unset meaning is not a value of its
  // own type — `value_tile`'s `decimals`, "raw, unrounded" — must be declarable with no `default`
  // at all rather than a placebo. A PRESENT default is still checked (next two cases).
  it('accepts an option that declares no default at all', () => {
    expect(validateOptions(design({ a: { type: 'number', label: 'A', min: 0, max: 10 } }))).toBeNull()
  })

  it('still refuses a present-but-wrong-type default even when other options omit theirs', () => {
    expect(validateOptions(design({
      a: { type: 'number', label: 'A' },
      b: { type: 'text', label: 'B', default: 7 },
    }))).toMatch(/default/)
  })
})

/**
 * `path`. An option may name a NESTED location on `cell.config` instead of a flat
 * top-level key, which is what let `gauge`'s `thresholds.warn`/`.crit`, the `clamp.*` line limits
 * and `overflow.counter` stop being hand-built admin fields.
 *
 * Every rejection below is checked HERE, at registration, because that is where every other meta
 * error is caught: a design with a malformed path throws while `CATALOGUE` is still loading, long
 * before the admin could generate a form field from it or a device could draw it. The value a
 * generated field writes is whatever an operator typed, and the path segments become object KEYS
 * on board config — which this codebase treats as attacker-adjacent — so the check is an allowlist
 * of ordinary property names rather than a list of things to ban.
 */
describe('meta.options path validation', () => {
  it('accepts a dotted path of plain property names', () => {
    expect(validateOptions(design({ warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' } }))).toBeNull()
  })

  it('accepts a single-segment path — a flat key spelled explicitly', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: 'headers' } }))).toBeNull()
  })

  it('accepts a path more than two levels deep', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: 'a.b.c.d' } }))).toBeNull()
  })

  it('accepts an option with no path at all — the original, still the common case', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', default: '' } }))).toBeNull()
  })

  it('refuses a path that is not a string', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: 42 } }))).toMatch(/path/)
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: ['a', 'b'] } }))).toMatch(/path/)
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: null } }))).toMatch(/path/)
  })

  it('refuses an empty path — "no path" is spelled by omitting the key, not by an empty one', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: '' } }))).toMatch(/path/)
  })

  it('refuses an empty segment anywhere in the path', () => {
    for (const path of ['a..b', '.a', 'a.', '.', '..']) {
      expect(validateOptions(design({ a: { type: 'text', label: 'A', path } })), path).toMatch(/path/)
    }
  })

  /**
   * Array indices are refused on purpose, not by accident — and for a better reason since `list`
   * exists. A repeating structure IS declarable now, as `type: 'list'`, which owns the whole array
   * and lets the admin own the row count. `columns.0.header` is therefore not an unreachable knob,
   * it is the wrong spelling of a reachable one: it would pin an author's knob to row 0 of an array
   * whose length an operator changes, and the admin's patch builder would turn the index into a
   * string key on a plain object, producing a shape the save schema rejects.
   */
  it('refuses an array index, in either spelling', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: 'columns.0.header' } }))).toMatch(/path/)
    expect(validateOptions(design({ a: { type: 'text', label: 'A', path: 'columns[0].header' } }))).toMatch(/path/)
  })

  it('refuses anything that is not plainly a property name', () => {
    for (const path of ['a b', 'a-b', 'a.b c', 'a/b', 'a.b?', '1a']) {
      expect(validateOptions(design({ a: { type: 'text', label: 'A', path } })), path).toMatch(/path/)
    }
  })

  /**
   * Prototype pollution, refused by name. A generated field builds `{ [segment]: … }` objects from
   * these segments and writes an operator-supplied value at the leaf; a `__proto__` segment would
   * make that assignment reach the object prototype instead of the config. The design does not
   * register, so no such path ever reaches the admin bundle or a device.
   */
  it('refuses a __proto__, constructor or prototype segment', () => {
    for (const path of ['__proto__', '__proto__.polluted', 'a.__proto__.b', 'constructor', 'a.constructor', 'prototype', 'a.b.prototype']) {
      expect(validateOptions(design({ a: { type: 'text', label: 'A', path } })), path).toMatch(/path/)
    }
  })

  it('names the offending option, so a build fault points at the design that caused it', () => {
    expect(validateOptions(design({ warn: { type: 'number', label: 'Warn', path: 'a..b' } })))
      .toMatch(/options\.warn\.path/)
  })

  it('refuses a bad path even when every other option in the same design is fine', () => {
    expect(validateOptions(design({
      good: { type: 'number', label: 'Good', path: 'thresholds.warn' },
      bad: { type: 'number', label: 'Bad', path: 'thresholds..crit' },
    }))).toMatch(/path/)
  })
})

/**
 * `list`, and the end of the contract's stated limitation. An option may declare a
 * REPEATING GROUP: `min`/`max` rows, each row an object built from the `item` fields. `table`'s
 * `columns` and `chart`'s `series` are the two shipped ones, and each cost a hand-written admin
 * editor for as long as this could not be said.
 *
 * Everything here is refused at REGISTRATION, exactly like `path`: a malformed list would generate
 * a form that writes rows the grid PATCH rejects, and the grid is PATCHed whole — so the 400 lands
 * on every unsaved edit on the screen, naming a key or an array length the operator never saw.
 */
describe('meta.options list validation', () => {
  const list = (over: Record<string, unknown> = {}) => ({
    type: 'list',
    label: 'column',
    min: 1,
    max: 4,
    item: {
      header: { type: 'text', label: 'header', required: true },
      align: { type: 'select', label: 'align', default: 'left', choices: ['left', 'right'] },
    },
    ...over,
  })

  it('accepts a list of ordinary item fields', () => {
    expect(validateOptions(design({ columns: list() }))).toBeNull()
  })

  it('accepts a feed item field — the one type only a row may have', () => {
    expect(validateOptions(design({
      series: list({ item: { feed: { type: 'feed', label: 'feed', required: true } } }),
    }))).toBeNull()
  })

  it('accepts a unique select item field, which is what keeps an added row off a taken value', () => {
    expect(validateOptions(design({
      series: list({ item: { icon: { type: 'select', label: 'icon', choices: ['a', 'b'], unique: true } } }),
    }))).toBeNull()
  })

  it('refuses a list with no human label', () => {
    expect(validateOptions(design({ columns: list({ label: '' }) }))).toMatch(/label/)
  })

  /**
   * The bounds are not decoration. The admin refuses to remove below `min` or add above `max`, on
   * behalf of the save schema's `minItems`/`maxItems`; a list with neither would generate a control
   * that builds a five-column table and a 400 nobody can read.
   */
  it('refuses a list with no row bounds, or bounds that are not whole counts', () => {
    expect(validateOptions(design({ columns: list({ min: undefined }) }))).toMatch(/min/)
    expect(validateOptions(design({ columns: list({ max: undefined }) }))).toMatch(/max/)
    expect(validateOptions(design({ columns: list({ min: 1.5 }) }))).toMatch(/min/)
    expect(validateOptions(design({ columns: list({ min: -1 }) }))).toMatch(/min/)
    expect(validateOptions(design({ columns: list({ max: 0 }) }))).toMatch(/max/)
    expect(validateOptions(design({ columns: list({ min: '1' }) }))).toMatch(/min/)
  })

  it('refuses a max below its own min — a range no row count can satisfy', () => {
    expect(validateOptions(design({ columns: list({ min: 3, max: 2 }) }))).toMatch(/max/)
  })

  it('refuses a list with no item fields at all', () => {
    expect(validateOptions(design({ columns: list({ item: undefined }) }))).toMatch(/item/)
    expect(validateOptions(design({ columns: list({ item: {} }) }))).toMatch(/item/)
    expect(validateOptions(design({ columns: list({ item: [] }) }))).toMatch(/item/)
    expect(validateOptions(design({ columns: list({ item: 'header' }) }))).toMatch(/item/)
  })

  /**
   * An item field is an ORDINARY option spec, checked by the same rules — so an author who has
   * written a top-level option already knows how to write one, and a malformed one is caught in the
   * same place rather than reaching the form.
   */
  it('applies the ordinary field rules inside item, and names the offending field', () => {
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'colour', label: 'A' } } }) })))
      .toMatch(/options\.columns\.item\.a\.type/)
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'text' } } }) })))
      .toMatch(/options\.columns\.item\.a\.label/)
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'select', label: 'A' } } }) })))
      .toMatch(/options\.columns\.item\.a\.choices/)
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'number', label: 'A', default: 'x' } } }) })))
      .toMatch(/options\.columns\.item\.a\.default/)
  })

  it('refuses a bad item field even when every other field in the same list is fine', () => {
    expect(validateOptions(design({
      columns: list({ item: { good: { type: 'text', label: 'Good' }, bad: { type: 'text' } } }),
    }))).toMatch(/options\.columns\.item\.bad/)
  })

  /**
   * ONE level, and the error says so. Nesting a list inside a list would need the admin to render a
   * repeating group inside a repeating row and the patch builder to write through an array index
   * into another array — neither exists, and no save schema in this codebase has such a shape.
   */
  it('refuses a list inside a list, and says that is what it is refusing', () => {
    const inner = { type: 'list', label: 'point', min: 1, max: 2, item: { x: { type: 'number', label: 'x' } } }
    expect(validateOptions(design({ columns: list({ item: { points: inner } }) })))
      .toMatch(/a list cannot contain another list/)
  })

  /**
   * `feed` is a row-only type. Every data widget's own `config.feed` already has a hand-built
   * control in `CellConfig.tsx`; a design declaring it would put a SECOND control on the same key,
   * which is the bug `image.fit` and `alert_feed.min_severity` each shipped once.
   */
  it('refuses a feed field outside a list item', () => {
    expect(validateOptions(design({ feed: { type: 'feed', label: 'feed' } })))
      .toMatch(/must not be feed outside a list item/)
  })

  it('refuses a default on a feed field — a feed id is a board\'s, not a design\'s', () => {
    expect(validateOptions(design({
      series: list({ item: { feed: { type: 'feed', label: 'feed', default: 'feed_abc' } } }),
    }))).toMatch(/default/)
  })

  /**
   * `path` is REFUSED on a list, deliberately and for now. A list writes its array at its own name,
   * which is where both shipped repeating knobs live (`config.columns`, `config.series`). Nesting
   * one would be a few characters in the admin's patch builder and zero consumers anywhere — the
   * shape of declaration this contract has twice deleted for meaning nothing. Refusing narrows, and
   * a narrowing can be widened later without breaking a design that already registers.
   */
  it('refuses a path on a list', () => {
    expect(validateOptions(design({ columns: list({ path: 'layout.columns' }) })))
      .toMatch(/options\.columns\.path is not accepted on a list/)
  })

  /** Same argument one level down: both item schemas are flat, so a nested item path writes nowhere. */
  it('refuses a path on an item field', () => {
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'text', label: 'A', path: 'x.y' } } }) })))
      .toMatch(/options\.columns\.item\.a\.path is not accepted/)
  })

  it('refuses a default on the list itself — an added row is built from the item fields', () => {
    expect(validateOptions(design({ columns: list({ default: [] }) }))).toMatch(/default/)
  })

  /** `required` and `unique` mean something only in a repeating row, so they are refused elsewhere. */
  it('refuses required or unique on a top-level option', () => {
    expect(validateOptions(design({ a: { type: 'text', label: 'A', required: true } }))).toMatch(/required/)
    expect(validateOptions(design({ a: { type: 'select', label: 'A', choices: ['x'], unique: true } }))).toMatch(/unique/)
  })

  it('refuses unique on an item field with no set of values to pick from', () => {
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'text', label: 'A', unique: true } } }) })))
      .toMatch(/unique is only accepted on a select item field/)
  })

  it('refuses a non-boolean required or unique', () => {
    expect(validateOptions(design({ columns: list({ item: { a: { type: 'text', label: 'A', required: 'yes' } } }) })))
      .toMatch(/required must be a boolean/)
    expect(validateOptions(design({
      columns: list({ item: { a: { type: 'select', label: 'A', choices: ['x'], unique: 1 } } }),
    }))).toMatch(/unique must be a boolean/)
  })
})
