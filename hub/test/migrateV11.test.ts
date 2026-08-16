import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, migrateV11 } from '../src/db/migrate.js'

/**
 * v11 — colorsets deleted (theme migration).
 *
 * They existed so a design could be recoloured independently of the palette. Measured, that was
 * never worth a table: every colour slot in all three clock designs already defaults to a board
 * colour, and the one seeded colorset held exactly TWO values the palette could not produce —
 * both derivable. Two shades, for a table, a CRUD API with a delete-cascade, a library page,
 * cell-level pinning and a copy-on-write rule.
 */
const fresh = () => { const db = new Database(':memory:'); migrate(db); return db }

describe('migration v11', () => {
  it('drops the colorsets table', () => {
    const db = fresh()
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
    expect(names).not.toContain('colorsets')
    expect(names).toContain('themes')
  })

  it('collapses a theme widget entry to the bare design id', () => {
    const db = fresh()
    const widgets = JSON.parse(
      (db.prepare("SELECT widgets FROM themes WHERE id='thm_cypherpunk'").get() as { widgets: string }).widgets,
    )
    expect(widgets.clock).toBe('segment')
  })

  /**
   * A cell that pinned a colorset must not keep a key the schema no longer accepts — the next save
   * of that screen would 400 on `additionalProperties: false`, which is a silent trap set months
   * earlier for whoever next edits the layout.
   */
  it('drops cell.config.colorset from stored grids', () => {
    const db = fresh()
    const now = Date.now()
    const grid = JSON.stringify({ cells: [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: { design: 'segment', colorset: 'cs_gone', scale: 1.5 } },
    ] })
    db.prepare('INSERT INTO screens (id, name, orientation, grid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('lay_x', 'X', 'landscape', grid, now)
    // Drives the data step directly rather than rewinding user_version and re-running the
    // dispatcher: later migrations include DDL (v14's ALTER TABLE) and replaying from an earlier
    // version fails on a column that already exists.
    migrateV11(db)
    const out = JSON.parse((db.prepare("SELECT grid FROM screens WHERE id='lay_x'").get() as { grid: string }).grid)
    expect(out.cells[0].config).toEqual({ design: 'segment', scale: 1.5 })
  })

  /** Re-running must be safe: a bare id stays a bare id rather than being reduced to nothing. */
  it('is idempotent on an already-collapsed entry', () => {
    const db = fresh()
    migrateV11(db)
    const widgets = JSON.parse(
      (db.prepare("SELECT widgets FROM themes WHERE id='thm_cypherpunk'").get() as { widgets: string }).widgets,
    )
    expect(widgets.clock).toBe('segment')
  })
})
