import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createAgentToken } from '../src/db/agents.js'

/**
 * GET /admin/api/feed-fit for the semantic widgets (weather_forecast, news_list,
 * calendar_events). Semantic feed contracts give feeds a source-output-backed binding rule
 * (validatePersistentBinding in screens/save.ts); this endpoint must answer fit/unfit the
 * SAME way, via the SAME outputForFeed + compatibleOutput, so the picker never shows a feed
 * as fit that a save would refuse.
 */
describe('GET /admin/api/feed-fit for semantic widgets', () => {
  const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
  let app: FastifyInstance, db: ReturnType<typeof openDb>

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config, db })
  })

  it('feed-fit reports semantic unfitness the way the save path enforces it', async () => {
    const now = Date.now()
    const mkFeed = (id: string, name: string) => db.prepare(
      "INSERT INTO feeds (id, name, mode, created_at) VALUES (?, ?, 'value', ?)").run(id, name, now)
    const mkSource = (id: string) => db.prepare(
      `INSERT INTO source_instances (id, provider_id, package_id, package_version, name, config,
         interval_s, created_at, updated_at) VALUES (?, 'p', 'pkg', '1', ?, '{}', 600, ?, ?)`)
      .run(id, id, now, now)
    const mkOutput = (id: string, sourceId: string, feedId: string, contractId: string, capabilities: string[]) =>
      db.prepare(`INSERT INTO source_outputs (id, source_id, contract_id, feed_id, capabilities, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, sourceId, contractId, feedId, JSON.stringify(capabilities), now)

    mkFeed('feed_plain', 'plain')                       // no source output at all
    mkFeed('feed_news', 'newsy'); mkSource('src_news')
    mkOutput('out_news', 'src_news', 'feed_news', 'dashboardz.news.items/v1', ['news.item.id', 'news.item.title'])
    mkFeed('feed_weather', 'weathery'); mkSource('src_w')
    mkOutput('out_w', 'src_w', 'feed_weather', 'dashboardz.weather.daily-forecast/v1',
      ['weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
       'weather.daily.temperature.high', 'weather.daily.temperature.low'])

    const { token } = createAgentToken(db, 'fitter')
    const res = await app.inject({
      url: '/admin/api/feed-fit?widget=weather_forecast&config=%7B%7D',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const unfitIds = Object.fromEntries(res.json().unfit.map((u: { id: string; why: string }) => [u.id, u.why]))
    expect(unfitIds['feed_weather']).toBeUndefined()                       // right contract + caps: fit
    expect(unfitIds['feed_plain']).toMatch(/semantic source output/)       // save.ts's exact rule
    expect(unfitIds['feed_news']).toMatch(/requires dashboardz\.weather/)  // compatibleOutput's error
  })
})
