import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createFeed } from '../src/db/feeds.js'
import { createOutput, createSource } from '../src/db/sources.js'
import { WIDGET_REQUIREMENTS } from '../src/widgets/requirements.js'
import { EDITOR_WIDGET_IDS } from '../admin/src/layout-edit.ts'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'

const WIDGET_IDS = [
  'clock', 'alert_feed', 'calendar_events', 'value_tile', 'gauge', 'stream_list', 'table',
  'text_block', 'chart', 'image', 'weather_forecast', 'news_list',
] as const

const isDeepFrozen = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return true
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

describe('browser widget definitions', () => {
  it('represents every current widget exactly once and pins the editor type list', () => {
    const ids = WIDGET_DEFINITIONS.map((definition: { id: string }) => definition.id)
    expect(ids).toEqual(WIDGET_IDS)
    expect(new Set(ids).size).toBe(ids.length)
    expect(EDITOR_WIDGET_IDS).toEqual(WIDGET_IDS)
  })

  it('publishes complete, deeply frozen catalogue metadata', () => {
    expect(isDeepFrozen(WIDGET_DEFINITIONS)).toBe(true)
    for (const definition of WIDGET_DEFINITIONS) {
      expect(definition).toEqual(expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        description: expect.any(String),
        category: expect.any(String),
        advanced: expect.any(Boolean),
        suggested_ratio: expect.any(Number),
        minimum_px: { w: expect.any(Number), h: expect.any(Number) },
        sample_config: expect.any(Object),
      }))
      expect(Object.hasOwn(definition, 'sample_data')).toBe(true)
      expect(definition.label.length).toBeGreaterThan(0)
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.category.length).toBeGreaterThan(0)
      expect(definition.suggested_ratio).toBeGreaterThan(0)
      expect(definition.minimum_px.w).toBeGreaterThan(1)
      expect(definition.minimum_px.h).toBeGreaterThan(1)
    }
  })

  it('preserves the existing renderer sizing contract and adds truthful semantic sizes', () => {
    const sizing = Object.fromEntries(WIDGET_DEFINITIONS.map(({ id, suggested_ratio, minimum_px }: {
      id: string
      suggested_ratio: number
      minimum_px: { w: number; h: number }
    }) => [id, { suggested_ratio, minimum_px }]))
    expect(sizing).toEqual({
      clock: { suggested_ratio: 2, minimum_px: { w: 120, h: 60 } },
      alert_feed: { suggested_ratio: 3 / 4, minimum_px: { w: 160, h: 110 } },
      calendar_events: { suggested_ratio: 3 / 4, minimum_px: { w: 180, h: 130 } },
      value_tile: { suggested_ratio: 3 / 2, minimum_px: { w: 100, h: 70 } },
      gauge: { suggested_ratio: 2, minimum_px: { w: 120, h: 110 } },
      stream_list: { suggested_ratio: 3 / 4, minimum_px: { w: 160, h: 110 } },
      table: { suggested_ratio: 3 / 2, minimum_px: { w: 180, h: 110 } },
      text_block: { suggested_ratio: 3 / 2, minimum_px: { w: 80, h: 40 } },
      chart: { suggested_ratio: 16 / 9, minimum_px: { w: 160, h: 100 } },
      image: { suggested_ratio: 4 / 3, minimum_px: { w: 60, h: 60 } },
      weather_forecast: { suggested_ratio: 16 / 9, minimum_px: { w: 300, h: 140 } },
      news_list: { suggested_ratio: 3 / 4, minimum_px: { w: 180, h: 120 } },
    })
  })

  it('agrees exactly with the server semantic requirement registry', () => {
    const semantic = Object.fromEntries(WIDGET_DEFINITIONS
      .filter((definition: { consumes?: unknown }) => definition.consumes !== undefined)
      .map((definition: { id: string; consumes: unknown }) => [definition.id, definition.consumes]))
    expect(semantic).toEqual(WIDGET_REQUIREMENTS)
    expect(Object.keys(semantic).sort()).toEqual(['calendar_events', 'news_list', 'weather_forecast'])
  })
})

describe('widget definition sample configurations', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string
  let feedIds: Record<string, string>

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({
      config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any,
      db,
    })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string

    const value = createFeed(db, { name: 'sample value', mode: 'value' }, 1_000)
    const stream = createFeed(db, { name: 'sample stream', mode: 'stream' }, 1_000)
    const image = createFeed(db, { name: 'sample image', mode: 'image' }, 1_000)
    const weather = createFeed(db, { name: 'sample weather', mode: 'value' }, 1_000)
    const news = createFeed(db, { name: 'sample news', mode: 'stream' }, 1_000)
    const calendar = createFeed(db, { name: 'sample calendar', mode: 'value' }, 1_000)
    const source = createSource(db, {
      provider_id: 'sample', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Sample semantic data', config: {}, interval_s: 900,
    }, 1_000)
    createOutput(db, {
      source_id: source.id,
      contract_id: 'dashboardz.weather.daily-forecast/v1',
      feed_id: weather.id,
      capabilities: [...WIDGET_REQUIREMENTS.weather_forecast.required_capabilities],
    }, 1_000)
    createOutput(db, {
      source_id: source.id,
      contract_id: 'dashboardz.news.items/v1',
      feed_id: news.id,
      capabilities: [...WIDGET_REQUIREMENTS.news_list.required_capabilities],
    }, 1_000)
    createOutput(db, {
      source_id: source.id,
      contract_id: 'dashboardz.calendar.events/v1',
      feed_id: calendar.id,
      capabilities: [...WIDGET_REQUIREMENTS.calendar_events.required_capabilities],
    }, 1_000)
    feedIds = {
      value_tile: value.id, gauge: value.id, stream_list: stream.id, table: stream.id,
      chart: stream.id, image: image.id, weather_forecast: weather.id, news_list: news.id,
      calendar_events: calendar.id,
    }
  })

  it('has a sample config accepted by the real screen schema for every widget', async () => {
    for (const definition of WIDGET_DEFINITIONS) {
      const config = structuredClone(definition.sample_config) as Record<string, unknown>
      const feed = feedIds[definition.id]
      if (feed && definition.id === 'chart') {
        const series = config.series as Record<string, unknown>[]
        series[0] = { ...series[0], feed }
      } else if (feed) {
        config.feed = feed
      }
      const response = await app.inject({
        method: 'POST', url: '/admin/api/screens', headers: { cookie },
        payload: {
          name: `sample ${definition.id}`,
          orientation: 'landscape',
          grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: definition.id, config }] },
        },
      })
      expect(response.statusCode, `${definition.id}: ${response.body}`).toBe(200)
    }
  })
})
