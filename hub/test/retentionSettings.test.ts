import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { setSetting } from '../src/db/settings.js'
import {
  resolveRetentionConfig, validateRetentionDays, writeRetentionDays,
  SETTINGS_KEY_ALERTS_DAYS, SETTINGS_KEY_AUDIT_DAYS, MAX_RETENTION_DAYS,
  type RetentionEnvConfig,
} from '../src/db/retentionSettings.js'

const envDefault: RetentionEnvConfig = {
  alertsDays: 90, alertsSource: 'default', auditDays: 180, auditSource: 'default',
}
const envSet: RetentionEnvConfig = {
  alertsDays: 30, alertsSource: 'env', auditDays: 60, auditSource: 'env',
}

describe('resolveRetentionConfig precedence', () => {
  it('falls back to the built-in default when nothing else is set', () => {
    const db = openDb(':memory:')
    expect(resolveRetentionConfig(db, envDefault)).toEqual({
      alertsDays: 90, alertsSource: 'default', auditDays: 180, auditSource: 'default',
    })
  })

  it('an env value outranks the built-in default', () => {
    const db = openDb(':memory:')
    expect(resolveRetentionConfig(db, envSet)).toEqual({
      alertsDays: 30, alertsSource: 'env', auditDays: 60, auditSource: 'env',
    })
  })

  it('a settings row outranks an env value', () => {
    const db = openDb(':memory:')
    setSetting(db, SETTINGS_KEY_ALERTS_DAYS, '14', 1000)
    expect(resolveRetentionConfig(db, envSet)).toEqual({
      alertsDays: 14, alertsSource: 'setting', auditDays: 60, auditSource: 'env',
    })
  })

  it('a settings row outranks the built-in default', () => {
    const db = openDb(':memory:')
    setSetting(db, SETTINGS_KEY_AUDIT_DAYS, '7', 1000)
    expect(resolveRetentionConfig(db, envDefault)).toEqual({
      alertsDays: 90, alertsSource: 'default', auditDays: 7, auditSource: 'setting',
    })
  })

  it('each key resolves independently — a setting on one does not affect the other', () => {
    const db = openDb(':memory:')
    setSetting(db, SETTINGS_KEY_ALERTS_DAYS, '5', 1000)
    const resolved = resolveRetentionConfig(db, envSet)
    expect(resolved.alertsDays).toBe(5)
    expect(resolved.alertsSource).toBe('setting')
    expect(resolved.auditDays).toBe(60) // still envSet's value, untouched
    expect(resolved.auditSource).toBe('env')
  })

  it('a settings row of "0" resolves to 0 (keep forever), not falling through to env/default', () => {
    const db = openDb(':memory:')
    setSetting(db, SETTINGS_KEY_ALERTS_DAYS, '0', 1000)
    expect(resolveRetentionConfig(db, envSet).alertsDays).toBe(0)
    expect(resolveRetentionConfig(db, envSet).alertsSource).toBe('setting')
  })

  it('re-reads live: a settings row written mid-test is picked up on the very next call, no caching', () => {
    const db = openDb(':memory:')
    expect(resolveRetentionConfig(db, envDefault).alertsDays).toBe(90)
    setSetting(db, SETTINGS_KEY_ALERTS_DAYS, '3', 2000)
    expect(resolveRetentionConfig(db, envDefault).alertsDays).toBe(3)
    expect(resolveRetentionConfig(db, envDefault).alertsSource).toBe('setting')
  })
})

describe('validateRetentionDays', () => {
  it('accepts a positive integer', () => {
    expect(validateRetentionDays(30)).toBe(30)
  })
  it('accepts 0 (keep forever)', () => {
    expect(validateRetentionDays(0)).toBe(0)
  })
  it('accepts the cap itself', () => {
    expect(validateRetentionDays(MAX_RETENTION_DAYS)).toBe(MAX_RETENTION_DAYS)
  })
  it('rejects a value past the cap', () => {
    expect(validateRetentionDays(MAX_RETENTION_DAYS + 1)).toBeNull()
  })
  it('rejects a negative integer', () => {
    expect(validateRetentionDays(-1)).toBeNull()
  })
  it('rejects a non-integer number', () => {
    expect(validateRetentionDays(1.5)).toBeNull()
  })
  it('rejects a non-number', () => {
    expect(validateRetentionDays('30')).toBeNull()
    expect(validateRetentionDays(null)).toBeNull()
    expect(validateRetentionDays(undefined)).toBeNull()
  })
})

describe('writeRetentionDays', () => {
  it('writes a settings row that resolveRetentionConfig then reports as source "setting"', () => {
    const db = openDb(':memory:')
    writeRetentionDays(db, SETTINGS_KEY_AUDIT_DAYS, 45, 1000)
    expect(resolveRetentionConfig(db, envDefault)).toEqual({
      alertsDays: 90, alertsSource: 'default', auditDays: 45, auditSource: 'setting',
    })
  })
})
