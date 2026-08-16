import { describe, expect, it, vi } from 'vitest'
import { buildNotifyOpts, parseArgs, validateNotifyFlags, type Flags } from '../src/cli.js'

/**
 * `fail()` (cli.ts) writes to stderr and calls `process.exit(2)`. Real code relies on
 * `process.exit` never returning (the call sites are typed `never`), so the mock must throw —
 * that both stops execution at the right point and gives the test something to catch.
 */
function captureExit(fn: () => void): number | undefined {
  let code: number | undefined
  const spy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c
    throw new Error(`process.exit(${c})`)
  }) as never)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    fn()
  } catch {
    // expected: the mocked exit throws to unwind
  } finally {
    spy.mockRestore()
    stderr.mockRestore()
  }
  return code
}

/** Captures stderr writes without also mocking process.exit — for cases that must NOT exit. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk)); return true
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return chunks.join('')
}

const base: Flags = {
  devices: [], options: [], sound: false, resolve: false,
  relay: 'wss://relay.example/ws', hub: 'hub_x', token: 'dbz_s_t',
}

describe('parseArgs --resolve', () => {
  it('parses --resolve as a boolean flag alongside --dedup-key', () => {
    const f = parseArgs(['--resolve', '--dedup-key', 'raid-nas01', '--relay', 'r', '--hub', 'h', '--token', 't'])
    expect(f.resolve).toBe(true)
    expect(f.dedupKey).toBe('raid-nas01')
  })

  it('defaults resolve to false when the flag is absent', () => {
    const f = parseArgs(['--relay', 'r'])
    expect(f.resolve).toBe(false)
  })
})

describe('validateNotifyFlags', () => {
  it('requires --relay/--hub/--token regardless of --resolve', () => {
    const code = captureExit(() => validateNotifyFlags({ ...base, relay: undefined }))
    expect(code).toBe(2)
  })

  it('rejects --resolve without --dedup-key', () => {
    const code = captureExit(() => validateNotifyFlags({ ...base, resolve: true }))
    expect(code).toBe(2)
  })

  it('accepts --resolve with --dedup-key and no --title/--severity', () => {
    expect(() => validateNotifyFlags({ ...base, resolve: true, dedupKey: 'raid-nas01' })).not.toThrow()
  })

  it('rejects --wait together with --resolve', () => {
    const code = captureExit(() => validateNotifyFlags({ ...base, resolve: true, dedupKey: 'k', wait: 30 }))
    expect(code).toBe(2)
  })

  it('still requires --title and --severity for a create (no --resolve)', () => {
    const codeNoTitle = captureExit(() => validateNotifyFlags({ ...base, severity: 'info' }))
    expect(codeNoTitle).toBe(2)
    const codeNoSeverity = captureExit(() => validateNotifyFlags({ ...base, title: 'x' }))
    expect(codeNoSeverity).toBe(2)
  })

  it('rejects an invalid --severity for a create', () => {
    const code = captureExit(() => validateNotifyFlags({ ...base, title: 'x', severity: 'apocalyptic' }))
    expect(code).toBe(2)
  })

  it('accepts a normal create with --wait and no --resolve', () => {
    expect(() => validateNotifyFlags({ ...base, title: 'x', severity: 'info', wait: 30 })).not.toThrow()
  })

  it('warns on stderr (without exiting) when --resolve is combined with create-only flags', () => {
    const out = captureStderr(() => validateNotifyFlags({
      ...base, resolve: true, dedupKey: 'k',
      title: 'x', body: 'y', devices: ['dev_1'], options: [{ id: 'o', label: 'O' }], sound: true, ttl: 60,
    }))
    for (const flag of ['--title', '--body', '--device', '--option', '--sound', '--ttl']) {
      expect(out).toContain(flag)
    }
  })

  it('does not warn for a plain --resolve carrying only --dedup-key', () => {
    const out = captureStderr(() => validateNotifyFlags({ ...base, resolve: true, dedupKey: 'k' }))
    expect(out).toBe('')
  })
})

describe('buildNotifyOpts', () => {
  it('builds a resolve-only payload: resolve + dedup_key, no title/severity/other fields', () => {
    const opts = buildNotifyOpts({ ...base, resolve: true, dedupKey: 'raid-nas01' })
    expect(opts).toEqual({ resolve: true, dedup_key: 'raid-nas01' })
  })

  it('builds a normal create payload, unaffected by resolve support', () => {
    const opts = buildNotifyOpts({ ...base, title: 'Backup done', severity: 'info', dedupKey: 'k' })
    expect(opts).toMatchObject({ title: 'Backup done', severity: 'info', dedup_key: 'k' })
    expect(opts.resolve).toBeUndefined()
  })
})
