import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, migrateV13 } from '../src/db/migrate.js'
import { BUILTIN_THEMES } from '../src/builtinThemes.js'
import { BUILTIN_BOARD, BUILTIN_CHROME } from '../src/themeDefaults.js'
// @ts-expect-error plain JS modules without types
import { derivedChrome, BACKDROP_NAMES } from '../static/device/theme.mjs'
// @ts-expect-error plain JS modules without types
import { registered } from '../static/device/widgets/index.mjs'

/**
 * The five shipped themes.
 *
 * The goal is "a theme model small enough that five good-looking built-in themes are an
 * afternoon". These tests are what "good-looking" is allowed to mean mechanically: a theme authors
 * ONLY its palette and a backdrop name, and everything else — twelve chrome colours, the whole
 * backdrop — falls out of that. So the interesting assertions here are not "Toscana's bg is
 * #f4ece0" (a restatement of the table, which would pass no matter how unreadable the result) but
 * the PROPERTIES a palette has to have for derivation to produce a board a person can read.
 *
 * That distinction caught a real defect: Cypherpunk as seeded in v7 had `dim: #5a1010` on a
 * #0a0a0a board — 1.43:1, invisible — and `ink === critical`, which makes `takeover_meta` and
 * `takeover_body` derive to the SAME colour, collapsing the critical overlay's type hierarchy.
 * Neither is visible in a table of hex values; both are obvious in a contrast floor.
 */
const fresh = () => { const db = new Database(':memory:'); migrate(db); return db }

const themeRow = (db: Database.Database, id: string) =>
  db.prepare('SELECT id, name, board, widgets, chrome, backdrop, rev, builtin FROM themes WHERE id = ?').get(id) as
    { id: string; name: string; board: string; widgets: string; chrome: string; backdrop: string; rev: number; builtin: number } | undefined

/** The same literal shape theme.mjs's COLOR_RE and widgets/tokens.mjs both accept, and nothing wider. */
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * WCAG relative luminance — properly linearised, unlike theme.mjs's own `luminance`, which is a
 * gamma-space approximation kept deliberately cheap because it makes exactly one binary decision
 * (`on_critical`). A legibility floor needs the real curve.
 */
const relLuminance = (hex: string): number => {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Design ids the device renderer can actually draw, asked of the registry rather than restated. */
const clockDesigns = (): string[] => (registered('clock') as { meta: { id: string } }[]).map((d) => d.meta.id)

describe('the built-in theme table', () => {
  it('covers all five built-in themes', () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual([
      'thm_default', 'thm_cypherpunk', 'thm_toscana', 'thm_nordic', 'thm_terminal',
    ])
  })

  /**
   * The point of the whole exercise. `thm_default` is the one exception: it is the fixture the v7
   * no-op property rests on, so it keeps the explicit twelve v9 wrote down.
   */
  it('authors no chrome anywhere but the default', () => {
    for (const theme of BUILTIN_THEMES) {
      if (theme.id === 'thm_default') continue
      expect(theme.chrome, `${theme.id} should derive its chrome`).toBeUndefined()
    }
  })

  it('names a backdrop the renderer can draw', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(BACKDROP_NAMES, `${theme.id}`).toContain(theme.backdrop)
    }
  })

  it('names a clock design the registry has', () => {
    const known = clockDesigns()
    for (const theme of BUILTIN_THEMES) {
      const design = theme.widgets.clock
      if (design === undefined) continue
      expect(known, `${theme.id}`).toContain(design)
    }
  })

  /**
   * A non-literal here does not throw — it silently drops the CSS custom property to its initial
   * value, i.e. a transparent or black board, which is strictly worse than never theming at all.
   */
  it('authors every palette colour as a literal both substitution points accept', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const [key, value] of Object.entries(theme.board)) {
        if (key === 'scrim') { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); continue }
        if (key === 'series') {
          expect((value as string[]).length, `${theme.id}.series`).toBe(4)
          for (const s of value as string[]) expect(s, `${theme.id}.series`).toMatch(COLOR_RE)
          continue
        }
        expect(value, `${theme.id}.${key}`).toMatch(COLOR_RE)
      }
    }
  })

  /** Every palette must carry the eight colours plus the ramp — a missing one falls back to DARK. */
  it('authors the full palette on every theme', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(Object.keys(theme.board).sort(), `${theme.id}`).toEqual(
        ['accent', 'bg', 'critical', 'dim', 'info', 'ink', 'scrim', 'series', 'surface', 'warn'],
      )
    }
  })

  it('derives twelve renderable chrome colours from every palette', () => {
    for (const theme of BUILTIN_THEMES) {
      const chrome = derivedChrome(theme.board, {}) as Record<string, string>
      expect(Object.keys(chrome).sort()).toEqual(Object.keys(BUILTIN_CHROME).sort())
      for (const [key, value] of Object.entries(chrome)) {
        expect(value, `${theme.id}.${key}`).toMatch(COLOR_RE)
      }
    }
  })

  /**
   * The floors: WCAG AA is 4.5:1 for body text and 3:1 for large text and graphical objects.
   * `ink` is body text. `dim`, `accent`, the severity colours and the chart ramp are labels,
   * strokes and fills — 3:1. Derived `muted`/`chip` are secondary text on a card.
   */
  it('clears the legibility floors on every palette', () => {
    for (const theme of BUILTIN_THEMES) {
      const b = theme.board
      const chrome = derivedChrome(b, {}) as Record<string, string>
      const at = (label: string, fg: string, bg: string, floor: number) =>
        expect(contrast(fg, bg), `${theme.id}: ${label}`).toBeGreaterThanOrEqual(floor)

      at('ink on bg', b.ink, b.bg, 4.5)
      at('ink on surface', b.ink, b.surface, 4.5)
      at('dim on bg', b.dim, b.bg, 3)
      at('dim on surface', b.dim, b.surface, 3)
      at('accent on bg', b.accent, b.bg, 3)
      for (const key of ['info', 'warn', 'critical'] as const) at(`${key} on surface`, b[key], b.surface, 3)
      b.series.forEach((s, i) => at(`series[${i}] on bg`, s, b.bg, 3))
      at('muted on surface', chrome.muted, b.surface, 3)
      at('chip on surface', chrome.chip, b.surface, 3)
      at('takeover_meta on takeover_bg', chrome.takeover_meta, chrome.takeover_bg, 3)
      at('takeover_body on takeover_bg', chrome.takeover_body, chrome.takeover_bg, 3)
      at('on_critical on critical', chrome.on_critical, b.critical, 3)
    }
  })

  /**
   * `takeover_meta` and `takeover_body` are both `mix(critical, ink, t)`, so a palette whose ink
   * IS its critical colour derives them identically and the critical overlay loses the distinction
   * between its heading and its body. v7's Cypherpunk did exactly this.
   */
  it('keeps the takeover overlay a hierarchy, not one flat colour', () => {
    for (const theme of BUILTIN_THEMES) {
      const chrome = derivedChrome(theme.board, {}) as Record<string, string>
      expect(chrome.takeover_meta, `${theme.id}`).not.toBe(chrome.takeover_body)
    }
  })

  /** Two dark, two light, so the derived-chrome path is exercised in both directions. */
  it('ships light themes as well as dark ones', () => {
    const light = BUILTIN_THEMES.filter((t) => relLuminance(t.board.bg) > 0.5)
    expect(light.map((t) => t.id).sort()).toEqual(['thm_nordic', 'thm_toscana'])
  })
})

