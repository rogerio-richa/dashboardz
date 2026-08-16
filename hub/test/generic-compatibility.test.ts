import { describe, expect, it } from 'vitest'
import { compatibleGeneric } from '../src/widgets/requirements.js'

describe('compatibleGeneric', () => {
  it('accepts a feed that produces a number at the bound path', () => {
    const result = compatibleGeneric('gauge', { path: 'cpu.percent' }, ['data.number@cpu.percent'], 'value')
    expect(result.ok).toBe(true)
  })

  it('rejects a feed whose value at that path is the wrong type, and says which path', () => {
    const result = compatibleGeneric('gauge', { path: 'host' }, ['data.scalar@host'], 'value')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('host')
  })

  it('a scalar need is satisfied by a number — number is a scalar', () => {
    expect(compatibleGeneric('value_tile', { path: 'x' }, ['data.number@x'], 'value').ok).toBe(true)
  })

  it('a number need is NOT satisfied by a scalar — the reverse does not hold', () => {
    expect(compatibleGeneric('gauge', { path: 'x' }, ['data.scalar@x'], 'value').ok).toBe(false)
  })

  it('checks every column of a table, not just the first', () => {
    const config = { path: 'rows', columns: [{ header: 'a', path: 'a' }, { header: 'b', path: 'b' }] }
    const ok = compatibleGeneric('table', config, ['data.array@rows', 'data.scalar@rows[].a', 'data.scalar@rows[].b'], 'value')
    expect(ok.ok).toBe(true)
    const bad = compatibleGeneric('table', config, ['data.array@rows', 'data.scalar@rows[].a'], 'value')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('b')
  })

  /**
   * The mode really selects which needs apply, and this is the pair that proves it. A stream-bound
   * table reads its rows straight off `ctx.rows` — `normalizeTable` never touches `cfg.path` in
   * that branch — so requiring `data.array@rows` of a stream feed would reject a binding the
   * widget has always accepted, and columns resolve against a row payload rather than inside a
   * collection.
   */
  it('a stream-bound table needs its columns per row, and no array at config.path', () => {
    const config = { path: 'ignored', columns: [{ header: 'a', path: 'a' }, { header: 'b', path: 'b' }] }
    expect(compatibleGeneric('table', config, ['data.scalar@a', 'data.scalar@b'], 'stream').ok).toBe(true)
    const bad = compatibleGeneric('table', config, ['data.scalar@a'], 'stream')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('b')
  })

  it('the value-feed column spelling does NOT satisfy a stream binding, and vice versa', () => {
    const config = { path: 'rows', columns: [{ header: 'a', path: 'a' }] }
    expect(compatibleGeneric('table', config, ['data.scalar@rows[].a'], 'stream').ok).toBe(false)
    expect(compatibleGeneric('table', config, ['data.scalar@a'], 'value').ok).toBe(false)
  })

  it('checks every chart series', () => {
    const config = { series: [{ feed: 'f', y_path: 'a', icon: 'circle' }, { feed: 'f', y_path: 'b', icon: 'square' }] }
    expect(compatibleGeneric('chart', config, ['data.number@a', 'data.number@b'], 'stream').ok).toBe(true)
    expect(compatibleGeneric('chart', config, ['data.number@a'], 'stream').ok).toBe(false)
  })

  it('a widget that binds no feed is trivially compatible', () => {
    expect(compatibleGeneric('clock', {}, [], 'value').ok).toBe(true)
  })

  it('an EMPTY capability list is inconclusive, not incompatible', () => {
    // A hand-pushed feed declares nothing. Absence of evidence must not read as
    // evidence of absence, or every legacy feed would warn on every save.
    expect(compatibleGeneric('gauge', { path: 'x' }, [], 'value').ok).toBe(true)
  })
})
