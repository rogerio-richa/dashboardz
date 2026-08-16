import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { validateContractOutput } from '../src/data/contracts.js'
import { SourceError } from '../src/sources/errors.js'
import {
  OPEN_METEO_GEOCODE_URL, geocodePlaces, openMeteoProvider,
} from '../src/sources/providers/openMeteo.js'

const fixture = (): Record<string, any> => JSON.parse(readFileSync(
  new URL('./fixtures/open-meteo-seven-day.json', import.meta.url), 'utf8',
))
const NOW = Date.parse('2026-08-05T12:00:00Z')

function context(fetchImpl: typeof fetch, signal = new AbortController().signal) {
  return { fetch: fetchImpl, now: NOW, signal }
}

describe('Open-Meteo provider', () => {
  const input = { config: { city: 'Lisbon', lat: 38.72, lon: -9.14, units: 'metric' }, secrets: {} }

  it('exports immutable discovery metadata even without loading the registry', () => {
    expect(Object.isFrozen(openMeteoProvider)).toBe(true)
    expect(Object.isFrozen(openMeteoProvider.setup)).toBe(true)
    expect(Object.isFrozen(openMeteoProvider.potential_outputs[1].capabilities)).toBe(true)
  })

  it('normalizes ordinary setup without moving coordinates into secrets', () => {
    expect(openMeteoProvider.validateSetup(input.config, {})).toEqual({
      ok: true,
      config: input.config,
      secrets: {},
    })
    expect(openMeteoProvider.validateSetup({ lat: 100, lon: -9.14 }, {})).toMatchObject({ ok: false })
  })

  it('fetches seven days once and produces two contract-valid attributed outputs', async () => {
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
    const fetchImpl = (async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(request), signal: init?.signal })
      return new Response(JSON.stringify(fixture()), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const outputs = await openMeteoProvider.run(input, context(fetchImpl))

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('forecast_days')).toBe('7')
    expect(url.searchParams.get('daily')).toContain('relative_humidity_2m_mean')
    expect(url.searchParams.get('daily')).toContain('wind_speed_10m_max')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
    expect(outputs.map((output) => output.contract_id)).toEqual([
      'dashboardz.weather.current/v1', 'dashboardz.weather.daily-forecast/v1',
    ])
    for (const output of outputs) expect(validateContractOutput(output.contract_id, output.result).ok).toBe(true)

    const current = (outputs[0].result as any).payload
    expect(current).toMatchObject({
      location: { name: 'Lisbon', timezone: 'Europe/Lisbon' },
      observed_at: Date.parse('2026-08-05T09:00:00Z'),
      current: { temp: 21.3, condition: { code: 'partly_cloudy', label: 'Partly cloudy' } },
      attribution: { label: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
    })
    const forecast = (outputs[1].result as any).payload
    expect(forecast.days).toHaveLength(7)
    expect(forecast.days[0]).toEqual({
      date: '2026-08-05', high: 24.6, low: 15.1,
      condition: { code: 'partly_cloudy', label: 'Partly cloudy' },
      humidity_mean_pct: 62, precipitation_probability_pct: 20, wind_speed_max: 18,
    })
    expect(forecast.days[0]).not.toHaveProperty('pollen')
    expect(forecast.attribution).toEqual(current.attribution)
  })

  it('omits optional daily data when upstream does not return it', async () => {
    const body = fixture()
    delete body.daily.relative_humidity_2m_mean
    delete body.daily.wind_speed_10m_max
    const fetchImpl = (async () => new Response(JSON.stringify(body))) as typeof fetch
    const output = (await openMeteoProvider.run(input, context(fetchImpl)))[1]
    const check = validateContractOutput(output.contract_id, output.result)

    expect(check).toMatchObject({ ok: true })
    if (!check.ok) return
    expect(check.capabilities).not.toContain('weather.daily.humidity')
    expect(check.capabilities).not.toContain('weather.daily.wind')
    expect((output.result as any).payload.days[0]).not.toHaveProperty('humidity_mean_pct')
  })

  it.each([401, 403])('maps HTTP %s to redacted authentication_required', async (status) => {
    const fetchImpl = (async () => new Response('secret response body', { status })) as typeof fetch
    const error = await openMeteoProvider.run(input, context(fetchImpl)).catch((caught) => caught)
    expect(error).toBeInstanceOf(SourceError)
    expect(error).toMatchObject({ code: 'authentication_required' })
    expect(error.message).not.toContain('secret response body')
  })

  it('honors Retry-After without exposing provider response data', async () => {
    const fetchImpl = (async () => new Response('account=private', {
      status: 429, headers: { 'retry-after': '120' },
    })) as typeof fetch
    const error = await openMeteoProvider.run(input, context(fetchImpl)).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'rate_limited', retryAt: NOW + 120_000 })
    expect(error.message).not.toContain('account=private')
  })

  it('omits retryAt when an extreme Retry-After value is outside the timestamp range', async () => {
    const fetchImpl = (async () => new Response('', {
      status: 429, headers: { 'retry-after': '9'.repeat(400) },
    })) as typeof fetch
    const error = await openMeteoProvider.run(input, context(fetchImpl)).catch((caught) => caught)

    expect(error).toMatchObject({ code: 'rate_limited' })
    expect(error).not.toHaveProperty('retryAt')
  })

  it('rejects non-JSON, oversized, and structurally malformed responses', async () => {
    for (const body of ['not json', 'x'.repeat(1024 * 1024 + 1), JSON.stringify({ current: {}, daily: {} })]) {
      const fetchImpl = (async () => new Response(body)) as typeof fetch
      await expect(openMeteoProvider.run(input, context(fetchImpl))).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })

  it('aborts a hung fetch after the ten-second provider deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch
      const promise = openMeteoProvider.run(input, context(fetchImpl))
      const rejected = expect(promise).rejects.toMatchObject({ code: 'unreachable' })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an already-aborted run without starting a provider fetch', async () => {
    const runner = new AbortController()
    runner.abort(new DOMException('Run cancelled', 'AbortError'))
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify(fixture()))
    }) as typeof fetch

    await expect(openMeteoProvider.run(input, context(fetchImpl, runner.signal)))
      .rejects.toMatchObject({ code: 'unreachable' })
    expect(calls).toBe(0)
  })

  it('rejects when the runner aborts a fetch already in progress', async () => {
    const runner = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const fetchImpl = (async (_request: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    }) as typeof fetch

    const pending = openMeteoProvider.run(input, context(fetchImpl, runner.signal))
    runner.abort(new DOMException('Run cancelled', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ code: 'unreachable' })
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('keeps the ten-second deadline active while a response body is still streaming', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (async (_request: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
        },
      }))) as typeof fetch
      const promise = openMeteoProvider.run(input, context(fetchImpl))
      const rejected = expect(promise).rejects.toMatchObject({ code: 'unreachable' })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  }, 500)
})

