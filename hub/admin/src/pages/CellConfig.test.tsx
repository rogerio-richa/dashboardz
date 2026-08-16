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

/**
 * A theme suggests designs; the picker lists them first, by name, and still offers everything.
 * Labels come from each design's own `meta.label`, so a newcomer reads "LED segment", not "segment".
 */
describe('CellConfig — the design picker puts the theme\'s suggestions first', () => {
  const renderClock = (props: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => render(
    <CellConfig
      cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config } as Cell}
      i={0} feeds={[]} previews={{}} ensurePreview={() => {}} setCellConfig={() => {}}
      replaceCellConfig={() => {}} onFeedsChanged={() => {}}
      {...props}
    />,
  )
  const picker = () => screen.getByLabelText('Cell 1 design') as HTMLSelectElement
  const groups = () => [...picker().querySelectorAll('optgroup')].map((g) => ({
    label: g.label, options: [...g.querySelectorAll('option')].map((o) => o.textContent),
  }))
  const terminal = { themeName: 'Terminal', themeWidgets: { clock: 'segment' }, themeRecommended: { clock: ['nixie', 'segment'] } }

  it('groups the theme\'s designs first by name, default first and once, then all designs', () => {
    renderClock(terminal)
    expect(picker().options[0].value).toBe('')
    // The first option says what "theme default" actually is.
    expect(picker().options[0].textContent).toBe('Theme default (LED segment)')
    expect(groups()).toEqual([
      { label: 'Suggested by Terminal', options: ['LED segment', 'Nixie tube'] },
      { label: 'All designs', options: ['Digital', 'LED segment', 'Analog face', 'Split-flap', 'Nixie tube'] },
    ])
  })

  it('skips suggested designs this admin does not have', () => {
    renderClock({ ...terminal, themeWidgets: {}, themeRecommended: { clock: ['nixie', 'hologram'] } })
    expect(groups()[0]).toEqual({ label: 'Suggested by Terminal', options: ['Nixie tube'] })
    expect([...picker().options].some((o) => o.value === 'hologram')).toBe(false)
  })

  it('keeps a saved design selected when it is outside the theme\'s suggestions', () => {
    renderClock(terminal, { design: 'analog' })
    expect(picker().value).toBe('analog')
  })

  it('shows one plain list when the theme only has a default and suggests nothing else', () => {
    renderClock({ themeName: 'Mine', themeWidgets: { clock: 'analog' } })
    expect(groups()).toEqual([])
    expect(picker().options[0].textContent).toBe('Theme default (Analog face)')
  })

  it('shows one plain list when there is no theme or no suggestion for this widget', () => {
    renderClock()
    expect(groups()).toEqual([])
    cleanup()
    renderClock({ themeName: 'Toscana', themeRecommended: { gauge: ['ring'] } })
    expect(groups()).toEqual([])
    expect([...picker().options].map((o) => o.textContent)).toEqual(
      [picker().options[0].textContent, 'Digital', 'LED segment', 'Analog face', 'Split-flap', 'Nixie tube'],
    )
  })
})
