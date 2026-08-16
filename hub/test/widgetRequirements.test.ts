import { describe, expect, it } from 'vitest'
import { compatibleOutput, WIDGET_REQUIREMENTS, widgetRequirement } from '../src/widgets/requirements.js'

const weatherRequired = [
  'weather.daily.condition',
  'weather.daily.date',
  'weather.daily.entries.5',
  'weather.daily.temperature.high',
  'weather.daily.temperature.low',
]

describe('semantic widget requirements', () => {
  it('publishes immutable requirements for the semantic widgets only', () => {
    expect(widgetRequirement('weather_forecast')).toEqual({
      contract_id: 'dashboardz.weather.daily-forecast/v1',
      required_capabilities: weatherRequired,
      optional_capabilities: [
        'attribution',
        'weather.current',
        'weather.daily.humidity',
        'weather.daily.pollen',
        'weather.daily.precipitation_probability',
        'weather.daily.wind',
      ],
    })
    expect(widgetRequirement('clock')).toBeUndefined()
    expect(widgetRequirement('toString')).toBeUndefined()
    expect(Object.isFrozen(WIDGET_REQUIREMENTS)).toBe(true)
    expect(Object.isFrozen(WIDGET_REQUIREMENTS.weather_forecast)).toBe(true)
  })

  it('never treats a shared discovery category as compatibility', () => {
    expect(compatibleOutput('weather_forecast', 'dashboardz.weather.current/v1', weatherRequired)).toEqual({
      ok: false,
      error: 'weather_forecast requires dashboardz.weather.daily-forecast/v1',
    })
  })

  it('accepts a five-day forecast without optional pollen', () => {
    expect(compatibleOutput('weather_forecast', 'dashboardz.weather.daily-forecast/v1', weatherRequired)).toEqual({
      ok: true,
      missing_optional: [
        'attribution',
        'weather.current',
        'weather.daily.humidity',
        'weather.daily.pollen',
        'weather.daily.precipitation_probability',
        'weather.daily.wind',
      ],
    })
  })

  it('rejects an output with only four daily entries', () => {
    expect(compatibleOutput('weather_forecast', 'dashboardz.weather.daily-forecast/v1', weatherRequired.filter((capability) => capability !== 'weather.daily.entries.5')))
      .toEqual({ ok: false, error: 'weather_forecast is missing weather.daily.entries.5' })
  })

  it('requires a matching daily entry capability for the configured display length', () => {
    expect(compatibleOutput('weather_forecast', 'dashboardz.weather.daily-forecast/v1', weatherRequired, { days: 7 }))
      .toEqual({ ok: false, error: 'weather_forecast is missing weather.daily.entries.7' })
    expect(compatibleOutput('weather_forecast', 'dashboardz.weather.daily-forecast/v1', [...weatherRequired, 'weather.daily.entries.6', 'weather.daily.entries.7'], { days: 7 }))
      .toMatchObject({ ok: true })
  })

  it('matches RSS-shaped news only through the news contract and its required capabilities', () => {
    expect(compatibleOutput('news_list', 'dashboardz.news.items/v1', ['news.item.title', 'news.item.id']))
      .toMatchObject({ ok: true })
    expect(compatibleOutput('news_list', 'dashboardz.legacy.stream/v1', ['news.item.id', 'news.item.title']))
      .toEqual({ ok: false, error: 'news_list requires dashboardz.news.items/v1' })
  })

  it('never matches legacy contracts to semantic widgets', () => {
    for (const contractId of ['dashboardz.legacy.value/v1', 'dashboardz.legacy.stream/v1', 'dashboardz.legacy.image/v1']) {
      expect(compatibleOutput('weather_forecast', contractId, weatherRequired)).toMatchObject({ ok: false })
      expect(compatibleOutput('news_list', contractId, ['news.item.id', 'news.item.title'])).toMatchObject({ ok: false })
    }
  })
})
