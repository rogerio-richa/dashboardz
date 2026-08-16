import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { databaseHasProtectedSecrets, openDb, verifySecretStore } from '../src/db/index.js'
import { migrate, LATEST_VERSION } from '../src/db/migrate.js'
import { imagePath } from '../src/feedImage.js'
import { createSecretBox, type SecretBox } from '../src/secrets/box.js'
import { loadMasterKey } from '../src/secrets/masterKey.js'

const MIGRATION_AT = 9_000_000
const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)
const box = createSecretBox(key(19))
const dirs: string[] = []

interface FeedFixture {
  id: string
  name: string
  mode: 'value' | 'stream' | 'image'
  payload?: string | null
  pushedAt?: number | null
  imageRev?: number
  allowedSenders?: string | null
  createdAt: number
}

interface ConnectorFixture {
  id: string
  type: string
  name: string
  config: string
  feedId: string
  intervalS: number
  enabled: number
  lastRunAt: number | null
  lastStatus: string | null
  createdAt: number
}

const feeds: FeedFixture[] = [
  {
    id: 'feed_weather', name: 'Weather legacy feed', mode: 'value', pushedAt: 1_800_000, createdAt: 1_000,
    payload: JSON.stringify({
      current: { temp: 21.5, feels_like: 20.5, humidity: 55, wind: 12, code: 2, is_day: 1 },
      today: { min: 15, max: 25, precip_prob: 10 },
      units: { temp: '°C', wind: 'km/h' },
    }),
  },
  { id: 'feed_rss', name: 'RSS legacy feed', mode: 'stream', pushedAt: 2_500_000, createdAt: 1_100 },
  {
    id: 'feed_ical', name: 'Calendar legacy feed', mode: 'value', pushedAt: 3_500_000, createdAt: 1_200,
    payload: JSON.stringify({
      events: [{
        title: 'Standup', start: '2026-08-05T09:00:00.000Z', end: '2026-08-05T09:30:00.000Z',
        all_day: false, location: null,
      }],
    }),
  },
  {
    id: 'feed_unknown', name: 'Unknown connector feed', mode: 'value', pushedAt: 4_500_000, createdAt: 1_300,
    payload: JSON.stringify({ opaque: true }),
  },
  {
    id: 'feed_bad_weather', name: 'Broken weather snapshot', mode: 'value', pushedAt: 5_500_000,
    createdAt: 1_400, payload: '{not readable weather',
  },
  {
    id: 'feed_raw_value', name: 'Raw value', mode: 'value', pushedAt: 6_500_000, createdAt: 1_500,
    allowedSenders: '["snd_alpha"]', payload: JSON.stringify({ room: 'kitchen', occupied: true }),
  },
  { id: 'feed_raw_stream', name: 'Raw stream', mode: 'stream', pushedAt: 7_500_000, createdAt: 1_600 },
  {
    id: 'feed_raw_image', name: 'Raw image', mode: 'image', pushedAt: 8_500_000, imageRev: 7,
    allowedSenders: '["snd_camera"]', createdAt: 1_700,
  },
]

const connectors: ConnectorFixture[] = [
  {
    id: 'con_weather', type: 'weather', name: 'Porto weather',
    config: JSON.stringify({ city: 'Porto', lat: 41.15, lon: -8.61, units: 'metric' }),
    feedId: 'feed_weather', intervalS: 900, enabled: 1, lastRunAt: 1_700_000,
    lastStatus: 'ok', createdAt: 1_000,
  },
  {
    id: 'con_rss', type: 'rss', name: 'Morning news',
    config: JSON.stringify({ url: 'https://news.example.test/private.xml', max_items: 20, extra: 'kept' }),
    feedId: 'feed_rss', intervalS: 600, enabled: 1, lastRunAt: 2_400_000,
    lastStatus: 'upstream timeout', createdAt: 1_100,
  },
  {
    id: 'con_ical', type: 'ical', name: 'Family calendar',
    config: JSON.stringify({ url: 'https://calendar.example.test/secret.ics', lookahead_days: 7, max_events: 10 }),
    feedId: 'feed_ical', intervalS: 300, enabled: 0, lastRunAt: 3_400_000,
    lastStatus: 'ok', createdAt: 1_200,
  },
  {
    id: 'con_future', type: 'toString', name: 'Future connector', config: '{future config stays byte-for-byte',
    feedId: 'feed_unknown', intervalS: 120, enabled: 1, lastRunAt: null,
    lastStatus: null, createdAt: 1_300,
  },
  {
    id: 'con_bad_weather', type: 'weather', name: 'Weather needing refresh',
    config: JSON.stringify({ city: 'Recife', lat: -8.05, lon: -34.9, units: 'metric' }),
    feedId: 'feed_bad_weather', intervalS: 900, enabled: 1, lastRunAt: null,
    lastStatus: null, createdAt: 1_400,
  },
]

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashboardz-v19-'))
  dirs.push(dir)
  return dir
}

