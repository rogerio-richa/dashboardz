import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import agenda, { agendaRows, formatDayHeading, formatEventTime, normalizeAgenda } from '../static/device/widgets/calendar/agenda.mjs'

const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime()
const iso = (h: number, m = 0, day = 6) => new Date(2026, 7, day, h, m).toISOString()

const event = (over: Record<string, unknown> = {}) => ({
  title: 'Dentist', start: iso(14), end: iso(15), all_day: false, location: null, ...over,
})
const payload = (...events: unknown[]) => ({ events })

describe('the agenda reader', () => {
  it('keeps what has not finished and drops what has', () => {
    const result = normalizeAgenda(payload(
      event({ title: 'This morning', start: iso(9), end: iso(10) }),
      event({ title: 'Right now', start: iso(11, 30), end: iso(12, 30) }),
      event({ title: 'Later', start: iso(14), end: iso(15) }),
    ), {}, NOW)

    // "Right now" survives: an event you are inside has not finished, and dropping it would clear
    // the wall display of the thing you are actually doing.
    expect(result.events.map((e: { title: string }) => e.title)).toEqual(['Right now', 'Later'])
  })

  it('sorts by start rather than trusting the payload order', () => {
    const result = normalizeAgenda(payload(
      event({ title: 'Evening', start: iso(19), end: iso(20) }),
      event({ title: 'Afternoon', start: iso(14), end: iso(15) }),
    ), {}, NOW)
    expect(result.events.map((e: { title: string }) => e.title)).toEqual(['Afternoon', 'Evening'])
  })

  it('caps to what the card asked for, clamped to something drawable', () => {
    const many = Array.from({ length: 9 }, (_, i) => event({ title: `E${i}`, start: iso(13 + i), end: iso(14 + i) }))
    expect(normalizeAgenda(payload(...many), { events: 3 }, NOW).events).toHaveLength(3)
    expect(normalizeAgenda(payload(...many), { events: 99 }, NOW).events).toHaveLength(9)
    expect(normalizeAgenda(payload(...many), { events: 0 }, NOW).events).toHaveLength(1)
  })

  /**
   * An all-day event's start is a DATE, not a moment. Parsed as UTC and rendered locally it lands
   * on the wrong square for anyone west of Greenwich — "Holiday" showing up on the wrong day is
   * the whole failure this parses local-first to avoid.
   */
  it('treats an all-day event as a local date and keeps it up all day', () => {
    const result = normalizeAgenda(payload(
      event({ title: 'Holiday', start: '2026-08-06', end: '2026-08-07', all_day: true }),
    ), {}, NOW)
    expect(result.events).toHaveLength(1)
    expect(formatEventTime(result.events[0])).toBe('ALL DAY')
  })

  it('drops an all-day event only once its day is over', () => {
    const yesterday = payload(event({ title: 'Gone', start: '2026-08-05', end: '2026-08-06', all_day: true }))
    expect(normalizeAgenda(yesterday, {}, NOW).events).toHaveLength(0)
  })

  it('survives a payload that is not a calendar rather than throwing', () => {
    for (const bad of [null, undefined, 42, 'events', { events: 'soon' }, { events: null }]) {
      expect(normalizeAgenda(bad, {}, NOW).available).toBe(false)
    }
    // An empty calendar is AVAILABLE and empty — a quiet week, not a broken source.
    expect(normalizeAgenda({ events: [] }, {}, NOW)).toMatchObject({ available: true, events: [] })
  })

  it('skips individual events it cannot read without losing the rest', () => {
    const result = normalizeAgenda(payload(
      event({ title: '   ' }),
      event({ title: 'Good', start: iso(16), end: iso(17) }),
      event({ start: 'not a date' }),
    ), {}, NOW)
    expect(result.events.map((e: { title: string }) => e.title)).toEqual(['Good'])
  })

  /** A getter that runs while the board is painting is not something a payload gets to do. */
  it('ignores inherited and accessor properties on a hostile payload', () => {
    const hostile = { events: [Object.defineProperty({}, 'title', { get() { throw new Error('boom') } })] }
    expect(() => normalizeAgenda(hostile, {}, NOW)).not.toThrow()
    expect(normalizeAgenda(hostile, {}, NOW).events).toEqual([])
  })
})

