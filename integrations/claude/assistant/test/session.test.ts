import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { loadRuntime, saveRuntime } from '../src/runtime.js'
import { buildOptions } from '../src/session.js'

const cfg = loadConfig({
  DASHBOARDZ_HUB_URL: 'http://h:1',
  DASHBOARDZ_SENDER_TOKEN: 'dbz_s_x',
  DASHBOARDZ_AGENT_TOKEN: 'dbz_a_x',
  DASHBOARDZ_MCP: '/repo/clients/mcp/dist/cli.js',
})

describe('runtime config', () => {
  it('defaults when absent and round-trips saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbza-'))
    expect(loadRuntime(dir)).toEqual({ permissionMode: 'default' })
    saveRuntime(dir, { model: 'claude-opus-5', permissionMode: 'plan' })
    expect(loadRuntime(dir)).toEqual({ model: 'claude-opus-5', permissionMode: 'plan' })
  })
})

describe('buildOptions', () => {
  it('maps runtime + config into SDK options with the dashboardz MCP attached', () => {
    const o = buildOptions(cfg, { model: 'claude-opus-5', permissionMode: 'plan' }) as any
    expect(o.model).toBe('claude-opus-5')
    expect(o.permissionMode).toBe('plan')
    expect(o.mcpServers.dashboardz).toEqual({
      command: 'node',
      args: ['/repo/clients/mcp/dist/cli.js'],
      env: { DASHBOARDZ_HUB_URL: 'http://h:1', DASHBOARDZ_TOKEN: 'dbz_a_x' },
    })
    expect(o.allowedTools).toEqual(['mcp__dashboardz__*'])
  })
  it('omits model when unset so the SDK default applies', () => {
    expect((buildOptions(cfg, { permissionMode: 'default' }) as any).model).toBeUndefined()
  })
})
