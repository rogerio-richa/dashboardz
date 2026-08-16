import type { DB } from './index.js'

/**
 * Generic admin-editable key/value store (v26, storage & retention) — the first, and so
 * far only, consumer is the two retention windows (`db/retentionSettings.ts`), but the table
 * itself knows nothing about retention: `value` is always TEXT, and each caller parses and
 * validates its own key's shape. That is what lets a future setting land with no migration of
 * its own, whatever type it needs.
 *
 * Deliberately thin — three one-statement functions, not a class or a cache. A settings read is
 * on the retention sweep's hot path (re-read every pass, per the precedence rule), and a cache
 * would be one more place a UI edit could appear to "not take effect" until something invalidated
 * it. SQLite reads a PRIMARY KEY lookup fast enough that this has never needed to be sped up.
 */
export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

/** Upsert: a key already present is overwritten in place, `updated_at` included. */
export function setSetting(db: DB, key: string, value: string, now: number): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now)
}

/** A missing key is not an error — deleting an already-absent setting is a no-op, same as SQL DELETE always is. */
export function deleteSetting(db: DB, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}
