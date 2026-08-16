import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'
// @ts-expect-error plain JS module without types
import { CHART_ICONS } from '../../../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { feedModesFor } from '../../../static/device/widgets/bindings.mjs'

afterEach(cleanup)

/**
 * `chart`'s `series[]` — the knob is generated from
 * `type: 'list'`, and the harder of the two.
 *
 * `ChartSeriesEditor.tsx` was 74 lines and owned three rules nothing tied to the design:
 *
 *  1. **the feed is a BINDING, not free text.** It rendered the same `DataSourcePicker` every other
 *     data widget gets, hardcoding `widget="chart"` so `bindings.mjs`'s `feedModesFor` filtered the
 *     list to stream feeds. `plot.mjs` declares `feed: { type: 'feed' }` now, and the generated row
 *     passes the HOST widget through — so the filter comes from the same declaration the hub's own
 *     `feedCheck` enforces, and the design never restates it. Degrading this to a text input would
 *     have handed an operator a box to type a feed id into.
 *  2. **an added row's icon must not collide.** `screens/save.ts` refuses two series wearing the
 *     same glyph (`chart series icons must be unique`), and `nextIcon` picked the first unused one.
 *     That is `unique: true` on the item field now.
 *  3. **a new row carries exactly `feed`, `y_path` and `icon`.** The save schema's `items.required`,
 *     `additionalProperties: false` — and the grid is PATCHed WHOLE, so a row missing one loses
 *     every unsaved edit on the screen.
 *
 * Structured like `CellConfig.table.test.tsx` next door, and deliberately NOT mocking
 * `../design-registry` for the same reason it gives: the point is what the real declaration does to
 * the editor.
 */
const FEEDS: FeedRow[] = [
  { id: 'feed_s', name: 'a stream feed', mode: 'stream' },
  { id: 'feed_s2', name: 'another stream feed', mode: 'stream' },
  { id: 'feed_v', name: 'a value feed', mode: 'value' },
  { id: 'feed_i', name: 'an image feed', mode: 'image' },
] as unknown as FeedRow[]

const SERIES = [
  { feed: 'feed_s', y_path: 'cpu.load', icon: 'circle' },
  { feed: 'feed_s2', y_path: 'mem.used', icon: 'square', label: 'Memory' },
]

const renderChart = (config: Record<string, unknown> = { series: SERIES, style: 'line' }) => {
  const setCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 2, h: 2 }, widget: 'chart', config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig }
}

const seriesOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ feed: 'feed_s', y_path: `p${i}`, icon: CHART_ICONS[i] as string }))

