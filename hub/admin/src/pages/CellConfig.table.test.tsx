import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'
// @ts-expect-error plain JS module without types
import { tableConfig } from '../../../static/device/layout-core.mjs'

afterEach(cleanup)

/**
 * `table`'s three knobs beyond the shared feed/path/scale — `headers`, `overflow.counter` and
 * per-column `align` — which the tab state gives its admin UI.
 *
 * `grid.mjs` declares two of them: `headers` and `counter` (the latter with
 * `path: 'overflow.counter'`) in `meta.options`, so the generated block draws them and
 * `renderTableFields`'s hand-built pair is deleted — the labels here are the design's own
 * (`Headers`, `Overflow counter`), and `getAllByLabelText(...).toHaveLength(1)` is what catches
 * either half coming back.
 *
 * `columns` is a declared `type: 'list'` — a repeating group — so
 * `renderTableFields` is gone entirely and the generated block draws the column rows, the align
 * select included. Every `toHaveLength(1)` below is therefore doing the same job for `columns` that
 * it already did for `headers`: a hand-built editor restored beside the generated one shows up as
 * two controls writing one key, which is how an operator ends up watching a value snap back to
 * something they did not choose.
 *
 * Structured like `CellConfig.gauge.test.tsx`, which covers the same nested-write problem for
 * gauge's `thresholds.warn`/`crit`, and deliberately NOT mocking `../design-registry` for the same
 * reason that file gives: the point is what the real widget declarations do to the editor.
 *
 * Two things every assertion here is really defending:
 *
 *  1. **The written shape is the shape the save schema accepts.** `hub/src/routes/admin.ts`'s
 *     `table` branch is `additionalProperties: false` with `headers` a top-level boolean,
 *     `overflow` an object whose only property is `counter`, and `align` an enum on each column.
 *     A control that wrote `overflow_counter`, or `align` at the top level, would look fine in the
 *     editor and fail on save.
 *  2. **The control's "unset" appearance equals what the renderer will actually draw.** All three
 *     knobs default ON/left in `tableConfig` (`c.headers !== false`, `overflow.counter !== false`,
 *     `col.align === 'right' ? 'right' : 'left'`), so an unset checkbox must render CHECKED. Get
 *     that backwards and the editor tells the operator headers are off while the panel draws them.
 *     Those tests assert against `tableConfig` itself rather than a hardcoded `true`, so if the
 *     renderer's default ever flips, this file fails instead of quietly going stale.
 */
const FEEDS: FeedRow[] = [
  { id: 'feed_s', name: 'a stream feed', mode: 'stream' },
  { id: 'feed_v', name: 'a value feed', mode: 'value' },
] as unknown as FeedRow[]

const COLUMNS = [
  { header: 'Host', path: 'host' },
  { header: 'Latency', path: 'ms' },
]

const renderTable = (config: Record<string, unknown> = { feed: 'feed_s', columns: COLUMNS }) => {
  const setCellConfig = vi.fn()
  const replaceCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 2, h: 2 }, widget: 'table', config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={replaceCellConfig} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig, replaceCellConfig }
}

describe('table config: the three knobs have a control at all', () => {
  it('offers headers, overflow counter, and one align select per column', () => {
    renderTable()
    expect(screen.getAllByLabelText('Cell 1 Headers')).toHaveLength(1)
    expect(screen.getAllByLabelText('Cell 1 Overflow counter')).toHaveLength(1)
    expect(screen.getByLabelText('Cell 1 column 1 align')).toBeDefined()
    expect(screen.getByLabelText('Cell 1 column 2 align')).toBeDefined()
  })

  /**
   * EXACTLY one control per column field. `renderTableFields`'s hand-built editor drew the same
   * three inputs under the same three labels; if it is ever restored beside the generated list,
   * every one of these finds two.
   */
  it('offers exactly one control per field of each column, and none for a column that is not there', () => {
    renderTable()
    for (const row of [1, 2]) {
      for (const item of ['header', 'path', 'align']) {
        expect(screen.getAllByLabelText(`Cell 1 column ${row} ${item}`), `${row} ${item}`).toHaveLength(1)
      }
    }
    expect(screen.queryByLabelText('Cell 1 column 3 header')).toBeNull()
  })

  it('offers exactly left and right for align — the enum the save schema accepts', () => {
    renderTable()
    const picker = screen.getByLabelText('Cell 1 column 1 align') as HTMLSelectElement
    expect([...picker.options].map((o) => o.value)).toEqual(['left', 'right'])
  })
})

