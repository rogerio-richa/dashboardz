import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell } from './Screens'

afterEach(cleanup)

/**
 * Every design that ships has to be REACHABLE. The editor and the Themes page both carried a
 * hand-written copy of the clock catalogue; adding the nixie design left both stale, so a design
 * that rendered perfectly could not be selected by anyone. Both now read the catalogue itself
 * (widgets/catalogue.mjs), and this pins that they offer all of it — asked of the catalogue rather
 * than spelled out, so a sixth clock face needs no edit here.
 */
describe('CellConfig — the design picker offers the whole catalogue', () => {
  it('lists every clock design the renderer ships', async () => {
    const catalogue = await import(
      // @ts-expect-error plain JS module without types
      '../../../static/device/widgets/catalogue.mjs'
    ) as { designIdsFor: (w: string) => string[] }
    const ids = catalogue.designIdsFor('clock')
    expect(ids).toContain('nixie')

    render(
      <CellConfig
        cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} } as Cell}
        i={0}
        feeds={[]}
        previews={{}}
        ensurePreview={() => {}}
        setCellConfig={() => {}}
        replaceCellConfig={() => {}}
        onFeedsChanged={() => {}}
      />,
    )
    const picker = screen.getByLabelText('Cell 1 design') as HTMLSelectElement
    const offered = [...picker.options].map((o) => o.value).filter(Boolean)
    expect(offered).toEqual(ids)
  })
})
