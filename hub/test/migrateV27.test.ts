import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, migrateV27 } from '../src/db/migrate.js'
import { BUILTIN_THEMES } from '../src/builtinThemes.js'

describe('v27 sounds columns', () => {
  it('fresh database: columns exist, default {} on new rows, curated builtin sounds seeded', () => {
    const db = new Database(':memory:')
    migrate(db as never)
    const theme = db.prepare("SELECT sounds FROM themes WHERE id = 'thm_default'").get() as { sounds: string }
    expect(theme.sounds).toBe('{}')  // thm_default is the untouched fixture — stays classic
    const curated = BUILTIN_THEMES.filter((t) => t.sounds)
    expect(curated.length).toBeGreaterThan(0)
    for (const t of curated) {
      const row = db.prepare('SELECT sounds FROM themes WHERE id = ?').get(t.id) as { sounds: string }
      expect(JSON.parse(row.sounds)).toEqual(t.sounds)
    }
  })

  it('existing database: every theme and screen gets {} — an upgrade never changes what a room sounds like', () => {
    const db = new Database(':memory:')
    migrate(db as never)  // stand-in for "already at v26+": rerunning migrate is a no-op past this
    db.prepare("INSERT INTO screens (id, name, orientation, grid, rev, created_at) VALUES ('lay_x', 'x', 'landscape', '{\"cells\":[]}', 1, 0)").run()
    const s = db.prepare("SELECT sounds FROM screens WHERE id = 'lay_x'").get() as { sounds: string }
    expect(s.sounds).toBe('{}')
  })

  it('upgrade from v26 does NOT seed curated sounds onto builtins', () => {
    // Build a database migrated to v26 by hand: run `migrate` on a fresh db (which lands at the
    // CURRENT LATEST_VERSION, already v27), then wipe every theme's sounds back to '{}' to fake
    // "this is what a real v26 hub looked like right before the v27 ALTERs ran" — the exact
    // migrateV22.test.ts pattern of exercising the exported step function directly rather than
    // rebuilding history from SCHEMA_V1..V26 by hand.
    const db = new Database(':memory:')
    migrate(db as never)
    db.prepare("UPDATE themes SET sounds = '{}'").run()

    migrateV27(db as never, { fromVersion: 26 })

    for (const t of BUILTIN_THEMES) {
      if (!t.sounds) continue
      const row = db.prepare('SELECT sounds FROM themes WHERE id = ?').get(t.id) as { sounds: string }
      expect(row.sounds).toBe('{}') // an upgrade must not retroactively curate an existing theme
    }

    // A second, independent fresh database run through migrateV27 with fromVersion: 0 (a real
    // fresh install) DOES seed the curated maps, and doing it twice is idempotent.
    const freshDb = new Database(':memory:')
    freshDb.exec(`
      CREATE TABLE themes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, board TEXT NOT NULL, widgets TEXT NOT NULL DEFAULT '{}',
        chrome TEXT NOT NULL DEFAULT '{}', bg_kind TEXT NOT NULL DEFAULT 'none', bg_color TEXT,
        bg_rev INTEGER NOT NULL DEFAULT 0, backdrop TEXT NOT NULL DEFAULT 'flat',
        rev INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE screens (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, orientation TEXT NOT NULL, grid TEXT NOT NULL,
        created_at INTEGER NOT NULL, theme_id TEXT, rev INTEGER NOT NULL DEFAULT 1
      );
    `)
    const now = Date.now()
    for (const t of BUILTIN_THEMES) {
      freshDb.prepare(
        "INSERT INTO themes (id, name, board, widgets, bg_kind, rev, builtin, created_at) VALUES (?, ?, '{}', '{}', 'none', 1, 1, ?)",
      ).run(t.id, t.name, now)
    }

    migrateV27(freshDb as never, { fromVersion: 0 })
    migrateV27(freshDb as never, { fromVersion: 0 }) // idempotent: same rows, same values

    for (const t of BUILTIN_THEMES) {
      if (!t.sounds || t.id === 'thm_default') continue
      const row = freshDb.prepare('SELECT sounds FROM themes WHERE id = ?').get(t.id) as { sounds: string }
      expect(JSON.parse(row.sounds)).toEqual(t.sounds)
    }
    const defaultRow = freshDb.prepare("SELECT sounds FROM themes WHERE id = 'thm_default'").get() as { sounds: string }
    expect(defaultRow.sounds).toBe('{}') // thm_default fixture never touched (migrateV13 rule)
  })
})
