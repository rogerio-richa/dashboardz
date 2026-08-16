import type { DB } from './index.js'

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionConfig {
  /** Days a concluded (non-active) alert and its deliveries survive. 0 keeps them forever. */
  alertsDays: number
  /** Days an audit_log row survives. 0 keeps it forever. */
  auditDays: number
}

export interface RetentionResult {
  alerts: number
  audit: number
}

/**
 * The one-shot deletion pass, run in a single transaction so a crash mid-pass can never leave
 * `deliveries` rows orphaned from the `alerts` row that owned them, or vice versa.
 *
 * Only a CONCLUDED alert (`status != 'active'`) is ever in scope, however old — an active alert
 * has no end yet, by definition, and pruning it out from under a device would be indistinguishable
 * from data loss. `alerts.created_at` is the age used for alerts (not `updated_at`): retention is
 * about how long a row has existed, not how recently it changed.
 *
 * `audit_log` is pruned independently, on its own cutoff and its own column (`ts`, not
 * `created_at` — the two tables don't share a timestamp name).
 */
export function sweepRetention(db: DB, now: number, config: RetentionConfig): RetentionResult {
  const sweep = db.transaction(() => {
    let alerts = 0
    if (config.alertsDays > 0) {
      const cutoff = now - config.alertsDays * DAY_MS
      db.prepare(`
        DELETE FROM deliveries WHERE alert_id IN (
          SELECT id FROM alerts WHERE status != 'active' AND created_at < ?
        )`).run(cutoff)
      alerts = db.prepare(
        "DELETE FROM alerts WHERE status != 'active' AND created_at < ?",
      ).run(cutoff).changes as number
    }

    let audit = 0
    if (config.auditDays > 0) {
      const cutoff = now - config.auditDays * DAY_MS
      audit = db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes as number
    }

    return { alerts, audit }
  })
  return sweep()
}
