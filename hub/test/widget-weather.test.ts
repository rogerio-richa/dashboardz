import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module without types
import forecast, { forecastTier, formatIsoDate, normalizeForecast } from '../static/device/widgets/weather/forecast.mjs'
// @ts-expect-error plain JS module without types
import { conditionLabel, conditionVisual, drawCondition } from '../static/device/widgets/weather/weather-code.mjs'
// @ts-expect-error plain JS module without types
import { designIdsFor } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error executable demo script exposes pure fixture builders for contract checks
import { FORECAST_DEMO_SETUP, forecastDemoScreen } from '../scripts/demo-data.mjs'

const DAYS = [
  { date: '2026-08-05', high: 24, low: 14, condition: { code: 'clear', label: 'Clear' }, humidity_mean_pct: 55, precipitation_probability_pct: 0, wind_speed_max: 12, pollen: { level: 'low', index: 2, scale: '0-5', dominant: 'Grass' } },
  { date: '2026-08-06', high: 23, low: 15, condition: { code: 'mostly_clear', label: 'Mostly clear' }, humidity_mean_pct: 59, precipitation_probability_pct: 10, wind_speed_max: 14, pollen: { level: 'moderate' } },
  { date: '2026-08-07', high: 21, low: 14, condition: { code: 'partly_cloudy', label: 'Partly cloudy' }, humidity_mean_pct: 68, precipitation_probability_pct: 65, wind_speed_max: 18, pollen: { level: 'high' } },
  { date: '2026-08-08', high: 20, low: 13, condition: { code: 'cloudy', label: 'Cloudy' }, humidity_mean_pct: 72, precipitation_probability_pct: 30, wind_speed_max: 20, pollen: { level: 'very_high' } },
  { date: '2026-08-09', high: 22, low: 14, condition: { code: 'fog', label: 'Fog' }, humidity_mean_pct: 75, precipitation_probability_pct: 20, wind_speed_max: 9, pollen: { level: 'unknown' } },
  { date: '2026-08-10', high: 19, low: 12, condition: { code: 'rain', label: 'Rain' }, humidity_mean_pct: 84, precipitation_probability_pct: 85, wind_speed_max: 23 },
  { date: '2026-08-11', high: 18, low: 10, condition: { code: 'thunderstorm', label: 'Thunderstorm' }, humidity_mean_pct: 88, precipitation_probability_pct: 90, wind_speed_max: 28 },
]

