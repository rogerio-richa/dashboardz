import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'

afterEach(cleanup)

/**
 * `image`'s real, registered design (`static/device/widgets/image/frame.mjs`) — deliberately NOT
 * mocking `../design-registry` the way `CellConfig.options.test.tsx` does, because this file's
 * whole point is to prove what the REAL `fit` declaration does to the editor, not a synthetic
 * stand-in. Mirrors `CellConfig.gauge.test.tsx`'s own structure — see that file's
 * docstring for the same reasoning restated here.
 *
 * `image`'s hand-built `fit` selector (`renderImageFields`) was left
 * behind when `frame.mjs` declared `fit` in `meta.options` — the two drew the SAME knob
 * twice, under two different labels ("Cell 1 fit" and "Cell 1 Fit"), both writing `cfg.fit`. These
 * tests pin "exactly one control per knob" so that regression cannot come back silently.
 */
const FEEDS: FeedRow[] = [{ id: 'feed_i', name: 'an image feed', mode: 'image' }] as unknown as FeedRow[]

const renderImage = (config: Record<string, unknown> = { feed: '' }) => {
  const setCellConfig = vi.fn()
  const replaceCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'image', config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={replaceCellConfig} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig, replaceCellConfig }
}

describe('image config: no duplicate controls between the hand-built branch and meta.options', () => {
  it('renders exactly one fit control', () => {
    renderImage()
    expect(screen.getAllByLabelText(/^Cell 1 Fit$/i)).toHaveLength(1)
  })

  it('the surviving fit control is the generated one and writes through setCellConfig by name', () => {
    const { setCellConfig } = renderImage()
    fireEvent.change(screen.getByLabelText('Cell 1 Fit'), { target: { value: 'cover' } })
    expect(setCellConfig).toHaveBeenCalledWith({ fit: 'cover' })
  })

  it('shows the stored fit, so a save cannot silently drop it', () => {
    renderImage({ feed: '', fit: 'cover' })
    expect((screen.getByLabelText('Cell 1 Fit') as HTMLSelectElement).value).toBe('cover')
  })
})
