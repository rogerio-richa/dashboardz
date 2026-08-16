import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'

afterEach(cleanup)

/**
 * `calendar_events`' editor — the per-widget file this widget never had, and the bug it pins.
 *
 * `CellConfig.tsx`'s semantic branch groups widgets by their contract. `calendar_events` shares
 * that branch, so it must not fall into the `news_list` arm and be
 * offered `items`, `show_summary`, `show_source` and `show_time` — four keys its own save schema
 * (`hub/src/routes/admin.ts`, `semanticConfig` ⇒ `additionalProperties: false`) rejects. Touching
 * any one of them wrote a key that 400s the whole grid PATCH with `cell N (calendar_events):
 * unknown config key "items"`, so the operator lost every unsaved edit on the screen and the error
 * named a knob the editor itself had just drawn for them. Meanwhile `events` and `show_location`,
 * the two knobs `calendar/agenda.mjs` actually reads, must remain available in the editor.
 *
 * Both halves are pinned here, because fixing one without the other leaves the bug reachable: the
 * knobs it SHOULD have (now declared `meta.options` on the real, registered design — deliberately
 * not mocked, same reasoning as `CellConfig.valueTile.test.tsx`'s docstring), and the knobs it must
 * never be handed again.
 */
const FEEDS: FeedRow[] = [{ id: 'feed_cal', name: 'a calendar source', mode: 'value' }] as unknown as FeedRow[]

const renderCell = (widget: string, config: Record<string, unknown> = { feed: 'feed_cal' }) => {
  const setCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget, config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig }
}

describe('calendar_events config: its own knobs are reachable', () => {
  it('offers exactly one events control and one show_location control', () => {
    renderCell('calendar_events')
    expect(screen.getAllByLabelText(/^Cell 1 Events$/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/^Cell 1 Show location$/i)).toHaveLength(1)
  })

  it('events defaults to the 5 the design normalizes to, within the schema\'s 1..10', () => {
    renderCell('calendar_events')
    const input = screen.getByLabelText('Cell 1 Events') as HTMLInputElement
    expect(input.value).toBe('5')
    expect(input.min).toBe('1')
    expect(input.max).toBe('10')
  })

  it('writes `events` as a flat top-level number — the key the schema lists', () => {
    const { setCellConfig } = renderCell('calendar_events')
    fireEvent.change(screen.getByLabelText('Cell 1 Events'), { target: { value: '7' } })
    expect(setCellConfig).toHaveBeenCalledWith({ events: 7 })
  })

  it('renders the events value the cell already has rather than the default', () => {
    renderCell('calendar_events', { feed: 'feed_cal', events: 9 })
    expect((screen.getByLabelText('Cell 1 Events') as HTMLInputElement).value).toBe('9')
  })

  it('show_location starts unchecked — the design tests `=== true`, so absent means off', () => {
    renderCell('calendar_events')
    expect((screen.getByLabelText('Cell 1 Show location') as HTMLInputElement).checked).toBe(false)
  })

  it('writes `show_location` as a flat top-level boolean', () => {
    const { setCellConfig } = renderCell('calendar_events')
    fireEvent.click(screen.getByLabelText('Cell 1 Show location'))
    expect(setCellConfig).toHaveBeenCalledWith({ show_location: true })
  })

  it('reflects a show_location the cell already has', () => {
    renderCell('calendar_events', { feed: 'feed_cal', show_location: true })
    expect((screen.getByLabelText('Cell 1 Show location') as HTMLInputElement).checked).toBe(true)
  })
})

/**
 * The regression itself. Every name below is a key `calendar_events`' schema branch does NOT list,
 * so a control for it can only ever produce a 400 that fails the entire grid save.
 */
describe('calendar_events config: never offered a key its schema rejects', () => {
  it('has no news_list controls (items, summaries, sources, times)', () => {
    renderCell('calendar_events')
    expect(screen.queryByLabelText('Cell 1 items')).toBeNull()
    expect(screen.queryByLabelText('summaries')).toBeNull()
    expect(screen.queryByLabelText('sources')).toBeNull()
    expect(screen.queryByLabelText('times')).toBeNull()
  })

  it('has no weather_forecast controls either', () => {
    renderCell('calendar_events')
    expect(screen.queryByLabelText('Cell 1 days')).toBeNull()
    for (const label of ['humidity', 'precipitation', 'wind', 'pollen']) {
      expect(screen.queryByLabelText(label), label).toBeNull()
    }
  })

  it('draws no hand-built "Widget options" block at all — it has no hand-built knob', () => {
    renderCell('calendar_events')
    expect(screen.queryByText('Widget options')).toBeNull()
    // …but it does get the generated block, which is where its two knobs live.
    expect(screen.getByText('Design options')).toBeDefined()
  })
})

/**
 * The two widgets that share the branch still get their own arms, unchanged. Without these, a
 * restructure that dropped a hand-built arm entirely would satisfy every assertion above.
 */
describe('the other semantic widgets keep exactly their own controls', () => {
  it('weather_forecast still gets days and its four flags, and no news knobs', () => {
    renderCell('weather_forecast')
    expect((screen.getByLabelText('Cell 1 days') as HTMLInputElement).value).toBe('5')
    for (const label of ['humidity', 'precipitation', 'wind', 'pollen']) {
      expect(screen.getByLabelText(label), label).toBeDefined()
    }
    expect(screen.queryByLabelText('Cell 1 items')).toBeNull()
    expect(screen.queryByLabelText('summaries')).toBeNull()
  })

  it('news_list still gets items and its three flags, and no weather knobs', () => {
    renderCell('news_list')
    expect((screen.getByLabelText('Cell 1 items') as HTMLInputElement).value).toBe('5')
    for (const label of ['summaries', 'sources', 'times']) {
      expect(screen.getByLabelText(label), label).toBeDefined()
    }
    expect(screen.queryByLabelText('Cell 1 days')).toBeNull()
    expect(screen.queryByLabelText('humidity')).toBeNull()
  })

  it('news_list writes `items` as the number its own schema lists', () => {
    const { setCellConfig } = renderCell('news_list')
    fireEvent.change(screen.getByLabelText('Cell 1 items'), { target: { value: '8' } })
    expect(setCellConfig).toHaveBeenCalledWith({ items: 8 })
  })
})