const payload = (overrides: Record<string, unknown> = {}) => ({
  location: { name: 'Sao Paulo', timezone: 'America/Sao_Paulo' },
  units: { temperature: 'C', wind_speed: 'km/h' },
  days: DAYS,
  attribution: { label: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
  ...overrides,
})

type Call = {
  op: string
  args: unknown[]
  font: string
  fillStyle: string
  strokeStyle: string
  textAlign: string
  textBaseline: string
}

function recorder() {
  const calls: Call[] = []
  let measurementCount = 0
  const g = {
    font: '', fillStyle: '', strokeStyle: '', textAlign: '', textBaseline: '',
    lineWidth: 1, lineCap: '', globalAlpha: 1,
    beginPath: () => calls.push(call('beginPath')),
    closePath: () => calls.push(call('closePath')),
    fill: () => calls.push(call('fill')),
    stroke: () => calls.push(call('stroke')),
    save: () => calls.push(call('save')),
    restore: () => calls.push(call('restore')),
    arc: (...args: unknown[]) => calls.push(call('arc', args)),
    rect: (...args: unknown[]) => calls.push(call('rect', args)),
    moveTo: (...args: unknown[]) => calls.push(call('moveTo', args)),
    lineTo: (...args: unknown[]) => calls.push(call('lineTo', args)),
    translate: (...args: unknown[]) => calls.push(call('translate', args)),
    rotate: (...args: unknown[]) => calls.push(call('rotate', args)),
    scale: (...args: unknown[]) => calls.push(call('scale', args)),
    fillText: (...args: unknown[]) => calls.push(call('fillText', args)),
    measureText: (text: string) => {
      measurementCount++
      const px = Number(g.font.match(/([\d.]+)px/)?.[1] ?? 10)
      return { width: text.length * px * 0.56 }
    },
  }
  function call(op: string, args: unknown[] = []): Call {
    return {
      op, args, font: g.font, fillStyle: g.fillStyle, strokeStyle: g.strokeStyle,
      textAlign: g.textAlign, textBaseline: g.textBaseline,
    }
  }
  return {
    g,
    calls,
    texts: () => calls.filter((entry) => entry.op === 'fillText').map((entry) => String(entry.args[0])),
    textCalls: () => calls.filter((entry) => entry.op === 'fillText'),
    measurementCount: () => measurementCount,
  }
}

type Bounds = { left: number; top: number; right: number; bottom: number }

const callFontPx = (entry: Call) => Number(entry.font.match(/([\d.]+)px/)?.[1] ?? 0)

function textBounds(entry: Call): Bounds {
  const text = String(entry.args[0])
  const x = Number(entry.args[1])
  const y = Number(entry.args[2])
  const height = callFontPx(entry)
  const width = text.length * height * 0.56
  const left = entry.textAlign === 'right' ? x - width : entry.textAlign === 'center' ? x - width / 2 : x
  const top = entry.textBaseline === 'bottom' ? y - height : entry.textBaseline === 'middle' ? y - height / 2 : y
  return { left, top, right: left + width, bottom: top + height }
}

function geometryBounds(entry: Call): Bounds | null {
  if (entry.op === 'arc') {
    const [x, y, radius] = entry.args.map(Number)
    return { left: x - radius, top: y - radius, right: x + radius, bottom: y + radius }
  }
  if (entry.op === 'rect') {
    const [x, y, width, height] = entry.args.map(Number)
    return { left: x, top: y, right: x + width, bottom: y + height }
  }
  if (entry.op === 'moveTo' || entry.op === 'lineTo') {
    const [x, y] = entry.args.map(Number)
    return { left: x, top: y, right: x, bottom: y }
  }
  return null
}

function expectInside(bounds: Bounds, box: { w: number; h: number }) {
  expect(bounds.left).toBeGreaterThanOrEqual(-0.001)
  expect(bounds.top).toBeGreaterThanOrEqual(-0.001)
  expect(bounds.right).toBeLessThanOrEqual(box.w + 0.001)
  expect(bounds.bottom).toBeLessThanOrEqual(box.h + 0.001)
}

function expectSeparated(entries: Call[]) {
  const ordered = entries.map(textBounds).sort((left, right) => left.top - right.top)
  for (let index = 1; index < ordered.length; index++) {
    expect(ordered[index - 1].bottom).toBeLessThanOrEqual(ordered[index].top + 0.001)
  }
}

function expectWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      expect(value.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xDC00)
      expect(value.charCodeAt(index + 1)).toBeLessThanOrEqual(0xDFFF)
      index++
    } else {
      expect(unit < 0xDC00 || unit > 0xDFFF).toBe(true)
    }
  }
}

const ctx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#111111', dim: '#666666' },
  config: { days: 5, show_precipitation: true },
  data: payload(),
  box: { w: 900, h: 320, t: 1 },
  now: Date.UTC(2026, 7, 5, 12),
  state: {},
  motion: 'full',
  ...overrides,
})

