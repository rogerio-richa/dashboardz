import type { DB } from './index.js'
import { getSetting, setSetting } from './settings.js'

/** Integer days, or 0 for "keep forever" (RetentionConfig's own documented escape hatch). Anything past this is rejected on write — not a hard technical limit, just a sanity cap against a fat-fingered "36500". */
export const MAX_RETENTION_DAYS = 3650

export const SETTINGS_KEY_ALERTS_DAYS = 'retention_alerts_days'
export const SETTINGS_KEY_AUDIT_DAYS = 'retention_audit_days'

export type RetentionSource = 'setting' | 'env' | 'default'

/**
 * The env/default layer alone — what `config.ts` already knows before any settings-table lookup.
 * `startTtlSweep` carries one of these in its closure for the process's whole lifetime (it is the
 * fallback that never changes without a restart); `resolveRetentionConfig` re-reads the settings
 * table on top of it fresh on every call.
 */
export interface RetentionEnvConfig {
  alertsDays: number
  alertsSource: 'env' | 'default'
  auditDays: number
  auditSource: 'env' | 'default'
}

export interface ResolvedRetention {
  alertsDays: number
  alertsSource: RetentionSource
  auditDays: number
  auditSource: RetentionSource
}

/**
 * Precedence (storage & retention): a `settings` row → the env/default config → the
 * built-in default. The env/default distinction is already folded into `envConfig` by
 * `config.ts` (its `retentionAlertsDaysSource`/`retentionAuditDaysSource`), so this function has
 * exactly one more layer to check: does a settings row exist for this key?
 *
 * Called fresh on every retention pass (ttl.ts) and on every admin request that needs the
 * current effective value — never cached — so a UI edit takes effect on the very next sweep
 * without a restart, as required by the live settings path.
 */
export function resolveRetentionConfig(db: DB, envConfig: RetentionEnvConfig): ResolvedRetention {
  const alertsSetting = getSetting(db, SETTINGS_KEY_ALERTS_DAYS)
  const auditSetting = getSetting(db, SETTINGS_KEY_AUDIT_DAYS)
  return {
    alertsDays: alertsSetting !== null ? Number(alertsSetting) : envConfig.alertsDays,
    alertsSource: alertsSetting !== null ? 'setting' : envConfig.alertsSource,
    auditDays: auditSetting !== null ? Number(auditSetting) : envConfig.auditDays,
    auditSource: auditSetting !== null ? 'setting' : envConfig.auditSource,
  }
}

/** Integer >= 0, capped at MAX_RETENTION_DAYS. Returns null for anything else — the caller turns that into a 400. */
export function validateRetentionDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 0 || value > MAX_RETENTION_DAYS) return null
  return value
}

/** Writes a validated days value as a settings row. Caller (the PATCH route) validates first — this trusts its input. */
export function writeRetentionDays(db: DB, key: typeof SETTINGS_KEY_ALERTS_DAYS | typeof SETTINGS_KEY_AUDIT_DAYS, days: number, now: number): void {
  setSetting(db, key, String(days), now)
}