describe('agenda headings', () => {
  it('says TODAY and TOMORROW before it resorts to a date', () => {
    const midnight = new Date(2026, 7, 6).getTime()
    expect(formatDayHeading(midnight, NOW)).toBe('TODAY')
    expect(formatDayHeading(midnight + 86_400_000, NOW)).toBe('TOMORROW')
    expect(formatDayHeading(midnight + 2 * 86_400_000, NOW)).toMatch(/\d/)
  })

  it('heads each new day exactly once, in order', () => {
    const { events } = normalizeAgenda(payload(
      event({ title: 'A', start: iso(14), end: iso(15) }),
      event({ title: 'B', start: iso(16), end: iso(17) }),
      event({ title: 'C', start: iso(9, 0, 7), end: iso(10, 0, 7) }),
    ), {}, NOW)
    const rows = agendaRows(events, NOW)
    expect(rows.map((row: { kind: string }) => row.kind))
      .toEqual(['day', 'event', 'event', 'day', 'event'])
    expect(rows[0].label).toBe('TODAY')
    expect(rows[3].label).toBe('TOMORROW')
  })
})

describe('the agenda design', () => {
  it('declares the metadata the registry demands', () => {
    for (const key of ['id', 'widget', 'label', 'suggested_ratio', 'tokens', 'animations']) {
      expect(agenda.meta[key], key).toBeDefined()
    }
    expect(agenda.meta.widget).toBe('calendar_events')
    // Nothing on an agenda moves, so it must never ask the board loop for a frame.
    expect(agenda.isAnimating).toBeUndefined()
  })

  /**
   * `events` and `show_location` are the only two knobs `normalizeAgenda` reads, and until they
   * were declared here the admin drew NO control for either — while handing a `calendar_events`
   * cell the `news_list` arm's `items`/`show_*` keys, which its schema rejects outright. The
   * declaration is what makes the generated form draw the right pair.
   */
  it('declares exactly the two knobs the normalizer reads', () => {
    expect(Object.keys(agenda.meta.options).sort()).toEqual(['events', 'show_location'])
    expect(agenda.meta.options.events.type).toBe('number')
    expect(agenda.meta.options.show_location.type).toBe('boolean')
    // Flat top-level keys: no `path`, because that is the shape the schema accepts.
    expect(agenda.meta.options.events.path).toBeUndefined()
    expect(agenda.meta.options.show_location.path).toBeUndefined()
  })

  /**
   * Declared defaults and bounds pinned against the RUNTIME, not restated. A generated control that
   * showed a different default from what an unset cell renders would be lying about the current
   * state, and one that offered a number outside `clampInt`'s range would silently produce a value
   * the save schema (`integer, 1..10`) rejects with a 400 that fails the whole grid.
   */
  it('declares the defaults and bounds normalizeAgenda actually applies', () => {
    const unset = normalizeAgenda(payload(), {}, NOW)
    expect(unset.limit).toBe(agenda.meta.options.events.default)
    expect(unset.showLocation).toBe(agenda.meta.options.show_location.default)
    // The clamp's own floor and ceiling, read off the normalizer by asking for beyond each.
    expect(normalizeAgenda(payload(), { events: 0 }, NOW).limit).toBe(agenda.meta.options.events.min)
    expect(normalizeAgenda(payload(), { events: 99 }, NOW).limit).toBe(agenda.meta.options.events.max)
  })

  it('draws every state without throwing, including an empty and a broken calendar', () => {
    const calls: string[] = []
    const g = new Proxy({}, {
      get: (_t, key) => {
        if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
        if (key === 'font' || key === 'fillStyle' || key === 'textAlign' || key === 'textBaseline') return ''
        return (...args: unknown[]) => { calls.push(`${String(key)}:${args[0]}`) }
      },
      set: () => true,
    }) as CanvasRenderingContext2D

    const ctx = (data: unknown) => ({
      box: { w: 400, h: 300, t: 1 }, tokens: { ink: '#fff', dim: '#888' },
      data, config: { events: 4, show_location: true }, now: NOW, state: {}, motion: 'full', assets: {},
    })

    expect(() => agenda.draw(g, ctx(payload(event())))).not.toThrow()
    expect(calls.some((c) => c.startsWith('fillText:Dentist'))).toBe(true)

    calls.length = 0
    expect(() => agenda.draw(g, ctx({ events: [] }))).not.toThrow()
    expect(calls.some((c) => c.includes('Nothing on'))).toBe(true)

    calls.length = 0
    expect(() => agenda.draw(g, ctx('not a calendar'))).not.toThrow()
    expect(calls.some((c) => c.includes('unavailable'))).toBe(true)
  })

  it('draws nothing at all into a cell with no area', () => {
    const g = new Proxy({}, { get: () => () => { throw new Error('must not paint') }, set: () => true }) as CanvasRenderingContext2D
    expect(() => agenda.draw(g, {
      box: { w: 0, h: 0, t: 1 }, tokens: { ink: '#fff', dim: '#888' },
      data: payload(event()), config: {}, now: NOW, state: {}, motion: 'full', assets: {},
    })).not.toThrow()
  })
})
