import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { ingestNotify } from '../src/db/alerts.js'
import { createFeed, pushValue, pushStreamRow } from '../src/db/feeds.js'
import { audit } from '../src/db/audit.js'
import { computeStorageStats, computeImagesBytes } from '../src/db/storageStats.js'

function setup() {
  const db = openDb(':memory:')
  const dev = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
  const snd = createSender(db, 's', []).sender.id
  return { db, dev, snd }
}

describe('computeStorageStats', () => {
  it('db_bytes is derived from PRAGMA page_count * page_size and is positive for a real db', () => {
    const { db } = setup()
    const stats = computeStorageStats(db, '/nonexistent')
    expect(stats.db_bytes).toBeGreaterThan(0)
    const pageCount = db.pragma('page_count', { simple: true }) as number
    const pageSize = db.pragma('page_size', { simple: true }) as number
    expect(stats.db_bytes).toBe(pageCount * pageSize)
  })

  it('images_bytes is 0 when the data dir does not exist', () => {
    const { db } = setup()
    expect(computeStorageStats(db, '/definitely/does/not/exist').images_bytes).toBe(0)
  })

  it('reports exactly five pools with the expected ids', () => {
    const { db } = setup()
    const stats = computeStorageStats(db, '/nonexistent')
    expect(stats.pools.map((p) => p.id).sort()).toEqual(
      ['alerts_active', 'alerts_concluded', 'audit_log', 'feed_rows', 'feed_values'].sort(),
    )
  })

  it('counts concluded vs active alerts into their own pools, with bytes > 0 once seeded', () => {
    const { db, dev, snd } = setup()
    const active = ingestNotify(db, { senderId: snd, title: 'active one', severity: 'info', targetDevices: [dev] }, 1000).alert
    const concluded = ingestNotify(db, { senderId: snd, title: 'concluded one', severity: 'info', targetDevices: [dev] }, 1000).alert
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(concluded.id)

    const stats = computeStorageStats(db, '/nonexistent')
    const activePool = stats.pools.find((p) => p.id === 'alerts_active')!
    const concludedPool = stats.pools.find((p) => p.id === 'alerts_concluded')!

    // Each alert delivers to one device, so rows = 1 alert + 1 delivery per pool.
    expect(activePool.rows).toBe(2)
    expect(activePool.bytes).toBeGreaterThan(0)
    expect(activePool.approx).toBe(true)
    expect(concludedPool.rows).toBe(2)
    expect(concludedPool.bytes).toBeGreaterThan(0)
    expect(concludedPool.approx).toBe(true)
  })

  it('counts audit_log rows and reports bytes > 0 once seeded', () => {
    const { db } = setup()
    audit(db, 'system', null, 'something_happened', { detail: 'x'.repeat(50) })
    const stats = computeStorageStats(db, '/nonexistent')
    const pool = stats.pools.find((p) => p.id === 'audit_log')!
    expect(pool.rows).toBeGreaterThanOrEqual(1)
    expect(pool.bytes).toBeGreaterThan(0)
    expect(typeof pool.approx).toBe('boolean')
  })

  it('counts feed_rows (stream pushes) and reports bytes > 0 once seeded', () => {
    const { db, snd } = setup()
    const feed = createFeed(db, { name: 'stream feed', mode: 'stream' }, 1000)
    pushStreamRow(db, feed.id, { v: 'hello world, this is a stream row payload' }, snd, 2000)
    pushStreamRow(db, feed.id, { v: 'a second row' }, snd, 3000)

    const stats = computeStorageStats(db, '/nonexistent')
    const pool = stats.pools.find((p) => p.id === 'feed_rows')!
    expect(pool.rows).toBe(2)
    expect(pool.bytes).toBeGreaterThan(0)
  })

  it('counts feed value payloads and reports bytes > 0 once seeded', () => {
    const { db, snd } = setup()
    const feed = createFeed(db, { name: 'value feed', mode: 'value' }, 1000)
    pushValue(db, feed.id, { temp: 21.5, note: 'a fairly long payload string for byte counting' }, snd, 2000)

    const stats = computeStorageStats(db, '/nonexistent')
    const pool = stats.pools.find((p) => p.id === 'feed_values')!
    expect(pool.rows).toBe(1)
    expect(pool.bytes).toBeGreaterThan(0)
    expect(pool.approx).toBe(true)
  })

  it('an empty database reports zero rows for every pool, none of it throwing', () => {
    const { db } = setup()
    const stats = computeStorageStats(db, '/nonexistent')
    for (const pool of stats.pools) expect(pool.rows).toBe(0)
    // The LENGTH()-based (approx) pools have nothing to sum, so they're genuinely 0 bytes. The
    // two dbstat-backed pools (audit_log, feed_rows) are NOT: SQLite allocates a root page for a
    // table the moment it's created, empty or not, and dbstat reports that real page — a witness
    // that dbstat's bytes are actual page accounting, not a derived estimate.
    const approxPools = stats.pools.filter((p) => p.approx)
    for (const pool of approxPools) expect(pool.bytes).toBe(0)
    expect(approxPools.length).toBeGreaterThan(0)
  })
})

describe('computeImagesBytes', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dbz-storage-test-'))
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('is 0 for a data dir with no feeds/ or themes/ subdirectory', () => {
    expect(computeImagesBytes(dataDir)).toBe(0)
  })

  it('sums file sizes under feeds/ and themes/', () => {
    mkdirSync(join(dataDir, 'feeds'))
    mkdirSync(join(dataDir, 'themes'))
    writeFileSync(join(dataDir, 'feeds', 'feed_a'), Buffer.alloc(100))
    writeFileSync(join(dataDir, 'feeds', 'feed_b'), Buffer.alloc(50))
    writeFileSync(join(dataDir, 'themes', 'thm_a'), Buffer.alloc(30))
    expect(computeImagesBytes(dataDir)).toBe(180)
  })
})
