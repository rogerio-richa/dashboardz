import type { DB } from './index.js'
import { newId } from '../ids.js'
import { audit, type AdminActor } from './audit.js'
import { listDeviceTabs, setDeviceTabs } from './devices.js'

export type Orientation = 'landscape' | 'portrait'

export interface ScreenRow {
  id: string
  name: string
  orientation: Orientation
  grid: string
  /** NULL means the built-in default theme — a first-class state, not an error. */
  theme_id: string | null
  /**
   * Sparse event->family OVERRIDE map (schema v27, alert-sound contract); parsed via `parseSounds` for reads.
   * '{}' means "follow the theme" — see `resolveSounds` (hub/src/sounds.ts) for the theme + screen
   * + classic layering this feeds at render time.
   */
  sounds: string
  /**
   * Row version (v14). Every write bumps it; a grid save must carry the one it was built from.
   * Same shape as `themes.rev`, and unrelated to the STATE message's `rev`, which is a
   * per-connection message counter.
   */
  rev: number
  created_at: number
}

/**
 * What a write to a screen can come back as. A conflict is NOT an error the caller invented — it
 * carries the rev the row is actually on, so the client can say how far behind it is.
 */
export type ScreenUpdateResult =
  | { status: 'updated'; rev: number }
  | { status: 'conflict'; rev: number }
  | { status: 'missing' }

export interface ScreenPatch {
  name?: string
  orientation?: Orientation
  grid?: object
  theme_id?: string | null
  /** undefined = leave alone; `{}` clears the override back to "follow the theme" (screen state, alert-sound contract). */
  sounds?: Record<string, string>
}

const COLS = 'id, name, orientation, grid, theme_id, sounds, rev, created_at'

