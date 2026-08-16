import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'

afterEach(cleanup)

/**
 * `gauge`'s real, registered designs (`static/device/widgets/gauge/ring.mjs`/`bar.mjs`) —
 * deliberately NOT mocking `../design-registry` the way `CellConfig.options.test.tsx` does,
 * because this file's whole point is to prove what the REAL `label`/`unit`/`min`/`max`/`decimals`
 * declarations do to the editor, not a synthetic stand-in. Mirrors
 * `CellConfig.valueTile.test.tsx`'s own structure — see that file's docstring for the
 * same reasoning restated here.
 *
 * `gauge`'s hand-built `renderLabelUnit(true)`/`renderDecimals()`/`renderGaugeFields()`'s
 * own `min`/`max`/`style` fields were deleted from `CellConfig.tsx`'s `case 'gauge'` because the
 * generated `meta.options` block now draws `label`/`unit`/`min`/`max`/`decimals`, and the
 * already-existing `design` picker (offered to any widget with more than one design) now covers
 * `style`'s old ring-vs-bar choice. These tests pin "exactly one control per knob" so that
 * regression cannot come back silently.
 *
 * Nested `warn`/`crit` fields are generated through an optional dotted `path`, so both
 * gauge designs declare `path: 'thresholds.warn'`/`'thresholds.crit'` and the hand-built
 * `renderGaugeThresholds` is deleted. Gauge now has NO hand-built knob at all — the second describe
 * below is where the nested read/write and its sibling-preservation are pinned.
 */
const FEEDS: FeedRow[] = [{ id: 'feed_v', name: 'a value feed', mode: 'value' }] as unknown as FeedRow[]

const renderGauge = (config: Record<string, unknown> = { feed: '', path: '', min: 0, max: 100 }) => {
  const setCellConfig = vi.fn()
  const replaceCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'gauge', config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={replaceCellConfig} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig, replaceCellConfig }
}

describe('gauge config: no duplicate controls between the hand-built branch and meta.options', () => {
  it('renders exactly one label, unit, min, max and decimals control', () => {
    renderGauge()
    expect(screen.getAllByLabelText(/^Cell 1 Label$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Unit$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Min$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Max$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Decimals$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Warn$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Crit$/i)).toHaveLength(1)
  })

  it('the surviving label control is the generated one and writes through setCellConfig by name', () => {
    const { setCellConfig } = renderGauge()
    fireEvent.change(screen.getByLabelText('Cell 1 Label'), { target: { value: 'battery' } })
    expect(setCellConfig).toHaveBeenCalledWith({ label: 'battery' })
  })

  it('shows the stored label and unit, so a save cannot silently drop them', () => {
    renderGauge({ feed: '', path: '', min: 0, max: 100, label: 'battery', unit: '%' })
    expect((screen.getByLabelText('Cell 1 Label') as HTMLInputElement).value).toBe('battery')
    expect((screen.getByLabelText('Cell 1 Unit') as HTMLInputElement).value).toBe('%')
  })

  it('offers no standalone "style" control any more — ring vs bar is the design picker\'s job', () => {
    renderGauge()
    expect(screen.queryByLabelText('Cell 1 style')).toBeNull()
  })

  // `bar` is gauge's real default: layout-core.mjs's gaugeConfig reads
  // `style: c.style === 'ring' ? 'ring' : 'bar'`.
  it('the design picker offers every gauge design, bar first (the default)', () => {
    renderGauge()
    const picker = screen.getByLabelText('Cell 1 design') as HTMLSelectElement
    const offered = [...picker.options].map((o) => o.value).filter(Boolean)
    expect(offered).toEqual(['bar', 'ring', 'battery'])
  })
})

/**
 * `warn`/`crit` are GENERATED now: both gauge designs declare them with
 * `path: 'thresholds.warn'` / `'thresholds.crit'`, and `renderGaugeThresholds` — the hand-built
 * pair that existed only because a generated field could not write a nested key — is deleted.
 *
 * The label case is how you tell which control you are looking at: the hand-built pair was
 * lowercase (`Cell 1 warn`), the generated one prints the design's own `label` (`Cell 1 Warn`).
 * Asserting `getAllByLabelText(/^Cell 1 Warn$/i)` has length 1 therefore catches BOTH regressions
 * at once — the hand-built field coming back, and the generated one disappearing.
 */