describe('chart config: every series field has exactly one control', () => {
  it('draws one control per field of each series, and none for a series that is not there', () => {
    renderChart()
    for (const row of [1, 2]) {
      for (const item of ['feed', 'y_path', 'icon', 'label']) {
        expect(screen.getAllByLabelText(`Cell 1 series ${row} ${item}`), `${row} ${item}`).toHaveLength(1)
      }
    }
    expect(screen.queryByLabelText('Cell 1 series 3 feed')).toBeNull()
  })

  /**
   * The hand-built editor is GONE, not merely unused. Two controls writing one config key is how an
   * operator ends up watching a select snap back to a value they did not choose — the bug
   * `image.fit` and `alert_feed.min_severity` each shipped, and the rule `CellConfig.tsx`'s own
   * docstring states.
   */
  it('leaves nothing hand-built to draw a second copy of a series field', () => {
    renderChart()
    expect(screen.getAllByLabelText('Cell 1 series 1 icon')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Add series' })).toHaveLength(1)
  })

  it('shows the stored value of every field, so a save cannot silently drop one', () => {
    renderChart()
    expect((screen.getByLabelText('Cell 1 series 2 feed') as HTMLSelectElement).value).toBe('feed_s2')
    expect((screen.getByLabelText('Cell 1 series 2 y_path') as HTMLInputElement).value).toBe('mem.used')
    expect((screen.getByLabelText('Cell 1 series 2 icon') as HTMLSelectElement).value).toBe('square')
    expect((screen.getByLabelText('Cell 1 series 2 label') as HTMLInputElement).value).toBe('Memory')
  })

  it('offers the whole shared icon enum, which is what the save schema accepts', () => {
    renderChart()
    const picker = screen.getByLabelText('Cell 1 series 1 icon') as HTMLSelectElement
    expect([...picker.options].map((o) => o.value)).toEqual(CHART_ICONS)
  })
})

/**
 * The feed picker, which is the one item field that could not have been a text input.
 * `feedModesFor('chart')` is asked rather than spelled out, so a change to what a chart may bind
 * needs no edit here — the same discipline `bindings.test.tsx` applies to every other widget.
 */
describe('chart config: a series feed is a binding, filtered by what a chart may bind', () => {
  it('offers stream feeds and nothing else, from the declaration the hub enforces', () => {
    renderChart()
    const picker = screen.getByLabelText('Cell 1 series 1 feed') as HTMLSelectElement
    const offered = [...picker.options].map((o) => o.value).filter(Boolean)
    expect(offered).toEqual(FEEDS.filter((f) => feedModesFor('chart').includes(f.mode)).map((f) => f.id))
  })

  it('is the same picker every other data widget gets, "Push it yourself" included', () => {
    renderChart()
    expect(screen.getByLabelText('Cell 1 series 1 push it yourself')).toBeDefined()
  })

  it('writes the chosen feed into its own series row', () => {
    const { setCellConfig } = renderChart()
    fireEvent.change(screen.getByLabelText('Cell 1 series 1 feed'), { target: { value: 'feed_s2' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      series: [{ ...SERIES[0], feed: 'feed_s2' }, SERIES[1]],
    })
  })
})

describe('chart config: the series list respects the bounds its schema will enforce', () => {
  /**
   * The unique-icon rule, which is the whole reason `unique` exists on an item field. Without it the
   * second series a person adds carries the first one's glyph and the save fails with `chart series
   * icons must be unique` — a message about a key they never touched.
   */
  it('adds a series whose icon no other series is using', () => {
    const { setCellConfig } = renderChart({ series: [SERIES[0]], style: 'line' })
    fireEvent.click(screen.getByRole('button', { name: 'Add series' }))
    expect(setCellConfig).toHaveBeenCalledWith({
      series: [SERIES[0], { feed: '', y_path: '', icon: CHART_ICONS[1] }],
    })
    expect(CHART_ICONS[1]).not.toBe(SERIES[0].icon)
  })

  it('adds a row carrying exactly the schema\'s required keys — no label, no stray key', () => {
    const { setCellConfig } = renderChart({ series: [SERIES[0]], style: 'line' })
    fireEvent.click(screen.getByRole('button', { name: 'Add series' }))
    expect(Object.keys(setCellConfig.mock.calls[0][0].series[1]).sort()).toEqual(['feed', 'icon', 'y_path'])
  })

  it('offers no Add at maxItems, so a fifth series cannot be built', () => {
    renderChart({ series: seriesOf(4), style: 'line' })
    expect(screen.getByLabelText('Cell 1 series 4 y_path')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Add series' })).toBeNull()
  })

  it('offers no Remove at minItems, so the last series cannot be deleted', () => {
    renderChart({ series: seriesOf(1), style: 'line' })
    expect(screen.queryByRole('button', { name: 'Remove series' })).toBeNull()
  })

  it('removes the series it was clicked on, keeping the positional order of the rest', () => {
    const { setCellConfig } = renderChart({ series: seriesOf(3), style: 'line' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove series' })[1])
    expect(setCellConfig).toHaveBeenCalledWith({ series: [seriesOf(3)[0], seriesOf(3)[2]] })
  })
})

describe('chart config: what an operator types is written in the schema-accepted shape', () => {
  it('a REQUIRED field cleared keeps its key, as an empty string', () => {
    const { setCellConfig } = renderChart()
    fireEvent.change(screen.getByLabelText('Cell 1 series 1 y_path'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({ series: [{ ...SERIES[0], y_path: '' }, SERIES[1]] })
  })

  /**
   * `label` is the one OPTIONAL key, so clearing it must DELETE it rather than leave `label: ''`
   * behind — what `ChartSeriesEditor` wrote by hand, and what "this series has no label" means to
   * `normalizeChart`, which falls back to the feed id and then to the position.
   */
  it('an OPTIONAL field cleared deletes its key rather than storing an empty string', () => {
    const { setCellConfig } = renderChart()
    fireEvent.change(screen.getByLabelText('Cell 1 series 2 label'), { target: { value: '' } })
    const written = setCellConfig.mock.calls[0][0].series[1]
    expect('label' in written).toBe(false)
    expect(written).toEqual({ feed: 'feed_s2', y_path: 'mem.used', icon: 'square' })
  })

  it('patches only `series`, never the data window beside it', () => {
    const { setCellConfig } = renderChart({ series: SERIES, style: 'line', window_s: 60, y_min: 0 })
    fireEvent.change(screen.getByLabelText('Cell 1 series 1 icon'), { target: { value: 'triangle' } })
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['series'])
  })

  /**
   * The data window stays hand-built on purpose (it is the chart's DATA, not a choice about how the
   * design looks), and `style` is generated. Both must still be there beside the series rows —
   * migrating `series` must not have taken a neighbour with it.
   */
  it('leaves the data window and the generated style control where they were', () => {
    renderChart()
    for (const knob of ['window_s', 'y_min', 'y_max']) expect(screen.getByLabelText(`Cell 1 ${knob}`)).toBeDefined()
    expect(screen.getByLabelText('Cell 1 Style')).toBeDefined()
  })
})
