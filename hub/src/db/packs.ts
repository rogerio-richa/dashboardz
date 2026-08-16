import type { DB } from './index.js'

/** One installed theme pack (v30). `designs` is JSON: [{ widget, id }]. */
export interface PackRow {
  id: string
  name: string
  version: string
  theme_id: string | null
  install_rev: number
  designs: string
  installed_at: number
  updated_at: number
}
export interface PackDesign { widget: string; id: string }

export const listPacks = (db: DB): PackRow[] => db.prepare('SELECT * FROM packs ORDER BY installed_at').all() as PackRow[]
export const getPack = (db: DB, id: string): PackRow | undefined => db.prepare('SELECT * FROM packs WHERE id = ?').get(id) as PackRow | undefined
export const packDesigns = (row: PackRow): PackDesign[] => {
  try { const v = JSON.parse(row.designs); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** Inserts or replaces a pack's row, bumping install_rev on every install. Returns the new row. */
export function upsertPack(db: DB, p: { id: string; name: string; version: string; theme_id: string; designs: PackDesign[] }, now: number): PackRow {
  db.prepare(
    `INSERT INTO packs (id, name, version, theme_id, install_rev, designs, installed_at, updated_at)
     VALUES (@id, @name, @version, @theme_id, 1, @designs, @now, @now)
     ON CONFLICT(id) DO UPDATE SET name = @name, version = @version, theme_id = @theme_id,
       install_rev = install_rev + 1, designs = @designs, updated_at = @now`,
  ).run({ ...p, designs: JSON.stringify(p.designs), now })
  return getPack(db, p.id)!
}

export const deletePack = (db: DB, id: string): boolean => db.prepare('DELETE FROM packs WHERE id = ?').run(id).changes > 0
