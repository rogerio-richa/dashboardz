import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { WIDGET_MIN_PX, belowMinimum } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { designMinimum } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'

/**
 * "If it's too small then it's too small." (fit model)
 *
 * A widget below its minimum is an AUTHORING mistake, and gets the same loud dashed placeholder as
 * a cell bound to a feed that does not exist — not a quietly worse widget. The fit plan handles
 * "a bit tight"; it is not an answer to a gauge with no room for its own label, which is how a
 * board ends up showing four anonymous rings that look deliberate and read as nothing.
 */
describe('widget minimum sizes', () => {
  it('covers every widget the editor can place', () => {
    // The shared list future gallery/editor surfaces offer. A widget that can be placed but has
    // no minimum would slip straight back to silent degradation.
    const placeable = WIDGET_DEFINITIONS.map((definition: { id: string }) => definition.id)
    for (const w of placeable) expect(WIDGET_MIN_PX[w], w).toBeDefined()
  })

  it('is derived from the minimums published in the widget definitions', () => {
    expect(WIDGET_MIN_PX).toEqual(Object.fromEntries(WIDGET_DEFINITIONS.map((definition: {
      id: string
      minimum_px: { w: number; h: number }
    }) => [definition.id, definition.minimum_px])))
  })

  it('is expressed in PIXELS, not fractions', () => {
    // The whole flaw was sizing from a share of the board. Anything <= 1 here would be a fraction
    // that had crept back in.
    for (const [widget, min] of Object.entries(WIDGET_MIN_PX) as [string, { w: number; h: number }][]) {
      expect(min.w, widget).toBeGreaterThan(1)
      expect(min.h, widget).toBeGreaterThan(1)
    }
  })

  it('blocks a box short or narrow on either axis', () => {
    const g = WIDGET_MIN_PX.gauge
    expect(belowMinimum('gauge', g.w, g.h)).toBe(false)
    expect(belowMinimum('gauge', g.w - 1, g.h)).toBe(true)
    expect(belowMinimum('gauge', g.w, g.h - 1)).toBe(true)
  })

  /**
   * The case that started this: a 135x88 gauge cell on the A05 rendered ring + value with the
   * label, unit and age chip all dropped.
   */
  it('rejects the 135x88 gauge cell that produced an anonymous ring', () => {
    expect(belowMinimum('gauge', 135, 88)).toBe(true)
  })

  /**
   * A client older than a widget type must not refuse to draw something it does not recognise —
   * the same degradation rule an unknown design id follows.
   */
  it('has no opinion about a widget it does not know', () => {
    expect(belowMinimum('something_new', 1, 1)).toBe(false)
    expect(belowMinimum(undefined, 1, 1)).toBe(false)
  })

  it('treats a garbage box as too small rather than throwing', () => {
    expect(() => belowMinimum('gauge', null, undefined)).not.toThrow()
    expect(belowMinimum('gauge', null, undefined)).toBe(true)
    expect(belowMinimum('gauge', NaN, NaN)).toBe(true)
  })

  /**
   * A gauge's minimum has to leave room for everything the widget actually draws, so the
   * placeholder fires while the cell is still too small rather than after the gauge has already
   * degraded itself to fit.
   *
   * `gauge` is two canvas designs (`gauge/bar.mjs`, `gauge/ring.mjs`), which size their own
   * contents off `box.w`/`box.h` and drop nothing. The height floor keeps the widget's contents
   * inside the cell, so it remains load-bearing.
   */
  it('leaves room for everything a gauge draws', () => {
    // label + ring + value + chip + gaps + padding at the smallest ramp tier ~ 111px.
    expect(WIDGET_MIN_PX.gauge.h).toBeGreaterThanOrEqual(105)
  })

  it('is frozen — a render pass reads this every cell', () => {
    expect(Object.isFrozen(WIDGET_MIN_PX)).toBe(true)
    expect(Object.isFrozen(WIDGET_MIN_PX.gauge)).toBe(true)
  })
})

/**
 * Design-aware minimums. `belowMinimum` reads a per-WIDGET table, which is the right default and
 * the wrong answer for a design built for a shape its widget normally cannot use: `stream/ticker`
 * is a one-line crawl and its widget's floor is a two-line card. An optional override keeps the
 * table authoritative for everything that does not ask.
 */
describe('belowMinimum with a design override', () => {
  it('still uses the widget table when no design asks for anything', () => {
    expect(belowMinimum('stream_list', 200, 120)).toBe(false)
    expect(belowMinimum('stream_list', 200, 40)).toBe(true)
  })

  it('lets a design lower the floor for its own shape', () => {
    expect(belowMinimum('stream_list', 200, 40, { w: 120, h: 28 })).toBe(false)
  })

  it('still blocks a cell below the design\'s own floor', () => {
    expect(belowMinimum('stream_list', 100, 20, { w: 120, h: 28 })).toBe(true)
  })

  it('ignores a malformed override rather than trusting it', () => {
    expect(belowMinimum('stream_list', 200, 40, { w: 'nope' })).toBe(true)
    expect(belowMinimum('stream_list', 200, 40, null)).toBe(true)
  })
})

describe('designMinimum', () => {
  it('finds the floor a design declared', () => {
    expect(designMinimum('stream_list', 'ticker')).toEqual({ w: 120, h: 28 })
  })

  it('is null for a design that declares none, an unknown design, or no design at all', () => {
    expect(designMinimum('stream_list', 'list')).toBeNull()
    expect(designMinimum('stream_list', 'nope')).toBeNull()
    expect(designMinimum('stream_list', undefined)).toBeNull()
  })
})
