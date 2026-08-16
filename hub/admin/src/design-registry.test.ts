import { describe, expect, it } from 'vitest'
import { designFor } from './design-registry'

/**
 * CellConfig resolves "the design this cell will
 * actually render with" must match `index.mjs`'s three-tier precedence exactly (cell -> theme ->
 * registry default), or a themed screen shows the option fields of the wrong design while the
 * device draws a different one. Exercised directly against real registered clock designs
 * (digital = the registry default, plus analog/flip/nixie) rather than through CellConfig's DOM,
 * since this is the precedence logic itself, not the form it feeds.
 */
describe('design-registry: three-tier design resolution', () => {
  it('cell.config.design wins outright over the theme', () => {
    expect(designFor('clock', 'nixie', { clock: 'analog' })?.meta.id).toBe('nixie')
  })

  it("falls to the theme's per-widget choice when the cell names none", () => {
    expect(designFor('clock', '', { clock: 'analog' })?.meta.id).toBe('analog')
  })

  it('an unresolvable explicit cell design falls to the registry default, never through to the theme', () => {
    expect(designFor('clock', 'nonexistent-design', { clock: 'analog' })?.meta.id).toBe('digital')
  })

  it('falls to the registry default when neither the cell nor the theme names one', () => {
    expect(designFor('clock', '', undefined)?.meta.id).toBe('digital')
  })

  it('treats an empty-string cell design as absent, not as a choice that would suppress the theme', () => {
    expect(designFor('clock', '', { clock: 'flip' })?.meta.id).toBe('flip')
  })

  /*
   * NOT a real widget type any more, and it cannot be one again. This fixture named whichever
   * widget still had no design — `alert_feed`, then `chart` — and the final canvas design put the last of
   * twelve on the contract, so no `WIDGET_DEFINITIONS` entry can play the part.
   *
   * The branch is still live for the input that CANNOT be migrated away: a cell naming a widget type
   * this build has never heard of, which is what a board saved by a newer hub produces. `CellConfig`
   * must resolve no design for it (and so offer no design-specific fields) rather than picking some
   * unrelated widget's default.
   */
  it('returns null for a widget type this build has no designs for at all', () => {
    expect(designFor('__no_such_widget__', '', undefined)).toBeNull()
    // ...and naming a design does not conjure one either — the null is about the WIDGET.
    expect(designFor('__no_such_widget__', 'digital', { __no_such_widget__: 'analog' })).toBeNull()
  })
})
