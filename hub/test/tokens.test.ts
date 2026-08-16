import { describe, expect, it } from 'vitest'
import { newId } from '../src/ids.js'
import { generateToken, hashToken } from '../src/auth/tokens.js'
import { openDb } from '../src/db/index.js'
import { audit } from '../src/db/audit.js'

describe('ids and tokens', () => {
  it('newId prefixes and is unique', () => {
    const a = newId('alr'); const b = newId('alr')
    expect(a).toMatch(/^alr_[A-Za-z0-9_-]{8}$/)
    expect(a).not.toBe(b)
  })
  it('generateToken uses kind prefix', () => {
    expect(generateToken('sender')).toMatch(/^dbz_s_[A-Za-z0-9_-]{43}$/)
    expect(generateToken('device')).toMatch(/^dbz_c_[A-Za-z0-9_-]{43}$/)
  })
  it('hashToken is a stable sha256 hex', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })
  it('audit writes a row', () => {
    const db = openDb(':memory:')
    audit(db, 'system', null, 'test_event', { a: 1 })
    const row = db.prepare('SELECT * FROM audit_log').get() as any
    expect(row.event).toBe('test_event')
    expect(JSON.parse(row.details)).toEqual({ a: 1 })
  })
})