describe('forecast data normalization', () => {
  it('defaults to five days and clips an explicit seven-day request deterministically', () => {
    expect(normalizeForecast(payload(), {}).days).toHaveLength(5)
    expect(normalizeForecast(payload(), { days: 7 }).days.map((day: { date: string }) => day.date))
      .toEqual(DAYS.map((day) => day.date))
    expect(normalizeForecast(payload(), { days: 6 }).days).toHaveLength(6)
    expect(normalizeForecast(payload(), { days: 4 }).days).toHaveLength(5)
    expect(normalizeForecast(payload(), { days: 7.5 }).days).toHaveLength(5)
  })

  it('formats the source-local ISO calendar date without hub-timezone arithmetic', () => {
    expect(formatIsoDate('2026-08-05')).toEqual({ weekday: 'Wed', day: '5' })
    expect(formatIsoDate('2026-01-01')).toEqual({ weekday: 'Thu', day: '1' })
    expect(formatIsoDate('2026-02-30')).toBeNull()
  })

  it('includes requested optional details only when that day owns valid data', () => {
    const sparse = payload({ days: DAYS.map((day, index) => index === 0 ? {
      date: day.date, high: day.high, low: day.low, condition: day.condition,
      precipitation_probability_pct: 0,
    } : day) })
    const normalized = normalizeForecast(sparse, {
      days: 5, show_humidity: true, show_precipitation: true, show_wind: true, show_pollen: true,
    })
    expect(normalized.days[0].details).toEqual(['Rain 0%'])
    expect(normalized.days[1].details).toEqual(['Humidity 59%', 'Rain 10%', 'Wind 14 km/h', 'Pollen moderate'])
    expect(normalized.days[4].details).not.toContain('Pollen unknown')
    expect(normalized.days.flatMap((day: { details: string[] }) => day.details).join(' ')).not.toMatch(/N\/A|undefined|null/)
  })

  it('does not invent optional zeroes or pollen when fields are absent', () => {
    const bareDays = DAYS.map(({ date, high, low, condition }) => ({ date, high, low, condition }))
    const normalized = normalizeForecast(payload({ days: bareDays }), {
      show_humidity: true, show_precipitation: true, show_wind: true, show_pollen: true,
    })
    expect(normalized.days.every((day: { details: string[] }) => day.details.length === 0)).toBe(true)
  })

  it('omits wind when its unit is malformed instead of drawing a unitless fake detail', () => {
    const normalized = normalizeForecast(payload({ units: { temperature: 'C' } }), { show_wind: true })
    expect(normalized.days.every((day: { details: string[] }) => day.details.every((line) => !line.startsWith('Wind ')))).toBe(true)
  })

  it('uses local canonical condition copy rather than provider-controlled glyph text', () => {
    const strange = payload({ days: DAYS.map((day) => ({
      ...day, condition: { ...day.condition, label: '🌞 remote glyph' },
    })) })
    expect(normalizeForecast(strange, {}).days[0].conditionLabel).toBe('Clear')
  })

  it('drops malformed days and degrades to unavailable when fewer than five valid days remain', () => {
    const withOneInvalid = payload({ days: DAYS.map((day, index) => index === 2 ? { ...day, high: null } : day) })
    expect(normalizeForecast(withOneInvalid, { days: 7 }).days).toHaveLength(6)
    const tooShort = payload({ days: DAYS.slice(0, 5).map((day, index) => index === 2 ? { ...day, date: 'not-a-date' } : day) })
    expect(normalizeForecast(tooShort, {}).available).toBe(false)
  })

  it('is total for null and malformed provider-owned values', () => {
    for (const data of [null, undefined, 7, [], {}, { days: null }, { days: [null, {}, { high: Infinity }] }]) {
      expect(() => normalizeForecast(data, null)).not.toThrow()
      expect(normalizeForecast(data, null).available).toBe(false)
    }
  })

  it.each([
    {
      size: 100,
      kind: 'ASCII',
      input: `ASCII${'x'.repeat(95)}`,
      expected: `ASCII${'x'.repeat(95)}`,
    },
    {
      size: 1_000,
      kind: 'astral',
      input: `Astral ${'😀'.repeat(993)}`,
      expected: `Astral ${'😀'.repeat(505)}...`,
    },
    {
      size: 10_000,
      kind: 'mixed',
      input: `Mix ${'a😀'.repeat(4_998)}`,
      expected: `Mix ${'a😀'.repeat(254)}...`,
    },
    {
      size: 50_000,
      kind: 'trailing whitespace',
      input: `Trailing${' '.repeat(49_992)}`,
      expected: 'Trailing...',
    },
  ])('caps $size-code-point $kind display input before trimming or copying the full value', ({ input, expected }) => {
    const iteratorRuns: Array<{ codeUnits: number; traversed: number }> = []
    const trimInputs: number[] = []
    const originalIterator = String.prototype[Symbol.iterator]
    const originalTrim = String.prototype.trim
    const iteratorSpy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
      const iterator = originalIterator.call(this)
      const run = { codeUnits: this.length, traversed: 0 }
      iteratorRuns.push(run)
      return {
        next() {
          const result = iterator.next()
          if (!result.done) run.traversed++
          return result
        },
        [Symbol.iterator]() { return this },
        // A real StringIterator is disposable; the stub only needs to say so — for-of never
        // calls it, and the traversal counters above are what this test reads.
        [Symbol.dispose]() {},
      }
    })
    const trimSpy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      trimInputs.push(this.length)
      return originalTrim.call(this)
    })
    let location = ''
    try {
      location = normalizeForecast(payload({ location: { name: input } }), {}).location
    } finally {
      trimSpy.mockRestore()
      iteratorSpy.mockRestore()
    }

    expect(location).toBe(expected)
    expectWellFormedUtf16(location)
    const rawIteration = iteratorRuns.find((run) => run.codeUnits === input.length)
    expect(rawIteration).toBeDefined()
    expect(rawIteration!.traversed).toBeLessThanOrEqual(513)
    expect(Math.max(...trimInputs)).toBeLessThanOrEqual(1_024)
  })

  it('reads only own data properties and never invokes own or inherited accessors', () => {
    let invoked = 0
    const ownGetter = Object.defineProperty({}, 'days', {
      enumerable: true,
      get() { invoked++; throw new Error('own getter ran') },
    })
    const inheritedGetter = Object.create(Object.defineProperty({}, 'days', {
      get() { invoked++; throw new Error('inherited getter ran') },
    }))
    const inheritedValues = Object.create(payload())
    const inheritedConfig = Object.create({ days: 7, scale: 2, show_humidity: true })

    for (const [data, config] of [
      [ownGetter, {}], [inheritedGetter, {}], [inheritedValues, {}], [payload(), inheritedConfig],
    ]) {
      expect(() => normalizeForecast(data, config)).not.toThrow()
      expect(() => forecast.draw(recorder().g, ctx({ data, config }), 0)).not.toThrow()
    }
    expect(invoked).toBe(0)
    expect(normalizeForecast(inheritedValues, {}).available).toBe(false)
    expect(normalizeForecast(payload(), inheritedConfig).days).toHaveLength(5)
    expect(normalizeForecast(payload(), inheritedConfig).scale).toBe(1)
  })

  it('degrades reflection failures in hostile proxies and nested records without throwing', () => {
    const hostile = () => new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('reflection blocked') },
      get() { throw new Error('property read') },
    })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const cases: Array<{ data: unknown; config?: unknown }> = [
      { data: hostile() },
      { data: revoked.proxy },
      { data: payload(), config: hostile() },
      { data: payload({ location: hostile() }) },
      { data: payload({ units: hostile() }) },
      { data: payload({ attribution: hostile() }) },
      { data: payload({ days: [hostile(), ...DAYS.slice(1)] }) },
      { data: payload({ days: DAYS.map((day, index) => index === 0 ? { ...day, condition: hostile() } : day) }) },
      { data: payload({ days: DAYS.map((day, index) => index === 0 ? { ...day, pollen: hostile() } : day) }) },
      { data: payload({ days: new Proxy([...DAYS], {
        getOwnPropertyDescriptor() { throw new Error('array reflection blocked') },
        get() { throw new Error('array property read') },
      }) }) },
    ]
    for (const candidate of cases) {
      expect(() => normalizeForecast(candidate.data, candidate.config)).not.toThrow()
      expect(() => forecast.draw(recorder().g, ctx({ data: candidate.data, config: candidate.config }), 0)).not.toThrow()
    }
  })
})

