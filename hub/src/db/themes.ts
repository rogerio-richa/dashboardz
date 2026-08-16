import type { DB } from './index.js'
import { newId } from '../ids.js'
import { audit, type AdminActor } from './audit.js'
import { BUILTIN_BOARD } from '../themeDefaults.js'

/**
 * What a theme says about a widget TYPE: the design id, and nothing else (v11).
 *
 * A theme widget entry is `{ design }`. Colour comes from the palette — every design's slots
 * already default to a board colour — so a theme names geometry and the board names colour.
 */
export type ThemeWidgetEntry = string

export interface ThemeRow {
  id: string
  name: string
  board: string
  widgets: string
  chrome: string
  bg_kind: string
  bg_color: string | null
  bg_rev: number
  /**
   * The procedural backdrop this theme paints under everything (schema v10): a NAME the renderer
   * turns into CSS, derived from the board's own palette. Separate from bg_kind/bg_color, which
   * describe a user-uploaded image that paints OVER it.
   */
  backdrop: string
  /** Sparse event→family suggestion map (schema v27, alert-sound contract); parsed via `parseSounds` for reads. */
  sounds: string
  rev: number
  builtin: number
  created_at: number
}

export interface ThemeDocument {
  id: string
  rev: number
  board: object
  // The optional chrome map (tab-bar chrome) — always present on the document, defaulting to {} rather
  // than being omitted, so a client need not special-case "theme predates chrome" vs. "theme
  // sets no chrome overrides"; both look identical (an empty override map).
  chrome: object
  bg: { kind: string; color: string | null; rev: number }
  /** Procedural backdrop name (v10). Always present; 'flat' renders as plain `bg`. */
  backdrop: string
  /** Design id per widget type (v11). A theme names geometry; colour comes from the palette. */
  widgets: Record<string, string>
}

const COLS = 'id, name, board, widgets, chrome, bg_kind, bg_color, bg_rev, backdrop, sounds, rev, builtin, created_at'

export function createTheme(
  db: DB,
  input: {
    name: string
    board: object
    widgets: Record<string, ThemeWidgetEntry>
    chrome?: object
    bg_kind?: string
    bg_color?: string | null
    bg_rev?: number
    backdrop?: string
    sounds?: Record<string, string>
  },
): ThemeRow {
  const row: ThemeRow = {
    id: newId('thm'),
    name: input.name,
    board: JSON.stringify(input.board),
    widgets: JSON.stringify(input.widgets ?? {}),
    chrome: JSON.stringify(input.chrome ?? {}),
    bg_kind: input.bg_kind ?? 'none',
    backdrop: input.backdrop ?? 'flat',
    bg_color: input.bg_color ?? null,
    bg_rev: input.bg_rev ?? 0,
    sounds: JSON.stringify(input.sounds ?? {}),
    rev: 1,
    builtin: 0,
    created_at: Date.now(),
  }
  db.prepare(
    'INSERT INTO themes (id, name, board, widgets, chrome, bg_kind, bg_color, bg_rev, backdrop, sounds, rev, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id, row.name, row.board, row.widgets, row.chrome, row.bg_kind, row.bg_color, row.bg_rev,
    row.backdrop, row.sounds, row.rev, row.builtin, row.created_at,
  )
  return row
}

export function listThemes(db: DB): ThemeRow[] {
  return db.prepare(`SELECT ${COLS} FROM themes ORDER BY created_at`).all() as ThemeRow[]
}