export function createScreen(
  db: DB,
  input: {
    name: string; orientation: Orientation; grid: object; theme_id?: string | null
    sounds?: Record<string, string>
  },
  now: number,
): ScreenRow {
  const row: ScreenRow = {
    id: newId('lay'),
    name: input.name,
    orientation: input.orientation,
    grid: JSON.stringify(input.grid),
    theme_id: input.theme_id ?? null,
    sounds: JSON.stringify(input.sounds ?? {}),
    rev: 1,
    created_at: now,
  }
  db.prepare('INSERT INTO screens (id, name, orientation, grid, theme_id, sounds, rev, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.name, row.orientation, row.grid, row.theme_id, row.sounds, row.rev, row.created_at)
  return row
}

export function listScreens(db: DB): ScreenRow[] {
  return db.prepare(`SELECT ${COLS} FROM screens ORDER BY created_at`).all() as ScreenRow[]
}

export function getScreen(db: DB, id: string): ScreenRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM screens WHERE id = ?`).get(id) as ScreenRow | undefined
}

/**
 * Applies a patch, optionally only if the row is still on `expectedRev` (v14).
 *
 * The compare-and-swap is in the UPDATE's own WHERE clause, not in a read-then-write around it.
 * better-sqlite3 is synchronous and today's caller has no await between the two, so a check up here
 * would happen to be safe — but it would be safe by accident, and the whole point of this function
 * is that a write which quietly wins is the bug. `rev = rev + 1` and `WHERE rev = ?` together mean
 * exactly one of two concurrent saves can land, whatever the caller does.
 *
 * `expectedRev` undefined means "no opinion": a field-level write from a control that never read
 * the grid has no lost update to prevent. The route decides which writes must supply one.
 */
export function updateScreen(
  db: DB,
  id: string,
  patch: ScreenPatch,
  expectedRev?: number,
): ScreenUpdateResult {
  const existing = getScreen(db, id)
  if (!existing) return { status: 'missing' }
  if (expectedRev !== undefined && expectedRev !== existing.rev) {
    return { status: 'conflict', rev: existing.rev }
  }
  // theme_id follows the same undefined-vs-null convention as updateTheme's bg_color: undefined
  // means "leave it alone", explicit null means "clear it back to the built-in default".
  // sounds follows the same undefined-vs-value convention, except the "clear" sentinel is `{}`
  // rather than null — there is no separate cleared-vs-unset state for a sparse override map,
  // `{}` already means "follow the theme" — same as updateTheme's `sounds` patch.
  const res = db.prepare(
    'UPDATE screens SET name = ?, orientation = ?, grid = ?, theme_id = ?, sounds = ?, rev = rev + 1 WHERE id = ? AND rev = ?',
  ).run(
    patch.name ?? existing.name,
    patch.orientation ?? existing.orientation,
    patch.grid !== undefined ? JSON.stringify(patch.grid) : existing.grid,
    patch.theme_id !== undefined ? patch.theme_id : existing.theme_id,
    patch.sounds !== undefined ? JSON.stringify(patch.sounds) : existing.sounds,
    id,
    existing.rev,
  )
  // Lost the race between the read above and the write: somebody else's save landed first.
  if (res.changes === 0) return { status: 'conflict', rev: getScreen(db, id)?.rev ?? existing.rev }
  return { status: 'updated', rev: existing.rev + 1 }
}

export function assignedDeviceIds(db: DB, screenId: string): string[] {
  return (db.prepare('SELECT DISTINCT device_id FROM device_screens WHERE screen_id = ?').all(screenId) as { device_id: string }[])
    .map((r) => r.device_id)
}

/**
 * Every feed id a grid's cells bind to (reference set). Guarded end to end — a grid is
 * operator-authored JSON and bad data in the DB must never crash a read path. chart behavior: also
 * walks chart cells' `config.series[].feed` — a device whose layout has ONLY a chart must still
 * get DATA for every series feed, so both binding shapes are collected into the same deduped set.
 */
export function referencedFeedIds(grid: unknown): string[] {
  const out: string[] = []
  const push = (feed: unknown) => {
    if (typeof feed === 'string' && feed && !out.includes(feed)) out.push(feed)
  }
  const cells = (grid as { cells?: unknown[] } | null)?.cells
  if (!Array.isArray(cells)) return out
  for (const cell of cells) {
    const config = (cell as { config?: { feed?: unknown; series?: unknown } } | null)?.config
    push(config?.feed)
    const series = config?.series
    if (Array.isArray(series)) for (const s of series) push((s as { feed?: unknown } | null)?.feed)
  }
  return out
}

export function screensReferencingFeed(db: DB, feedId: string): { id: string; name: string }[] {
  return listScreens(db).filter((s) => {
    try {
      return referencedFeedIds(JSON.parse(s.grid)).includes(feedId)
    } catch {
      return false
    }
  }).map((s) => ({ id: s.id, name: s.name }))
}

/**
 * Delete-cascade (data model): every assigned device resets to the default layout in the
 * SAME transaction as the delete, and each reset is audited — a layout id must never dangle.
 *
 * `tabDeviceIds` is the whole answer (v25): `device_screens` is the only place an assignment is
 * recorded, so the device reset uses one source of truth.
 */
export function deleteScreen(
  db: DB, id: string, actor: AdminActor = { type: 'admin', id: null },
): { deleted: boolean; resetDeviceIds: string[] } {
  return db.transaction(() => {
    const tabDeviceIds = (db.prepare('SELECT DISTINCT device_id FROM device_screens WHERE screen_id = ?')
      .all(id) as { device_id: string }[]).map((r) => r.device_id)
    db.prepare('DELETE FROM device_screens WHERE screen_id = ?').run(id)
    for (const deviceId of tabDeviceIds) {
      const rest = listDeviceTabs(db, deviceId)
      setDeviceTabs(db, deviceId, rest.map((t) => ({ screen_id: t.screen_id, label: t.label })))
    }
    const res = db.prepare('DELETE FROM screens WHERE id = ?').run(id)
    if (res.changes > 0) {
      for (const deviceId of tabDeviceIds) {
        audit(db, actor.type, actor.id, 'device_screen_assigned', { device_id: deviceId, screen_id: null, reason: 'screen_deleted' })
      }
      audit(db, actor.type, actor.id, 'screen_deleted', { screen_id: id, reset_devices: tabDeviceIds.length })
    }
    return { deleted: res.changes > 0, resetDeviceIds: tabDeviceIds }
  })()
}