describe('migration v13 — seeding the built-in themes', () => {
  it('stores a row for every theme in the table', () => {
    const db = fresh()
    for (const theme of BUILTIN_THEMES) {
      const row = themeRow(db, theme.id)
      expect(row, theme.id).toBeDefined()
      expect(row!.name).toBe(theme.name)
      expect(row!.backdrop).toBe(theme.backdrop)
      expect(JSON.parse(row!.board)).toEqual(theme.board)
      expect(JSON.parse(row!.widgets)).toEqual(theme.widgets)
      expect(row!.builtin).toBe(1)
    }
  })

  it('stores no chrome for the four derived themes', () => {
    const db = fresh()
    for (const theme of BUILTIN_THEMES) {
      if (theme.id === 'thm_default') continue
      expect(JSON.parse(themeRow(db, theme.id)!.chrome), theme.id).toEqual({})
    }
  })

  /**
   * The v7 no-op property, restated at v13: `thm_default` reproduces today's palette exactly, and
   * every migration since has had to leave it alone. Seeding four themes around it must not be the
   * one that finally moves it.
   */
  it('does not move thm_default', () => {
    const db = fresh()
    const row = themeRow(db, 'thm_default')!
    expect(JSON.parse(row.board)).toEqual(BUILTIN_BOARD)
    expect(JSON.parse(row.chrome)).toEqual(BUILTIN_CHROME)
    expect(JSON.parse(row.widgets)).toEqual({})
    expect(row.backdrop).toBe('flat')
  })

  /**
   * Cypherpunk predates the palette-only model: v7 gave it a full twelve-key chrome map so an
   * on-device check would show a fully recoloured board. Derivation now does that job, and the
   * map's presence is what stops it happening.
   */
  it('converts the v7 Cypherpunk to the palette-only model', () => {
    const db = fresh()
    const row = themeRow(db, 'thm_cypherpunk')!
    expect(JSON.parse(row.chrome)).toEqual({})
    expect(row.backdrop).toBe('glow')
    expect(JSON.parse(row.widgets)).toEqual({ clock: 'segment' })
  })

  /**
   * A built-in is a starting point, not a fixture — an operator who has recoloured one has a `rev`
   * above 1, and a migration that overwrote it would silently discard their work on every hub
   * restart. Same rule migrateV9 applies to a customised chrome map.
   */
  it('leaves a theme an operator has already edited alone', () => {
    const db = fresh()
    const mine = JSON.stringify({ ...BUILTIN_BOARD, ink: '#00ff00' })
    db.prepare("UPDATE themes SET board = ?, rev = rev + 1 WHERE id = 'thm_cypherpunk'").run(mine)
    migrateV13(db)
    expect(themeRow(db, 'thm_cypherpunk')!.board).toBe(mine)
  })

  /**
   * A re-run must not duplicate rows, bump revs, or undo an operator's edits.
   *
   * Drives the step directly rather than rewinding user_version and re-running the dispatcher —
   * later migrations include DDL (v14's ALTER TABLE) and replaying from an earlier version fails
   * on a column that already exists. Same reasoning, and the same fix, as migrateV7.test.ts's v9
   * cases.
   */
  it('is idempotent', () => {
    const db = fresh()
    const cols = 'SELECT id, board, widgets, chrome, backdrop, rev FROM themes ORDER BY id'
    const before = db.prepare(cols).all()
    migrateV13(db)
    expect(db.prepare(cols).all()).toEqual(before)
  })

  it('adds no themes beyond the five', () => {
    const db = fresh()
    const ids = (db.prepare('SELECT id FROM themes ORDER BY created_at').all() as { id: string }[]).map((r) => r.id)
    expect(ids.sort()).toEqual(BUILTIN_THEMES.map((t) => t.id).sort())
  })
})
