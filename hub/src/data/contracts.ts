export type ContractId =
  | 'dashboardz.weather.current/v1'
  | 'dashboardz.weather.daily-forecast/v1'
  | 'dashboardz.news.items/v1'
  | 'dashboardz.calendar.events/v1'
  | 'dashboardz.legacy.value/v1'
  | 'dashboardz.legacy.stream/v1'
  | 'dashboardz.legacy.image/v1'

export type SourceResult =
  | { mode: 'value'; payload: unknown }
  | { mode: 'stream'; rows: Record<string, unknown>[]; dedupe_by: string }
  | { mode: 'image'; image_rev: number }

export type ContractCheck =
  | { ok: true; capabilities: string[] }
  | { ok: false; error: string }

export type Location = { name: string; timezone: string | null }
export type Attribution = { label: string; url: string | null }
export type ConditionCode =
  | 'clear' | 'mostly_clear' | 'partly_cloudy' | 'cloudy' | 'fog' | 'drizzle'
  | 'rain' | 'snow' | 'showers' | 'thunderstorm' | 'unknown'
export type Condition = { code: ConditionCode; label: string }
export type Pollen = {
  level: 'low' | 'moderate' | 'high' | 'very_high' | 'unknown'
  index?: number
  scale?: string
  dominant?: string
}
export type WeatherCurrentV1 = {
  location: Location
  observed_at: number
  current: {
    temp: number
    condition: Condition
    feels_like?: number
    humidity?: number
    wind?: number
    code?: number
    is_day?: number
  }
  today?: { min?: number; max?: number; precip_prob?: number }
  units: { temp: '°C' | '°F'; wind: 'km/h' | 'mph' }
  attribution?: Attribution
}
export type WeatherDailyForecastV1 = {
  location: Location
  units: { temperature: 'C' | 'F'; wind_speed: 'km/h' | 'mph' }
  current?: WeatherCurrentV1
  days: Array<{
    date: string
    high: number
    low: number
    condition: Condition
    humidity_mean_pct?: number
    pollen?: Pollen
    precipitation_probability_pct?: number
    wind_speed_max?: number
  }>
  attribution?: Attribution
}
export type NewsItemV1 = {
  id: string
  title: string
  summary?: string
  url?: string
  link?: string
  published_at?: number
  source?: string
  attribution?: Attribution
}
export type CalendarEventsV1 = {
  events: Array<{ title: string; start: string; end: string; all_day: boolean; location: string | null }>
}

export interface ContractDefinition {
  id: ContractId
  mode: SourceResult['mode']
  collection_limit?: number
}

const freeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** The public shapes are static built-ins, so callers cannot alter validation globally. */
export const CONTRACTS = freeze({
  'dashboardz.weather.current/v1': { id: 'dashboardz.weather.current/v1', mode: 'value' },
  'dashboardz.weather.daily-forecast/v1': { id: 'dashboardz.weather.daily-forecast/v1', mode: 'value', collection_limit: 7 },
  'dashboardz.news.items/v1': { id: 'dashboardz.news.items/v1', mode: 'stream', collection_limit: 100 },
  'dashboardz.calendar.events/v1': { id: 'dashboardz.calendar.events/v1', mode: 'value', collection_limit: 50 },
  'dashboardz.legacy.value/v1': { id: 'dashboardz.legacy.value/v1', mode: 'value' },
  'dashboardz.legacy.stream/v1': { id: 'dashboardz.legacy.stream/v1', mode: 'stream' },
  'dashboardz.legacy.image/v1': { id: 'dashboardz.legacy.image/v1', mode: 'image' },
} satisfies Record<ContractId, ContractDefinition>)

const CONDITION_CODES = new Set<ConditionCode>([
  'clear', 'mostly_clear', 'partly_cloudy', 'cloudy', 'fog', 'drizzle',
  'rain', 'snow', 'showers', 'thunderstorm', 'unknown',
])
const POLLEN_LEVELS = new Set<Pollen['level']>(['low', 'moderate', 'high', 'very_high', 'unknown'])

const fail = (error: string): ContractCheck => ({ ok: false, error })
const pass = (capabilities: Iterable<string>): ContractCheck => ({ ok: true, capabilities: [...new Set(capabilities)].sort() })
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string'
const optional = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)

const validDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const validInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  if (!validDate(value.slice(0, 10))) return false
  const hour = Number(value.slice(11, 13))
  const minute = Number(value.slice(14, 16))
  const second = Number(value.slice(17, 19))
  return hour < 24 && minute < 60 && second < 60 && Number.isFinite(Date.parse(value))
}

const validEpoch = (value: unknown): value is number =>
  finite(value) && Number.isFinite(new Date(value).getTime())

const validateLocation = (value: unknown, path: string): string | null => {
  const location = record(value)
  if (!location) return `${path} must be an object`
  if (!text(location.name)) return `${path}.name must be a non-empty string`
  if (!nullableText(location.timezone)) return `${path}.timezone must be a string or null`
  return null
}

const validateAttribution = (value: unknown, path: string): string | null => {
  const attribution = record(value)
  if (!attribution) return `${path} must be an object`
  if (!text(attribution.label)) return `${path}.label must be a non-empty string`
  if (!nullableText(attribution.url)) return `${path}.url must be a string or null`
  return null
}

const validateCondition = (value: unknown, path: string): string | null => {
  const condition = record(value)
  if (!condition) return `${path} must be an object`
  if (typeof condition.code !== 'string' || !CONDITION_CODES.has(condition.code as ConditionCode)) {
    return `${path}.code must be a known condition code`
  }
  if (!text(condition.label)) return `${path}.label must be a non-empty string`
  return null
}

const validatePollen = (value: unknown, path: string): string | null => {
  const pollen = record(value)
  if (!pollen) return `${path} must be an object`
  if (typeof pollen.level !== 'string' || !POLLEN_LEVELS.has(pollen.level as Pollen['level'])) {
    return `${path}.level must be a known pollen level`
  }
  if (optional(pollen, 'index') && !finite(pollen.index)) return `${path}.index must be a finite number`
  if (optional(pollen, 'scale') && typeof pollen.scale !== 'string') return `${path}.scale must be a string`
  if (optional(pollen, 'dominant') && typeof pollen.dominant !== 'string') return `${path}.dominant must be a string`
  return null
}

const validateWeatherCurrent = (value: unknown, path = ''): string | null => {
  const weather = record(value)
  const at = (field: string) => path ? `${path}.${field}` : field
  if (!weather) return `${path || 'payload'} must be an object`
  const locationError = validateLocation(weather.location, at('location'))
  if (locationError) return locationError
  if (!validEpoch(weather.observed_at)) return `${at('observed_at')} must be a valid epoch timestamp`
  const now = record(weather.current)
  if (!now) return `${at('current')} must be an object`
  if (!finite(now.temp)) return `${at('current.temp')} must be a finite number`
  const conditionError = validateCondition(now.condition, at('current.condition'))
  if (conditionError) return conditionError
  for (const field of ['feels_like', 'humidity', 'wind', 'code', 'is_day']) {
    if (optional(now, field) && !finite(now[field])) return `${at(`current.${field}`)} must be a finite number`
  }
  const units = record(weather.units)
  if (!units || (units.temp !== '°C' && units.temp !== '°F')) return `${at('units.temp')} must be °C or °F`
  if (units.wind !== 'km/h' && units.wind !== 'mph') return `${at('units.wind')} must be km/h or mph`
  if (optional(weather, 'today')) {
    const today = record(weather.today)
    if (!today) return `${at('today')} must be an object`
    for (const field of ['min', 'max', 'precip_prob']) {
      if (optional(today, field) && !finite(today[field])) return `${at(`today.${field}`)} must be a finite number`
    }
  }
  if (optional(weather, 'attribution')) return validateAttribution(weather.attribution, at('attribution'))
  return null
}