export function getTheme(db: DB, id: string): ThemeRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM themes WHERE id = ?`).get(id) as ThemeRow | undefined
}

export function updateTheme(
  db: DB,
  id: string,
  patch: {
    name?: string
    board?: object
    widgets?: Record<string, ThemeWidgetEntry>
    chrome?: object
    bg_kind?: string
    bg_color?: string | null
    bg_rev?: number
    backdrop?: string
    sounds?: Record<string, string>
  },
): boolean {
  const existing = getTheme(db, id)
  if (!existing) return false
  const res = db
    .prepare(
      'UPDATE themes SET name = ?, board = ?, widgets = ?, chrome = ?, bg_kind = ?, bg_color = ?, bg_rev = ?, backdrop = ?, sounds = ?, rev = rev + 1 WHERE id = ?',
    )
    .run(
      patch.name ?? existing.name,
      patch.board !== undefined ? JSON.stringify(patch.board) : existing.board,
      patch.widgets !== undefined ? JSON.stringify(patch.widgets) : existing.widgets,
      patch.chrome !== undefined ? JSON.stringify(patch.chrome) : existing.chrome,
      patch.bg_kind ?? existing.bg_kind,
      patch.bg_color !== undefined ? patch.bg_color : existing.bg_color,
      patch.bg_rev ?? existing.bg_rev,
      patch.backdrop ?? existing.backdrop,
      patch.sounds !== undefined ? JSON.stringify(patch.sounds) : existing.sounds,
      id,
    )
  return res.changes > 0
}

/**
 * Delete-cascade (data model). Every screen pointing at this theme resets to `theme_id
 * NULL` — the built-in default — in the SAME transaction as the delete, and each reset is
 * audited, copying `deleteScreen`'s device-reset pattern (screens.ts:99). Builtins are never
 * deletable, mirroring `deleteColorset`'s guard.
 */
export function deleteTheme(
  db: DB, id: string, actor: AdminActor = { type: 'admin', id: null },
): { deleted: boolean; resetScreenIds: string[] } {
  return db.transaction(() => {
    const existing = getTheme(db, id)
    if (!existing || existing.builtin) return { deleted: false, resetScreenIds: [] }

    const resetScreenIds = (db.prepare('SELECT id FROM screens WHERE theme_id = ?').all(id) as { id: string }[]).map(
      (r) => r.id,
    )
    db.prepare('UPDATE screens SET theme_id = NULL WHERE theme_id = ?').run(id)
    const res = db.prepare('DELETE FROM themes WHERE id = ?').run(id)
    if (res.changes > 0) {
      for (const screenId of resetScreenIds) {
        audit(db, actor.type, actor.id, 'screen_theme_assigned', { screen_id: screenId, theme_id: null, reason: 'theme_deleted' })
      }
      audit(db, actor.type, actor.id, 'theme_deleted', { theme_id: id, reset_screens: resetScreenIds.length })
    }
    return { deleted: res.changes > 0, resetScreenIds }
  })()
}

/**
 * Background-image upload (theming: background image). Bumps `bg_rev` (the bg-bytes ETag,
 * mirroring feeds.image_rev) AND sets `bg_kind = 'image'` — an upload is the one action that
 * unambiguously means "the background is now this image", regardless of what it was before.
 * Critically, this ALSO bumps `rev` — the theme DOCUMENT's own ETag (see themesRoutes /
 * themeDocument above). If only `bg_rev` moved, a device that already cached the theme document
 * would keep serving it from cache (its `rev` unchanged) and would never learn `bg.kind`/`bg.rev`
 * changed, so it would never think to re-fetch the background bytes either.
 */
export function bumpBgRev(db: DB, id: string): number {
  db.prepare("UPDATE themes SET bg_kind = 'image', bg_rev = bg_rev + 1, rev = rev + 1 WHERE id = ?").run(id)
  return (db.prepare('SELECT bg_rev FROM themes WHERE id = ?').get(id) as { bg_rev: number }).bg_rev
}

/**
 * The document a device fetches for a theme.
 *
 * "Never a throw" covers the stored JSON itself being corrupted, not just references within it
 * being absent: `board`, `widgets` and `chrome` are each checked both for a parse failure AND for
 * parsing to the wrong shape (e.g. the column holding `"null"` — valid JSON, not an object), so a
 * bad row degrades to a sane default rather than crashing the read.
 */
export function themeDocument(db: DB, id: string): ThemeDocument | undefined {
  const theme = getTheme(db, id)
  if (!theme) return undefined

  // A syntax error OR a syntactically valid non-object (e.g. the column holding the string
  // "null") both degrade to {} — JSON.parse succeeding is not the same as it returning
  // something Object.entries can walk.
  let widgetsIn: Record<string, ThemeWidgetEntry>
  try {
    const parsed = JSON.parse(theme.widgets)
    widgetsIn = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    widgetsIn = {}
  }

  // Same "parsed but wrong shape ≠ failed to parse" distinction as widgetsIn above: a board
  // column holding valid JSON that isn't an object (e.g. the string "null", a number, an array)
  // parses without throwing and must still degrade to the built-in board.
  let board: object
  try {
    const parsed = JSON.parse(theme.board)
    board = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : BUILTIN_BOARD
  } catch {
    board = BUILTIN_BOARD
  }

  // Chrome (tab-bar chrome) degrades to {} on either failure shape, exactly like widgetsIn above — NOT
  // to BUILTIN_CHROME. Chrome is an optional per-key override map, not a mandatory full block
  // like board: per-key fallback to BUILTIN_CHROME happens downstream, in the device's
  // applyChromeToCss, the same place partial boards already get theirs.
  let chrome: object
  try {
    const parsed = JSON.parse(theme.chrome)
    chrome = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    chrome = {}
  }

  // Widget entries are bare design ids (v11). Anything that is not a non-empty string is skipped
  // rather than emitted broken — a widget with no entry simply follows the board.
  const widgets: Record<string, string> = {}
  for (const [type, entry] of Object.entries(widgetsIn)) {
    if (typeof entry === 'string' && entry) widgets[type] = entry
  }

  return {
    id: theme.id,
    rev: theme.rev,
    board,
    chrome,
    bg: { kind: theme.bg_kind, color: theme.bg_color, rev: theme.bg_rev },
    backdrop: theme.backdrop ?? 'flat',
    widgets,
  }
}
