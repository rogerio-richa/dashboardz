import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { REPAINT_MS, boardRepaintPeriod, cellsDueForRepaint, repaintPlan } from '../static/device/widgets/repaint.mjs'

const screen = (...widgets: string[]) => ({
  grid: { cells: widgets.map((widget) => ({ widget, config: {} })) },
})

/**
 * The rule that decides whether a board needs a timer at all.
 *
 * A panel is on 24/7. Repainting a weather-and-news screen sixty times a minute rebuilds the whole
 * grid's DOM to draw the same pixels fifty-nine of those times, which was measured at 30–45ms a
 * pass on an A05 — real battery, no visible benefit. Animation is not the reason a board repaints;
 * `loop.mjs` owns that and idles to zero.
 */
describe('boardRepaintPeriod', () => {
  it('asks for nothing at all when nothing on the board tells the time', () => {
    expect(boardRepaintPeriod(screen('weather_forecast', 'gauge', 'image', 'table'))).toBeNull()
  })

  it('ticks every second for a clock, because a clock face moves that often', () => {
    expect(boardRepaintPeriod(screen('weather_forecast', 'clock'))).toBe(1_000)
  })

  /** "4m ago" and "2h" change once a minute at the fastest — a second is 59 wasted repaints. */
  it('ticks once a minute for relative times', () => {
    expect(boardRepaintPeriod(screen('news_list'))).toBe(60_000)
    expect(boardRepaintPeriod(screen('alert_feed'))).toBe(60_000)
    // An agenda drops finished events and re-heads TODAY at midnight, with no new data involved.
    expect(boardRepaintPeriod(screen('calendar_events'))).toBe(60_000)
  })

  it('takes the shortest period any one widget needs', () => {
    expect(boardRepaintPeriod(screen('news_list', 'clock', 'alert_feed'))).toBe(1_000)
  })

  /**
   * The default layout is alert cards and their relative times. With no alerts there is nothing on
   * it that moves on its own — the clock and status line beside it are chrome, written directly
   * every second without going near the board.
   */
  it('needs a timer for the default layout only while alerts are showing', () => {
    expect(boardRepaintPeriod(null, 0)).toBeNull()
    expect(boardRepaintPeriod(null, 2)).toBe(60_000)
    expect(boardRepaintPeriod(undefined, 1)).toBe(60_000)
  })

  /** A hand-edited or older row must degrade to "no timer", never throw at the tick. */
  it('survives a malformed screen without asking for a repaint', () => {
    expect(boardRepaintPeriod({})).toBeNull()
    expect(boardRepaintPeriod({ grid: {} })).toBeNull()
    expect(boardRepaintPeriod({ grid: { cells: 'not an array' } })).toBeNull()
    expect(boardRepaintPeriod({ grid: { cells: [null, undefined, {}] } })).toBeNull()
    expect(boardRepaintPeriod(screen('a_widget_from_the_future'))).toBeNull()
  })

  /** Adding a time-rendering widget and forgetting to list it here is the failure mode. */
  it('lists every widget type whose output moves on its own', () => {
    expect(Object.keys(REPAINT_MS).sort()).toEqual(['alert_feed', 'calendar_events', 'clock', 'news_list'])
  })
})

/**
 * Which CELLS are due, rather than whether the board is.
 *
 * `boardRepaintPeriod` answers "does this board need a timer at all", and a board with a clock on it
 * answers yes every second. That is the whole board's answer, and acting on it repaints the whole
 * board: the grid's DOM rebuilt, every canvas redrawn, to move one clock cell. A five-day forecast
 * beside that clock is a pure function of data that arrives over the socket — it is redrawn 59 times
 * a minute to produce identical pixels.
 */