describe('gauge config: warn/crit are generated from a declared path, drawn once', () => {
  it('renders exactly one warn and one crit control', () => {
    renderGauge()
    expect(screen.getAllByLabelText(/^Cell 1 Warn$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Crit$/i)).toHaveLength(1)
  })

  it('shows the stored thresholds, read back out of the nested path', () => {
    renderGauge({ feed: '', path: '', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } })
    expect((screen.getByLabelText('Cell 1 Warn') as HTMLInputElement).value).toBe('70')
    expect((screen.getByLabelText('Cell 1 Crit') as HTMLInputElement).value).toBe('90')
  })

  it('renders empty, not 0, when no threshold is set — 0 is a real threshold', () => {
    renderGauge()
    expect((screen.getByLabelText('Cell 1 Warn') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Cell 1 Crit') as HTMLInputElement).value).toBe('')
  })

  /**
   * THE regression this whole mechanism has to get right. `setCellConfig` SHALLOW-merges, so a
   * patch of `{ thresholds: { crit: 90 } }` replaces the whole `thresholds` object and the `warn`
   * the operator set a moment ago is gone — silently, since the cell still saves and the schema
   * still accepts it. The sibling has to travel in the patch.
   */
  it('writing crit preserves a warn already stored beside it', () => {
    const { setCellConfig } = renderGauge({ feed: '', path: '', min: 0, max: 100, thresholds: { warn: 70 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Crit'), { target: { value: '90' } })
    expect(setCellConfig).toHaveBeenCalledWith({ thresholds: { warn: 70, crit: 90 } })
  })

  it('writing warn preserves a crit already stored beside it', () => {
    const { setCellConfig } = renderGauge({ feed: '', path: '', min: 0, max: 100, thresholds: { crit: 90 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Warn'), { target: { value: '70' } })
    expect(setCellConfig).toHaveBeenCalledWith({ thresholds: { crit: 90, warn: 70 } })
  })

  it('creates the parent object when nothing is stored there yet', () => {
    const { setCellConfig } = renderGauge()
    fireEvent.change(screen.getByLabelText('Cell 1 Warn'), { target: { value: '70' } })
    expect(setCellConfig).toHaveBeenCalledWith({ thresholds: { warn: 70 } })
  })

  it('clearing one threshold unsets it without disturbing the other', () => {
    const { setCellConfig } = renderGauge({ feed: '', path: '', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Crit'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({ thresholds: { warn: 70, crit: undefined } })
  })

  /**
   * Two nested knobs under ONE parent, set in sequence against the config each write produces.
   * The single-write tests above pass even for a builder that merges only the first level; this
   * one is what proves both can be held at the same time, which is what an operator actually does.
   */
  it('lets both thresholds be set one after the other without clobbering', () => {
    const first = renderGauge({ feed: '', path: '', min: 0, max: 100 })
    fireEvent.change(screen.getByLabelText('Cell 1 Warn'), { target: { value: '70' } })
    const afterWarn = first.setCellConfig.mock.calls[0][0] as Record<string, unknown>
    expect(afterWarn).toEqual({ thresholds: { warn: 70 } })

    cleanup()
    const second = renderGauge({ feed: '', path: '', min: 0, max: 100, ...afterWarn })
    fireEvent.change(screen.getByLabelText('Cell 1 Crit'), { target: { value: '90' } })
    expect(second.setCellConfig).toHaveBeenCalledWith({ thresholds: { warn: 70, crit: 90 } })
  })

  // A flat option in the SAME design must be unaffected by the nested ones sharing the form.
  it('still writes a pathless option as a flat top-level key', () => {
    const { setCellConfig } = renderGauge({ feed: '', path: '', min: 0, max: 100, thresholds: { warn: 70 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Min'), { target: { value: '5' } })
    expect(setCellConfig).toHaveBeenCalledWith({ min: 5 })
  })
})

describe('gauge config: min/max/decimals defaults', () => {
  it('min/max render the widget\'s existing defaults (0/100) when unset', () => {
    renderGauge({ feed: '', path: '' })
    expect((screen.getByLabelText('Cell 1 Min') as HTMLInputElement).value).toBe('0')
    expect((screen.getByLabelText('Cell 1 Max') as HTMLInputElement).value).toBe('100')
  })

  it('decimals renders empty, not 0, when unset — gaugeConfig\'s own "no forced rounding" default', () => {
    renderGauge()
    expect((screen.getByLabelText('Cell 1 Decimals') as HTMLInputElement).value).toBe('')
  })

  it('writes a real number when the operator types a decimals value', () => {
    const { setCellConfig } = renderGauge()
    fireEvent.change(screen.getByLabelText('Cell 1 Decimals'), { target: { value: '2' } })
    expect(setCellConfig).toHaveBeenCalledWith({ decimals: 2 })
  })
})
