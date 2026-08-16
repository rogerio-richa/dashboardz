import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('token config', () => {
  it('defaults to no tokens, not required, no admin token', () => {
    const c = loadConfig({})
    expect(c.tokensPath).toBeNull()
    expect(c.requireToken).toBe(false)
    expect(c.adminToken).toBeNull()
  })
  it('reads TOKENS_PATH, REQUIRE_TOKEN and ADMIN_TOKEN', () => {
    const c = loadConfig({ TOKENS_PATH: '/data/tokens.json', REQUIRE_TOKEN: 'true', ADMIN_TOKEN: 'adm_x' })
    expect(c.tokensPath).toBe('/data/tokens.json')
    expect(c.requireToken).toBe(true)
    expect(c.adminToken).toBe('adm_x')
  })
  it('refuses REQUIRE_TOKEN without TOKENS_PATH — that combination locks every hub out', () => {
    expect(() => loadConfig({ REQUIRE_TOKEN: 'true' })).toThrow(/TOKENS_PATH/)
  })
  it('rejects a REQUIRE_TOKEN value that is neither true nor false', () => {
    expect(() => loadConfig({ TOKENS_PATH: '/t.json', REQUIRE_TOKEN: 'yes' })).toThrow(/REQUIRE_TOKEN/)
  })
  it('rejects an empty TOKENS_PATH — set-but-empty is a misconfiguration, not "unset"', () => {
    expect(() => loadConfig({ TOKENS_PATH: '' })).toThrow(/TOKENS_PATH/)
  })
})
