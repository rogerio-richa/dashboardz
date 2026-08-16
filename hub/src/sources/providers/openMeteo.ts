import type { Condition, WeatherCurrentV1, WeatherDailyForecastV1 } from '../../data/contracts.js'
import { SourceError, fetchProvider, readCappedJson } from '../errors.js'
import {
  asRecord, defineProvider, setupNumber, setupText, validateProducedOutputs,
  type ProviderDefinition, type ProviderRunContext, type ProviderRunInput,
} from '../provider.js'

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const MAX_JSON_BYTES = 1024 * 1024
const ATTRIBUTION = {
  label: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
} as const
const CURRENT_FIELDS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'wind_speed_10m', 'weather_code', 'is_day',
]
const DAILY_FIELDS = [
  'temperature_2m_min', 'temperature_2m_max', 'weather_code',
  'relative_humidity_2m_mean', 'precipitation_probability_max', 'wind_speed_10m_max',
]

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const at = (value: unknown, index: number): unknown => Array.isArray(value) ? value[index] : undefined

function condition(value: unknown): Condition {
  const code = finite(value)
  if (code === 0) return { code: 'clear', label: 'Clear' }
  if (code === 1) return { code: 'mostly_clear', label: 'Mostly clear' }
  if (code === 2) return { code: 'partly_cloudy', label: 'Partly cloudy' }
  if (code === 3) return { code: 'cloudy', label: 'Cloudy' }
  if (code === 45 || code === 48) return { code: 'fog', label: 'Fog' }
  if (code !== undefined && [51, 53, 55, 56, 57].includes(code)) return { code: 'drizzle', label: 'Drizzle' }
  if (code !== undefined && [61, 63, 65, 66, 67].includes(code)) return { code: 'rain', label: 'Rain' }
  if (code !== undefined && [71, 73, 75, 77, 85, 86].includes(code)) return { code: 'snow', label: 'Snow' }
  if (code !== undefined && [80, 81, 82].includes(code)) return { code: 'showers', label: 'Rain showers' }
  if (code !== undefined && [95, 96, 99].includes(code)) return { code: 'thunderstorm', label: 'Thunderstorm' }
  return { code: 'unknown', label: 'Unknown' }
}

function observedAt(current: Record<string, unknown>, body: Record<string, unknown>, fallback: number): number {
  if (typeof current.time !== 'string') return fallback
  const localAsUtc = Date.parse(`${current.time}Z`)
  const offset = finite(body.utc_offset_seconds)
  return Number.isFinite(localAsUtc) ? localAsUtc - (offset ?? 0) * 1000 : fallback
}

function optionalNumber(target: Record<string, unknown>, name: string, value: unknown): void {
  const number = finite(value)
  if (number !== undefined) target[name] = number
}

function checkedSetup(input: ProviderRunInput) {
  const checked = openMeteoProvider.validateSetup(input.config, input.secrets)
  if (!checked.ok) throw new SourceError('invalid_response', checked.error)
  return checked
}

async function runOpenMeteo(input: ProviderRunInput, ctx: Parameters<ProviderDefinition['run']>[1]) {
  const checked = checkedSetup(input)
  const url = new URL(OPEN_METEO_FORECAST_URL)
  url.searchParams.set('latitude', String(checked.config.lat))
  url.searchParams.set('longitude', String(checked.config.lon))
  url.searchParams.set('current', CURRENT_FIELDS.join(','))
  url.searchParams.set('daily', DAILY_FIELDS.join(','))
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', '7')
  if (checked.config.units === 'imperial') {
    url.searchParams.set('temperature_unit', 'fahrenheit')
    url.searchParams.set('wind_speed_unit', 'mph')
  }

  const body = await readCappedJson(await fetchProvider(url, ctx), MAX_JSON_BYTES)
  const currentRaw = asRecord(body.current) ?? {}
  const currentUnits = asRecord(body.current_units) ?? {}
  const dailyRaw = asRecord(body.daily) ?? {}
  const location = {
    name: String(checked.config.city),
    timezone: typeof body.timezone === 'string' ? body.timezone : null,
  }
  const tempUnit = currentUnits.temperature_2m === '°F' || checked.config.units === 'imperial' ? '°F' : '°C'
  const windUnit = currentUnits.wind_speed_10m === 'mph' || checked.config.units === 'imperial' ? 'mph' : 'km/h'
  const currentValues: Record<string, unknown> = {
    temp: finite(currentRaw.temperature_2m),
    condition: condition(currentRaw.weather_code),
  }
  optionalNumber(currentValues, 'feels_like', currentRaw.apparent_temperature)
  optionalNumber(currentValues, 'humidity', currentRaw.relative_humidity_2m)
  optionalNumber(currentValues, 'wind', currentRaw.wind_speed_10m)
  optionalNumber(currentValues, 'code', currentRaw.weather_code)
  optionalNumber(currentValues, 'is_day', currentRaw.is_day)
  const today: Record<string, unknown> = {}
  optionalNumber(today, 'min', at(dailyRaw.temperature_2m_min, 0))
  optionalNumber(today, 'max', at(dailyRaw.temperature_2m_max, 0))
  optionalNumber(today, 'precip_prob', at(dailyRaw.precipitation_probability_max, 0))
  const current: WeatherCurrentV1 = {
    location,
    observed_at: observedAt(currentRaw, body, ctx.now),
    current: currentValues as WeatherCurrentV1['current'],
    ...(Object.keys(today).length > 0 ? { today } : {}),
    units: { temp: tempUnit, wind: windUnit },
    attribution: ATTRIBUTION,
  }

  const dates = Array.isArray(dailyRaw.time) ? dailyRaw.time : []
  const days: WeatherDailyForecastV1['days'] = Array.from({ length: 7 }, (_, index) => {
    const day: Record<string, unknown> = {
      date: dates[index],
      high: finite(at(dailyRaw.temperature_2m_max, index)),
      low: finite(at(dailyRaw.temperature_2m_min, index)),
      condition: condition(at(dailyRaw.weather_code, index)),
    }
    optionalNumber(day, 'humidity_mean_pct', at(dailyRaw.relative_humidity_2m_mean, index))
    optionalNumber(day, 'precipitation_probability_pct', at(dailyRaw.precipitation_probability_max, index))
    optionalNumber(day, 'wind_speed_max', at(dailyRaw.wind_speed_10m_max, index))
    return day as WeatherDailyForecastV1['days'][number]
  })
  const forecast: WeatherDailyForecastV1 = {
    location,
    units: { temperature: tempUnit === '°F' ? 'F' : 'C', wind_speed: windUnit },
    current,
    days,
    attribution: ATTRIBUTION,
  }

  return validateProducedOutputs([
    { contract_id: 'dashboardz.weather.current/v1', result: { mode: 'value', payload: current } },
    { contract_id: 'dashboardz.weather.daily-forecast/v1', result: { mode: 'value', payload: forecast } },
  ])
}