describe('cellsDueForRepaint', () => {
  const T0 = 1_786_000_000_000

  it('asks for nothing when nothing on the board tells the time', () => {
    const def = screen('weather_forecast', 'gauge', 'image')
    expect(cellsDueForRepaint(def, T0 + 60_000, { 0: T0, 1: T0, 2: T0 })).toEqual([])
  })

  /** The point of the whole exercise: a clock beside a forecast repaints the clock ALONE. */
  it('returns the clock alone on a board whose other cells are pure functions of data', () => {
    const def = screen('weather_forecast', 'clock', 'gauge')
    expect(cellsDueForRepaint(def, T0 + 1_000, { 0: T0, 1: T0, 2: T0 })).toEqual([1])
  })

  /** Minute-scale cells must not be dragged along by the second-scale one sharing the board. */
  it('leaves a minute-scale cell alone until its own period has elapsed', () => {
    const def = screen('clock', 'news_list')
    const painted = { 0: T0, 1: T0 }
    expect(cellsDueForRepaint(def, T0 + 1_000, painted)).toEqual([0])
    expect(cellsDueForRepaint(def, T0 + 30_000, painted)).toEqual([0])
    expect(cellsDueForRepaint(def, T0 + 60_000, painted)).toEqual([0, 1])
  })

  it('is not due again until a further full period has passed', () => {
    const def = screen('clock')
    expect(cellsDueForRepaint(def, T0 + 999, { 0: T0 })).toEqual([])
    expect(cellsDueForRepaint(def, T0 + 1_000, { 0: T0 })).toEqual([0])
  })

  /** A cell nothing has painted yet is due — that is what makes the first tick after a resize correct. */
  it('treats a never-painted cell as due', () => {
    expect(cellsDueForRepaint(screen('clock', 'news_list'), T0, {})).toEqual([0, 1])
  })

  /**
   * Same degradation rule as `boardRepaintPeriod`: a hand-edited row or a board from a future build
   * must produce no repaint rather than throw inside the 1s tick.
   */
  it('survives a malformed screen without asking for a repaint', () => {
    expect(cellsDueForRepaint(null, T0, {})).toEqual([])
    expect(cellsDueForRepaint({}, T0, {})).toEqual([])
    expect(cellsDueForRepaint({ grid: { cells: 'not an array' } }, T0, {})).toEqual([])
    expect(cellsDueForRepaint({ grid: { cells: [null, undefined, {}] } }, T0, {})).toEqual([])
    expect(cellsDueForRepaint(screen('a_widget_from_the_future'), T0, {})).toEqual([])
  })

  /**
   * The board-level answer and the per-cell answer must not disagree about whether anything is due:
   * a tick that `boardRepaintPeriod` says is needed has to find at least one cell to repaint, or the
   * timer would be waking up to do nothing at all.
   */
  it('finds work whenever the board-level rule says a tick is due', () => {
    const def = screen('weather_forecast', 'news_list', 'clock')
    const period = boardRepaintPeriod(def)
    expect(cellsDueForRepaint(def, T0 + period, { 0: T0, 1: T0, 2: T0 }).length).toBeGreaterThan(0)
  })
})

/**
 * What a single 1s tick should actually do.
 *
 * Not every widget that moves with the clock can be repainted on its own. `paintWidgets` redraws
 * canvases, and `alert_feed` has no canvas design — it is one of the widgets still rendered as HTML,
 * so the only thing that redraws its relative times is a full render. A tick that quietly skipped it
 * would freeze "4m ago" on the wall forever, which is worse than the repaint it saves.
 */
describe('repaintPlan', () => {
  const T0 = 1_786_000_000_000
  // Matches the shipped catalogue: clock, weather_forecast, news_list and calendar_events have
  // canvas designs; alert_feed does not.
  const hasCanvas = (cell: { widget: string } | null | undefined) =>
    ['clock', 'weather_forecast', 'news_list', 'calendar_events'].includes(cell?.widget ?? '')

  it('does nothing when no cell is due', () => {
    const def = screen('clock', 'weather_forecast')
    expect(repaintPlan(def, T0 + 500, { 0: T0, 1: T0 }, hasCanvas)).toEqual({ kind: 'none', cells: [] })
  })

  /** The whole point: a clock ticking beside a forecast repaints one canvas, not the board. */
  it('repaints just the due canvas cells', () => {
    const def = screen('weather_forecast', 'clock')
    expect(repaintPlan(def, T0 + 1_000, { 0: T0, 1: T0 }, hasCanvas)).toEqual({ kind: 'cells', cells: [1] })
  })

  /** alert_feed is HTML, so its minute tick has to go the long way round. */
  it('falls back to a full render when a due cell has no canvas design', () => {
    const def = screen('clock', 'alert_feed')
    expect(repaintPlan(def, T0 + 60_000, { 0: T0, 1: T0 })).toMatchObject({ kind: 'full' })
    expect(repaintPlan(def, T0 + 60_000, { 0: T0, 1: T0 }, hasCanvas)).toMatchObject({ kind: 'full' })
  })

  /**
   * The 59 seconds either side of that minute are still per-cell. A board carrying both an
   * alert_feed and a clock is the case this whole change is for, so it must not degrade to
   * "full render every second" just because one cell on it is HTML.
   */
  it('still repaints per-cell on the seconds the alert_feed is not due', () => {
    const def = screen('clock', 'alert_feed')
    expect(repaintPlan(def, T0 + 1_000, { 0: T0, 1: T0 }, hasCanvas)).toEqual({ kind: 'cells', cells: [0] })
  })

  it('does nothing for a malformed screen rather than forcing a render', () => {
    expect(repaintPlan(null, T0, {}, hasCanvas)).toEqual({ kind: 'none', cells: [] })
    expect(repaintPlan({ grid: { cells: 'nope' } }, T0, {}, hasCanvas)).toEqual({ kind: 'none', cells: [] })
  })
})