describe('table config: an unset knob renders as what the renderer will draw', () => {
  it('headers and the overflow counter render checked when unset, matching tableConfig', () => {
    const drawn = tableConfig({ feed: 'feed_s', columns: COLUMNS })
    expect(drawn.headers).toBe(true)
    expect(drawn.counter).toBe(true)
    renderTable()
    expect((screen.getByLabelText('Cell 1 Headers') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Cell 1 Overflow counter') as HTMLInputElement).checked).toBe(true)
  })

  it('align renders left when unset, matching tableConfig', () => {
    expect(tableConfig({ feed: 'feed_s', columns: COLUMNS }).columns[0].align).toBe('left')
    renderTable()
    expect((screen.getByLabelText('Cell 1 column 1 align') as HTMLSelectElement).value).toBe('left')
  })
})

describe('table config: stored values show, so a save cannot silently drop them', () => {
  it('shows headers off and the counter off when stored false', () => {
    renderTable({ feed: 'feed_s', columns: COLUMNS, headers: false, overflow: { counter: false } })
    expect((screen.getByLabelText('Cell 1 Headers') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Cell 1 Overflow counter') as HTMLInputElement).checked).toBe(false)
  })

  it('shows a stored per-column align on the right column only', () => {
    renderTable({ feed: 'feed_s', columns: [COLUMNS[0], { ...COLUMNS[1], align: 'right' }] })
    expect((screen.getByLabelText('Cell 1 column 1 align') as HTMLSelectElement).value).toBe('left')
    expect((screen.getByLabelText('Cell 1 column 2 align') as HTMLSelectElement).value).toBe('right')
  })
})

describe('table config: what the operator toggles is written in the schema-accepted shape', () => {
  it('headers writes a top-level boolean', () => {
    const { setCellConfig } = renderTable()
    fireEvent.click(screen.getByLabelText('Cell 1 Headers'))
    expect(setCellConfig).toHaveBeenCalledWith({ headers: false })
  })

  it('the overflow counter writes NESTED under overflow, not as a flat key', () => {
    const { setCellConfig } = renderTable()
    fireEvent.click(screen.getByLabelText('Cell 1 Overflow counter'))
    expect(setCellConfig).toHaveBeenCalledWith({ overflow: { counter: false } })
  })

  it('align writes inside the column it belongs to, leaving the other column untouched', () => {
    const { setCellConfig } = renderTable()
    fireEvent.change(screen.getByLabelText('Cell 1 column 2 align'), { target: { value: 'right' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      columns: [{ header: 'Host', path: 'host' }, { header: 'Latency', path: 'ms', align: 'right' }],
    })
  })

  // The knobs are independent, but they are written through one shallow-merging `setCellConfig`.
  // Toggling headers must not carry a `columns` or `overflow` key along with it, or a later save
  // would round-trip stale sibling state the operator never touched.
  it('toggling one knob patches only that knob', () => {
    const { setCellConfig } = renderTable({
      feed: 'feed_s', columns: COLUMNS, headers: false, overflow: { counter: false },
    })
    fireEvent.click(screen.getByLabelText('Cell 1 Headers'))
    expect(setCellConfig).toHaveBeenCalledTimes(1)
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['headers'])
  })

  /**
   * `table`'s `overflow` has exactly one property today, so its own siblings cannot be dropped —
   * but the patch builder is shared with `alert_feed`/`stream_list`, whose `clamp` has two. This
   * pins the shape a widget-specific reading would get wrong anyway: an unrelated key that happens
   * to sit under `overflow` survives the write rather than being replaced along with it.
   */
  it('writing overflow.counter carries any sibling already under overflow', () => {
    const { setCellConfig } = renderTable({
      feed: 'feed_s', columns: COLUMNS, overflow: { counter: true, unrelated: 1 },
    } as Record<string, unknown>)
    fireEvent.click(screen.getByLabelText('Cell 1 Overflow counter'))
    expect(setCellConfig).toHaveBeenCalledWith({ overflow: { counter: false, unrelated: 1 } })
  })
})

/**
 * `columns` as a GENERATED repeating group — the knob that kept `renderTableFields`
 * alive, and the reason the contract had a stated limitation at all.
 *
 * The bounds are the point. `hub/src/routes/admin.ts` accepts `minItems: 1, maxItems: 4`, and the
 * grid is PATCHed WHOLE: a UI that lets an operator build a fifth column, or delete the last one,
 * produces a 400 that loses every unsaved edit on the screen and names an array length nothing in
 * the editor ever showed them. `grid.mjs` declares `min: 1, max: 4` and the generated control is
 * what has to honour it.
 */
describe('table config: the column list respects the bounds its schema will enforce', () => {
  const columnsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ header: `H${i}`, path: `p${i}` }))

  it('adds a column in the shape the save schema accepts: the required keys, and nothing else', () => {
    const { setCellConfig } = renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }))
    // `align` is deliberately absent — it is not in the schema's `items.required`, and the renderer
    // draws an omitted one left.
    expect(setCellConfig).toHaveBeenCalledWith({
      columns: [...COLUMNS, { header: '', path: '' }],
    })
  })

  it('offers no Add at maxItems, so a fifth column cannot be built', () => {
    renderTable({ feed: 'feed_s', columns: columnsOf(4) })
    expect(screen.getByLabelText('Cell 1 column 4 header')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Add column' })).toBeNull()
  })

  it('offers Add again one below maxItems', () => {
    renderTable({ feed: 'feed_s', columns: columnsOf(3) })
    expect(screen.getByRole('button', { name: 'Add column' })).toBeDefined()
  })

  it('offers no Remove at minItems, so the last column cannot be deleted', () => {
    renderTable({ feed: 'feed_s', columns: columnsOf(1) })
    expect(screen.queryByRole('button', { name: 'Remove column' })).toBeNull()
  })

  it('removes the column it was clicked on, and leaves the others in order', () => {
    const { setCellConfig } = renderTable({ feed: 'feed_s', columns: columnsOf(3) })
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove column' })[1])
    expect(setCellConfig).toHaveBeenCalledWith({ columns: [columnsOf(3)[0], columnsOf(3)[2]] })
  })

  it('writes a header into its own column, leaving every sibling key untouched', () => {
    const { setCellConfig } = renderTable()
    fireEvent.change(screen.getByLabelText('Cell 1 column 2 header'), { target: { value: 'Latency (ms)' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      columns: [{ header: 'Host', path: 'host' }, { header: 'Latency (ms)', path: 'ms' }],
    })
  })

  /**
   * `header` is in the schema's `items.required`, so clearing it must leave the key behind as an
   * empty string — deleting it would produce a row the save schema rejects, which is exactly what
   * the hand-built editor's `value=""` did by accident and this does on purpose.
   */
  it('clearing a REQUIRED column field keeps the key, as an empty string', () => {
    const { setCellConfig } = renderTable()
    fireEvent.change(screen.getByLabelText('Cell 1 column 1 header'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      columns: [{ header: '', path: 'host' }, { header: 'Latency', path: 'ms' }],
    })
  })

  it('patches only `columns`, never a sibling config key', () => {
    const { setCellConfig } = renderTable()
    fireEvent.change(screen.getByLabelText('Cell 1 column 1 path'), { target: { value: 'hostname' } })
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['columns'])
  })
})
