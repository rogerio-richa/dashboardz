import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'

afterEach(cleanup)

/**
 * `value_tile`'s real, registered design (`static/device/widgets/value/tile.mjs`) — deliberately
 * NOT mocking `../design-registry` the way `CellConfig.options.test.tsx` does, because this file's
 * whole point is to prove what the REAL `label`/`unit`/`decimals` declaration does to the editor,
 * not a synthetic stand-in.
 *
 * `value_tile`'s hand-built `renderLabelUnit(true)` call was deleted from
 * `CellConfig.tsx`'s `case 'value_tile'` because the generated `meta.options` block already draws
 * `label`/`unit` — the editor renders the SAME two knobs exactly once. These tests pin
 * "exactly one control per knob" so duplicate controls cannot return silently.
 *
 * `decimals` declares no `default` at all (its unset meaning, "raw,
 * unrounded", is not a number `decimals` could hold) — these tests also pin that the generated
 * number field renders as an EMPTY, still-controlled input rather than `0` or `undefined`.
 */
const FEEDS: FeedRow[] = [{ id: 'feed_v', name: 'a value feed', mode: 'value' }] as unknown as FeedRow[]

const renderValueTile = (config: Record<string, unknown> = { feed: '', path: '' }) => {
  const setCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig }
}

describe('value_tile config: no duplicate controls between the hand-built branch and meta.options', () => {
  it('renders exactly one label control and one unit control', () => {
    renderValueTile()
    expect(screen.getAllByLabelText(/^Cell 1 Label$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Unit$/i)).toHaveLength(1)
  })

  it('the surviving label control is the generated one and writes through setCellConfig by name', () => {
    const { setCellConfig } = renderValueTile()
    fireEvent.change(screen.getByLabelText('Cell 1 Label'), { target: { value: 'Temperature' } })
    expect(setCellConfig).toHaveBeenCalledWith({ label: 'Temperature' })
  })

  it('offers a decimals control at all — the hand-built branch never had one for value_tile', () => {
    renderValueTile()
    expect(screen.getByLabelText('Cell 1 Decimals')).toBeDefined()
  })
})

/**
 * `format` was a LIVE knob with no way to reach it: the schema has always accepted
 * `format: { enum: ['raw', 'abbrev'] }` and `normalizeValue` has always read it, but it was
 * declared in neither `meta.options` nor any hand-built field, so only hand-written JSON could set
 * it. It is a declared `select` now — these pin that the generated control exists, shows the
 * normalizer's own `'raw'` default, and can only write one of the two values the schema lists.
 */
describe('value_tile config: format is reachable from the form', () => {
  it('offers exactly one format control', () => {
    renderValueTile()
    expect(screen.getAllByLabelText(/^Cell 1 Format$/i)).toHaveLength(1)
  })

  it('shows `raw` — what normalizeValue renders for a cell that never set it', () => {
    renderValueTile()
    expect((screen.getByLabelText('Cell 1 Format') as HTMLSelectElement).value).toBe('raw')
  })

  it('offers exactly the schema\'s two choices and nothing else', () => {
    renderValueTile()
    const select = screen.getByLabelText('Cell 1 Format') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['raw', 'abbrev'])
  })

  it('writes the chosen value under the `format` key', () => {
    const { setCellConfig } = renderValueTile()
    fireEvent.change(screen.getByLabelText('Cell 1 Format'), { target: { value: 'abbrev' } })
    expect(setCellConfig).toHaveBeenCalledWith({ format: 'abbrev' })
  })

  it('reflects a format the cell already has', () => {
    renderValueTile({ feed: '', path: '', format: 'abbrev' })
    expect((screen.getByLabelText('Cell 1 Format') as HTMLSelectElement).value).toBe('abbrev')
  })
})

describe('value_tile config: decimals has no default', () => {
  it('renders empty, not 0, when the cell has no decimals set', () => {
    renderValueTile()
    const input = screen.getByLabelText('Cell 1 Decimals') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('writes a real number when the operator types one', () => {
    const { setCellConfig } = renderValueTile()
    fireEvent.change(screen.getByLabelText('Cell 1 Decimals'), { target: { value: '2' } })
    expect(setCellConfig).toHaveBeenCalledWith({ decimals: 2 })
  })

  it('clearing it back out writes undefined, not 0', () => {
    const { setCellConfig } = renderValueTile({ feed: '', path: '', decimals: 2 })
    fireEvent.change(screen.getByLabelText('Cell 1 Decimals'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({ decimals: undefined })
  })

  it('still renders the SET value when the cell already has one', () => {
    renderValueTile({ feed: '', path: '', decimals: 3 })
    const input = screen.getByLabelText('Cell 1 Decimals') as HTMLInputElement
    expect(input.value).toBe('3')
  })
})
