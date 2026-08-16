import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenStore, hashToken } from '../src/tokens.js'

let path: string
beforeEach(() => { path = join(mkdtempSync(join(tmpdir(), 'relay-tok-')), 'tokens.json') })

const ALICE = { label: 'alice', maxClients: 2, createdAt: 1 }

function write(accounts: Record<string, unknown>, tokens: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ version: 1, accounts, tokens }))
}

describe('TokenStore', () => {
  it('resolves a known token to its account and limit', () => {
    write({ acc_x: ALICE }, { [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 } })
    expect(new TokenStore(path).validate('dzr_abc')).toEqual({ accountId: 'acc_x', label: 'alice', maxClients: 2 })
  })

  it('rejects an unknown token', () => {
    write({ acc_x: ALICE }, { [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 } })
    expect(new TokenStore(path).validate('dzr_nope')).toBeNull()
  })

  it('rejects a revoked token while its account keeps working for other tokens', () => {
    write({ acc_x: ALICE }, {
      [hashToken('dzr_old')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1, revokedAt: 5 },
      [hashToken('dzr_new')]: { id: 'tk_2', accountId: 'acc_x', createdAt: 6 },
    })
    const store = new TokenStore(path)
    expect(store.validate('dzr_old')).toBeNull()
    expect(store.validate('dzr_new')?.accountId).toBe('acc_x')
  })

  it('rejects a token whose account is missing', () => {
    write({}, { [hashToken('dzr_orphan')]: { id: 'tk_1', accountId: 'acc_gone', createdAt: 1 } })
    expect(new TokenStore(path).validate('dzr_orphan')).toBeNull()
  })

  it('never stores the plaintext token', () => {
    write({ acc_x: ALICE }, { [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 } })
    expect(readFileSync(path, 'utf8')).not.toContain('dzr_abc')
  })

  it('picks up a token minted after construction, without a restart', () => {
    write({ acc_x: ALICE }, {})
    const store = new TokenStore(path)
    expect(store.validate('dzr_new')).toBeNull()
    write({ acc_x: ALICE }, { [hashToken('dzr_new')]: { id: 'tk_2', accountId: 'acc_x', createdAt: 3 } })
    utimesSync(path, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
    expect(store.validate('dzr_new')?.label).toBe('alice')
  })

  it('treats a missing or corrupt file as no accounts, never throwing', () => {
    expect(new TokenStore(join(tmpdir(), 'relay-tok-missing', 'nope.json')).validate('anything')).toBeNull()
    writeFileSync(path, '{ not json')
    expect(new TokenStore(path).validate('anything')).toBeNull()
  })

  it('skips an account with a non-numeric maxClients, failing its tokens closed', () => {
    write({ acc_x: { label: 'alice', maxClients: '2', createdAt: 1 } }, {
      [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    expect(new TokenStore(path).validate('dzr_abc')).toBeNull()
  })

  it('skips an account with a negative maxClients, failing its tokens closed', () => {
    write({ acc_x: { label: 'alice', maxClients: -1, createdAt: 1 } }, {
      [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    expect(new TokenStore(path).validate('dzr_abc')).toBeNull()
  })

  it('keeps an account with maxClients 0 — a real "no clients allowed" value, not falsy-therefore-missing', () => {
    write({ acc_x: { label: 'alice', maxClients: 0, createdAt: 1 } }, {
      [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    expect(new TokenStore(path).validate('dzr_abc')).toEqual({ accountId: 'acc_x', label: 'alice', maxClients: 0 })
  })

  it('treats maxClients null as unlimited', () => {
    write({ acc_x: { label: 'alice', maxClients: null, createdAt: 1 } }, {
      [hashToken('dzr_abc')]: { id: 'tk_1', accountId: 'acc_x', createdAt: 1 },
    })
    expect(new TokenStore(path).validate('dzr_abc')).toEqual({ accountId: 'acc_x', label: 'alice', maxClients: null })
  })

  it('lists accounts sorted by label and resolves one by id', () => {
    write({ acc_z: { label: 'zoe', maxClients: null, createdAt: 1 }, acc_a: { label: 'ana', maxClients: 1, createdAt: 2 } }, {})
    const store = new TokenStore(path)
    expect(store.accounts().map(a => a.label)).toEqual(['ana', 'zoe'])
    expect(store.account('acc_a')?.maxClients).toBe(1)
    expect(store.account('acc_missing')).toBeNull()
  })
})
