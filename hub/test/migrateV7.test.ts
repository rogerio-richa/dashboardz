import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { migrate, migrateV9, LATEST_VERSION } from '../src/db/migrate.js'
import { BUILTIN_BOARD, BUILTIN_CHROME } from '../src/themeDefaults.js'
// @ts-expect-error plain JS module without types
import { derivedChrome } from '../static/device/theme.mjs'

const fresh = () => { const db = new Database(':memory:'); migrate(db as never); return db }

/** Parse :root's custom properties out of the served stylesheet — the source of truth. */
function rootVars(): Record<string, string> {
  const html = readFileSync('static/device/index.html', 'utf8')
  const block = /:root\s*\{([^}]*)\}/.exec(html)
  if (!block) throw new Error(':root block not found in index.html')
  const out: Record<string, string> = {}
  for (const m of block[1].matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) out[m[1]] = m[2]
  return out
}

describe('migration v7', () => {
  /**
   * v7 is APPLIED, not that it is the newest thing there is. Pinning LATEST_VERSION in a
   * version-specific file makes every future migration fail a test about an older one, which says
   * nothing about whether that older migration still works.
   */
  it('is applied by a fresh migrate', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(7)
    const db = fresh()
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
  })

  it('creates themes, and adds screens.theme_id', () => {
    const db = fresh()
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    // colorsets was dropped again in v11 (theme migration); themes remains.
    expect(names.map((r) => r.name)).toEqual(expect.arrayContaining(['themes']))
    const cols = db.prepare('PRAGMA table_info(screens)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('theme_id')
  })

  it('leaves every existing screen on theme_id NULL', () => {
    const db = fresh()
    db.prepare("INSERT INTO screens (id,name,orientation,grid,created_at) VALUES ('lay_x','X','landscape','{\"cells\":[]}',1)").run()
    const row = db.prepare("SELECT theme_id FROM screens WHERE id='lay_x'").get() as { theme_id: string | null }
    expect(row.theme_id).toBeNull()
  })

  it('the default theme reproduces index.html’s :root exactly — v7 is a visual no-op', () => {
    const vars = rootVars()
    expect(BUILTIN_BOARD.bg).toBe(vars.bg)
    expect(BUILTIN_BOARD.surface).toBe(vars.card)
    expect(BUILTIN_BOARD.ink).toBe(vars.text)
    expect(BUILTIN_BOARD.dim).toBe(vars.dim)
    expect(BUILTIN_BOARD.accent).toBe(vars.info)
    expect(BUILTIN_BOARD.info).toBe(vars.info)
    expect(BUILTIN_BOARD.warn).toBe(vars.warn)
    expect(BUILTIN_BOARD.critical).toBe(vars.critical)
  })

  it('seeds the default theme from BUILTIN_BOARD, builtin and unassigned', () => {
    const db = fresh()
    const t = db.prepare("SELECT * FROM themes WHERE id='thm_default'").get() as { board: string; builtin: number; bg_kind: string }
    expect(t.builtin).toBe(1)
    expect(t.bg_kind).toBe('none')
    expect(JSON.parse(t.board)).toEqual(BUILTIN_BOARD)
  })

  /**
   * v7 seeded cypherpunk as `{clock: {design, colorset_id}}`. v11 collapsed that to the bare design
   * id and dropped the colorset — the palette does that job, and every design's slots already
   * defaulted to a board colour. What survives is the property that matters: cypherpunk still
   * chooses the segment clock.
   */
  it('seeds cypherpunk choosing the segment clock', () => {
    const db = fresh()
    const t = db.prepare("SELECT widgets FROM themes WHERE id='thm_cypherpunk'").get() as { widgets: string }
    expect(JSON.parse(t.widgets).clock).toBe('segment')
  })

  it('default.series preserves today’s cycling, alarm-red third series included', () => {
    expect(BUILTIN_BOARD.series).toEqual([BUILTIN_BOARD.info, BUILTIN_BOARD.warn, BUILTIN_BOARD.critical, BUILTIN_BOARD.dim])
  })

  // tab-bar chrome: the eleven chrome keys index.html tokenises but the board block does not drive.
  // Pinned against the served stylesheet, not copied, the same way BUILTIN_BOARD is above — so
  // the built-in map and the markup cannot silently drift apart.
  it('the chrome map reproduces index.html’s :root exactly — byte-identical, not copied', () => {
    const vars = rootVars()
    expect(BUILTIN_CHROME.hairline).toBe(vars.hairline)
    expect(BUILTIN_CHROME.muted).toBe(vars.muted)
    expect(BUILTIN_CHROME.chip).toBe(vars.chip)
    expect(BUILTIN_CHROME.border).toBe(vars.border)
    expect(BUILTIN_CHROME.surface_warn).toBe(vars['surface-warn'])
    expect(BUILTIN_CHROME.surface_critical).toBe(vars['surface-critical'])
    expect(BUILTIN_CHROME.takeover_bg).toBe(vars['takeover-bg'])
    expect(BUILTIN_CHROME.takeover_meta).toBe(vars['takeover-meta'])
    expect(BUILTIN_CHROME.takeover_body).toBe(vars['takeover-body'])
    expect(BUILTIN_CHROME.takeover_hint_bg).toBe(vars['takeover-hint-bg'])
    expect(BUILTIN_CHROME.on_critical).toBe(vars['on-critical'])
    expect(Object.keys(BUILTIN_CHROME)).toHaveLength(11)
  })

  /**
   * v7 seeded thm_default's chrome as {} because {} meant "use BUILTIN_CHROME". Since chrome is
   * DERIVED from the palette, {} would instead mean "derive" — and derivation does not land
   * byte-identically on this one theme (an ink-tinted hairline rather than pure white).
   * So v9 writes the eleven values down explicitly.
   *
   * The property being defended has not changed: thm_default renders exactly as an unthemed board
   * does. Only the mechanism moved, from an implicit fallback to a stored fact.
   */
  it('thm_default ends up with today’s exact chrome — the visual no-op still holds', () => {
    const db = fresh()
    const t = db.prepare("SELECT chrome FROM themes WHERE id='thm_default'").get() as { chrome: string }
    expect(JSON.parse(t.chrome)).toEqual(BUILTIN_CHROME)
  })

  /**
   * v9 must not trample a chrome somebody has already customised.
   *
   * Drives migrateV9 directly rather than rewinding user_version and re-running the dispatcher:
   * later migrations include DDL (v10's ALTER TABLE), so replaying from an earlier version fails
   * on a column that already exists. Testing the step in isolation is what the guard is about.
   */
  it('v9 leaves an already-customised thm_default chrome alone', () => {
    const db = fresh()
    db.prepare("UPDATE themes SET chrome = ? WHERE id='thm_default'").run('{"muted":"#123456"}')
    migrateV9(db)
    const t = db.prepare("SELECT chrome FROM themes WHERE id='thm_default'").get() as { chrome: string }
    expect(JSON.parse(t.chrome)).toEqual({ muted: '#123456' })
  })

  it('v9 fills an empty chrome, and is idempotent', () => {
    const db = fresh()
    db.prepare("UPDATE themes SET chrome = '{}' WHERE id='thm_default'").run()
    migrateV9(db)
    const once = db.prepare("SELECT chrome FROM themes WHERE id='thm_default'").get() as { chrome: string }
    expect(JSON.parse(once.chrome)).toEqual(BUILTIN_CHROME)
    migrateV9(db)
    const twice = db.prepare("SELECT chrome FROM themes WHERE id='thm_default'").get() as { chrome: string }
    expect(JSON.parse(twice.chrome)).toEqual(BUILTIN_CHROME)
  })

  /**
   * v7 stored a full twelve-key chrome map on thm_cypherpunk so an on-device check would show a
   * FULLY recoloured board rather than a mostly-recoloured one with stray default hairlines and
   * surfaces showing through. That property still has to hold — but v13 removed the stored map,
   * because chrome derivation now produces it, and a stored map is precisely what stops a theme
   * from exercising derivation at all.
   *
   * So the assertion moves down a layer, from the mechanism to the outcome: whatever the board
   * ends up painting, no key of it may still be the built-in dark furniture. Deriving from
   * Cypherpunk's stored palette is a stronger check than the old one — it fails if derivation
   * regresses, which the stored map could not have noticed.
   */
  it('leaves no built-in chrome key showing through on thm_cypherpunk', () => {
    const db = fresh()
    const t = db.prepare("SELECT board, chrome FROM themes WHERE id='thm_cypherpunk'")
      .get() as { board: string; chrome: string }
    expect(JSON.parse(t.chrome)).toEqual({}) // v13: derived, not authored
    const chrome = derivedChrome(JSON.parse(t.board), {})
    expect(Object.keys(chrome).sort()).toEqual(Object.keys(BUILTIN_CHROME).sort())
    for (const [k, v] of Object.entries(chrome)) {
      expect(v, k).not.toBe(BUILTIN_CHROME[k as keyof typeof BUILTIN_CHROME])
    }
  })
})
