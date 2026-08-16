import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { LATEST_VERSION } from '../src/db/migrate.js'

describe('openDb', () => {
  it('creates all tables and sets pragmas', () => {
    const db = openDb(':memory:')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r: any) => r.name)
    expect(tables).toEqual(expect.arrayContaining([
      'senders', 'devices', 'pairing_codes', 'alerts', 'deliveries', 'audit_log',
    ]))
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })
  it('is idempotent on reopen', () => {
    const db = openDb(':memory:')
    expect(() => db.exec('SELECT 1')).not.toThrow()
  })
})
