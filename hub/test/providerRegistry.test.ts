import { describe, expect, it } from 'vitest'
import { CONTRACTS } from '../src/data/contracts.js'
import type { ProviderDefinition } from '../src/sources/provider.js'
import {
  BUILTIN_PROVIDERS, builtInProvider, validateProviderDefinitions,
} from '../src/sources/registry.js'

describe('built-in provider registry', () => {
  const changedRss = (patch: Record<string, unknown>): ProviderDefinition => ({
    ...builtInProvider('dashboardz.rss')!, ...patch,
  }) as ProviderDefinition

  it('publishes deterministic deeply immutable discovery metadata', () => {
    expect(BUILTIN_PROVIDERS.map((provider) => provider.id)).toEqual([
      'dashboardz.ical', 'dashboardz.open-meteo', 'dashboardz.rss',
    ])
    expect(Object.isFrozen(BUILTIN_PROVIDERS)).toBe(true)
    for (const provider of BUILTIN_PROVIDERS) {
      expect(Object.isFrozen(provider)).toBe(true)
      expect(Object.isFrozen(provider.potential_outputs)).toBe(true)
      expect(Object.isFrozen(provider.setup)).toBe(true)
    }
  })

  it('looks up own provider ids without accepting inherited object names', () => {
    expect(builtInProvider('dashboardz.rss')?.id).toBe('dashboardz.rss')
    expect(builtInProvider('toString')).toBeUndefined()
    expect(builtInProvider('__proto__')).toBeUndefined()
  })

  it('declares only known contracts and capabilities, with pollen truthfully unavailable', () => {
    expect(() => validateProviderDefinitions(BUILTIN_PROVIDERS)).not.toThrow()
    for (const provider of BUILTIN_PROVIDERS) {
      for (const output of provider.potential_outputs) {
        expect(Object.hasOwn(CONTRACTS, output.contract_id)).toBe(true)
      }
    }
    const forecast = builtInProvider('dashboardz.open-meteo')!.potential_outputs
      .find((output) => output.contract_id === 'dashboardz.weather.daily-forecast/v1')!
    expect(forecast.capabilities).not.toContain('weather.daily.pollen')
  })

  it('rejects a provider capability unknown to its semantic contract', () => {
    const rss = builtInProvider('dashboardz.rss')!
    const invalid = {
      ...rss,
      id: 'dashboardz.invalid',
      potential_outputs: [{
        contract_id: 'dashboardz.news.items/v1',
        capabilities: ['news.item.id', 'news.item.title', 'weather.daily.pollen'],
      }],
    } as ProviderDefinition

    expect(() => validateProviderDefinitions([invalid])).toThrow(/weather\.daily\.pollen.*dashboardz\.news\.items\/v1/)
  })

  it.each([
    ['weather current', 'dashboardz.weather.current/v1', ['attribution'], 'weather.current'],
    [
      'daily forecast',
      'dashboardz.weather.daily-forecast/v1',
      [
        'weather.daily.date', 'weather.daily.entries.5', 'weather.daily.temperature.high',
        'weather.daily.temperature.low',
      ],
      'weather.daily.condition',
    ],
    ['news items', 'dashboardz.news.items/v1', ['news.item.id'], 'news.item.title'],
  ] as const)('rejects %s outputs missing an unconditional capability', (_case, contract_id, capabilities, missing) => {
    const provider = changedRss({ potential_outputs: [{ contract_id, capabilities }] })

    expect(() => validateProviderDefinitions([provider])).toThrow(
      new RegExp(`required capability ${missing.replaceAll('.', '\\.')}`),
    )
  })

  it('rejects daily entry capabilities that omit their cumulative predecessor', () => {
    const provider = changedRss({
      potential_outputs: [{
        contract_id: 'dashboardz.weather.daily-forecast/v1',
        capabilities: [
          'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
          'weather.daily.entries.7', 'weather.daily.temperature.high',
          'weather.daily.temperature.low',
        ],
      }],
    })

    expect(() => validateProviderDefinitions([provider])).toThrow(
      /required capability weather\.daily\.entries\.6/,
    )
  })

  it.each([
    ['weather current', 'dashboardz.weather.current/v1', ['weather.current']],
    [
      'daily forecast',
      'dashboardz.weather.daily-forecast/v1',
      [
        'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
        'weather.daily.temperature.high', 'weather.daily.temperature.low',
      ],
    ],
    ['news items', 'dashboardz.news.items/v1', ['news.item.id', 'news.item.title']],
    ['calendar events', 'dashboardz.calendar.events/v1', ['calendar.event.all_day', 'calendar.event.times', 'calendar.event.title']],
    ['legacy value', 'dashboardz.legacy.value/v1', []],
    ['legacy stream', 'dashboardz.legacy.stream/v1', []],
    ['legacy image', 'dashboardz.legacy.image/v1', []],
  ] as const)('allows %s outputs to omit optional capabilities', (_case, contract_id, capabilities) => {
    const provider = changedRss({ potential_outputs: [{ contract_id, capabilities }] })

    expect(() => validateProviderDefinitions([provider])).not.toThrow()
  })

  /**
   * A calendar provider must promise a title, a start/end pair and an all-day flag — the contract
   * refuses any payload without them, so a provider that will not declare them cannot produce a
   * valid output and should be caught at boot rather than at the first poll. `location` stays
   * optional: most events in a real calendar have none.
   */
  it('rejects a calendar provider that will not promise the basics', () => {
    const provider = changedRss({
      potential_outputs: [{ contract_id: 'dashboardz.calendar.events/v1', capabilities: ['calendar.event.title'] }],
    })

    expect(() => validateProviderDefinitions([provider])).toThrow(/calendar/i)
  })

  it.each([
    ['empty', ''],
    ['prototype name', 'toString'],
    ['reserved segment', 'dashboardz.constructor'],
  ])('rejects %s provider ids', (_case, id) => {
    expect(() => validateProviderDefinitions([changedRss({ id })])).toThrow(/provider id/i)
  })

  it.each([
    ['package id', { package_id: 'third.party' }],
    ['package version', { package_version: '2.0.0' }],
    ['strategy', { strategy: 'manual' }],
    ['blank label', { label: ' ' }],
    ['blank category', { category: '' }],
    ['recommended flag', { recommended: 'yes' }],
  ])('rejects invalid core descriptor metadata: %s', (_case, patch) => {
    expect(() => validateProviderDefinitions([changedRss(patch)])).toThrow(/provider descriptor/i)
  })

  it.each([
    ['negative minimum', { min_interval_s: -1 }],
    ['default below minimum', { default_interval_s: 299, min_interval_s: 300 }],
    ['fractional default', { default_interval_s: 900.5 }],
  ])('rejects invalid provider intervals: %s', (_case, patch) => {
    expect(() => validateProviderDefinitions([changedRss(patch)])).toThrow(/interval/i)
  })

  it.each([
    ['no outputs', [], /output/i],
    ['duplicate capabilities', [{
      contract_id: 'dashboardz.news.items/v1',
      capabilities: ['news.item.id', 'news.item.id'],
    }], /capability/i],
  ])('rejects provider outputs with %s', (_case, potential_outputs, error) => {
    expect(() => validateProviderDefinitions([changedRss({ potential_outputs })])).toThrow(error)
  })

  it.each([
    ['duplicate names', () => {
      const rss = builtInProvider('dashboardz.rss')!
      return [rss.setup[0], rss.setup[0]]
    }],
    ['reserved names', () => [{ ...builtInProvider('dashboardz.rss')!.setup[0], name: '__proto__' }]],
    ['contradictory ranges', () => [{ ...builtInProvider('dashboardz.rss')!.setup[1], min: 100, max: 1 }]],
  ])('rejects setup fields with %s', (_case, setup) => {
    expect(() => validateProviderDefinitions([changedRss({ setup: setup() })])).toThrow(/setup field/i)
  })

  it('keeps URL credentials write-only in setup metadata', () => {
    for (const id of ['dashboardz.rss', 'dashboardz.ical']) {
      const provider = builtInProvider(id)!
      expect(provider.setup.find((field) => field.name === 'url')).toMatchObject({ secret: true, required: true })
      expect(JSON.stringify(provider)).not.toContain('news.example.test')
      expect(JSON.stringify(provider)).not.toContain('calendar.example.test')
    }
    expect(builtInProvider('dashboardz.open-meteo')!.setup.every((field) => !field.secret)).toBe(true)
  })
})
