import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync as mkdtempRaw, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { hasBrowser } from './support/browser.js'

// Every temp folder this file makes is removed afterwards.
const made: string[] = []
const mkdtempSync = (prefix: string) => { const d = mkdtempRaw(prefix); made.push(d); return d }
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

const SCRIPT = fileURLToPath(new URL('../scripts/check-pack.mjs', import.meta.url))
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

const BOARD = { bg: '#f4ecd8', surface: '#fbf6ea', ink: '#2b2118', dim: '#5c4a38', accent: '#8a5a1f', info: '#2f5f8a', warn: '#8a5a06', critical: '#a32b25', scrim: 0.4, series: ['#8a5a1f', '#2f5f8a', '#5f7a2a', '#a32b25'] }
const MANIFEST = { id: 'vintage', name: 'Vintage', version: '1.0.0', theme: { board: BOARD, backdrop: 'wash', widgets: { gauge: 'vintage-dial' }, recommended: {}, sounds: {} } }
const DESIGN = `const meta = { id: 'vintage-dial', widget: 'gauge', label: 'Brass dial', suggested_ratio: 1,
  tokens: { ink: { type: 'color', default: '@ink' } }, animations: { transition: [], persistent: [] },
  options: { needle: { type: 'select', label: 'Needle', default: 'spade', choices: ['spade', 'arrow'], path: 'design_options.needle' } } }
function draw(g, ctx) { g.fillStyle = ctx.tokens.ink; g.beginPath(); g.arc(ctx.box.w / 2, ctx.box.h / 2, Math.min(ctx.box.w, ctx.box.h) / 3, 0, 6.3); g.fill() }
export default { meta, draw }
`
function pack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbz-pack-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}
const good = () => pack({ 'pack.json': JSON.stringify(MANIFEST), 'designs/gauge/vintage-dial.mjs': DESIGN })

describe('check-pack CLI', () => {
  it('passes a valid pack with exit 0', () => {
    const r = run([good()])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('No problems found.')
  })

  it('explains invalid JSON in pack.json in one line, without a stack trace', () => {
    const r = run([pack({ 'pack.json': '{ "id": "vintage", ' })])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/pack\.json.*is not valid JSON/)
    expect(r.stdout + r.stderr).not.toMatch(/^\s+at /m)
  })

  it('reports a missing theme', () => {
    const { theme: _t, ...noTheme } = MANIFEST
    const r = run([pack({ 'pack.json': JSON.stringify(noTheme) })])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/theme/)
  })

  it('ignores a README, warns about stray files under designs/, and errors on a misplaced design', () => {
    const dir = pack({
      'pack.json': JSON.stringify(MANIFEST), 'README.md': '# hi',
      'designs/gauge/vintage-dial.mjs': DESIGN, 'designs/notes.txt': 'x', 'designs/gauge/.DS_Store': 'x',
    })
    const r = run([dir])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/notes\.txt[\s\S]*not a design file/)
    expect(r.stdout).not.toMatch(/README/)
    const misplaced = run([pack({ 'pack.json': JSON.stringify(MANIFEST), 'designs/clock/vintage-dial.mjs': DESIGN })])
    expect(misplaced.status).toBe(1)
    expect(misplaced.stdout).toMatch(/designs\/gauge\/vintage-dial\.mjs/)
  })

  it('reports a broken link under designs/ instead of crashing', () => {
    const dir = good()
    symlinkSync(join(dir, 'nowhere.mjs'), join(dir, 'designs', 'gauge', 'gone.mjs'))
    const r = run([dir])
    expect(r.stdout + r.stderr).not.toMatch(/^\s+at /m)
    expect(r.stdout).toMatch(/gone\.mjs/)
  })

  it('treats a Chrome path that is not a program as "no Chrome": warning, exit 0', () => {
    const out = mkdtempSync(join(tmpdir(), 'dbz-prev-'))
    const r = run([good(), '--previews', out], { CHROME_PATH: tmpdir() })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Chrome/)
    expect(r.stdout + r.stderr).not.toMatch(/^\s+at /m)
  })

  it.skipIf(!hasBrowser())('keeps preview files inside the previews folder, whatever a choice is called', () => {
    const out = mkdtempSync(join(tmpdir(), 'dbz-prev-'))
    const tricky = DESIGN.replace("choices: ['spade', 'arrow']", "choices: ['spade', 'km/h', '../../escape']")
    const r = run([pack({ 'pack.json': JSON.stringify(MANIFEST), 'designs/gauge/vintage-dial.mjs': tricky }), '--previews', out])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const files = readdirSync(out)
    expect(files).toContain('vintage-dial-needle-km-h.png')
    expect(files.every((f) => !f.includes('/') && !f.startsWith('.'))).toBe(true)
    expect(existsSync(join(out, '..', '..', 'escape.png'))).toBe(false)
  }, 30_000)

  it('prints usage and exits 2 without a folder', () => {
    const r = run([])
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toMatch(/usage/i)
  })

  it('skips previews with a clear warning when Chrome is missing, and still checks', () => {
    const out = mkdtempSync(join(tmpdir(), 'dbz-prev-'))
    const r = run([good(), '--previews', out], { CHROME_PATH: '/nonexistent/chrome' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Chrome/)
    expect(r.stdout).toMatch(/CHROME_PATH/)
  })

  it.skipIf(!hasBrowser())('writes a PNG preview per design, and one per needle choice', () => {
    const out = mkdtempSync(join(tmpdir(), 'dbz-prev-'))
    const r = run([good(), '--previews', out])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    for (const name of ['vintage-dial.png', 'vintage-dial-needle-arrow.png']) {
      const file = join(out, name)
      expect(existsSync(file), name).toBe(true)
      const bytes = readFileSync(file)
      expect(bytes.subarray(1, 4).toString()).toBe('PNG')
      expect(bytes.length).toBeGreaterThan(1000)
    }
  }, 30_000)
})
