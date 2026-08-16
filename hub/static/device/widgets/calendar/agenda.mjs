/**
 * "What's next" — the upcoming events in time order, under day headings.
 *
 * An agenda rather than a month grid because of what a wall panel is for. A month tells you when
 * the long weekend is; a kitchen display is answering "what am I doing today", and titles do not
 * fit in a month cell anyway. The layout degrades the way `news_list` does: fewer lines per row
 * before smaller type, and optional detail dropped before anything essential.
 *
 * Two states are NOT failures and must not read like one. A calendar with nothing in the window is
 * a quiet week — the commonest thing a real calendar says — and gets its own wording. Only a
 * missing or malformed payload is "unavailable".
 */
import { centredNotice, fitted, paintText } from '../text-fit.mjs'

const MIN_EVENTS = 1
const MAX_EVENTS = 10
const DEFAULT_EVENTS = 5
const CONTRACT_EVENT_LIMIT = 50
const DISPLAY_CODE_POINT_LIMIT = 512
const TITLE_FLOOR = 10
const OPTIONAL_FLOOR = 10
const LINE_GAP = 2
const DAY_MS = 86_400_000

const meta = {
  id: 'agenda',
  widget: 'calendar_events',
  label: 'Agenda',
  suggested_ratio: 3 / 4,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  /**
   * The two visual knobs `normalizeAgenda` below actually reads, and the ONLY way to reach either
   * from the admin. Until these were declared, `CellConfig.tsx`'s semantic branch was a binary on
   * `weather_forecast`, so a `calendar_events` cell fell into the `news_list` arm and was offered
   * `items`/`show_summary`/`show_source`/`show_time` — four keys `semanticConfig`'s
   * `additionalProperties: false` rejects, which meant touching any of them 400'd the WHOLE grid
   * PATCH (`cell N (calendar_events): unknown config key "items"`), while `events` and
   * `show_location` had no control anywhere.
   *
   * Both are flat top-level keys, so neither needs a `path`. `min`/`max` restate the save schema's
   * `integer, 1..10` (`hub/src/routes/admin.ts`'s `calendar_events` branch) — the same discipline
   * `alert_feed`'s line clamps follow, and `hub/test/option-bounds.test.ts` fails if a declared
   * bound ever exceeds the schema's — and `MIN_EVENTS`/`MAX_EVENTS`/`DEFAULT_EVENTS` are the
   * constants `normalizeAgenda`'s own `clampInt` uses, so the declared default is the runtime one
   * by construction rather than by a number copied here and left to drift.
   *
   * `show_location` defaults `false` because the normalizer tests `=== true`: an absent key and an
   * explicit `false` are the same thing, which is exactly what an unchecked box writes.
   */
  options: {
    events: { type: 'number', label: 'Events', default: DEFAULT_EVENTS, min: MIN_EVENTS, max: MAX_EVENTS },
    show_location: { type: 'boolean', label: 'Show location', default: false },
  },
  animations: { transition: [], persistent: [] },
}

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const record = (value) =>
  value !== null && typeof value === 'object' && !isArray(value) ? value : null

/**
 * A own-data-property read. Board payloads are attacker-adjacent by construction — they come from
 * whatever a provider returned — so a getter that runs during rendering is not something this file
 * offers. Same rule and same shape as `news/list.mjs`.
 */
