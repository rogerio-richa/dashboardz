import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const BASE = {
  DASHBOARDZ_HUB_URL: 'http://hub.example.lan:8484',
  DASHBOARDZ_SENDER_TOKEN: 'dbz_s_x',
  DASHBOARDZ_AGENT_TOKEN: 'dbz_a_x',
}

describe('loadConfig', () => {
  it('loads required values and applies defaults', () => {
    const cfg = loadConfig({ ...BASE })
    expect(cfg.hubUrl).toBe('http://hub.example.lan:8484')
    expect(cfg.tickMs).toBe(30_000)
    expect(cfg.devices).toEqual([])
    expect(cfg.adherenceFeed).toBeNull()
    expect(cfg.dataDir.endsWith('/dashboardz-assistant')).toBe(true)
    expect(cfg.mcpCli.endsWith('clients/mcp/dist/cli.js')).toBe(true)
  })
  it('strips a trailing slash from the hub url', () => {
    expect(loadConfig({ ...BASE, DASHBOARDZ_HUB_URL: 'http://h:1/' }).hubUrl).toBe('http://h:1')
  })
  it('parses devices and overrides', () => {
    const cfg = loadConfig({ ...BASE, ASSISTANT_DEVICES: 'dev_a, dev_b', ASSISTANT_TICK_MS: '5000', ASSISTANT_ADHERENCE_FEED: 'feed_x' })
    expect(cfg.devices).toEqual(['dev_a', 'dev_b'])
    expect(cfg.tickMs).toBe(5000)
    expect(cfg.adherenceFeed).toBe('feed_x')
  })
  it('names the missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DASHBOARDZ_HUB_URL/)
  })
  it('rejects a non-numeric ASSISTANT_TICK_MS', () => {
    expect(() => loadConfig({ ...BASE, ASSISTANT_TICK_MS: 'abc' })).toThrow(/ASSISTANT_TICK_MS/)
  })
  it('rejects a zero or negative ASSISTANT_TICK_MS', () => {
    expect(() => loadConfig({ ...BASE, ASSISTANT_TICK_MS: '0' })).toThrow(/ASSISTANT_TICK_MS/)
    expect(() => loadConfig({ ...BASE, ASSISTANT_TICK_MS: '-100' })).toThrow(/ASSISTANT_TICK_MS/)
  })
  it('accepts a valid ASSISTANT_TICK_MS', () => {
    expect(loadConfig({ ...BASE, ASSISTANT_TICK_MS: '5000' }).tickMs).toBe(5000)
  })
})