describe('portable weather condition visuals', () => {
  it('maps every canonical condition to local geometry with a stable unknown fallback', () => {
    expect([
      'clear', 'mostly_clear', 'partly_cloudy', 'cloudy', 'fog', 'drizzle',
      'rain', 'snow', 'showers', 'thunderstorm', 'unknown', 'future_code', null,
    ].map(conditionVisual)).toEqual([
      'sun', 'partly-cloudy', 'partly-cloudy', 'cloud', 'fog', 'rain',
      'rain', 'snow', 'rain', 'storm', 'unknown', 'unknown', 'unknown',
    ])
  })

  it('draws conditions with portable geometry and ASCII fallback text, never emoji glyphs', () => {
    for (const code of ['clear', 'partly_cloudy', 'cloudy', 'fog', 'rain', 'snow', 'thunderstorm', 'unknown']) {
      const r = recorder()
      expect(() => drawCondition(r.g, code, 50, 50, 24, '#111111', '#666666')).not.toThrow()
      expect(r.calls.length).toBeGreaterThan(0)
      expect(r.texts().join('')).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
    }
  })
})

describe('forecast canvas design', () => {
  it('registers one portable forecast design and declares only the tokens it reads', () => {
    expect(forecast.meta).toMatchObject({ id: 'forecast', widget: 'weather_forecast' })
    expect(designIdsFor('weather_forecast')).toEqual(['forecast'])
    expect(Object.keys(forecast.meta.tokens).sort()).toEqual(['dim', 'ink'])
    expect(forecast.meta.assets).toBeUndefined()
  })

  it('chooses full and compact tiers from box dimensions and day count', () => {
    expect(forecastTier({ w: 900, h: 320 }, 5)).toBe('full')
    expect(forecastTier({ w: 320, h: 140 }, 5)).toBe('compact')
    expect(forecastTier({ w: 520, h: 180 }, 7)).toBe('compact')
  })

  it('draws full labels and requested details but omits secondary content in compact boxes', () => {
    const full = recorder()
    forecast.draw(full.g, ctx({ config: { days: 5, show_humidity: true, show_precipitation: true } }), 0)
    expect(full.texts()).toContain('Clear')
    expect(full.texts()).toContain('Humidity 55%')
    expect(full.texts()).toContain('Rain 0%')

    const compact = recorder()
    forecast.draw(compact.g, ctx({ box: { w: 320, h: 140, t: 0.3 }, config: { days: 5, show_humidity: true, show_precipitation: true } }), 0)
    expect(compact.texts()).not.toContain('Clear')
    expect(compact.texts()).not.toContain('Humidity 55%')
    expect(compact.texts()).not.toContain('Rain 0%')
    expect(compact.texts()).toContain('Wed 5')
    expect(compact.texts().some((text) => text.includes('24'))).toBe(true)
  })

  it.each([0.5, 1, 2])('keeps every required value bounded at 300x140 with seven days and scale %s', (scale) => {
    const box = { w: 300, h: 140, t: 0.3 }
    const r = recorder()
    forecast.draw(r.g, ctx({ box, config: { days: 7, scale }, data: payload() }), 0)

    const expectedColumns = DAYS.flatMap((day) => {
      const date = formatIsoDate(day.date)!
      return [`${date.weekday} ${date.day}`, `H ${day.high}°`, `L ${day.low}°C`]
    })
    expect(r.texts()).toEqual([...expectedColumns, 'Open-Meteo.com'])
    expect(r.texts().some((value) => value.includes('...'))).toBe(false)

    const columnCalls = r.textCalls().filter((entry) => entry.args[0] !== 'Open-Meteo.com')
    expect(columnCalls).toHaveLength(21)
    for (let index = 0; index < 7; index++) expectSeparated(columnCalls.slice(index * 3, index * 3 + 3))
    for (const entry of r.textCalls()) expectInside(textBounds(entry), box)
    for (const entry of r.calls) {
      const bounds = geometryBounds(entry)
      if (bounds) expectInside(bounds, box)
    }
  })

  it.each([
    { box: { w: 602, h: 220, t: 0.6 }, details: 'short' },
    { box: { w: 900, h: 320, t: 1 }, details: 'long' },
  ])('pre-fits the complete scale-2 full stack at $box.w x $box.h', ({ box, details }) => {
    const allDays = DAYS.map((day) => ({
      ...day,
      pollen: day.pollen?.level && day.pollen.level !== 'unknown' ? day.pollen : { level: 'moderate' },
    }))
    const r = recorder()
    forecast.draw(r.g, ctx({
      box,
      data: payload({ days: allDays }),
      config: {
        days: 7, scale: 2, show_humidity: true, show_precipitation: true,
        show_wind: true, show_pollen: true,
      },
    }), 0)

    const footer = r.textCalls().find((entry) => entry.args[0] === 'Weather data by Open-Meteo.com')
    expect(footer).toBeDefined()
    const footerTop = textBounds(footer!).top
    const expectedPerDay = allDays.flatMap((day) => {
      const date = formatIsoDate(day.date)!
      const pollen = String(day.pollen.level).replace('_', ' ')
      const long = [
        date.weekday, date.day, conditionLabel(day.condition.code),
        `${day.high}/${day.low}°C`, `Humidity ${day.humidity_mean_pct}%`,
        `Rain ${day.precipitation_probability_pct}%`, `Wind ${day.wind_speed_max} km/h`, `Pollen ${pollen}`,
      ]
      return details === 'short' ? [
        date.weekday, date.day, conditionLabel(day.condition.code),
        `${day.high}/${day.low}°C`, `Hum ${day.humidity_mean_pct}%`,
        `Rain ${day.precipitation_probability_pct}%`, `Wind ${day.wind_speed_max}km/h`,
        `Pollen ${pollen === 'moderate' ? 'mod.' : pollen === 'very high' ? 'v.high' : pollen}`,
      ] : long
    })
    expect(r.texts()).toEqual(['Sao Paulo', ...expectedPerDay, 'Weather data by Open-Meteo.com'])
    expect(r.texts().some((value) => value.includes('...'))).toBe(false)

    for (const entry of r.textCalls()) {
      const bounds = textBounds(entry)
      expectInside(bounds, box)
      if (entry !== footer) expect(bounds.bottom).toBeLessThanOrEqual(footerTop + 0.001)
    }
    for (const entry of r.calls) {
      const bounds = geometryBounds(entry)
      if (!bounds) continue
      expectInside(bounds, box)
      expect(bounds.bottom).toBeLessThanOrEqual(footerTop + 0.001)
    }

    const bodyCalls = r.textCalls().slice(1, -1)
    expect(bodyCalls).toHaveLength(7 * 8)
    for (let index = 0; index < 7; index++) expectSeparated(bodyCalls.slice(index * 8, index * 8 + 8))
  })

  it('bounds fitting work and truncates a very long location deterministically at code-point boundaries', () => {
    const box = { w: 900, h: 320, t: 1 }
    const longName = `Long place ${'😀'.repeat(5_000)} end`
    const render = (name: string) => {
      const r = recorder()
      forecast.draw(r.g, ctx({ box, data: payload({ location: { name } }) }), 0)
      return r
    }
    const baseline = render('Long place')
    const first = render(longName)
    const second = render(longName)
    const displayed = first.texts()[0]

    expect(displayed).toBe(second.texts()[0])
    expect(displayed).toMatch(/^Long place .+\.\.\.$/u)
    expectWellFormedUtf16(displayed)
    expectInside(textBounds(first.textCalls()[0]), box)
    expect(first.measurementCount() - baseline.measurementCount()).toBeLessThanOrEqual(32)
    expect(second.measurementCount() - baseline.measurementCount()).toBeLessThanOrEqual(32)
  })

  it('bounds compact attribution fitting after prefix removal without malformed Unicode or footer overflow', () => {
    const box = { w: 320, h: 140, t: 0.3 }
    const longLabel = `Weather data by Source ${'😀'.repeat(5_000)} end`
    const render = (label: string) => {
      const r = recorder()
      forecast.draw(r.g, ctx({ box, data: payload({ attribution: { label } }) }), 0)
      return r
    }
    const baseline = render('Weather data by Source')
    const first = render(longLabel)
    const second = render(longLabel)
    const displayed = first.texts().at(-1)!

    expect(displayed).toBe(second.texts().at(-1))
    expect(displayed).toMatch(/^Source .+\.\.\.$/u)
    expect(displayed).not.toContain('Weather data by')
    expectWellFormedUtf16(displayed)
    expectInside(textBounds(first.textCalls().at(-1)!), box)
    expect(first.measurementCount() - baseline.measurementCount()).toBeLessThanOrEqual(32)
    expect(second.measurementCount() - baseline.measurementCount()).toBeLessThanOrEqual(32)
  })

  it('keeps readable attribution in full, compact, and unavailable tiers', () => {
    const full = recorder()
    forecast.draw(full.g, ctx(), 0)
    expect(full.texts()).toContain('Weather data by Open-Meteo.com')

    const compact = recorder()
    forecast.draw(compact.g, ctx({ box: { w: 320, h: 140, t: 0.3 } }), 0)
    expect(compact.texts()).toContain('Open-Meteo.com')
    const compactFooter = compact.textCalls().find((entry) => entry.args[0] === 'Open-Meteo.com')!
    expect(Number(compactFooter.font.match(/([\d.]+)px/)?.[1])).toBeGreaterThanOrEqual(10)

    const unavailable = recorder()
    forecast.draw(unavailable.g, ctx({ data: payload({ days: [] }) }), 0)
    expect(unavailable.texts()).toContain('Forecast unavailable')
    expect(unavailable.texts()).toContain('Weather data by Open-Meteo.com')

    const compactUnavailable = recorder()
    forecast.draw(compactUnavailable.g, ctx({
      box: { w: 320, h: 140, t: 0.3 }, data: payload({ days: [] }),
    }), 0)
    expect(compactUnavailable.texts()).toContain('Forecast unavailable')
    expect(compactUnavailable.texts()).toContain('Open-Meteo.com')
  })

  it('draws attribution through the declared dim token so themes remain authoritative', () => {
    const r = recorder()
    forecast.draw(r.g, ctx({ tokens: { ink: '#123456', dim: '#abcdef' } }), 0)
    const footer = r.textCalls().find((entry) => entry.args[0] === 'Weather data by Open-Meteo.com')
    expect(footer?.fillStyle).toBe('#abcdef')
  })

  it('draws a calm provider-neutral unavailable state for null or insufficient data', () => {
    for (const data of [null, payload({ days: DAYS.slice(0, 4) })]) {
      const r = recorder()
      expect(() => forecast.draw(r.g, ctx({ data }), 0)).not.toThrow()
      expect(r.texts()).toContain('Forecast unavailable')
      expect(r.texts()).toContain('Weather data will appear here')
    }
  })

  it('uses continuous box-aware type and honors the responsive scale knob within readable floors', () => {
    const small = recorder()
    forecast.draw(small.g, ctx({ box: { w: 700, h: 260, t: 0.7 }, config: { days: 5, scale: 1 } }), 0)
    const large = recorder()
    forecast.draw(large.g, ctx({ box: { w: 1000, h: 400, t: 1 }, config: { days: 5, scale: 1 } }), 0)
    const scaled = recorder()
    forecast.draw(scaled.g, ctx({ box: { w: 1000, h: 400, t: 1 }, config: { days: 5, scale: 1.5 } }), 0)
    const fontPx = (r: ReturnType<typeof recorder>, text: string) =>
      Number(r.textCalls().find((entry) => entry.args[0] === text)!.font.match(/([\d.]+)px/)?.[1])
    expect(fontPx(large, 'Sao Paulo')).toBeGreaterThan(fontPx(small, 'Sao Paulo'))
    expect(fontPx(scaled, 'Sao Paulo')).toBeGreaterThan(fontPx(large, 'Sao Paulo'))
    expect(Math.min(...scaled.textCalls().map((entry) => Number(entry.font.match(/([\d.]+)px/)?.[1])))).toBeGreaterThanOrEqual(10)
  })

  it('is deterministic and does not throw for collapsed boxes', () => {
    const a = recorder()
    const b = recorder()
    forecast.draw(a.g, ctx(), 123)
    forecast.draw(b.g, ctx(), 9_999)
    expect(a.calls).toEqual(b.calls)

    for (const box of [{ w: 0, h: 100, t: 0 }, { w: 100, h: 0, t: 0 }, { w: -1, h: 20, t: 0 }]) {
      const r = recorder()
      expect(() => forecast.draw(r.g, ctx({ box }), 0)).not.toThrow()
      expect(r.calls).toHaveLength(0)
    }
  })
})

describe('forecast demo fixture', () => {
  it('uses the built-in semantic provider and binds a truthful seven-day screen', () => {
    expect(FORECAST_DEMO_SETUP).toEqual({
      provider_id: 'dashboardz.open-meteo',
      name: 'Demo weather - Sao Paulo',
      config: { city: 'Sao Paulo', lat: -23.55, lon: -46.63, units: 'metric' },
      secrets: {},
    })
    expect(forecastDemoScreen('feed_daily')).toEqual({ cells: [{
      rect: { x: 0, y: 0, w: 1, h: 1 },
      widget: 'weather_forecast',
      config: {
        feed: 'feed_daily', days: 7, show_humidity: true, show_precipitation: true,
        show_wind: true, show_pollen: true, scale: 1, design: 'forecast',
      },
    }] })
  })
})
