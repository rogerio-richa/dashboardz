import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate, migrateV21 } from '../src/db/migrate.js'

/**
 * v21 — `gauge`'s old `config.style` ('ring'|'bar') is retired in favour
 * of `config.design`, the same selection field every other multi-design widget uses. See
 * `migrateV21`'s own docstring in `src/db/migrate.ts` for the full reasoning — this pins the exact
 * rewrite rules the human ruled on: `style` becomes `design` when no `design` is already present,
 * `style` is dropped either way, non-gauge cells and gauge cells with no `style` are untouched, and
 * the rewrite is idempotent.
 */
const fresh = () => { const db = new Database(':memory:'); migrate(db); return db }

const insertScreen = (db: Database.Database, id: string, cells: unknown[]) => {
  db.prepare('INSERT INTO screens (id, name, orientation, grid, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, 'landscape', JSON.stringify({ cells }), Date.now())
}

const gridOf = (db: Database.Database, id: string) =>
  JSON.parse((db.prepare('SELECT grid FROM screens WHERE id = ?').get(id) as { grid: string }).grid)

describe('migration v21', () => {
  it('rewrites style: ring to design: ring and drops style', () => {
    const db = fresh()
    insertScreen(db, 'lay_ring', [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'gauge', config: { feed: 'f', path: 'v', min: 0, max: 100, style: 'ring' } },
    ])
    migrateV21(db)
    expect(gridOf(db, 'lay_ring').cells[0].config).toEqual({ feed: 'f', path: 'v', min: 0, max: 100, design: 'ring' })
  })

  it('rewrites style: bar to design: bar and drops style', () => {
    const db = fresh()
    insertScreen(db, 'lay_bar', [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'gauge', config: { feed: 'f', path: 'v', min: 0, max: 100, style: 'bar' } },
    ])
    migrateV21(db)
    expect(gridOf(db, 'lay_bar').cells[0].config).toEqual({ feed: 'f', path: 'v', min: 0, max: 100, design: 'bar' })
  })

  it('a cell with both design and style keeps its own design and just loses style', () => {
    const db = fresh()
    insertScreen(db, 'lay_both', [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'gauge', config: { feed: 'f', path: 'v', min: 0, max: 100, design: 'ring', style: 'bar' } },
    ])
    migrateV21(db)
    expect(gridOf(db, 'lay_both').cells[0].config).toEqual({ feed: 'f', path: 'v', min: 0, max: 100, design: 'ring' })
  })

  it('leaves a non-gauge cell untouched, even one that happens to carry a style key', () => {
    const db = fresh()
    insertScreen(db, 'lay_chart', [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'chart', config: { series: [], style: 'bar' } },
    ])
    migrateV21(db)
    expect(gridOf(db, 'lay_chart').cells[0].config).toEqual({ series: [], style: 'bar' })
  })

  it('leaves a gauge cell with no style key at all untouched', () => {
    const db = fresh()
    insertScreen(db, 'lay_plain', [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'gauge', config: { feed: 'f', path: 'v', min: 0, max: 100 } },
    ])
    migrateV21(db)
    expect(gridOf(db, 'lay_plain').cells[0].config).toEqual({ feed: 'f', path: 'v', min: 0, max: 100 })
  })

  it('is idempotent: a second run against already-migrated data changes nothing further', () => {
    const db = fresh()
    insertScreen(db, 'lay_twice', [
      { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'gauge', config: { feed: 'f', path: 'v', min: 0, max: 100, style: 'ring' } },
    ])
    migrateV21(db)
    const once = gridOf(db, 'lay_twice')
    migrateV21(db)
    const twice = gridOf(db, 'lay_twice')
    expect(twice).toEqual(once)
    expect(twice.cells[0].config).toEqual({ feed: 'f', path: 'v', min: 0, max: 100, design: 'ring' })
  })

  it('a screen with an unreadable grid is left untouched, not crashed on', () => {
    const db = fresh()
    db.prepare('INSERT INTO screens (id, name, orientation, grid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('lay_bad', 'bad', 'landscape', '{not json', Date.now())
    expect(() => migrateV21(db)).not.toThrow()
    expect((db.prepare('SELECT grid FROM screens WHERE id = ?').get('lay_bad') as { grid: string }).grid).toBe('{not json')
  })

  it('the LATEST_VERSION migration path runs v21 without error on a fresh database', () => {
    // A fresh db has no gauge cells at all, so this only proves migrateV21 is wired into the
    // dispatcher and safe to run against an otherwise-empty screens table.
    expect(() => fresh()).not.toThrow()
  })
})
