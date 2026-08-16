import ical from 'node-ical'

/**
 * A published ICS document, into the events the calendar contract is built from.
 *
 * Google, Outlook and Apple all publish a "secret address in iCal format" per calendar, which is
 * why this is in the OAuth-free set (hub collection): the whole point is that the kitchen-display persona can
 * paste a URL and be done, with no developer console, no consent screen and no token to refresh.
 * The trade is that the URL IS the credential — anyone holding it can read the calendar — so it is
 * stored as a source SECRET and never shown on a board.
 *
 * RRULE is handled rather than punted. A standup, a bin collection and a birthday are most of what
 * is on a real family calendar; a connector that skipped recurrence would show an empty week and
 * look broken. `node-ical` (Apache-2.0, pinned) does the parsing — hand-rolling RFC 5545 recurrence,
 * with EXDATE and per-occurrence overrides, is a project rather than a function.
 */

export interface CalEvent {
  title: string
  /** ISO instant for a timed event; a plain YYYY-MM-DD for an all-day one. */
  start: string
  end: string
  all_day: boolean
  location: string | null
}

const DAY_MS = 86_400_000

/**
 * An all-day event is a DATE, not a moment. node-ical gives local midnight for one, so the local
 * components are the calendar date — `toISOString()` would shift it an hour east of UTC and a whole
 * DAY west of it, putting "Holiday" on the wrong square of the calendar.
 */
const dateOnly = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const asEvent = (title: unknown, start: Date, end: Date, allDay: boolean, location: unknown): CalEvent => ({
  // A blank row on a wall panel says nothing at all; every calendar app shows a placeholder here.
  title: typeof title === 'string' && title.trim() !== '' ? title.trim() : '(no title)',
  start: allDay ? dateOnly(start) : start.toISOString(),
  end: allDay ? dateOnly(end) : end.toISOString(),
  all_day: allDay,
  location: typeof location === 'string' && location.trim() !== '' ? location.trim() : null,
})

/** RECURRENCE-ID keys, as node-ical stores them on `recurrences` / `exdate`. */
const keyOf = (d: Date): string => d.toISOString().slice(0, 10)

export interface IcalWindow {
  /** The instant "now" is anchored to, so a run is reproducible against a fixture. */
  now: number
  /**
   * Both are `unknown` because they arrive as validated provider config, which is typed as a plain
   * record — and because the coercion below is load-bearing rather than defensive noise: a stored
   * config written by an older build can carry a string where a number is expected, and a calendar
   * that showed nothing for that reason would look like an empty week.
   */
  lookahead_days: unknown
  max_events: unknown
}

/**
 * Reading the body is the caller's job (`errors.ts` owns the capped, deadlined HTTP boundary for
 * every provider), so this takes text. What it owns is the part that is genuinely calendar work:
 * recurrence expansion, overrides, exclusions, the lookahead window, and the ordering a "what is
 * next" widget depends on.
 */
export const parseIcalEvents = (text: string, window: IcalWindow): CalEvent[] => {
  const lookaheadDays = Number(window.lookahead_days) || 7
  const maxEvents = Number(window.max_events) || 10
  const now = window.now
  const windowEnd = now + lookaheadDays * DAY_MS

  // The single most common misconfiguration is a sign-in page served where an ICS was expected —
  // an HTML body parses to zero events, which would otherwise look like an empty calendar forever.
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('that URL did not return a calendar (no VCALENDAR found)')

  let parsed: Record<string, any>
  try {
    parsed = ical.sync.parseICS(text) as Record<string, any>
  } catch (err) {
    throw new Error(`could not read the calendar: ${(err as Error).message}`)
  }

  const out: CalEvent[] = []

  for (const entry of Object.values(parsed)) {
    if (!entry || entry.type !== 'VEVENT' || !(entry.start instanceof Date)) continue
    const allDay = entry.datetype === 'date'
    const start: Date = entry.start
    const end: Date = entry.end instanceof Date ? entry.end : new Date(start.getTime() + 3600_000)
    const durationMs = end.getTime() - start.getTime()

    if (!entry.rrule) {
      if (end.getTime() >= now && start.getTime() <= windowEnd) {
        out.push(asEvent(entry.summary, start, end, allDay, entry.location))
      }
      continue
    }

    /**
     * A moved or renamed single occurrence. node-ical does NOT surface these as top-level events
     * even though they are separate VEVENTs in the file — it folds them into the master's
     * `recurrences` map, under BOTH a date key and a full-ISO key pointing at the same object. So
     * they have to be emitted from here, and de-duplicated by identity rather than by key.
     */
    const overrides = (entry.recurrences ?? {}) as Record<string, any>
    for (const override of new Set(Object.values(overrides))) {
      if (!(override?.start instanceof Date)) continue
      const oStart: Date = override.start
      const oEnd: Date = override.end instanceof Date ? override.end : new Date(oStart.getTime() + durationMs)
      if (oEnd.getTime() < now || oStart.getTime() > windowEnd) continue
      out.push(asEvent(
        override.summary ?? entry.summary, oStart, oEnd,
        override.datetype === 'date', override.location ?? entry.location,
      ))
    }

    // Ask the rule only for the window, never for "all" — COUNT-less rules are infinite, and an
    // unbounded expansion on a 15-minute poll is a way to hang the loop rather than fill a screen.
    let occurrences: Date[] = []
    try {
      occurrences = entry.rrule.between(new Date(now - durationMs), new Date(windowEnd), true) as Date[]
    } catch {
      // A rule this parser cannot expand must not take the whole calendar down: the one-off events
      // around it are still worth showing.
      continue
    }

    const excluded = new Set(
      (Array.isArray(entry.exdate) ? entry.exdate : Object.values(entry.exdate ?? {}))
        .filter((d: unknown): d is Date => d instanceof Date)
        .map((d: Date) => d.getTime()),
    )
    const overriddenKeys = new Set(Object.keys(overrides))

    for (const occStart of occurrences) {
      if (excluded.has(occStart.getTime())) continue
      // The override itself was emitted by the branch above — skipping here is what stops the
      // moved occurrence appearing twice, once at its old time and once at its new one.
      if (overriddenKeys.has(keyOf(occStart))) continue
      const occEnd = new Date(occStart.getTime() + durationMs)
      if (occEnd.getTime() < now || occStart.getTime() > windowEnd) continue
      out.push(asEvent(entry.summary, occStart, occEnd, allDay, entry.location))
    }
  }

  // Sorted and capped: a calendar widget shows "what is next", so the ORDER is the information and
  // the cap is what stops a busy month arriving as a thousand-element payload every five minutes.
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

  return out.slice(0, maxEvents)
}
