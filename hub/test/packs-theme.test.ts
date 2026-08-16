import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES } from '../src/builtinThemes.js'
// @ts-expect-error plain JS module without types
import { checkTheme, checkContrast, checkManifest, contrastRatio } from '../packs/theme.mjs'

type Finding = { level: string; where: string; rule: string; message: string }
const rules = (fs: Finding[]) => fs.map((f) => f.rule)
const BOARD = BUILTIN_THEMES.find((t) => t.id === 'thm_nordic')!.board
const theme = (over: Record<string, unknown> = {}) => ({ board: { ...BOARD }, backdrop: 'flat', widgets: {}, recommended: {}, sounds: {}, ...over })
const manifest = (over: Record<string, unknown> = {}) => ({ id: 'vintage', name: 'Vintage', version: '1.0.0', theme: theme(), ...over })
const CATALOGUE = { clock: ['digital', 'analog'], gauge: ['bar', 'ring'] }

describe('pack theme checks', () => {
  it('every built-in theme passes', () => {
    for (const t of BUILTIN_THEMES) {
      expect(checkTheme({ board: t.board, backdrop: t.backdrop, widgets: t.widgets, recommended: t.recommended, sounds: t.sounds ?? {} }), t.id).toEqual([])
    }
  })

  it('reports ink that is too close to the background, naming both colours and the floor', () => {
    const fs: Finding[] = checkContrast({ ...BOARD, ink: BOARD.bg })
    const ink = fs.find((f) => f.rule === 'theme.contrast.ink')!
    expect(ink.level).toBe('error')
    expect(ink.message).toContain(BOARD.bg)
    expect(ink.message).toContain('4.5:1')
  })

  /** One bad base colour must read as one problem, not as every colour the hub derives from it. */
  it('checks derived colours only once the base colours pass', () => {
    const fs: Finding[] = checkContrast({ ...BOARD, ink: '#c9c9c9', bg: '#ffffff', surface: '#ffffff' })
    expect(rules(fs)).toContain('theme.contrast.ink')
    expect(rules(fs).filter((r) => r === 'theme.contrast.chrome' || r === 'theme.contrast.takeover')).toEqual([])
  })

  it('reports a bad colour, a missing palette colour, a short series and an unknown backdrop', () => {
    const { warn: _w, ...noWarn } = BOARD as unknown as Record<string, unknown>
    expect(rules(checkTheme(theme({ board: { ...BOARD, ink: 'red' } })))).toContain('theme.color')
    expect(rules(checkTheme(theme({ board: noWarn })))).toContain('theme.palette-missing')
    expect(rules(checkTheme(theme({ board: { ...BOARD, series: ['#000000'] } })))).toContain('theme.series')
    expect(rules(checkTheme(theme({ backdrop: 'sparkles' })))).toContain('theme.backdrop')
    expect(rules(checkTheme(theme({ sounds: { siren: 'bells' } })))).toContain('theme.sounds')
  })

  /** Everything the admin theme API would refuse, the checker refuses too. */
  it('refuses what the theme API refuses: unknown keys, bad chrome colours, too many suggestions', () => {
    expect(rules(checkTheme(theme({ recomended: {} })))).toContain('theme.unknown-key')
    expect(rules(checkTheme(theme({ chrome: { muted: 'red' } })))).toContain('theme.color')
    expect(rules(checkTheme(theme({ recommended: { clock: Array.from({ length: 17 }, (_, i) => `c${i}`) } })))).toContain('theme.range')
    expect(rules(checkTheme(theme({ widgets: { clock: 'x'.repeat(41) } })))).toContain('theme.range')
  })

  it('contrastRatio matches WCAG for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })
})

describe('pack manifest checks', () => {
  const ids = [{ widget: 'gauge', id: 'vintage-dial' }]

  it('a good manifest passes', () => {
    expect(checkManifest(manifest({ theme: theme({ widgets: { gauge: 'vintage-dial' }, recommended: { clock: ['analog'] } }) }), ids, CATALOGUE)).toEqual([])
  })

  it('reports a bad id, a missing version and a missing theme', () => {
    expect(rules(checkManifest(manifest({ id: 'Vintage' }), [], CATALOGUE))).toContain('manifest.id')
    expect(rules(checkManifest(manifest({ version: undefined }), [], CATALOGUE))).toContain('manifest.version')
    expect(rules(checkManifest(manifest({ theme: undefined }), [], CATALOGUE))).toContain('manifest.theme')
  })

  it('requires design ids to start with the pack id, and to be new', () => {
    const prefix = checkManifest(manifest(), [{ widget: 'gauge', id: 'dial' }], CATALOGUE)
    expect(prefix.find((f: Finding) => f.rule === 'manifest.design-prefix')!.message).toContain('vintage-')
    expect(rules(checkManifest(manifest({ id: 'bar' }), [{ widget: 'gauge', id: 'bar-x' }, { widget: 'gauge', id: 'bar-x' }], CATALOGUE))).toContain('manifest.duplicate')
  })

  it('survives widget names like toString and constructor', () => {
    const run = () => checkManifest(manifest({ theme: theme({ widgets: { toString: 'x' }, recommended: { constructor: ['x'] } }) }), [], CATALOGUE)
    expect(run).not.toThrow()
    expect(rules(run())).toContain('manifest.unknown-widget')
  })

  it('reports a default or suggestion that names a design nobody has', () => {
    const fs = checkManifest(manifest({ theme: theme({ widgets: { clock: 'nope' } }) }), [], CATALOGUE)
    expect(rules(fs)).toContain('manifest.unknown-design')
    expect(rules(checkManifest(manifest({ theme: theme({ recommended: { gauges: ['bar'] } }) }), [], CATALOGUE))).toContain('manifest.unknown-widget')
  })
})