function createV18(path: string, opts: { connectors?: boolean } = {}): Database.Database {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  migrate(db as any, { targetVersion: 18 })
  expect(db.pragma('user_version', { simple: true })).toBe(18)

  if (opts.connectors === false) return db

  const insertFeed = db.prepare(
    'INSERT INTO feeds (id, name, mode, cap, stale_after_s, alert_on_stale, allowed_senders, payload, pushed_at, pushed_by, image_rev, created_at)' +
    ' VALUES (?, ?, ?, 50, NULL, 0, ?, ?, ?, ?, ?, ?)',
  )
  for (const feed of feeds) {
    insertFeed.run(
      feed.id, feed.name, feed.mode, feed.allowedSenders ?? null, feed.payload ?? null,
      feed.pushedAt ?? null, feed.pushedAt === undefined ? null : 'snd_fixture', feed.imageRev ?? 0, feed.createdAt,
    )
  }

  db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
    .run('feed_rss', JSON.stringify({
      title: 'First story', link: 'https://news.example.test/first', summary: 'Summary', published_at: 2_100_000,
    }), 2_100_000, 'snd_fixture')
  db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
    .run('feed_rss', JSON.stringify({
      title: 'Second story', link: 'https://news.example.test/second', source: 'Morning desk',
    }), 2_200_000, 'snd_fixture')
  db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
    .run('feed_raw_stream', JSON.stringify({ arbitrary: ['stream', 1] }), 7_400_000, 'snd_fixture')

  const insertConnector = db.prepare(
    'INSERT INTO connectors (id, type, name, config, feed_id, interval_s, enabled, last_run_at, last_status, created_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const connector of connectors) {
    insertConnector.run(
      connector.id, connector.type, connector.name, connector.config, connector.feedId,
      connector.intervalS, connector.enabled, connector.lastRunAt, connector.lastStatus, connector.createdAt,
    )
  }

  db.prepare('INSERT INTO screens (id, name, orientation, grid, created_at, rev) VALUES (?, ?, ?, ?, ?, ?)')
    .run('lay_legacy', 'Legacy bindings', 'landscape', JSON.stringify({
      cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'value_tile', config: { feed: 'feed_weather', path: 'current.temp' } },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'image', config: { feed: 'feed_raw_image' } },
      ],
    }), 1_800, 1)
  return db
}

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'source_%' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('v18 connector to v19 source migration', () => {
  it('maps every connector and unclaimed feed append-only while retaining existing bindings and bytes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(MIGRATION_AT)
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const storedImagePath = imagePath(dataDir, 'feed_raw_image')
    mkdirSync(join(dataDir, 'feeds'))
    writeFileSync(storedImagePath, imageBytes)
    const legacy = createV18(path)
    const connectorRowsBefore = legacy.prepare('SELECT * FROM connectors ORDER BY id').all()
    const screenGridBefore = (legacy.prepare("SELECT grid FROM screens WHERE id = 'lay_legacy'").get() as { grid: string }).grid
    const calendarBefore = (legacy.prepare("SELECT payload FROM feeds WHERE id = 'feed_ical'").get() as { payload: string }).payload
    legacy.close()

    const db = openDb(path, { secretBox: box })

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    // v19 copies append-only and v20 then destroys the table it read, so an opened database has
    // no connector rows left to compare. What survives the pair is the trail: every source
    // records which connector it came from, and nothing else about the migration changed.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connectors'").get())
      .toBeUndefined()
    expect(db.prepare('SELECT legacy_connector_id FROM source_instances WHERE legacy_connector_id IS NOT NULL ORDER BY legacy_connector_id').all())
      .toEqual(connectorRowsBefore.map((row) => ({ legacy_connector_id: (row as { id: string }).id })))
    expect((db.prepare("SELECT grid FROM screens WHERE id = 'lay_legacy'").get() as { grid: string }).grid)
      .toBe(screenGridBefore)
    expect((db.prepare("SELECT payload FROM feeds WHERE id = 'feed_ical'").get() as { payload: string }).payload)
      .toBe(calendarBefore)
    expect(readFileSync(storedImagePath)).toEqual(imageBytes)

    const sourceRows = db.prepare(`
      SELECT id, provider_id, package_id, package_version, name, config, strategy, interval_s,
             enabled, state, next_run_at, failure_count, last_run_at, last_success_at, last_status,
             legacy_connector_id, last_used_at, rev, created_at, updated_at
        FROM source_instances ORDER BY id
    `).all()
    expect(sourceRows).toEqual([
      {
        id: 'con_bad_weather', provider_id: 'dashboardz.open-meteo', package_id: 'dashboardz.builtin',
        package_version: '1.0.0', name: 'Weather needing refresh',
        config: JSON.stringify({ city: 'Recife', lat: -8.05, lon: -34.9, units: 'metric' }),
        strategy: 'scheduled', interval_s: 900, enabled: 1, state: 'healthy', next_run_at: MIGRATION_AT,
        failure_count: 0, last_run_at: null, last_success_at: null, last_status: null,
        legacy_connector_id: 'con_bad_weather', last_used_at: null, rev: 1, created_at: 1_400, updated_at: MIGRATION_AT,
      },
      {
        id: 'con_future', provider_id: 'legacy.toString', package_id: 'dashboardz.builtin',
        package_version: '1.0.0', name: 'Future connector', config: '{future config stays byte-for-byte',
        strategy: 'scheduled', interval_s: 120, enabled: 1, state: 'healthy', next_run_at: MIGRATION_AT,
        failure_count: 0, last_run_at: null, last_success_at: null, last_status: null,
        legacy_connector_id: 'con_future', last_used_at: null, rev: 1, created_at: 1_300, updated_at: MIGRATION_AT,
      },
      {
        id: 'con_ical', provider_id: 'dashboardz.ical', package_id: 'dashboardz.builtin',
        package_version: '1.0.0', name: 'Family calendar',
        config: JSON.stringify({ lookahead_days: 7, max_events: 10 }), strategy: 'scheduled', interval_s: 300,
        enabled: 0, state: 'paused', next_run_at: 3_700_000, failure_count: 0, last_run_at: 3_400_000,
        last_success_at: 3_400_000, last_status: 'ok', legacy_connector_id: 'con_ical', last_used_at: null,
        rev: 1, created_at: 1_200, updated_at: MIGRATION_AT,
      },
      {
        id: 'con_rss', provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
        name: 'Morning news', config: JSON.stringify({ max_items: 20, extra: 'kept' }), strategy: 'scheduled',
        interval_s: 600, enabled: 1, state: 'degraded', next_run_at: 3_000_000, failure_count: 0,
        last_run_at: 2_400_000, last_success_at: null, last_status: 'upstream timeout',
        legacy_connector_id: 'con_rss', last_used_at: null, rev: 1, created_at: 1_100, updated_at: MIGRATION_AT,
      },
      {
        id: 'con_weather', provider_id: 'dashboardz.open-meteo', package_id: 'dashboardz.builtin',
        package_version: '1.0.0', name: 'Porto weather',
        config: JSON.stringify({ city: 'Porto', lat: 41.15, lon: -8.61, units: 'metric' }),
        strategy: 'scheduled', interval_s: 900, enabled: 1, state: 'healthy', next_run_at: 2_600_000,
        failure_count: 0, last_run_at: 1_700_000, last_success_at: 1_700_000, last_status: 'ok',
        legacy_connector_id: 'con_weather', last_used_at: null, rev: 1, created_at: 1_000, updated_at: MIGRATION_AT,
      },
    ])

    const secretRows = db.prepare('SELECT id, source_id, name, ciphertext, created_at, updated_at FROM source_secrets ORDER BY source_id').all() as {
      id: string; source_id: string; name: string; ciphertext: string; created_at: number; updated_at: number
    }[]
    expect(secretRows.map(({ id, source_id, name, created_at, updated_at }) => ({ id, source_id, name, created_at, updated_at })))
      .toEqual([
        { id: 'sec_con_ical_url', source_id: 'con_ical', name: 'url', created_at: 1_200, updated_at: MIGRATION_AT },
        { id: 'sec_con_rss_url', source_id: 'con_rss', name: 'url', created_at: 1_100, updated_at: MIGRATION_AT },
      ])
    expect(secretRows.map((row) => box.open(row.ciphertext))).toEqual([
      'https://calendar.example.test/secret.ics',
      'https://news.example.test/private.xml',
    ])
    for (const row of secretRows) {
      expect(row.ciphertext).toMatch(/^v1\./)
      expect(row.ciphertext).not.toContain('example.test')
    }
    const copiedConfigs = (db.prepare('SELECT config FROM source_instances').all() as { config: string }[])
      .map((row) => row.config).join('\n')
    expect(copiedConfigs).not.toContain('calendar.example.test')
    expect(copiedConfigs).not.toContain('news.example.test')

    const outputs = db.prepare(`
      SELECT id, source_id, contract_id, feed_id, capabilities, content_hash, last_valid_at, created_at
        FROM source_outputs ORDER BY feed_id
    `).all()
    expect(outputs).toEqual([
      { id: 'out_feed_bad_weather', source_id: 'con_bad_weather', contract_id: 'dashboardz.weather.current/v1', feed_id: 'feed_bad_weather', capabilities: '[]', content_hash: null, last_valid_at: null, created_at: 1_400 },
      // A migrated calendar carries the capabilities its stored payload actually validates to:
      // v19 re-validates every payload it copies, so a source migrated before the calendar
      // contract had a vocabulary gains one without a second migration.
      { id: 'out_feed_ical', source_id: 'con_ical', contract_id: 'dashboardz.calendar.events/v1', feed_id: 'feed_ical', capabilities: '["calendar.event.all_day","calendar.event.times","calendar.event.title"]', content_hash: null, last_valid_at: 3_500_000, created_at: 1_200 },
      { id: 'out_feed_raw_image', source_id: null, contract_id: 'dashboardz.legacy.image/v1', feed_id: 'feed_raw_image', capabilities: '[]', content_hash: null, last_valid_at: 8_500_000, created_at: 1_700 },
      { id: 'out_feed_raw_stream', source_id: null, contract_id: 'dashboardz.legacy.stream/v1', feed_id: 'feed_raw_stream', capabilities: '[]', content_hash: null, last_valid_at: 7_500_000, created_at: 1_600 },
      { id: 'out_feed_raw_value', source_id: null, contract_id: 'dashboardz.legacy.value/v1', feed_id: 'feed_raw_value', capabilities: '[]', content_hash: null, last_valid_at: 6_500_000, created_at: 1_500 },
      { id: 'out_feed_rss', source_id: 'con_rss', contract_id: 'dashboardz.news.items/v1', feed_id: 'feed_rss', capabilities: '["news.item.id","news.item.published_at","news.item.source","news.item.summary","news.item.title","news.item.url"]', content_hash: null, last_valid_at: 2_500_000, created_at: 1_100 },
      { id: 'out_feed_unknown', source_id: 'con_future', contract_id: 'dashboardz.legacy.value/v1', feed_id: 'feed_unknown', capabilities: '[]', content_hash: null, last_valid_at: 4_500_000, created_at: 1_300 },
      { id: 'out_feed_weather', source_id: 'con_weather', contract_id: 'dashboardz.weather.current/v1', feed_id: 'feed_weather', capabilities: '["weather.current"]', content_hash: null, last_valid_at: 1_800_000, created_at: 1_000 },
    ])

    const weather = JSON.parse((db.prepare("SELECT payload FROM feeds WHERE id = 'feed_weather'").get() as { payload: string }).payload)
    expect(weather).toMatchObject({
      location: { name: 'Porto', timezone: null }, observed_at: 1_800_000,
      current: {
        temp: 21.5, feels_like: 20.5, humidity: 55, wind: 12, code: 2, is_day: 1,
        condition: { code: 'partly_cloudy', label: 'Partly cloudy' },
      },
      today: { min: 15, max: 25, precip_prob: 10 }, units: { temp: '°C', wind: 'km/h' },
    })
    expect((db.prepare("SELECT payload FROM feeds WHERE id = 'feed_bad_weather'").get() as { payload: string }).payload)
      .toBe('{not readable weather')

    const rssRows = (db.prepare("SELECT id, payload, pushed_at, pushed_by FROM feed_rows WHERE feed_id = 'feed_rss' ORDER BY id").all() as {
      id: number; payload: string; pushed_at: number; pushed_by: string
    }[]).map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
    expect(rssRows).toEqual([
      {
        id: 1, pushed_at: 2_100_000, pushed_by: 'snd_fixture',
        payload: {
          title: 'First story', link: 'https://news.example.test/first', summary: 'Summary', published_at: 2_100_000,
          id: 'https://news.example.test/first', url: 'https://news.example.test/first',
        },
      },
      {
        id: 2, pushed_at: 2_200_000, pushed_by: 'snd_fixture',
        payload: {
          title: 'Second story', link: 'https://news.example.test/second', source: 'Morning desk',
          id: 'https://news.example.test/second', url: 'https://news.example.test/second',
        },
      },
    ])

    expect(db.prepare("SELECT id, allowed_senders, payload, pushed_at, image_rev FROM feeds WHERE id = 'feed_raw_value'").get())
      .toEqual({
        id: 'feed_raw_value', allowed_senders: '["snd_alpha"]',
        payload: JSON.stringify({ room: 'kitchen', occupied: true }), pushed_at: 6_500_000, image_rev: 0,
      })
    expect(db.prepare("SELECT id, allowed_senders, payload, pushed_at, image_rev FROM feeds WHERE id = 'feed_raw_image'").get())
      .toEqual({ id: 'feed_raw_image', allowed_senders: '["snd_camera"]', payload: null, pushed_at: 8_500_000, image_rev: 7 })

    const firstCiphertexts = secretRows.map((row) => row.ciphertext)
    db.close()
    const reopened = openDb(path, { secretBox: box })
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM source_instances').get()).toEqual({ n: connectors.length })
    expect((reopened.prepare('SELECT ciphertext FROM source_secrets ORDER BY source_id').all() as { ciphertext: string }[])
      .map((row) => row.ciphertext)).toEqual(firstCiphertexts)
    reopened.close()
  })

  it('rolls back all v19 DDL and data when encrypting a known URL fails', () => {
    const db = createV18(':memory:')
    const providerSecret = 'https://calendar.example.test/secret.ics'
    const failingBox: SecretBox = {
      seal(plaintext) { throw new Error(`provider secret leaked by seal: ${plaintext}`) },
      open() { throw new Error('not reached') },
    }

    let message = ''
    try {
      migrate(db as any, { secretBox: failingBox })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toBe('Could not protect migrated source secret')
    expect(message).not.toContain(providerSecret)
    expect(message).not.toContain('provider secret leaked by seal')
    expect(db.pragma('user_version', { simple: true })).toBe(18)
    expect(tableNames(db)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM connectors').get()).toEqual({ n: connectors.length })
    expect((db.prepare("SELECT config FROM connectors WHERE id = 'con_rss'").get() as { config: string }).config)
      .toContain('https://news.example.test/private.xml')
    db.close()
  })

  /**
   * The two halves of the same story, kept apart so each is checkable.
   *
   * v19 is append-only: it reads the connector rows and writes source instances beside them,
   * touching nothing. v20 then drops the table, because a table nothing reads is not used by the runtime —
   * it is a second, plaintext copy of every migrated credential. Stopping at 19 is the only way to
   * see the first half, so this test does.
   */
  it('preserves connector rows byte for byte at v19, then destroys the table at v20', () => {
    const db = createV18(':memory:')
    const before = db.prepare('SELECT * FROM connectors ORDER BY id').all()
    expect(before.length).toBeGreaterThan(0)

    migrate(db as any, { secretBox: box, targetVersion: 19 })
    expect(db.pragma('user_version', { simple: true })).toBe(19)
    expect(db.prepare('SELECT * FROM connectors ORDER BY id').all()).toEqual(before)
    // The plaintext this whole change exists to remove, still present one step earlier.
    expect(JSON.stringify(before)).toContain('https://news.example.test/private.xml')

    migrate(db as any, { secretBox: box })
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connectors'").get())
      .toBeUndefined()
    // Gone from the file, not merely from a query: the sources it produced still work, and the
    // credential now exists only inside the secret box.
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_instances').get()).toEqual({ n: connectors.length })
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_secrets').get()).not.toEqual({ n: 0 })
    db.close()
  })

  it('uses the fail-closed default box only when migration has no URL secret to seal', () => {
    const safe = createV18(':memory:', { connectors: false })
    expect(() => migrate(safe as any)).not.toThrow()
    expect(safe.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    safe.close()

    const secretBearing = createV18(':memory:')
    expect(() => migrate(secretBearing as any)).toThrow(/could not protect migrated source secret/i)
    expect(secretBearing.pragma('user_version', { simple: true })).toBe(18)
    secretBearing.close()
  })

  it('does not validate malformed raw or unknown-connector stream rows through invented objects', () => {
    const db = createV18(':memory:', { connectors: false })
    const insertFeed = db.prepare(`
      INSERT INTO feeds
        (id, name, mode, cap, stale_after_s, alert_on_stale, payload, pushed_at, pushed_by, image_rev, created_at)
      VALUES (?, ?, 'stream', 50, NULL, 0, NULL, ?, 'snd_fixture', 0, ?)
    `)
    insertFeed.run('feed_bad_raw_stream', 'Malformed raw stream', 6_000, 1_000)
    insertFeed.run('feed_bad_unknown_stream', 'Malformed unknown stream', 7_000, 2_000)
    db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
      .run('feed_bad_raw_stream', '{malformed raw row', 5_900, 'snd_fixture')
    db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
      .run('feed_bad_unknown_stream', '{malformed unknown row', 6_900, 'snd_fixture')
    db.prepare(`
      INSERT INTO connectors
        (id, type, name, config, feed_id, interval_s, enabled, last_run_at, last_status, created_at)
      VALUES ('con_bad_unknown_stream', 'future-stream', 'Unknown stream', '{opaque config',
              'feed_bad_unknown_stream', 300, 1, NULL, NULL, 2000)
    `).run()

    migrate(db as any, { secretBox: box })

    expect(db.prepare(`
      SELECT source_id, contract_id, feed_id, capabilities, last_valid_at
        FROM source_outputs ORDER BY feed_id
    `).all()).toEqual([
      {
        source_id: null, contract_id: 'dashboardz.legacy.stream/v1', feed_id: 'feed_bad_raw_stream',
        capabilities: '[]', last_valid_at: null,
      },
      {
        source_id: 'con_bad_unknown_stream', contract_id: 'dashboardz.legacy.stream/v1',
        feed_id: 'feed_bad_unknown_stream', capabilities: '[]', last_valid_at: null,
      },
    ])
    expect((db.prepare("SELECT payload FROM feed_rows WHERE feed_id = 'feed_bad_raw_stream'").get() as { payload: string }).payload)
      .toBe('{malformed raw row')
    expect((db.prepare("SELECT payload FROM feed_rows WHERE feed_id = 'feed_bad_unknown_stream'").get() as { payload: string }).payload)
      .toBe('{malformed unknown row')
    db.close()
  })
})

describe('protected-secret startup preflight', () => {
  it('refuses to reopen persistent v19 ciphertext without a real secret box', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    openDb(path, { secretBox: box }).close()

    expect(() => openDb(path)).toThrow(/secret box is unavailable/i)
  })

  it('refuses to reopen draft v19 ciphertext without a real secret box', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    const db = openDb(path, { secretBox: box })
    db.prepare(`
      INSERT INTO source_drafts
        (id, provider_id, package_id, package_version, name, config, strategy, interval_s, expires_at, created_at)
      VALUES ('draft_only', 'dashboardz.rss', 'dashboardz.builtin', '1.0.0', 'Draft', '{}', 'scheduled', 600, 99, 1)
    `).run()
    db.prepare(`
      INSERT INTO source_draft_secrets (id, draft_id, name, ciphertext, created_at)
      VALUES ('draft_only_secret', 'draft_only', 'url', ?, 1)
    `).run(box.seal('https://draft.example.test/private.xml'))
    db.close()

    expect(() => openDb(path)).toThrow(/secret box is unavailable/i)
  })

  it('does not create a database and returns false for missing and pre-v19 files', () => {
    const dataDir = tempDir()
    const missing = join(dataDir, 'missing.db')
    expect(databaseHasProtectedSecrets(missing)).toBe(false)
    expect(existsSync(missing)).toBe(false)

    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    expect(databaseHasProtectedSecrets(path)).toBe(false)
  })

  it('fails closed when an existing database cannot be opened for preflight', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    chmodSync(path, 0o000)

    expect(() => databaseHasProtectedSecrets(path)).toThrow()
  })

  it('checks both persistent and draft secret tables at v19', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    openDb(path, { secretBox: box }).close()
    expect(databaseHasProtectedSecrets(path)).toBe(true)

    const db = new Database(path)
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM source_secrets').run()
    expect(databaseHasProtectedSecrets(path)).toBe(false)
    db.prepare(`
      INSERT INTO source_drafts
        (id, provider_id, package_id, package_version, name, config, strategy, interval_s, expires_at, created_at)
      VALUES ('draft_1', 'dashboardz.rss', 'dashboardz.builtin', '1.0.0', 'Draft', '{}', 'scheduled', 600, 99, 1)
    `).run()
    db.prepare(`
      INSERT INTO source_draft_secrets (id, draft_id, name, ciphertext, created_at)
      VALUES ('draft_secret_1', 'draft_1', 'url', ?, 1)
    `).run(box.seal('https://draft.example.test/private.xml'))
    db.close()
    expect(databaseHasProtectedSecrets(path)).toBe(true)
  })

  it('refuses to replace a missing key when a migrated v19 database contains ciphertext', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    openDb(path, { secretBox: box }).close()

    const allowCreate = !databaseHasProtectedSecrets(path)
    expect(allowCreate).toBe(false)
    expect(() => loadMasterKey(dataDir, null, { allowCreate })).toThrow(/restore.*master\.key|master key is missing/i)
    expect(existsSync(join(dataDir, 'master.key'))).toBe(false)
  })

  it('rejects the wrong key during ciphertext verification before runtime work can start', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    openDb(path, { secretBox: box }).close()

    const db = openDb(path, { secretBox: createSecretBox(key(20)) })
    let runtimeStarted = false
    expect(() => {
      verifySecretStore(db, createSecretBox(key(20)))
      runtimeStarted = true
    }).toThrow(/authentication failed/i)
    expect(runtimeStarted).toBe(false)
    db.close()
  })

  it('makes the real production entrypoint verify a wrong key before booting the server', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    openDb(path, { secretBox: box }).close()

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        ADMIN_PASSWORD: 'test-admin-password',
        DATA_DIR: dataDir,
        DASHBOARDZ_MASTER_KEY: Buffer.from(key(20)).toString('base64'),
        PORT: '64999',
      },
      encoding: 'utf8',
      timeout: 5_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/authentication failed/i)
    expect(result.stdout).not.toContain('hub listening')
  })

  it('allows a v18 database with no key to create one, encrypt migration URLs, and verify recovery', () => {
    const dataDir = tempDir()
    const path = join(dataDir, 'hub.db')
    createV18(path).close()
    expect(databaseHasProtectedSecrets(path)).toBe(false)

    const createdKey = loadMasterKey(dataDir, null, { allowCreate: true })
    const createdBox = createSecretBox(createdKey)
    const db = openDb(path, { secretBox: createdBox })
    expect(() => verifySecretStore(db, createdBox)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    const ciphertext = (db.prepare("SELECT ciphertext FROM source_secrets WHERE source_id = 'con_rss'").get() as { ciphertext: string }).ciphertext
    expect(createdBox.open(ciphertext)).toBe('https://news.example.test/private.xml')
    expect(readFileSync(join(dataDir, 'master.key'))).toEqual(Buffer.from(createdKey))
    db.close()
  })
})