export const openMeteoProvider: ProviderDefinition = defineProvider({
  id: 'dashboardz.open-meteo',
  package_id: 'dashboardz.builtin',
  package_version: '1.0.0',
  strategy: 'scheduled',
  label: 'Open-Meteo',
  category: 'weather',
  recommended: true,
  default_interval_s: 900,
  min_interval_s: 300,
  potential_outputs: [
    { contract_id: 'dashboardz.weather.current/v1', capabilities: ['attribution', 'weather.current'] },
    {
      contract_id: 'dashboardz.weather.daily-forecast/v1',
      capabilities: [
        'attribution', 'weather.current', 'weather.daily.condition', 'weather.daily.date',
        'weather.daily.entries.5', 'weather.daily.entries.6', 'weather.daily.entries.7',
        'weather.daily.humidity', 'weather.daily.precipitation_probability',
        'weather.daily.temperature.high', 'weather.daily.temperature.low', 'weather.daily.wind',
      ],
    },
  ],
  setup: [
    { name: 'city', label: 'Location name', type: 'text', required: true, secret: false },
    { name: 'lat', label: 'Latitude', type: 'number', required: true, secret: false, min: -90, max: 90 },
    { name: 'lon', label: 'Longitude', type: 'number', required: true, secret: false, min: -180, max: 180 },
    {
      name: 'units', label: 'Units', type: 'select', required: true, secret: false,
      options: [{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }],
    },
  ],
  validateSetup(config, _secrets) {
    const raw = asRecord(config)
    if (raw === null) return { ok: false, error: 'Weather setup must be an object' }
    const city = setupText(raw.city ?? raw.name)
    const lat = setupNumber(raw.lat ?? raw.latitude)
    const lon = setupNumber(raw.lon ?? raw.longitude)
    if (city === null) return { ok: false, error: 'Weather needs a location name' }
    if (lat === null || lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be between -90 and 90' }
    if (lon === null || lon < -180 || lon > 180) return { ok: false, error: 'Longitude must be between -180 and 180' }
    return {
      ok: true,
      config: { city, lat, lon, units: raw.units === 'imperial' ? 'imperial' : 'metric' },
      secrets: {},
    }
  },
  run: runOpenMeteo,
})

export const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

export interface Place { name: string; country: string; region: string; lat: number; lon: number }

/**
 * City in, coordinates out. Proxied through the hub (`routes/sourceAdmin.ts`) rather than called
 * from the browser: the admin is served from the hub's own origin and Open-Meteo sets no CORS
 * header a private-network page can rely on, so the fetch belongs on this side.
 *
 * It lives beside the provider whose coordinates it produces, and goes through the same redacted
 * HTTP boundary every provider run uses — so an upstream failure arrives as a `SourceError` with
 * provider-safe wording rather than as a body a caller might forward to a browser.
 *
 * "No such place" is an EMPTY LIST, not an error — the form reports it and stays open.
 */
export async function geocodePlaces(query: string, ctx: ProviderRunContext): Promise<Place[]> {
  const url = new URL(OPEN_METEO_GEOCODE_URL)
  url.searchParams.set('name', query)
  url.searchParams.set('count', '5')
  const body = await readCappedJson(await fetchProvider(url, ctx), MAX_JSON_BYTES)
  const results = Array.isArray(body.results) ? body.results : []
  return results
    .filter((place: unknown): place is Record<string, unknown> => {
      const record = asRecord(place)
      return record !== null && typeof record.latitude === 'number' && typeof record.longitude === 'number'
    })
    .map((place) => ({
      name: typeof place.name === 'string' ? place.name : query,
      country: typeof place.country === 'string' ? place.country : '',
      region: typeof place.admin1 === 'string' ? place.admin1 : '',
      lat: place.latitude as number,
      lon: place.longitude as number,
    }))
}
