import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { getOrCreateIdentity } from '../src/relay/identity.js'

describe('relay identity', () => {
  it('generates once and is stable across calls', () => {
    const db = openDb(':memory:')
    const a = getOrCreateIdentity(db)
    expect(a.hubUid).toMatch(/^hub_[A-Za-z0-9_-]{22}$/)
    expect(a.hubSecret).toHaveLength(43)
    expect(getOrCreateIdentity(db)).toEqual(a)
  })

  it('two hubs never share a uid', () => {
    expect(getOrCreateIdentity(openDb(':memory:')).hubUid)
      .not.toBe(getOrCreateIdentity(openDb(':memory:')).hubUid)
  })
})
