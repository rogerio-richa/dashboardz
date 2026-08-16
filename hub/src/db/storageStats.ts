import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './index.js'

export interface PoolStat {
  id: string
  label: string
  rows: number
  bytes: number
  /** True when `bytes` is a rough LENGTH()-based estimate rather than SQLite's own page accounting. */
  approx: boolean
}

export interface StorageStats {
  db_bytes: number
  images_bytes: number
  pools: PoolStat[]
}

/**
 * `dbstat` (better-sqlite3 usually ships it, but it is a compile-time SQLite extension, not a
 * guaranteed one) gives exact, real page-accounting bytes for an ENTIRE table — but only for an
 * entire table. It cannot answer "how many bytes belong to just the WHERE status != 'active'
 * rows of `alerts`", because a table's pages hold a mix of whatever rows SQLite put on them; a
 * predicate does not correspond to a set of pages. So it's used only for the two pools below that
 * map 1:1 onto a whole table (`audit_log`, `feed_rows`); probed with a try/catch because
 * whether it's compiled in is a property of the SQLite build, not something worth crashing over
 * if it's missing — the LENGTH() fallback below is what `approx: true` exists to be honest about.
 */
function dbstatTableBytes(db: DB, table: string): number | null {
  try {
    const row = db.prepare('SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ?').get(table) as
      { bytes: number | null }
    return row?.bytes ?? 0
  } catch {
    return null
  }
}

/** Sums file sizes in a directory; a missing directory (never written to, e.g. a hub with no image feeds yet) is 0, not an error. */
function dirBytes(dir: string): number {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  let total = 0
  for (const name of entries) {
    try {
      total += statSync(join(dir, name)).size
    } catch {
      // Raced against a concurrent delete/rename between readdir and stat — skip, don't crash a
      // read-only stats endpoint over a file that is, by the time we'd report it, already gone.
    }
  }
  return total
}

/**
 * Bytes of on-disk image blobs, OUTSIDE the sqlite file — `feedImage.ts`'s `imagePath`/
 * `themeBgPath` both write under `dataDir`, one directory each (feed images, theme backgrounds),
 * and neither lives in a DB table the sweep or this stats view otherwise accounts for.
 */
export function computeImagesBytes(dataDir: string): number {
  return dirBytes(join(dataDir, 'feeds')) + dirBytes(join(dataDir, 'themes'))
}

/**
 * Storage stats (storage & retention) — five pools chosen to line up with what the
 * retention sweep actually prunes (concluded alerts/deliveries, audit_log) plus the two other
 * pools an operator sizing "how much room does this eat" would want to see (active alerts, which
 * retention never touches; feed rows and feed value payloads, which retention does not touch
 * either but which can still dominate a busy hub's disk use).
 */
export function computeStorageStats(db: DB, dataDir: string): StorageStats {
  const pageCount = db.pragma('page_count', { simple: true }) as number
  const pageSize = db.pragma('page_size', { simple: true }) as number

  const concludedAlerts = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(
      LENGTH(id) + LENGTH(sender_id) + LENGTH(title) + LENGTH(COALESCE(body, '')) +
      LENGTH(COALESCE(options, '')) + LENGTH(COALESCE(reply_to, '')) + LENGTH(target_devices) + 40
    ), 0) AS bytes
    FROM alerts WHERE status != 'active'
  `).get() as { rows: number; bytes: number }
  const concludedDeliveries = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(
      LENGTH(alert_id) + LENGTH(device_id) + LENGTH(COALESCE(answer, '')) + 24
    ), 0) AS bytes
    FROM deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE status != 'active')
  `).get() as { rows: number; bytes: number }

  const activeAlerts = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(
      LENGTH(id) + LENGTH(sender_id) + LENGTH(title) + LENGTH(COALESCE(body, '')) +
      LENGTH(COALESCE(options, '')) + LENGTH(COALESCE(reply_to, '')) + LENGTH(target_devices) + 40
    ), 0) AS bytes
    FROM alerts WHERE status = 'active'
  `).get() as { rows: number; bytes: number }
  const activeDeliveries = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(
      LENGTH(alert_id) + LENGTH(device_id) + LENGTH(COALESCE(answer, '')) + 24
    ), 0) AS bytes
    FROM deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE status = 'active')
  `).get() as { rows: number; bytes: number }

  const auditBytes = dbstatTableBytes(db, 'audit_log')
  const auditRows = db.prepare('SELECT COUNT(*) AS rows FROM audit_log').get() as { rows: number }
  const auditEstimate = () => db.prepare(`
    SELECT COALESCE(SUM(
      LENGTH(event) + LENGTH(actor_type) + LENGTH(COALESCE(actor_id, '')) + LENGTH(details) + 24
    ), 0) AS bytes
    FROM audit_log
  `).get() as { bytes: number }

  const feedRowsBytes = dbstatTableBytes(db, 'feed_rows')
  const feedRowsCount = db.prepare('SELECT COUNT(*) AS rows FROM feed_rows').get() as { rows: number }
  const feedRowsEstimate = () => db.prepare(`
    SELECT COALESCE(SUM(LENGTH(payload) + LENGTH(feed_id) + LENGTH(pushed_by) + 16), 0) AS bytes
    FROM feed_rows
  `).get() as { bytes: number }

  const feedValues = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
    FROM feeds WHERE payload IS NOT NULL
  `).get() as { rows: number; bytes: number }

  const pools: PoolStat[] = [
    {
      id: 'alerts_concluded', label: 'Concluded alerts',
      rows: concludedAlerts.rows + concludedDeliveries.rows,
      bytes: concludedAlerts.bytes + concludedDeliveries.bytes,
      approx: true, // a row subset of a shared table — dbstat cannot isolate it, see dbstatTableBytes
    },
    {
      id: 'alerts_active', label: 'Active alerts',
      rows: activeAlerts.rows + activeDeliveries.rows,
      bytes: activeAlerts.bytes + activeDeliveries.bytes,
      approx: true,
    },
    {
      id: 'audit_log', label: 'Audit log',
      rows: auditRows.rows,
      bytes: auditBytes ?? auditEstimate().bytes,
      approx: auditBytes === null,
    },
    {
      id: 'feed_rows', label: 'Feed rows (journal/streams)',
      rows: feedRowsCount.rows,
      bytes: feedRowsBytes ?? feedRowsEstimate().bytes,
      approx: feedRowsBytes === null,
    },
    {
      id: 'feed_values', label: 'Feed value payloads',
      rows: feedValues.rows,
      bytes: feedValues.bytes,
      approx: true, // a column subset of the shared `feeds` table, same reasoning as the alert pools
    },
  ]

  return {
    db_bytes: pageCount * pageSize,
    images_bytes: computeImagesBytes(dataDir),
    pools,
  }
}
