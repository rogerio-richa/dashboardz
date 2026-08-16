import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { getSetting, setSetting, deleteSetting } from '../src/db/settings.js'

describe('settings accessors', () => {
  it('getSetting returns null for a key that was never set', () => {
    const db = openDb(':memory:')
    expect(getSetting(db, 'nope')).toBeNull()
  })

  it('setSetting then getSetting round-trips the value', () => {
    const db = openDb(':memory:')
    setSetting(db, 'retention_alerts_days', '30', 1000)
    expect(getSetting(db, 'retention_alerts_days')).toBe('30')
  })

  it('setSetting on an existing key overwrites the value and updated_at', () => {
    const db = openDb(':memory:')
    setSetting(db, 'k', 'first', 1000)
    setSetting(db, 'k', 'second', 2000)
    expect(getSetting(db, 'k')).toBe('second')
    const row = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get('k') as
      { value: string; updated_at: number }
    expect(row).toEqual({ value: 'second', updated_at: 2000 })
    // Overwriting a key must not leave a second row behind.
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 1 })
  })

  it('deleteSetting removes the row', () => {
    const db = openDb(':memory:')
    setSetting(db, 'k', 'v', 1000)
    deleteSetting(db, 'k')
    expect(getSetting(db, 'k')).toBeNull()
  })

  it('deleteSetting on an absent key is a no-op, not an error', () => {
    const db = openDb(':memory:')
    expect(() => deleteSetting(db, 'never-set')).not.toThrow()
  })

  it('settings are independent by key', () => {
    const db = openDb(':memory:')
    setSetting(db, 'a', '1', 1000)
    setSetting(db, 'b', '2', 1000)
    expect(getSetting(db, 'a')).toBe('1')
    expect(getSetting(db, 'b')).toBe('2')
  })
})
