import { describe, expect, it } from 'vitest'
import { parseIcalEvents } from '../src/sources/providers/icalEvents.js'

/**
 * The iCalendar reader, on its own.
 *
 * Fetching is not its job — `sources/errors.ts` owns the capped, deadlined, redacted HTTP boundary
 * every provider shares, and the iCalendar provider hands the body straight here. What is left is
 * the calendar work: recurrence, overrides, exclusions, the lookahead window and the ordering a
 * "what is next" widget depends on. All of it survived the retirement of the v18 connector runtime
 * unchanged, so this coverage did too.
 */

/** now = 2026-08-05T12:00:00Z for every case below. */
const NOW = Date.parse('2026-08-05T12:00:00Z')

const cal = (...events: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dashboardz//test//EN', ...events, 'END:VCALENDAR'].join('\r\n')

const events = (ics: string, config: Record<string, unknown> = {}): Record<string, unknown>[] =>
  parseIcalEvents(ics, { now: NOW, lookahead_days: 7, max_events: 10, ...config }) as unknown as Record<string, unknown>[]

describe('the iCalendar reader', () => {
  it('reads a plain timed event', () => {
    const out = events(cal(
      'BEGIN:VEVENT', 'UID:one@test', 'DTSTAMP:20260801T090000Z',
      'DTSTART:20260806T090000Z', 'DTEND:20260806T100000Z',
      'SUMMARY:Dentist', 'LOCATION:Rua Augusta 12', 'END:VEVENT',
    ))
    expect(out).toEqual([{
      title: 'Dentist',
      start: '2026-08-06T09:00:00.000Z',
      end: '2026-08-06T10:00:00.000Z',
      all_day: false,
      location: 'Rua Augusta 12',
    }])
  })

  /**
   * An all-day event is a DATE, not a moment. Emitting a timestamp for one puts "Holiday" at
   * 01:00 for anybody east of UTC and on the wrong DAY for anybody west of it.
   */
  it('keeps an all-day event as a date', () => {
    const out = events(cal(
      'BEGIN:VEVENT', 'UID:allday@test', 'DTSTAMP:20260801T090000Z',
      'DTSTART;VALUE=DATE:20260807', 'DTEND;VALUE=DATE:20260808',
      'SUMMARY:Holiday', 'END:VEVENT',
    ))
    expect(out).toEqual([{ title: 'Holiday', start: '2026-08-07', end: '2026-08-08', all_day: true, location: null }])
  })

  /**
   * RRULE is not an edge case — a standup, a bin day and a birthday are most of what is on a real
   * family calendar, and a connector that ignored recurrence would show an empty week.
   */
  it('expands a recurring event across the window', () => {
    const out = events(cal(
      'BEGIN:VEVENT', 'UID:rec@test', 'DTSTAMP:20260801T090000Z',
      'DTSTART:20260805T170000Z', 'DTEND:20260805T173000Z',
      'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Standup', 'END:VEVENT',
    ))
    expect(out.map((e) => e.start)).toEqual([
      '2026-08-05T17:00:00.000Z',
      '2026-08-06T17:00:00.000Z',
      '2026-08-07T17:00:00.000Z',
      '2026-08-08T17:00:00.000Z',
      '2026-08-09T17:00:00.000Z',
    ])
    // Each occurrence keeps the master's DURATION, not the master's end time.
    expect(out[2].end).toBe('2026-08-07T17:30:00.000Z')
  })

  it('honours EXDATE, so a cancelled occurrence does not appear', () => {
    const out = events(cal(
      'BEGIN:VEVENT', 'UID:rec@test', 'DTSTAMP:20260801T090000Z',
      'DTSTART:20260805T170000Z', 'DTEND:20260805T173000Z',
      'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20260807T170000Z', 'SUMMARY:Standup', 'END:VEVENT',
    ))
    expect(out.map((e) => e.start)).not.toContain('2026-08-07T17:00:00.000Z')
    expect(out).toHaveLength(4)
  })

  /** A moved or renamed single occurrence overrides the generated one. */
  it('uses an overridden occurrence in place of the generated one', () => {
    const out = events(cal(
      'BEGIN:VEVENT', 'UID:rec@test', 'DTSTAMP:20260801T090000Z',
      'DTSTART:20260805T170000Z', 'DTEND:20260805T173000Z',
      'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Standup', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:rec@test', 'DTSTAMP:20260801T090000Z',
      'RECURRENCE-ID:20260806T170000Z',
      'DTSTART:20260806T180000Z', 'DTEND:20260806T183000Z',
      'SUMMARY:Standup (moved)', 'END:VEVENT',
    ))
    expect(out.find((e) => e.title === 'Standup (moved)')?.start).toBe('2026-08-06T18:00:00.000Z')
    expect(out.map((e) => e.start)).not.toContain('2026-08-06T17:00:00.000Z')
  })

  describe('the rolling window', () => {
    it('drops what has already finished — a calendar is a snapshot, not history', () => {
      const out = events(cal(
        'BEGIN:VEVENT', 'UID:past@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260804T090000Z', 'DTEND:20260804T100000Z', 'SUMMARY:Yesterday', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:next@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260806T090000Z', 'DTEND:20260806T100000Z', 'SUMMARY:Tomorrow', 'END:VEVENT',
      ))
      expect(out.map((e) => e.title)).toEqual(['Tomorrow'])
    })

    /** An event running right now is still on — it has not finished. */
    it('keeps an event that has started but not ended', () => {
      const out = events(cal(
        'BEGIN:VEVENT', 'UID:now@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260805T113000Z', 'DTEND:20260805T130000Z', 'SUMMARY:In progress', 'END:VEVENT',
      ))
      expect(out.map((e) => e.title)).toEqual(['In progress'])
    })

    it('drops what is past the lookahead', () => {
      const out = events(cal(
        'BEGIN:VEVENT', 'UID:far@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z', 'SUMMARY:Next month', 'END:VEVENT',
      ), { lookahead_days: 7 })
      expect(out).toEqual([])
    })

    it('sorts by start and caps at max_events', () => {
      const out = events(cal(
        'BEGIN:VEVENT', 'UID:c@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260808T090000Z', 'DTEND:20260808T100000Z', 'SUMMARY:Third', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:a@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260806T090000Z', 'DTEND:20260806T100000Z', 'SUMMARY:First', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:b@test', 'DTSTAMP:20260801T090000Z',
        'DTSTART:20260807T090000Z', 'DTEND:20260807T100000Z', 'SUMMARY:Second', 'END:VEVENT',
      ), { max_events: 2 })
      expect(out.map((e) => e.title)).toEqual(['First', 'Second'])
    })
  })

  it('names an event with no SUMMARY rather than showing a blank row', () => {
    const out = events(cal(
      'BEGIN:VEVENT', 'UID:bare@test', 'DTSTAMP:20260801T090000Z',
      'DTSTART:20260806T090000Z', 'DTEND:20260806T100000Z', 'END:VEVENT',
    ))
    expect(out[0].title).toBe('(no title)')
  })

  /** A login page served where an ICS was expected is the most common misconfiguration there is. */
  it('reports a body that is not a calendar', () => {
    expect(() => events('<html>Sign in</html>')).toThrow(/calendar/i)
  })

  it('returns an empty list for a calendar with nothing in the window', () => {
    const out = events(cal())
    expect(out).toEqual([])
  })
})
