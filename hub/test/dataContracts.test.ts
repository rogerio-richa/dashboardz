import { describe, expect, it } from 'vitest'
import { CONTRACTS, validateContractOutput } from '../src/data/contracts.js'
import type {
  Condition, NewsItemV1, WeatherCurrentV1, WeatherDailyForecastV1,
} from '../src/data/contracts.js'

const condition: Condition = { code: 'clear', label: 'Clear' }

// Annotated with the contract types themselves, so the optional fields these tests add one at a
// time (`current`, `pollen`, `published_at` …) are the ones the contract actually declares — a
// fixture that drifted from the type would fail here instead of quietly testing a shape no
// provider can emit.
const current = (): WeatherCurrentV1 => ({
  location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
  observed_at: Date.parse('2026-08-05T10:00:00Z'),
  current: { temp: 22.5, condition },
  units: { temp: '°C', wind: 'km/h' },
})

const daily = (): WeatherDailyForecastV1 => ({
  location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
  units: { temperature: 'C', wind_speed: 'km/h' },
  days: Array.from({ length: 5 }, (_, index) => ({
    date: `2026-08-${String(index + 5).padStart(2, '0')}`,
    high: 25 + index,
    low: 15 + index,
    condition,
  })),
})

const news = (): { mode: 'stream'; dedupe_by: string; rows: NewsItemV1[] } => ({
  mode: 'stream',
  dedupe_by: 'id',
  rows: [{ id: 'https://example.test/first', title: 'First story' }],
})