const validateDaily = (result: SourceResult): ContractCheck => {
  if (result.mode !== 'value') return fail('mode must be value')
  const weather = record(result.payload)
  if (!weather) return fail('payload must be an object')
  const locationError = validateLocation(weather.location, 'location')
  if (locationError) return fail(locationError)
  const units = record(weather.units)
  if (!units || (units.temperature !== 'C' && units.temperature !== 'F')) return fail('units.temperature must be C or F')
  if (units.wind_speed !== 'km/h' && units.wind_speed !== 'mph') return fail('units.wind_speed must be km/h or mph')
  if (!Array.isArray(weather.days) || weather.days.length < 5 || weather.days.length > 7) {
    return fail('days must contain between 5 and 7 entries')
  }
  const capabilities = [
    'weather.daily.entries.5', 'weather.daily.date', 'weather.daily.temperature.high',
    'weather.daily.temperature.low', 'weather.daily.condition',
  ]
  for (let index = 5; index <= weather.days.length; index++) capabilities.push(`weather.daily.entries.${index}`)
  const optionalFields = {
    'weather.daily.humidity': 'humidity_mean_pct',
    'weather.daily.pollen': 'pollen',
    'weather.daily.precipitation_probability': 'precipitation_probability_pct',
    'weather.daily.wind': 'wind_speed_max',
  } as const
  const presentEveryDay = new Set<string>(Object.values(optionalFields))
  for (let index = 0; index < weather.days.length; index++) {
    const day = record(weather.days[index])
    if (!day) return fail(`days[${index}] must be an object`)
    if (!validDate(day.date)) return fail(`days[${index}].date must be a YYYY-MM-DD date`)
    if (!finite(day.high)) return fail(`days[${index}].high must be a finite number`)
    if (!finite(day.low)) return fail(`days[${index}].low must be a finite number`)
    const conditionError = validateCondition(day.condition, `days[${index}].condition`)
    if (conditionError) return fail(conditionError)
    for (const [capability, field] of Object.entries(optionalFields)) {
      if (!optional(day, field)) {
        presentEveryDay.delete(field)
        continue
      }
      if (field === 'pollen') {
        const pollenError = validatePollen(day[field], `days[${index}].${field}`)
        if (pollenError) return fail(pollenError)
      } else if (!finite(day[field])) return fail(`days[${index}].${field} must be a finite number`)
      void capability
    }
  }
  for (const [capability, field] of Object.entries(optionalFields)) {
    if (presentEveryDay.has(field)) capabilities.push(capability)
  }
  if (optional(weather, 'current')) {
    const currentError = validateWeatherCurrent(weather.current, 'current')
    if (currentError) return fail(currentError)
    capabilities.push('weather.current')
  }
  if (optional(weather, 'attribution')) {
    const attributionError = validateAttribution(weather.attribution, 'attribution')
    if (attributionError) return fail(attributionError)
    capabilities.push('attribution')
  }
  return pass(capabilities)
}

const validateNews = (result: SourceResult): ContractCheck => {
  if (result.mode !== 'stream') return fail('mode must be stream')
  if (result.dedupe_by !== 'id') return fail('dedupe_by must be id')
  if (!Array.isArray(result.rows) || result.rows.length > 100) return fail('rows must contain at most 100 entries')
  const ids = new Set<string>()
  const capabilities = ['news.item.id', 'news.item.title']
  const optionalCapabilities = {
    summary: 'news.item.summary', url: 'news.item.url', published_at: 'news.item.published_at',
    source: 'news.item.source', attribution: 'attribution',
  } as const
  for (let index = 0; index < result.rows.length; index++) {
    const row = record(result.rows[index])
    if (!row) return fail(`rows[${index}] must be an object`)
    if (!text(row.id)) return fail(`rows[${index}].id must be a non-empty string`)
    if (ids.has(row.id)) return fail(`rows[${index}].id must be unique`)
    ids.add(row.id)
    if (!text(row.title)) return fail(`rows[${index}].title must be a non-empty string`)
    for (const field of ['summary', 'url', 'link', 'source']) {
      if (optional(row, field) && typeof row[field] !== 'string') return fail(`rows[${index}].${field} must be a string`)
    }
    if (optional(row, 'published_at') && !validEpoch(row.published_at)) return fail(`rows[${index}].published_at must be a valid epoch timestamp`)
    if (optional(row, 'attribution')) {
      const attributionError = validateAttribution(row.attribution, `rows[${index}].attribution`)
      if (attributionError) return fail(attributionError)
    }
    for (const [field, capability] of Object.entries(optionalCapabilities)) {
      if (optional(row, field)) capabilities.push(capability)
    }
  }
  return pass(capabilities)
}