function ownData(value, key) {
  const target = value !== null && typeof value === 'object' ? value : null
  if (!target) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function arrayValues(value, limit) {
  if (!isArray(value)) return null
  const length = ownData(value, 'length')
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null
  const values = []
  for (let index = 0; index < length; index++) {
    const candidate = ownData(value, String(index))
    if (candidate === undefined) return null
    values.push(candidate)
  }
  return values
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

function displayText(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const points = Array.from(trimmed)
  return points.length > DISPLAY_CODE_POINT_LIMIT
    ? points.slice(0, DISPLAY_CODE_POINT_LIMIT).join('')
    : trimmed
}

function clampInt(value, fallback, min, max) {
  if (!finite(value)) return fallback
  const rounded = Math.round(value)
  return Math.min(max, Math.max(min, rounded))
}

/**
 * An all-day event's `start` is a plain `YYYY-MM-DD`, which is a DATE and not a moment — parsing
 * it as UTC and formatting it locally is how "Holiday" lands on the wrong square for anyone west
 * of Greenwich. Parsed into local components deliberately.
 */
function parseDayStart(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day] = match
  const at = new Date(Number(year), Number(month) - 1, Number(day))
  return Number.isFinite(at.getTime()) ? at.getTime() : null
}

function parseInstant(value) {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** Local midnight for an instant — the key events are grouped by. */
function dayKey(at) {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function formatDayHeading(dayAt, now) {
  const today = dayKey(now)
  if (dayAt === today) return 'TODAY'
  if (dayAt === today + DAY_MS) return 'TOMORROW'
  const date = new Date(dayAt)
  const weekday = date.toLocaleDateString([], { weekday: 'short' })
  const day = date.toLocaleDateString([], { day: 'numeric' })
  return `${weekday} ${day}`.toUpperCase()
}

export function formatEventTime(event) {
  if (event.allDay) return 'ALL DAY'
  return new Date(event.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The events worth drawing: anything that has not finished yet, soonest first, capped to what the
 * card asked for. Sorting here rather than trusting the payload — the contract does not promise an
 * order, and an agenda in the wrong order is worse than no agenda.
 */
export function normalizeAgenda(data, config, now) {
  const settings = record(config) ?? {}
  const scale = finite(ownData(settings, 'scale')) ? Math.min(2, Math.max(0.5, ownData(settings, 'scale'))) : 1
  const limit = clampInt(ownData(settings, 'events'), DEFAULT_EVENTS, MIN_EVENTS, MAX_EVENTS)
  const showLocation = ownData(settings, 'show_location') === true

  const payload = record(data)
  const raw = payload ? arrayValues(ownData(payload, 'events'), CONTRACT_EVENT_LIMIT) : null
  if (raw === null) return { available: false, scale, limit, showLocation, events: [] }

  const at = finite(now) ? now : 0
  const events = []
  for (const candidate of raw) {
    const event = record(candidate)
    if (!event) continue
    const title = displayText(ownData(event, 'title'))
    const allDay = ownData(event, 'all_day') === true
    const start = allDay ? parseDayStart(ownData(event, 'start')) : parseInstant(ownData(event, 'start'))
    if (title === null || start === null) continue
    // An all-day event runs to the end of its day; a timed one to its own end, falling back to its
    // start so a malformed end cannot hide an event that is genuinely still ahead.
    const rawEnd = allDay ? parseDayStart(ownData(event, 'end')) : parseInstant(ownData(event, 'end'))
    const end = allDay ? (rawEnd ?? start + DAY_MS) : (rawEnd ?? start)
    if (end < at) continue
    events.push({ title, allDay, start, end, location: displayText(ownData(event, 'location')) })
  }

  events.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title))
  return { available: true, scale, limit, showLocation, events: events.slice(0, limit) }
}

/** Rows to draw: a day heading whenever the date changes, then that day's events. */
export function agendaRows(events, now) {
  const rows = []
  let lastDay = null
  for (const event of events) {
    const day = event.allDay ? event.start : dayKey(event.start)
    if (day !== lastDay) {
      rows.push({ kind: 'day', label: formatDayHeading(day, now) })
      lastDay = day
    }
    rows.push({ kind: 'event', event })
  }
  return rows
}

/**
 * Type sizes for the whole card, and the height each kind of row will take.
 *
 * Sizes come from the cell's WIDTH and the number of rows, not from dividing its height into equal
 * bands. Equal bands were the first attempt and looked broken on the wall: two events in a tall
 * cell each got half the height and sat at the top of their band, so the agenda read as three
 * items marooned in white space rather than as a list. An agenda is packed from the top — the
 * empty space belongs at the bottom, where it looks like room for more rather than like a bug.
 */
export function agendaPlan(box, rowCount, scale, showLocation) {
  const heightBudget = rowCount > 0 ? Math.max(0, box.h) / rowCount : Math.max(0, box.h)
  const titlePx = Math.max(TITLE_FLOOR, Math.round(Math.min(20, box.w * 0.05, heightBudget) * scale))
  const optionalPx = Math.max(OPTIONAL_FLOOR, Math.round(Math.min(14, box.w * 0.032, heightBudget * 0.7) * scale))
  const dayPx = Math.max(OPTIONAL_FLOOR, Math.round(optionalPx * 0.95))
  const withLocation = titlePx + optionalPx + LINE_GAP
  const showLocationRow = showLocation && heightBudget >= withLocation
  return {
    titlePx,
    optionalPx,
    dayPx,
    showLocation: showLocationRow,
    /** Natural heights, so rows can be packed rather than spread. */
    eventHeight: (showLocationRow ? withLocation : titlePx) + Math.round(titlePx * 0.55),
    dayHeight: dayPx + Math.round(dayPx * 0.7),
  }
}

function draw(g, ctx) {
  const { box, tokens, data, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const normalized = normalizeAgenda(data, config, now)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (!normalized.available) {
    centredNotice(g, 'Calendar unavailable', 'Events will appear here', box, tokens, pad, normalized.scale)
    return
  }
  if (normalized.events.length === 0) {
    // Not a failure. An empty calendar is the commonest thing a real calendar says.
    centredNotice(g, 'Nothing on', 'The calendar is clear', box, tokens, pad, normalized.scale)
    return
  }

  const rows = agendaRows(normalized.events, finite(now) ? now : 0)
  const bodyWidth = Math.max(0, box.w - pad * 2)
  const bodyHeight = Math.max(0, box.h - pad * 2)
  const plan = agendaPlan({ w: box.w, h: bodyHeight }, rows.length, normalized.scale, normalized.showLocation)
  // A time column wide enough for the longest label this card will actually draw.
  const timeWidth = Math.min(bodyWidth * 0.34, Math.max(
    ...rows.filter((row) => row.kind === 'event').map((row) => {
      g.font = `600 ${plan.optionalPx}px system-ui`
      return g.measureText(formatEventTime(row.event)).width
    }),
    0,
  ) + plan.optionalPx * 0.6)

  // Packed from the top, and stopping at the bottom edge rather than drawing past it: an agenda
  // that runs out of room has shown you what is next, which is the whole job.
  let y = pad
  for (const row of rows) {
    const rowHeight = row.kind === 'day' ? plan.dayHeight : plan.eventHeight
    if (y + rowHeight > pad + bodyHeight) break
    if (row.kind === 'day') {
      paintText(g, row.label, pad, y, {
        px: plan.dayPx, floor: OPTIONAL_FLOOR, maxWidth: bodyWidth,
        color: tokens.dim, weight: 600,
      })
      y += rowHeight
      continue
    }
    paintText(g, formatEventTime(row.event), pad, y, {
      px: plan.optionalPx, floor: OPTIONAL_FLOOR, maxWidth: timeWidth,
      color: tokens.dim, weight: 600,
    })
    const titleX = pad + timeWidth
    const titleWidth = Math.max(0, bodyWidth - timeWidth)
    paintText(g, row.event.title, titleX, y, {
      px: plan.titlePx, floor: TITLE_FLOOR, maxWidth: titleWidth,
      color: tokens.ink, weight: 600,
    })
    if (plan.showLocation && row.event.location) {
      paintText(g, row.event.location, titleX, y + plan.titlePx + LINE_GAP, {
        px: plan.optionalPx, floor: OPTIONAL_FLOOR, maxWidth: titleWidth,
        color: tokens.dim, weight: 400,
      })
    }
    y += rowHeight
  }
}

export default { meta, draw }
