import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The example pack in examples/theme-packs/vintage is what docs/theme-packs.md walks through, so it
 * must always pass the checker cleanly: no errors and no warnings.
 */
describe('the example theme pack', () => {
  it('passes the pack checker with no findings at all', () => {
    const script = fileURLToPath(new URL('../scripts/check-pack.mjs', import.meta.url))
    const pack = fileURLToPath(new URL('../../examples/theme-packs/vintage', import.meta.url))
    const r = spawnSync(process.execPath, [script, pack], { encoding: 'utf8' })
    expect(r.stdout + r.stderr).toContain('No problems found.')
    expect(r.status).toBe(0)
  })
})
