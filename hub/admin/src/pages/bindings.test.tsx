import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
// @ts-expect-error plain JS module without types
import { WIDGET_BINDINGS, feedModesFor, bindsPhrase } from '../../../static/device/widgets/bindings.mjs'
import CellConfig from './CellConfig'
import Widgets from './Widgets'
import type { Cell, FeedRow, Widget } from './Screens'

afterEach(cleanup)

/**
 * A widget's accepted feed modes were written down three times — this editor's filter arguments,
 * the catalogue page's `binds:` strings, and the hub's feedCheck — and two of the three were wrong
 * about value_tile and gauge, which have always accepted stream feeds. Both admin copies now read
 * `WIDGET_BINDINGS`; these tests ask the DECLARATION what to expect rather than spelling it out, so
 * a widget whose contract changes needs no edit here.
 */

/** One feed of every mode, so a filter that drops the wrong ones is visible. */
const FEEDS: FeedRow[] = [
  { id: 'feed_v', name: 'a value feed', mode: 'value' },
  { id: 'feed_s', name: 'a stream feed', mode: 'stream' },
  { id: 'feed_i', name: 'an image feed', mode: 'image' },
] as unknown as FeedRow[]

const renderCell = (widget: Widget, config: Record<string, unknown>) =>
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget, config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={() => {}} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )

const offered = (label: string): string[] =>
  [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.value).filter(Boolean)

/** The feed a mode maps to in FEEDS above — the ids the select is expected to offer. */
const idsForModes = (modes: string[]): string[] =>
  FEEDS.filter((f) => modes.includes(f.mode)).map((f) => f.id)

describe('the editor offers exactly the feeds a widget declares it can bind', () => {
  const CASES: { widget: Widget; config: Record<string, unknown> }[] = [
    { widget: 'value_tile', config: { feed: '', path: '' } },
    { widget: 'gauge', config: { feed: '', path: '', min: 0, max: 100 } },
    { widget: 'stream_list', config: { feed: '' } },
    { widget: 'table', config: { feed: '', columns: [] } },
    { widget: 'text_block', config: { feed: '', path: '' } },
    { widget: 'image', config: { feed: '' } },
  ]

  for (const { widget, config } of CASES) {
    it(`${widget} offers ${feedModesFor(widget).join('/')} feeds and nothing else`, () => {
      renderCell(widget, config)
      expect(offered('Cell 1 feed')).toEqual(idsForModes(feedModesFor(widget)))
    })
  }

  /** chart binds per series (config.series[].feed), not config.feed — same declaration, other path. */
  it('chart series offer stream feeds and nothing else', () => {
    renderCell('chart', { series: [{ feed: '', y_path: '', icon: 'circle' }], style: 'line' })
    expect(offered('Cell 1 series 1 feed')).toEqual(idsForModes(feedModesFor('chart')))
  })

  /**
   * The regression that motivated the whole declaration: a stream feed IS bindable to a value_tile
   * (the newest row is read), and every hand-written copy of this rule had forgotten it.
   */
  it('a stream feed is offered to value_tile', () => {
    renderCell('value_tile', { feed: '', path: '' })
    expect(offered('Cell 1 feed')).toContain('feed_s')
  })
})

describe('the catalogue page describes bindings from the declaration', () => {
  /**
   * Scoped to the widget's OWN card, deliberately. A document-wide `getByText` for value_tile's
   * phrase passes on a page where value_tile is wrong, because `table` carries the same words —
   * which is exactly how the first version of this test passed against the stale strings.
   */
  const metaFor = (widget: string): string => {
    // By the card's own data-widget stamp — the heading leads with the human label now, so the
    // slug is no longer the heading's accessible name.
    const card = document.querySelector(`.edit-card[data-widget="${widget}"]`)
    expect(card).not.toBeNull()
    return card?.querySelector('span')?.textContent ?? ''
  }

  it('says what each widget actually binds, per card', () => {
    render(<Widgets />)
    // Asked of the declaration — a tenth widget needs no edit here.
    for (const widget of Object.keys(WIDGET_BINDINGS)) {
      expect(metaFor(widget)).toContain(`binds ${bindsPhrase(widget)}`)
    }
  })
})
