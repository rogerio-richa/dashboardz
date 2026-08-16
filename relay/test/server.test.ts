import { describe, expect, it } from 'vitest'
import { buildRelay } from '../src/server.js'
import { loadConfig } from '../src/config.js'

describe('relay server', () => {
  it('answers /health', async () => {
    const app = await buildRelay({ config: loadConfig({}) })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, service: 'dashboardz-relay' })
    await app.close()
  })

  it('defaults the port and reads an override', () => {
    expect(loadConfig({}).port).toBe(8790)
    expect(loadConfig({ PORT: '9999' }).port).toBe(9999)
  })

  it('permits an explicit port 0 (ephemeral, used by tests binding a random port)', () => {
    expect(loadConfig({ PORT: '0' }).port).toBe(0)
  })

  it('rejects an empty PORT instead of silently binding an ephemeral port', () => {
    expect(() => loadConfig({ PORT: '' })).toThrow(/PORT ""/)
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT "abc"/)
  })

  it('defaults trustProxy to false — spoofable behind an unconfigured proxy otherwise', () => {
    expect(loadConfig({}).trustProxy).toBe(false)
  })

  it('reads an explicit trustProxy override in either direction', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true)
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false)
  })

  it('rejects a malformed TRUST_PROXY instead of silently defaulting', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY "yes"/)
  })
})