/**
 * Place lookup lives beside the provider whose coordinates it produces. It is not part of a
 * scheduled run — the guided setup form calls it while somebody is typing a city name — but it
 * talks to the same host with the same credentials-free request, so keeping it anywhere else would
 * mean a second Open-Meteo client to maintain.
 */
describe('Open-Meteo place lookup', () => {
  const RESULTS = {
    results: [
      { name: 'Lisbon', latitude: 38.71667, longitude: -9.13333, country: 'Portugal', admin1: 'Lisbon' },
      { name: 'Lisbon', latitude: 44.03684, longitude: -70.10312, country: 'United States', admin1: 'Maine' },
    ],
  }

  const stub = (body: unknown, status = 200) => {
    const calls: string[] = []
    const impl = (async (request: RequestInfo | URL) => {
      calls.push(String(request))
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { impl, calls }
  }

  it('returns the candidates an operator has to choose between', async () => {
    const { impl, calls } = stub(RESULTS)
    const found = await geocodePlaces('Lisbon', context(impl))

    const called = new URL(calls[0])
    expect(called.origin + called.pathname).toBe(OPEN_METEO_GEOCODE_URL)
    expect(found).toEqual([
      { name: 'Lisbon', country: 'Portugal', region: 'Lisbon', lat: 38.71667, lon: -9.13333 },
      { name: 'Lisbon', country: 'United States', region: 'Maine', lat: 44.03684, lon: -70.10312 },
    ])
  })

  /** "No such place" is an empty list, not an error — the form says so and stays open. */
  it('returns nothing for an unknown place', async () => {
    const { impl } = stub({})
    expect(await geocodePlaces('Nowhereville', context(impl))).toEqual([])
  })

  /**
   * A result missing coordinates is not a place anything can be pinned to, and the setup form would
   * happily submit `undefined` as a latitude if one got through.
   */
  it('drops a result that carries no usable coordinates', async () => {
    const { impl } = stub({ results: [{ name: 'Nowhere', country: 'Nowhereland' }, RESULTS.results[0]] })
    expect(await geocodePlaces('Lisbon', context(impl))).toEqual([
      { name: 'Lisbon', country: 'Portugal', region: 'Lisbon', lat: 38.71667, lon: -9.13333 },
    ])
  })

  /**
   * The lookup goes through the shared provider boundary, so an upstream failure arrives as a
   * SourceError carrying provider-SAFE wording. The route forwards that message to a browser; a
   * raw upstream body must never reach it.
   */
  it('reports an upstream failure without carrying its body along', async () => {
    const { impl } = stub('a login page that should never be forwarded', 503)
    await expect(geocodePlaces('Lisbon', context(impl))).rejects.toMatchObject({
      name: 'SourceError', code: 'unreachable',
    })
    await expect(geocodePlaces('Lisbon', context(impl))).rejects.toThrow(/HTTP 503/)
  })
})
