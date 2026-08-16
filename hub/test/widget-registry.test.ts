import { describe, expect, it, beforeEach } from 'vitest'
// @ts-expect-error plain JS module without types
import { register, lookup, defaultDesignFor, _reset } from '../static/device/widgets/registry.mjs'

const design = (id: string, widget: string, isDefault = false) => ({
  meta: { id, widget, label: id, suggested_ratio: 2, tokens: {}, animations: { transition: [], persistent: [] }, default: isDefault },
  draw: () => {},
})

describe('widget design registry', () => {
  beforeEach(() => _reset())

  it('looks a registered design up by widget and id', () => {
    register(design('segment', 'clock'))
    expect(lookup('clock', 'segment').meta.id).toBe('segment')
  })

  it('falls back to the widget default when the design id is unknown', () => {
    register(design('digital', 'clock', true))
    register(design('segment', 'clock'))
    expect(lookup('clock', 'analog').meta.id).toBe('digital')
  })

  it('falls back to the widget default when no design is named at all', () => {
    register(design('digital', 'clock', true))
    expect(lookup('clock', undefined).meta.id).toBe('digital')
  })

  it('returns null for a widget with no registered designs', () => {
    expect(lookup('gauge', 'smooth')).toBe(null)
  })

  it('rejects a design whose meta is incomplete rather than half-registering it', () => {
    expect(() => register({ meta: { id: 'x', widget: 'clock' }, draw: () => {} }))
      .toThrow(/incomplete meta/)
  })

  /**
   * `validateOptions` is unit-tested in `meta-options.test.ts`; these pin that `register` actually
   * CALLS it for `path`, and that a refusal is a throw rather than a quietly half-registered
   * design. A design that registered with a malformed path would reach the admin, which generates
   * a form field straight from `meta.options` — the failure would surface as a broken editor, not
   * as a build fault.
   */
  it('refuses to register a design whose option declares a malformed path', () => {
    const withPath = (path: unknown) => ({
      ...design('ring', 'gauge'),
      meta: { ...design('ring', 'gauge').meta, options: { warn: { type: 'number', label: 'Warn', path } } },
    })
    expect(() => register(withPath('thresholds..warn'))).toThrow(/path/)
    expect(() => register(withPath('__proto__.warn'))).toThrow(/path/)
    expect(lookup('gauge', 'ring')).toBe(null)
  })

  it('registers a design whose option declares a well-formed nested path', () => {
    const base = design('ring', 'gauge')
    register({ ...base, meta: { ...base.meta, options: { warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' } } } })
    expect(lookup('gauge', 'ring').meta.options.warn.path).toBe('thresholds.warn')
  })
})
