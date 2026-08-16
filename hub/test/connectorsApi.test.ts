import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createSecretBox } from '../src/secrets/box.js'
import { inject } from './support/inject.js'

/**
 * The v18 connector admin surface is retired (data-source behavior).
 *
 * The retired `/admin/api/connectors` and `/admin/api/connector-types` routes are absent: data
 * sources are created and repaired by the
 * v19 source endpoints in `routes/sourceAdmin.ts`, which test a provider against real data before
 * anything is written and keep credentials in the secret box rather than in a config blob.
 *
 * What is left here is the pair of claims worth pinning after a removal. First, that the routes are
 * actually ABSENT rather than merely unused by the admin UI — a stale route that still writes to a
 * retired table is the failure mode this catches. Second, that nothing recreates the table v20
 * dropped.
 */

const NOW = Date.UTC(2026, 7, 6, 12)
const RSS_URL = 'https://news.example.test/feed.xml'
const rss = readFileSync(new URL('./fixtures/rss-news.xml', import.meta.url), 'utf8')

const config = {
  port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://hub.test', relayUrl: null,
} as const

describe('the retired v18 connector admin surface', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const secretBox = createSecretBox(new Uint8Array(32).fill(7))
    db = openDb(':memory:', { secretBox })
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === RSS_URL) return new Response(rss)
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    app = await buildServer({ config: config as any, db, secretBox, fetchImpl })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  const request = (method: string, url: string, payload?: object) =>
    inject(app, { method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) })

  const connectorTable = () =>
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connectors'").get()

  async function promoteRss(name = 'Family news'): Promise<{ id: string }> {
    const draft = await request('POST', '/admin/api/source-drafts', {
      provider_id: 'dashboardz.rss', name, config: { max_items: 20 }, secrets: { url: RSS_URL },
    })
    expect(draft.statusCode).toBe(200)
    const promoted = await request('POST', `/admin/api/source-drafts/${draft.json().id}/promote`)
    expect(promoted.statusCode).toBe(200)
    return promoted.json().source as { id: string }
  }

  /**
   * Every verb the retired surface answered, including the ones that only read. A GET left behind
   * is not harmless: the admin UI would still be able to render a v18 view of the world beside the
   * v19 one, and an operator would have two disagreeing answers to "what is this hub fetching?".
   */
  it('answers nothing on any connector route, authenticated or not', async () => {
    const retired: Array<[string, string, object?]> = [
      ['GET', '/admin/api/connector-types'],
      ['GET', '/admin/api/connectors'],
      ['POST', '/admin/api/connectors', { type: 'rss', name: 'x', config: { url: RSS_URL } }],
      ['PATCH', '/admin/api/connectors/src_anything', { name: 'x' }],
      ['DELETE', '/admin/api/connectors/src_anything'],
    ]
    for (const [method, url, payload] of retired) {
      const authed = await request(method, url, payload)
      expect(authed.statusCode, `${method} ${url} with a session`).toBe(404)

      const anonymous = await inject(app, { method, url, ...(payload === undefined ? {} : { payload }) })
      expect(anonymous.statusCode, `${method} ${url} without a session`).toBe(404)
    }
  })

  /**
   * The table itself is gone (v20). It survived the runtime's deletion for one release as
   * legacy migration data, which turned out to mean "a plaintext copy of every migrated
   * credential" — so v20 drops it, and `source_instances.legacy_connector_id` carries the trail
   * instead. Creating and repairing a source must not bring it back.
   */
  it('has no connectors table left, and no v19 path recreates one', async () => {
    expect(connectorTable()).toBeUndefined()

    const source = await promoteRss()
    expect(connectorTable()).toBeUndefined()

    const repaired = await request('PUT', `/admin/api/sources/${source.id}/setup`, {
      config: { max_items: 10 }, secrets: { url: RSS_URL },
    })
    expect(repaired.statusCode).toBe(200)
    expect(connectorTable()).toBeUndefined()

    const refreshed = await request('POST', `/admin/api/sources/${source.id}/refresh`)
    expect(refreshed.statusCode).toBe(200)
    expect(connectorTable()).toBeUndefined()
  })

  /**
   * The replacement, named. If this ever fails while the retirement test above passes, the surface
   * was removed without its successor being reachable — which is a worse state than either.
   */
  it('serves connection management from the v19 source routes instead', async () => {
    const source = await promoteRss()
    const list = await request('GET', '/admin/api/sources')
    expect(list.statusCode).toBe(200)
    expect(list.json().map((row: { id: string }) => row.id)).toEqual([source.id])
  })
})
