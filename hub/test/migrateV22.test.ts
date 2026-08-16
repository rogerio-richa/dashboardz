import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, migrateV22 } from '../src/db/migrate.js'

/**
 * v22 — `gauge_hole` retired. The DOM ring gauge's
 * `.gauge-ring-inner` CSS rule was its only reader, and that rule died with the whole DOM gauge
 * branch — see `migrateV22`'s own docstring in `src/db/migrate.ts` for the full reasoning. This
 * pins the exact rewrite: `gauge_hole` is deleted from a theme's stored `chrome` blob, every other
 * chrome key on the row survives untouched, and the migration never throws on bad data.
 */
const fresh = () => { const db = new Database(':memory:'); migrate(db); return db }

const insertTheme = (db: Database.Database, id: string, chrome: string) => {
  db.prepare(
    "INSERT INTO themes (id, name, board, widgets, chrome, bg_kind, bg_rev, rev, builtin, created_at) VALUES (?, ?, '{}', '{}', ?, 'none', 0, 1, 0, ?)",
  ).run(id, id, chrome, Date.now())
}

const chromeOf = (db: Database.Database, id: string) =>
  (db.prepare('SELECT chrome FROM themes WHERE id = ?').get(id) as { chrome: string }).chrome

describe('migration v22', () => {
  it('strips gauge_hole and leaves every other chrome key untouched', () => {
    const db = fresh()
    insertTheme(db, 'thm_a', JSON.stringify({ hairline: '#111111', gauge_hole: '#0b0d12', muted: '#a8adbd' }))
    migrateV22(db)
    expect(JSON.parse(chromeOf(db, 'thm_a'))).toEqual({ hairline: '#111111', muted: '#a8adbd' })
  })

  it('leaves a theme whose chrome never had gauge_hole untouched, without writing the row', () => {
    const db = fresh()
    insertTheme(db, 'thm_b', JSON.stringify({ hairline: '#111111' }))
    migrateV22(db)
    expect(JSON.parse(chromeOf(db, 'thm_b'))).toEqual({ hairline: '#111111' })
  })

  it('leaves an empty chrome object untouched', () => {
    const db = fresh()
    insertTheme(db, 'thm_c', '{}')
    migrateV22(db)
    expect(chromeOf(db, 'thm_c')).toBe('{}')
  })

  it('is idempotent: a second run against already-migrated data changes nothing further', () => {
    const db = fresh()
    insertTheme(db, 'thm_d', JSON.stringify({ gauge_hole: '#0b0d12', border: '#2a2e38' }))
    migrateV22(db)
    const once = chromeOf(db, 'thm_d')
    migrateV22(db)
    const twice = chromeOf(db, 'thm_d')
    expect(twice).toBe(once)
    expect(JSON.parse(twice)).toEqual({ border: '#2a2e38' })
  })

  it('does not throw on unparsable chrome JSON, and leaves the row exactly as stored', () => {
    const db = fresh()
    insertTheme(db, 'thm_bad', '{not json')
    expect(() => migrateV22(db)).not.toThrow()
    expect(chromeOf(db, 'thm_bad')).toBe('{not json')
  })

  it('does not throw when chrome is a JSON array or a bare literal instead of an object', () => {
    const db = fresh()
    insertTheme(db, 'thm_arr', '["gauge_hole"]')
    insertTheme(db, 'thm_null', 'null')
    insertTheme(db, 'thm_num', '42')
    expect(() => migrateV22(db)).not.toThrow()
    expect(chromeOf(db, 'thm_arr')).toBe('["gauge_hole"]')
    expect(chromeOf(db, 'thm_null')).toBe('null')
    expect(chromeOf(db, 'thm_num')).toBe('42')
  })

  it('preserves every other column on a row it rewrites', () => {
    const db = fresh()
    const now = Date.now()
    db.prepare(
      "INSERT INTO themes (id, name, board, widgets, chrome, bg_kind, bg_rev, rev, builtin, created_at) VALUES ('thm_full', 'Full', '{\"bg\":\"#000\"}', '{\"clock\":\"analog\"}', ?, 'none', 3, 5, 1, ?)",
    ).run(JSON.stringify({ gauge_hole: '#0b0d12', on_critical: '#fff' }), now)
    migrateV22(db)
    const row = db.prepare('SELECT * FROM themes WHERE id = ?').get('thm_full') as Record<string, unknown>
    expect(row.name).toBe('Full')
    expect(row.board).toBe('{"bg":"#000"}')
    expect(row.widgets).toBe('{"clock":"analog"}')
    expect(row.bg_kind).toBe('none')
    expect(row.bg_rev).toBe(3)
    expect(row.rev).toBe(5) // migrateV22 does not bump rev — retiring a dead key changes no rendering
    expect(row.builtin).toBe(1)
    expect(row.created_at).toBe(now)
    expect(JSON.parse(row.chrome as string)).toEqual({ on_critical: '#fff' })
  })

  it('the LATEST_VERSION migration path runs v22 without error on a fresh database', () => {
    // A fresh db seeds thm_default/thm_cypherpunk through v7/v9/v13 using the CURRENT
    // BUILTIN_CHROME (no gauge_hole), so this only proves v22 is wired into the dispatcher and
    // safe to run against themes that never had the key at all.
    expect(() => fresh()).not.toThrow()
  })
})