const validateCalendar = (result: SourceResult): ContractCheck => {
  if (result.mode !== 'value') return fail('mode must be value')
  const payload = record(result.payload)
  if (!payload || !Array.isArray(payload.events) || payload.events.length > 50) {
    return fail('events must contain at most 50 entries')
  }
  for (let index = 0; index < payload.events.length; index++) {
    const event = record(payload.events[index])
    if (!event) return fail(`events[${index}] must be an object`)
    if (!text(event.title)) return fail(`events[${index}].title must be a non-empty string`)
    if (typeof event.all_day !== 'boolean') return fail(`events[${index}].all_day must be a boolean`)
    const validTime = event.all_day ? validDate : validInstant
    if (!validTime(event.start)) return fail(`events[${index}].start must be a valid ${event.all_day ? 'date' : 'ISO instant'}`)
    if (!validTime(event.end)) return fail(`events[${index}].end must be a valid ${event.all_day ? 'date' : 'ISO instant'}`)
    if (!nullableText(event.location)) return fail(`events[${index}].location must be a string or null`)
  }
  /*
   * The base three are unconditional, and deliberately so: the loop above has just refused any
   * payload whose events lack a title, a start/end pair or an all-day flag, so a source that
   * validates can supply them. That matters most in the case that looks emptiest — a quiet week
   * with no events at all still declares the capabilities, because a calendar widget has to render
   * "nothing on" as a legitimate state rather than as an unmatched source.
   *
   * There is no `entries.N` here for the same reason. Weather has one because a five-day widget
   * genuinely cannot draw four days; a calendar with nothing in it is Tuesday.
   *
   * `location` is the one that depends on content, and ANY event carrying one is enough. Demanding
   * it on every event — the rule weather uses for its optional fields — would mean a single
   * location-less birthday dropped the capability for the whole calendar, and most events in a
   * real calendar have no location at all.
   */
  const capabilities = ['calendar.event.all_day', 'calendar.event.times', 'calendar.event.title']
  if (payload.events.some((event) => text(record(event)?.location))) {
    capabilities.push('calendar.event.location')
  }
  return pass(capabilities)
}

const jsonError = (value: unknown, path: string, stack: Set<object>): string | null => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return finite(value) ? null : `${path} must be JSON-safe`
  if (typeof value !== 'object') return `${path} must be JSON-safe`
  if (stack.has(value)) return `${path} must be JSON-safe`
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return `${path} must be JSON-safe`
  stack.add(value)
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value)
  for (const [key, child] of entries) {
    const error = jsonError(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, stack)
    if (error) return error
  }
  stack.delete(value)
  return null
}

const validateLegacy = (id: ContractId, result: SourceResult): ContractCheck => {
  if (id === 'dashboardz.legacy.image/v1') {
    return result.mode === 'image' && Number.isInteger(result.image_rev) && result.image_rev >= 0
      ? pass([]) : fail('image_rev must be a non-negative integer')
  }
  if (id === 'dashboardz.legacy.value/v1') {
    if (result.mode !== 'value') return fail('mode must be value')
    const error = jsonError(result.payload, 'payload', new Set())
    return error ? fail(error) : pass([])
  }
  if (result.mode !== 'stream') return fail('mode must be stream')
  if (!text(result.dedupe_by)) return fail('dedupe_by must be a non-empty string')
  for (let index = 0; index < result.rows.length; index++) {
    const error = jsonError(result.rows[index], `rows[${index}]`, new Set())
    if (error) return fail(error)
  }
  return pass([])
}

/** Provider-owned payloads are untrusted: validation is total and reports an actionable field path. */
export function validateContractOutput(id: ContractId, result: SourceResult): ContractCheck {
  try {
    if (!Object.hasOwn(CONTRACTS, id)) return fail('unknown contract')
    if (!result || typeof result !== 'object' || !('mode' in result)) return fail('result must be an output object')
    if (id === 'dashboardz.weather.current/v1') {
      if (result.mode !== 'value') return fail('mode must be value')
      const error = validateWeatherCurrent(result.payload)
      return error ? fail(error) : pass(['weather.current', ...(optional(record(result.payload)!, 'attribution') ? ['attribution'] : [])])
    }
    if (id === 'dashboardz.weather.daily-forecast/v1') return validateDaily(result)
    if (id === 'dashboardz.news.items/v1') return validateNews(result)
    if (id === 'dashboardz.calendar.events/v1') return validateCalendar(result)
    return validateLegacy(id, result)
  } catch {
    return fail('result must be a storage-safe output')
  }
}
