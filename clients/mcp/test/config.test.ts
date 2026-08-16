import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('config resolution', () => {
  it('env wins; the token file is the fallback; missing token is an actionable error', () => {
    expect(resolveConfig({ DASHBOARDZ_HUB_URL: 'http://h:8484', DASHBOARDZ_TOKEN: 'dbz_a_env' }, () => 'dbz_a_file'))
      .toEqual({ hubUrl: 'http://h:8484', token: 'dbz_a_env' })
    expect(resolveConfig({ DASHBOARDZ_HUB_URL: 'http://h:8484' }, () => ' dbz_a_file\n'))
      .toEqual({ hubUrl: 'http://h:8484', token: 'dbz_a_file' })
    // A CI-injected trailing newline on an env var is a common, silent failure mode — the file
    // token is already trimmed above; the env token must be too, or auth fails with no clue why.
    expect(resolveConfig({ DASHBOARDZ_HUB_URL: 'http://h:8484', DASHBOARDZ_TOKEN: ' dbz_a_env\n' }, () => 'unused'))
      .toEqual({ hubUrl: 'http://h:8484', token: 'dbz_a_env' })
    expect(() => resolveConfig({ DASHBOARDZ_HUB_URL: 'http://h:8484' }, () => null)).toThrow(/DASHBOARDZ_TOKEN|token/)
    expect(() => resolveConfig({}, () => 'x')).toThrow(/DASHBOARDZ_HUB_URL/)
  })
})
