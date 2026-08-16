import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/migrate.js'
import { createFeed, deleteFeed, getFeed } from '../src/db/feeds.js'
import { createScreen, getScreen } from '../src/db/screens.js'
import {
  createOutput, createSource, deleteSource, dueSources, getSource, listOutputs, listSourceSecrets,
  listSources, putSourceSecret, recordRun, updateOutput, updateSource,
} from '../src/db/sources.js'

describe('db/sources', () => {
  let db: Database.Database
  const create = (name: string, now = 1_000) => createSource(db, {
    provider_id: 'dashboardz.test', package_id: 'dashboardz.builtin', package_version: '1.0.0',
    name, config: { region: 'north' }, interval_s: 60,
  }, now)
  const feed = (name: string, now = 1_000) => createFeed(db, { name, mode: 'value' }, now)

  beforeEach(() => { db = new Database(':memory:'); migrate(db) })

  it('creates a source with multiple outputs while enforcing one contract per source', () => {
    const source = create('Weather')
    const current = feed('current')
    const forecast = feed('forecast')
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: current.id }, 1_001)
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.daily-forecast/v1', feed_id: forecast.id }, 1_002)

    expect(listOutputs(db, source.id).map((output) => output.contract_id)).toEqual([
      'dashboardz.weather.current/v1', 'dashboardz.weather.daily-forecast/v1',
    ])
    expect(() => createOutput(db, {
      source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: feed('duplicate').id,
    }, 1_003)).toThrow(/UNIQUE/)
  })

  it('updates source revision and schedules pause and resume deterministically', () => {
    const source = create('Weather')
    expect(updateSource(db, source.id, { name: 'Weather two' }, 2_000)?.rev).toBe(2)
    expect(updateSource(db, source.id, { enabled: false }, 3_000)).toMatchObject({ enabled: 0, state: 'paused', next_run_at: null, rev: 3 })
    expect(dueSources(db, 99_999)).toEqual([])
    expect(updateSource(db, source.id, { enabled: true }, 4_000)).toMatchObject({ enabled: 1, state: 'healthy', next_run_at: 4_000, rev: 4 })
    expect(dueSources(db, 3_999)).toEqual([])
    expect(dueSources(db, 4_000).map((row) => row.id)).toEqual([source.id])
  })

  it('orders due sources by scheduled time and records next run state', () => {
    const early = create('Early')
    const late = create('Late', 1_001)
    updateSource(db, early.id, { next_run_at: 5_000 }, 2_000)
    updateSource(db, late.id, { next_run_at: 4_000 }, 2_000)

    expect(dueSources(db, 4_500).map((row) => row.name)).toEqual(['Late'])
    expect(dueSources(db, 5_000).map((row) => row.name)).toEqual(['Late', 'Early'])
    expect(recordRun(db, early.id, 5_000, 'upstream timeout')).toMatchObject({
      state: 'degraded', failure_count: 1, last_run_at: 5_000, last_success_at: null,
      last_status: 'upstream timeout', next_run_at: 65_000,
    })
    expect(recordRun(db, early.id, 65_000, 'ok')).toMatchObject({
      state: 'healthy', failure_count: 0, last_success_at: 65_000, last_status: 'ok', next_run_at: 125_000,
    })
  })

  it('records explicit retry outcomes without changing config revision and keeps paused sources not due', () => {
    const source = create('Retried')
    const before = getSource(db, source.id)!.rev
    expect(recordRun(db, source.id, 5_000, {
      status: 'credentials rejected', state: 'authentication_failed', next_run_at: 17_000,
    })).toMatchObject({
      state: 'authentication_failed', failure_count: 1, next_run_at: 17_000, rev: before,
    })
    expect(dueSources(db, 16_999)).toEqual([])
    expect(dueSources(db, 17_000).map((row) => row.id)).toEqual([source.id])
    expect(recordRun(db, source.id, 17_000, {
      status: 'rate limited', state: 'rate_limited', next_run_at: 33_000,
    })).toMatchObject({ state: 'rate_limited', failure_count: 2, next_run_at: 33_000, rev: before })

    const paused = createSource(db, {
      provider_id: 'dashboardz.test', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Paused', config: {}, interval_s: 60, enabled: false,
    }, 1_000)
    expect(recordRun(db, paused.id, 2_000, {
      status: 'invalid provider response', state: 'invalid_output', next_run_at: 4_000,
    })).toMatchObject({ state: 'paused', next_run_at: null, last_status: 'invalid provider response' })
    expect(dueSources(db, 99_999).map((row) => row.id)).not.toContain(paused.id)
  })

  it('replaces ciphertext secrets by name without exposing plaintext semantics', () => {
    const source = create('RSS')
    putSourceSecret(db, source.id, 'url', 'ciphertext-v1', 1_001)
    putSourceSecret(db, source.id, 'url', 'ciphertext-v2', 1_002)

    expect(listSourceSecrets(db, source.id)).toEqual([expect.objectContaining({
      name: 'url', ciphertext: 'ciphertext-v2', created_at: 1_001, updated_at: 1_002,
    })])
  })

  it('degrades malformed source config and output capabilities rather than crashing a read', () => {
    const source = create('Broken')
    const sourceOutput = createOutput(db, {
      source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: feed('broken-output').id,
      capabilities: ['weather.current'],
    }, 1_001)
    db.prepare('UPDATE source_instances SET config = ? WHERE id = ?').run('{bad', source.id)
    db.prepare('UPDATE source_outputs SET capabilities = ? WHERE id = ?').run('{bad', sourceOutput.id)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(getSource(db, source.id)?.config).toEqual({})
      expect(listOutputs(db, source.id)[0]?.capabilities).toEqual([])
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses public deletion of a provider-owned output feed', () => {
    const source = create('Weather')
    const owned = feed('owned')
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: owned.id }, 1_001)

    expect(() => deleteFeed(db, owned.id)).toThrow('delete the connection instead')
    expect(getFeed(db, owned.id)).toBeDefined()
  })

  it('deleting a raw output feed removes only its nullable-source output', () => {
    const raw = feed('raw')
    createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.value/v1', feed_id: raw.id }, 1_001)

    expect(deleteFeed(db, raw.id)).toBe(true)
    expect(getFeed(db, raw.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_outputs WHERE feed_id = ?').get(raw.id)).toEqual({ count: 0 })
  })

  it('allows a nullable source id only for a legacy push-backed output', () => {
    expect(() => createOutput(db, {
      source_id: null, contract_id: 'dashboardz.weather.current/v1', feed_id: feed('not-raw').id,
    }, 1_001)).toThrow('nullable source outputs must use a legacy contract')
  })

  it('matches every legacy contract mode to its backing feed mode', () => {
    const value = feed('legacy value')
    const stream = createFeed(db, { name: 'legacy stream', mode: 'stream' }, 1_000)
    const image = createFeed(db, { name: 'legacy image', mode: 'image' }, 1_000)
    expect(() => createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.value/v1', feed_id: value.id }, 1_001)).not.toThrow()
    expect(() => createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.stream/v1', feed_id: stream.id }, 1_001)).not.toThrow()
    expect(() => createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.image/v1', feed_id: image.id }, 1_001)).not.toThrow()
    expect(() => createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.stream/v1', feed_id: feed('wrong stream').id }, 1_001))
      .toThrow('contract mode stream does not match feed mode value')
    expect(() => createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.value/v1', feed_id: createFeed(db, { name: 'wrong value', mode: 'stream' }, 1_000).id }, 1_001))
      .toThrow('contract mode value does not match feed mode stream')
    expect(() => createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.image/v1', feed_id: feed('wrong image').id }, 1_001))
      .toThrow('contract mode image does not match feed mode value')
  })

  it('refuses deletion of a used source with the exact screen names', () => {
    const source = create('Calendar')
    const owned = feed('calendar')
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.calendar.events/v1', feed_id: owned.id }, 1_001)
    createScreen(db, {
      name: 'Kitchen', orientation: 'landscape', grid: { cells: [{ config: { feed: owned.id } }] },
    }, 1_002)
    createScreen(db, {
      name: 'Hall', orientation: 'landscape', grid: { cells: [{ config: { series: [{ feed: owned.id }] } }] },
    }, 1_003)

    expect(deleteSource(db, source.id)).toEqual({ deleted: false, screenNames: ['Kitchen', 'Hall'] })
    expect(getSource(db, source.id)).toBeDefined()
  })

  it('deletes an unused source, all owned outputs and feeds in one operation', () => {
    const source = create('Weather')
    const current = feed('current')
    const forecast = feed('forecast')
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: current.id }, 1_001)
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.daily-forecast/v1', feed_id: forecast.id }, 1_002)
    putSourceSecret(db, source.id, 'token', 'opaque-ciphertext', 1_003)

    expect(deleteSource(db, source.id)).toEqual({ deleted: true, screenNames: [] })
    expect(getSource(db, source.id)).toBeUndefined()
    expect(getFeed(db, current.id)).toBeUndefined()
    expect(getFeed(db, forecast.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_secrets WHERE source_id = ?').get(source.id)).toEqual({ count: 0 })
  })

  it('rolls back every source-owned row when an owned-feed delete aborts', () => {
    const source = create('Rollback')
    const owned = feed('rollback feed')
    createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: owned.id }, 1_001)
    putSourceSecret(db, source.id, 'token', 'opaque-ciphertext', 1_002)
    // A second source sharing nothing with the first, so the rollback can be shown to be scoped:
    // an aborted delete must leave every row it did not own exactly where it was.
    const bystander = create('Bystander')
    db.exec(`CREATE TRIGGER abort_source_feed_delete BEFORE DELETE ON feeds
      WHEN OLD.id = '${owned.id}' BEGIN SELECT RAISE(ABORT, 'feed delete abort'); END`)

    expect(() => deleteSource(db, source.id)).toThrow('feed delete abort')
    expect(getSource(db, source.id)).toBeDefined()
    expect(getFeed(db, owned.id)).toBeDefined()
    expect(getSource(db, bystander.id)).toBeDefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_outputs WHERE source_id = ?').get(source.id)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_secrets WHERE source_id = ?').get(source.id)).toEqual({ count: 1 })
  })

  it('keeps a referenced raw-feed screen binding while deleting the feed and raw output', () => {
    const raw = feed('referenced raw')
    createOutput(db, { source_id: null, contract_id: 'dashboardz.legacy.value/v1', feed_id: raw.id }, 1_001)
    const screen = createScreen(db, {
      name: 'Still missing', orientation: 'landscape', grid: { cells: [{ config: { feed: raw.id } }] },
    }, 1_002)

    expect(deleteFeed(db, raw.id)).toBe(true)
    expect(getScreen(db, screen.id)?.grid).toContain(raw.id)
    expect(getFeed(db, raw.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_outputs WHERE feed_id = ?').get(raw.id)).toEqual({ count: 0 })
  })

  it('updates output metadata without changing source ownership', () => {
    const source = create('Weather')
    const output = createOutput(db, { source_id: source.id, contract_id: 'dashboardz.weather.current/v1', feed_id: feed('metadata').id }, 1_001)
    expect(updateOutput(db, output.id, { capabilities: ['weather.current'], content_hash: 'hash', last_valid_at: 4_000 }))
      .toMatchObject({ source_id: source.id, capabilities: ['weather.current'], content_hash: 'hash', last_valid_at: 4_000 })
  })

  it('lists sources in stable creation order', () => {
    create('First', 1_000)
    create('Second', 1_001)
    expect(listSources(db).map((row) => row.name)).toEqual(['First', 'Second'])
  })
})
