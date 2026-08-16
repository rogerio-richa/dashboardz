import { describe, expect, it } from 'vitest'
import { satisfiesNeed, capabilitiesForPayload, NEED_TYPES, NEED_SCOPES } from '../src/data/needs.js'
// @ts-expect-error plain JS module without types
import { WIDGET_BINDINGS } from '../static/device/widgets/bindings.mjs'

describe('satisfiesNeed: the four types, and nothing else', () => {
  it('exposes exactly four types — a fifth is a decision, not an implementation detail', () => {
    expect([...NEED_TYPES].sort()).toEqual(['array<object>', 'binary', 'number', 'scalar'])
  })

  it('number means FINITE number, matching what gauge and chart actually test', () => {
    expect(satisfiesNeed('number', 42)).toBe(true)
    expect(satisfiesNeed('number', 0)).toBe(true)
    expect(satisfiesNeed('number', NaN)).toBe(false)
    expect(satisfiesNeed('number', Infinity)).toBe(false)
    expect(satisfiesNeed('number', '42')).toBe(false)
    expect(satisfiesNeed('number', null)).toBe(false)
  })

  it('scalar is a non-null primitive — what a widget can print', () => {
    for (const ok of [1, 'x', true, false, 0, '']) expect(satisfiesNeed('scalar', ok)).toBe(true)
    for (const bad of [null, undefined, {}, [], NaN]) expect(satisfiesNeed('scalar', bad)).toBe(false)
  })

  it('array<object> rejects an array of scalars — a table needs rows, not values', () => {
    expect(satisfiesNeed('array<object>', [{ a: 1 }])).toBe(true)
    expect(satisfiesNeed('array<object>', [])).toBe(true)
    expect(satisfiesNeed('array<object>', [1, 2])).toBe(false)
    expect(satisfiesNeed('array<object>', [[]])).toBe(false)
    expect(satisfiesNeed('array<object>', {})).toBe(false)
  })
})

describe('WIDGET_BINDINGS.needs: matches what the designs really read', () => {
  it('gauge needs a finite number at config.path, against the scalar source', () => {
    expect(WIDGET_BINDINGS.gauge.needs).toEqual([
      { path_from: 'path', scope: 'scalar', type: 'number' },
    ])
  })

  /**
   * Table is the one widget whose needs depend on the bound mode, and the only user of `modes`.
   * `normalizeTable` reads `cfg.path` ONLY in its non-stream branch (table/grid.mjs:194-200) — on
   * a stream feed the rows are already the array. Declaring the value-feed shape alone would make
   * the contract reject a binding the widget has always accepted.
   */
  it('table needs an array of objects on a value feed, and a scalar per column in both modes', () => {
    expect(WIDGET_BINDINGS.table.needs).toEqual([
      { path_from: 'path', scope: 'scalar', type: 'array<object>', modes: ['value'] },
      { path_from: 'columns[].path', scope: 'collection', collection_from: 'path', type: 'scalar', modes: ['value'] },
      { path_from: 'columns[].path', scope: 'row', type: 'scalar', modes: ['stream'] },
    ])
  })

  it('only table conditions a need on the mode — everything else reads the same either way', () => {
    const conditioned = Object.entries(WIDGET_BINDINGS as Record<string, { needs?: { modes?: unknown }[] }>)
      .filter(([, binding]) => (binding.needs ?? []).some((need) => need.modes !== undefined))
      .map(([widget]) => widget)
    expect(conditioned).toEqual(['table'])
  })

  it('chart needs a finite number per series, inside each stream ROW', () => {
    expect(WIDGET_BINDINGS.chart.needs).toEqual([
      { path_from: 'series[].y_path', scope: 'row', type: 'number' },
    ])
  })

  it('image needs binary and binds no path at all', () => {
    expect(WIDGET_BINDINGS.image.needs).toEqual([{ scope: 'scalar', type: 'binary' }])
  })

  it('a widget that binds no feed declares no needs', () => {
    expect(WIDGET_BINDINGS.clock.needs ?? []).toEqual([])
    expect(WIDGET_BINDINGS.alert_feed.needs ?? []).toEqual([])
  })

  it('exposes exactly three scopes, for the same reason', () => {
    expect([...NEED_SCOPES].sort()).toEqual(['collection', 'row', 'scalar'])
  })

  it('every declared need uses the fixed vocabulary — no ad-hoc fifth type creeps in', () => {
    for (const [widget, binding] of Object.entries(WIDGET_BINDINGS as Record<string, {
      needs?: { path_from?: string; scope: string; type: string; collection_from?: string }[]
    }>)) {
      for (const need of binding.needs ?? []) {
        expect(NEED_TYPES, `${widget}`).toContain(need.type)
        expect(NEED_SCOPES, `${widget}`).toContain(need.scope)
        if (need.scope === 'collection') expect(need.collection_from, `${widget}`).toBeTruthy()
      }
    }
  })
})

describe('capabilitiesForPayload: what a feed demonstrably produces', () => {
  it('reports a number and a string at their dotted paths', () => {
    const caps = capabilitiesForPayload({ cpu: { percent: 91 }, host: 'web-01' })
    expect(caps).toContain('data.number@cpu.percent')
    expect(caps).toContain('data.scalar@host')
  })

  it('a number is reported as BOTH number and scalar, so a scalar need matches it', () => {
    expect(capabilitiesForPayload({ x: 1 })).toEqual(expect.arrayContaining(['data.number@x', 'data.scalar@x']))
  })

  it('reports an array of objects, and the scalars inside its elements', () => {
    const caps = capabilitiesForPayload({ rows: [{ a: 1, b: 'x' }] })
    expect(caps).toContain('data.array@rows')
    expect(caps).toContain('data.scalar@rows[].a')
    expect(caps).toContain('data.scalar@rows[].b')
  })

  it('unions keys across elements — a column present on any row is offerable', () => {
    const caps = capabilitiesForPayload({ rows: [{ a: 1 }, { b: 2 }] })
    expect(caps).toContain('data.scalar@rows[].a')
    expect(caps).toContain('data.scalar@rows[].b')
  })

  /**
   * Three separate bounds, asserted separately because they fail separately. Payloads arrive from
   * senders over the network and this walk runs on the save path, so "it did not throw on a
   * 200-deep object" is not evidence of anything — an UNBOUNDED walk survives that too, and an
   * earlier version of this test passed with the depth cap deleted.
   */
  describe('is bounded, so a pathological payload cannot hang a save', () => {
    const nest = (levels: number): Record<string, unknown> => {
      let deep: Record<string, unknown> = { leaf: 1 }
      for (let i = 0; i < levels; i += 1) deep = { nest: deep }
      return deep
    }

    it('stops descending, rather than reporting a path no operator could have typed', () => {
      for (const capability of capabilitiesForPayload(nest(200))) {
        expect(capability.split('.').length, capability).toBeLessThan(12)
      }
    })

    it('survives a payload deep enough to overflow the stack of an uncapped walk', () => {
      expect(() => capabilitiesForPayload(nest(50_000))).not.toThrow()
    })

    it('stops emitting, rather than returning a capability per key of a huge flat payload', () => {
      const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i]))
      expect(capabilitiesForPayload(wide).length).toBeLessThan(1_000)
    })
  })

  it('a null or non-object payload produces nothing, never throws', () => {
    for (const v of [null, undefined, 42, 'x', []]) expect(() => capabilitiesForPayload(v)).not.toThrow()
  })
})