describe('semantic contract validation', () => {
  it('validates the five-day forecast shape and returns sorted required capabilities', () => {
    const result = validateContractOutput('dashboardz.weather.daily-forecast/v1', {
      mode: 'value', payload: daily(),
    })

    expect(result).toEqual({
      ok: true,
      capabilities: [
        'weather.daily.condition',
        'weather.daily.date',
        'weather.daily.entries.5',
        'weather.daily.temperature.high',
        'weather.daily.temperature.low',
      ],
    })
  })

  it.each([
    ['current', (value: ReturnType<typeof daily>) => { value.current = current() }],
    ['humidity', (value: ReturnType<typeof daily>) => { value.days.forEach((day) => { day.humidity_mean_pct = 65 }) }],
    ['pollen', (value: ReturnType<typeof daily>) => { value.days.forEach((day) => { day.pollen = { level: 'low', index: 2 } }) }],
    ['precipitation probability', (value: ReturnType<typeof daily>) => { value.days.forEach((day) => { day.precipitation_probability_pct = 20 }) }],
    ['wind', (value: ReturnType<typeof daily>) => { value.days.forEach((day) => { day.wind_speed_max = 12 }) }],
    ['attribution', (value: ReturnType<typeof daily>) => { value.attribution = { label: 'Open-Meteo', url: 'https://open-meteo.com/' } }],
  ])('reports %s only when every forecast day provides it', (_name, add) => {
    const value = daily()
    add(value)

    const result = validateContractOutput('dashboardz.weather.daily-forecast/v1', { mode: 'value', payload: value })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const optional = {
      current: 'weather.current',
      humidity: 'weather.daily.humidity',
      pollen: 'weather.daily.pollen',
      'precipitation probability': 'weather.daily.precipitation_probability',
      wind: 'weather.daily.wind',
      attribution: 'attribution',
    }[_name]
    expect(result.capabilities).toContain(optional)
    expect(result.capabilities).toEqual([...result.capabilities].sort())
    expect(new Set(result.capabilities).size).toBe(result.capabilities.length)
  })

  it('rejects the wrong mode and required forecast fields with their provider paths', () => {
    expect(validateContractOutput('dashboardz.weather.daily-forecast/v1', news() as any))
      .toEqual({ ok: false, error: 'mode must be value' })

    const missingDate = daily()
    delete (missingDate.days[2] as any).date
    expect(validateContractOutput('dashboardz.weather.daily-forecast/v1', { mode: 'value', payload: missingDate }))
      .toEqual({ ok: false, error: 'days[2].date must be a YYYY-MM-DD date' })

    const invalidHigh = daily()
    invalidHigh.days[2].high = Number.POSITIVE_INFINITY
    expect(validateContractOutput('dashboardz.weather.daily-forecast/v1', { mode: 'value', payload: invalidHigh }))
      .toEqual({ ok: false, error: 'days[2].high must be a finite number' })
  })

  it('enforces the forecast collection bounds', () => {
    const tooShort = daily()
    tooShort.days = tooShort.days.slice(0, 4)
    expect(validateContractOutput('dashboardz.weather.daily-forecast/v1', { mode: 'value', payload: tooShort }))
      .toEqual({ ok: false, error: 'days must contain between 5 and 7 entries' })

    const tooLong = daily()
    tooLong.days.push({ ...tooLong.days[0], date: '2026-08-10' }, { ...tooLong.days[0], date: '2026-08-11' }, { ...tooLong.days[0], date: '2026-08-12' })
    expect(validateContractOutput('dashboardz.weather.daily-forecast/v1', { mode: 'value', payload: tooLong }))
      .toEqual({ ok: false, error: 'days must contain between 5 and 7 entries' })
  })

  it('requires valid finite current-weather measurements and an epoch timestamp', () => {
    const invalid = current()
    invalid.observed_at = Number.NaN
    expect(validateContractOutput('dashboardz.weather.current/v1', { mode: 'value', payload: invalid }))
      .toEqual({ ok: false, error: 'observed_at must be a valid epoch timestamp' })

    const nonFiniteTemp = current()
    nonFiniteTemp.current.temp = Number.NEGATIVE_INFINITY
    expect(validateContractOutput('dashboardz.weather.current/v1', { mode: 'value', payload: nonFiniteTemp }))
      .toEqual({ ok: false, error: 'current.temp must be a finite number' })
  })

  it('validates bounded news rows with stable unique IDs and non-empty titles', () => {
    const valid = validateContractOutput('dashboardz.news.items/v1', news())
    expect(valid).toEqual({ ok: true, capabilities: ['news.item.id', 'news.item.title'] })

    const duplicate = news()
    duplicate.rows.push({ id: 'https://example.test/first', title: 'Repeated story' })
    expect(validateContractOutput('dashboardz.news.items/v1', duplicate))
      .toEqual({ ok: false, error: 'rows[1].id must be unique' })

    const emptyTitle = news()
    emptyTitle.rows[0].title = '   '
    expect(validateContractOutput('dashboardz.news.items/v1', emptyTitle))
      .toEqual({ ok: false, error: 'rows[0].title must be a non-empty string' })

    const invalidTimestamp = news()
    invalidTimestamp.rows[0].published_at = Number.NaN
    expect(validateContractOutput('dashboardz.news.items/v1', invalidTimestamp))
      .toEqual({ ok: false, error: 'rows[0].published_at must be a valid epoch timestamp' })
  })

  it('rejects news streams over the hundred-item contract bound', () => {
    const output = news()
    output.rows = Array.from({ length: 101 }, (_, index) => ({ id: `item-${index}`, title: `Story ${index}` }))
    expect(validateContractOutput('dashboardz.news.items/v1', output))
      .toEqual({ ok: false, error: 'rows must contain at most 100 entries' })
  })

  it('keeps v18 calendar and legacy payloads validated, and legacy ones non-semantic', () => {
    expect(validateContractOutput('dashboardz.calendar.events/v1', {
      mode: 'value',
      payload: { events: [{ title: 'Standup', start: '2026-08-05T09:00:00.000Z', end: '2026-08-05T09:30:00.000Z', all_day: false, location: null }] },
    })).toEqual({
      ok: true,
      capabilities: ['calendar.event.all_day', 'calendar.event.times', 'calendar.event.title'],
    })
    expect(validateContractOutput('dashboardz.calendar.events/v1', {
      mode: 'value', payload: { events: Array.from({ length: 51 }, () => ({ title: 'Busy', start: '2026-08-05', end: '2026-08-06', all_day: true, location: null })) },
    })).toEqual({ ok: false, error: 'events must contain at most 50 entries' })
    expect(validateContractOutput('dashboardz.legacy.value/v1', { mode: 'value', payload: { safe: [null, true, 1, 'text'] } }))
      .toEqual({ ok: true, capabilities: [] })

    expect(validateContractOutput('dashboardz.legacy.image/v1', { mode: 'image', image_rev: -1 }))
      .toEqual({ ok: false, error: 'image_rev must be a non-negative integer' })
  })

  /**
   * The calendar contract's capabilities. The base three are unconditional because the validator
   * has already refused anything lacking them — including for an empty calendar, which is a
   * legitimate quiet week and must still match a widget rather than looking like a dead source.
   */
  it('declares calendar capabilities even for a week with nothing in it', () => {
    expect(validateContractOutput('dashboardz.calendar.events/v1', { mode: 'value', payload: { events: [] } }))
      .toEqual({
        ok: true,
        capabilities: ['calendar.event.all_day', 'calendar.event.times', 'calendar.event.title'],
      })
  })

  /**
   * Location is per-event in every real calendar — most entries have none. One event carrying a
   * location is enough to say this source can supply them; demanding it on every event would let a
   * single location-less birthday strip the capability from the whole calendar.
   */
  it('claims locations when any event has one, not only when all of them do', () => {
    const events = (...locations: (string | null)[]) => ({
      mode: 'value' as const,
      payload: { events: locations.map((location, index) => ({
        title: `Event ${index}`, start: '2026-08-05', end: '2026-08-06', all_day: true, location,
      })) },
    })

    expect(validateContractOutput('dashboardz.calendar.events/v1', events(null, 'Rua Augusta 12')).ok).toBe(true)
    expect((validateContractOutput('dashboardz.calendar.events/v1', events(null, 'Rua Augusta 12')) as { capabilities: string[] }).capabilities)
      .toContain('calendar.event.location')
    expect((validateContractOutput('dashboardz.calendar.events/v1', events(null, null)) as { capabilities: string[] }).capabilities)
      .not.toContain('calendar.event.location')
  })

  it('rejects inherited names rather than treating them as contract IDs', () => {
    expect(validateContractOutput('toString' as any, {
      mode: 'stream', dedupe_by: 'id', rows: [],
    })).toEqual({ ok: false, error: 'unknown contract' })
  })

  it('rejects impossible calendar instants instead of Date.parse-normalizing them', () => {
    expect(validateContractOutput('dashboardz.calendar.events/v1', {
      mode: 'value',
      payload: { events: [{ title: 'Impossible', start: '2026-02-30T09:00:00Z', end: '2026-02-30T10:00:00Z', all_day: false, location: null }] },
    })).toEqual({ ok: false, error: 'events[0].start must be a valid ISO instant' })
  })

  it('exposes immutable runtime registries', () => {
    expect(Object.isFrozen(CONTRACTS)).toBe(true)
    expect(Object.isFrozen(CONTRACTS['dashboardz.weather.daily-forecast/v1'])).toBe(true)
  })
})
