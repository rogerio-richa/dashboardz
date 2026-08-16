import type { DB } from './index.js'
import { SCHEMA_V27, SCHEMA_V26, SCHEMA_V25, SCHEMA_V24, SCHEMA_V23, SCHEMA_V20, SCHEMA_V18, SCHEMA_V17, SCHEMA_V16, SCHEMA_V15, SCHEMA_V14, SCHEMA_V11, SCHEMA_V10, SCHEMA_V8, SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V7 } from './schema.js'
import { gridToRects } from './migrations/v6-rects.js'
import { migrateV19 } from './migrations/v19-sources.js'
import { BUILTIN_BOARD, BUILTIN_CHROME } from '../themeDefaults.js'
import { BUILTIN_THEMES } from '../builtinThemes.js'
import type { SecretBox } from '../secrets/box.js'

/**
 * v6 rewrites nested JSON, which json_set + four CASE branches can express but only end-to-end
 * tests can check. A function keeps the mapping unit-testable (v6-rects.ts). v1-v5 stay
 * byte-identical strings — the append-only rule is about entries, not the runner's type.
 */
const migrateV6 = (db: DB): void => {
  const rows = db.prepare('SELECT id, grid FROM screens').all() as { id: string; grid: string }[]
  const update = db.prepare('UPDATE screens SET grid = ? WHERE id = ?')
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.grid)
    } catch {
      // Unreadable before, unreadable after — leave it for an operator to delete in admin.
      console.warn(`v6: screen ${row.id} has unreadable grid; left untouched`)
      continue
    }
    update.run(JSON.stringify(gridToRects(parsed as { template?: string })), row.id)
  }
}

/**
 * v7: theming. DDL plus two seeded themes. `default` reproduces today's hard-coded palette
 * exactly (board AND the tab-bar chrome map, which is simply omitted here so the `chrome` column
 * default of '{}' applies — the same omit-and-rely-on-DEFAULT convention `bg_color` already uses
 * below) and every existing screen stays on theme_id NULL, so the migration is a provable visual
 * no-op (migrateV7.test.ts pins both blocks against index.html's :root). `cypherpunk` seeds a
 * FULL chrome map instead — every one of the twelve keys set and visibly different from
 * BUILTIN_CHROME — so the on-device check this code exists for shows a fully recoloured board,
 * not a mostly-recoloured one with stray default hairlines/surfaces still showing through.
 */
function migrateV7(db: DB): void {
  db.exec(SCHEMA_V7)
  const now = Date.now()
  db.prepare('INSERT INTO themes (id,name,board,widgets,bg_kind,bg_rev,rev,builtin,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('thm_default', 'Default', JSON.stringify(BUILTIN_BOARD), '{}', 'none', 0, 1, 1, now)

  const cypherBoard = {
    bg: '#0a0a0a', surface: '#141414', ink: '#ff2b2b', dim: '#5a1010', accent: '#ff2b2b',
    scrim: 0.55, info: '#3ad6ff', warn: '#ffb000', critical: '#ff2b2b',
    series: ['#ff2b2b', '#3ad6ff', '#ffb000', '#8affc1'],
  }
  const cypherChrome = {
    hairline: '#ff2b2b33', muted: '#8a4040', chip: '#ffb0b0', border: '#3a1414',
    surface_warn: '#241a08', surface_critical: '#240808', takeover_bg: '#1a0404',
    takeover_meta: '#ff6a6a', takeover_body: '#ffaaaa', takeover_hint_bg: '#140a0a',
    on_critical: '#000000', gauge_hole: '#0a0a0a',
  }
  db.prepare('INSERT INTO colorsets (id,name,widget,design,colors,rev,builtin,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('cs_colors_2054', 'colors_2054', 'clock', 'segment',
      JSON.stringify({ segment_on: '#ff2b2b', segment_off: '#2a0808', bezel: '#161616', colon: '#ff2b2b' }),
      1, 1, now)
  db.prepare('INSERT INTO themes (id,name,board,widgets,chrome,bg_kind,bg_rev,rev,builtin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('thm_cypherpunk', 'Cypherpunk', JSON.stringify(cypherBoard),
      JSON.stringify({ clock: { design: 'segment', colorset_id: 'cs_colors_2054' } }),
      JSON.stringify(cypherChrome),
      'none', 0, 1, 1, now)
}

/** Index i applies version i+1. Append only — never edit a shipped entry. */
/**
 * v9 — pin thm_default's chrome, now that chrome is DERIVED from the palette.
 *
 * Derivation (theme.mjs's CHROME_FROM_BOARD) is what lets a light theme exist at all: before it,
 * BUILTIN_CHROME was a hardcoded dark map and the only fallback, so a beige board rendered with
 * dark-theme furniture. But `thm_default` reproduces today's palette EXACTLY and is the reference
 * point the v7 no-op property rests on — and derivation does not land byte-identically on it
 * (gauge_hole follows `surface` now rather than `bg`; hairline is ink-tinted rather than pure
 * white). Both are improvements, and neither may be applied to the one theme that is a fixture.
 *
 * So thm_default gets today's twelve values written down explicitly. Every other theme derives.
 * Only fills an EMPTY chrome: a hub where somebody has already customised it keeps their values.
 */
export function migrateV9(db: DB): void {
  const row = db.prepare("SELECT chrome FROM themes WHERE id = 'thm_default'").get() as
    { chrome: string } | undefined
  if (!row) return
  let existing: unknown
  try { existing = JSON.parse(row.chrome) } catch { existing = null }
  const empty = !existing || typeof existing !== 'object' || Object.keys(existing).length === 0
  if (!empty) return
  db.prepare("UPDATE themes SET chrome = ?, rev = rev + 1 WHERE id = 'thm_default'")
    .run(JSON.stringify(BUILTIN_CHROME))
}

/**
 * v11 — collapse `themes.widgets` and drop `cell.config.colorset`, alongside SCHEMA_V11's table
 * drop (theme migration).
 *
 * A theme's widget entry becomes the design id alone. Existing rows hold
 * `{clock: {design, colorset_id}}`; anything unreadable is dropped rather than guessed at, since a
 * widget with no entry simply follows the board — the same degradation an absent theme already
 * gets.
 */
export function migrateV11(db: DB): void {
  for (const t of db.prepare('SELECT id, widgets FROM themes').all() as { id: string; widgets: string }[]) {
    let parsed: unknown
    try { parsed = JSON.parse(t.widgets) } catch { parsed = null }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const out: Record<string, string> = {}
    for (const [widget, entry] of Object.entries(parsed as Record<string, unknown>)) {
      // Already a bare design id (a re-run, or a row written after this migration).
      if (typeof entry === 'string' && entry) { out[widget] = entry; continue }
      const design = (entry as { design?: unknown } | null)?.design
      if (typeof design === 'string' && design) out[widget] = design
    }
    db.prepare('UPDATE themes SET widgets = ? WHERE id = ?').run(JSON.stringify(out), t.id)
  }

  for (const s of db.prepare('SELECT id, grid FROM screens').all() as { id: string; grid: string }[]) {
    let grid: { cells?: { config?: Record<string, unknown> }[] }
    try { grid = JSON.parse(s.grid) } catch { continue }
    if (!grid || !Array.isArray(grid.cells)) continue
    let touched = false
    for (const cell of grid.cells) {
      if (cell?.config && 'colorset' in cell.config) { delete cell.config.colorset; touched = true }
    }
    if (touched) db.prepare('UPDATE screens SET grid = ? WHERE id = ?').run(JSON.stringify(grid), s.id)
  }
}

/**
 * v13 — ship the built-in themes.
 *
 * Three new themes, plus the conversion of Cypherpunk to the palette-only model. v7 gave it a full
 * twelve-key chrome map because at the time a theme that authored only its palette rendered as a
 * light board wearing dark furniture; chrome derivation replaced that, and the map's continued
 * presence is now the only thing stopping Cypherpunk from exercising it. Its palette is re-authored
 * with it: v7's `dim` was 1.43:1 against the board (invisible, and `--dim` carries every secondary
 * label), and its `ink` and `critical` were the same colour, which derives `takeover_meta` and
 * `takeover_body` to one flat shade.
 *
 * Two guards, and both matter:
 *
 * - **Only a theme at `rev = 1` is rewritten.** Every write path bumps `rev` (updateTheme,
 *   bumpBgRev), so `rev > 1` means an operator has edited this theme and a migration that
 *   overwrote it would silently discard their work — on every hub restart, since the row would
 *   never match again. Same rule migrateV9 applies by only filling an EMPTY chrome map.
 * - **A rewrite bumps `rev`.** `rev` is the theme document's ETag and a device caches by `id:rev`
 *   (theme.mjs's currentKey), so converting Cypherpunk in place without bumping it would leave
 *   every device that already showed it painting the v7 colours until something else moved.
 *
 * Together those make the step idempotent without a version check: a row that already matches is
 * not written at all, so re-running changes nothing.
 *
 * `thm_default` is deliberately absent from the loop below. It is in BUILTIN_THEMES because it IS
 * one of the built-ins and the table would lie by omitting it, but it is seeded by v7 and pinned by
 * v9, and the v7 no-op property depends on nothing ever touching it again.
 */
export function migrateV13(db: DB): void {
  const now = Date.now()
  const insert = db.prepare(
    'INSERT INTO themes (id, name, board, widgets, chrome, bg_kind, bg_color, bg_rev, backdrop, rev, builtin, created_at)' +
    " VALUES (?, ?, ?, ?, '{}', 'none', NULL, 0, ?, 1, 1, ?)",
  )
  const update = db.prepare(
    "UPDATE themes SET name = ?, board = ?, widgets = ?, chrome = '{}', backdrop = ?, rev = rev + 1 WHERE id = ?",
  )

  BUILTIN_THEMES.forEach((theme, i) => {
    if (theme.id === 'thm_default') return
    const board = JSON.stringify(theme.board)
    const widgets = JSON.stringify(theme.widgets)

    const existing = db.prepare('SELECT name, board, widgets, chrome, backdrop, rev FROM themes WHERE id = ?')
      .get(theme.id) as
      { name: string; board: string; widgets: string; chrome: string; backdrop: string; rev: number } | undefined

    if (!existing) {
      // `now + i` rather than `now`: listThemes orders by created_at, and three rows sharing a
      // millisecond would otherwise sort by whatever SQLite felt like.
      insert.run(theme.id, theme.name, board, widgets, theme.backdrop, now + i)
      return
    }
    if (existing.rev !== 1) return // an operator has edited this theme — theirs wins
    const matches = existing.name === theme.name && existing.board === board &&
      existing.widgets === widgets && existing.chrome === '{}' && existing.backdrop === theme.backdrop
    if (matches) return // already converted; writing would bump rev and re-fetch for nothing
    update.run(theme.name, board, widgets, theme.backdrop, theme.id)
  })
}

/**
 * v21 — `gauge`'s old DOM branch read `config.style` ('ring'|'bar') to
 * pick between two hand-written HTML shapes. That branch is gone; `gauge/ring.mjs` and
 * `gauge/bar.mjs` are now two real DESIGNS, selected the same way every other multi-design widget
 * is — `config.design` (cell) → the theme's per-widget choice → the registry's own default (`bar`,
 * matching `gaugeConfig`'s (layout-core.mjs) own unbroken-since-inception `style` default).
 * `requestedDesign` (widgets/index.mjs) has never read `style` — left alone, a saved gauge cell
 * that set `style: 'ring'` would silently start rendering as `bar` (the registry default) the
 * moment this build ships, which is exactly the kind of silent contract change an append-only
 * migration exists to prevent. Confirmed live on this hub's own data: screens `lay_Wx4er5Uj`
 * (Meshtastic) and `lay_e-2OS5QM` (Kitchen Sink) both carry gauge cells with `"style": "ring"`.
 *
 * Rewrites `style` → `design` in place: `style: 'ring'` becomes `design: 'ring'`, `style: 'bar'`
 * becomes `design: 'bar'` — an explicit `bar` is written even though it equals the registry's own
 * default, so a future change to that default cannot retroactively reinterpret what was, at save
 * time, an operator's explicit choice. A cell that already carries BOTH `design` and `style` keeps
 * its own `design` untouched (design already wins at render time; this migration must not flip
 * what that cell has actually been rendering as) and simply loses the now-meaningless `style` key.
 * Non-gauge cells, and gauge cells with no `style` key at all, are left untouched. Idempotent: a
 * row with no `style` key never matches the guard below, so a second run is a no-op.
 */
export function migrateV21(db: DB): void {
  for (const s of db.prepare('SELECT id, grid FROM screens').all() as { id: string; grid: string }[]) {
    let grid: { cells?: { widget?: string; config?: Record<string, unknown> }[] }
    try { grid = JSON.parse(s.grid) } catch { continue }
    if (!grid || !Array.isArray(grid.cells)) continue
    let touched = false
    for (const cell of grid.cells) {
      if (!cell || cell.widget !== 'gauge' || !cell.config || !('style' in cell.config)) continue
      const style = cell.config.style
      if (!('design' in cell.config) && (style === 'ring' || style === 'bar')) cell.config.design = style
      delete cell.config.style
      touched = true
    }
    if (touched) db.prepare('UPDATE screens SET grid = ? WHERE id = ?').run(JSON.stringify(grid), s.id)
  }
}

/**
 * v22 — retire the `gauge_hole` chrome key. The DOM ring gauge's
 * `.gauge-ring-inner` CSS rule was its only reader, and that rule died with the whole DOM gauge
 * branch (v21's `config.style` retirement is the same cleanup, one layer up); `gauge/ring.mjs`
 * gets its donut-hole colour from a declared `hole` design token instead (default `@bg`), and a
 * canvas design cannot read chrome at all — `resolveTokens` (widgets/tokens.mjs) resolves only
 * against the board palette. So `gauge_hole` is read by nothing, on every theme it was ever
 * stamped onto, including the `cypherpunk` seed migrateV7 wrote and the copy migrateV9 pinned onto
 * `thm_default`.
 *
 * Strips the `gauge_hole` key out of every theme's stored `chrome` JSON blob, in place. Every
 * other chrome key on the row is left exactly as stored — this deletes one key, it does not
 * rewrite or re-derive the object — and every other column on the row is untouched (only `chrome`
 * is written, and only for rows that actually change). A chrome blob that is absent, unparsable,
 * `null`, or not a plain object is left alone rather than guessed at, the same "leave it for an
 * operator" rule migrateV6 set for an unreadable `grid`. Idempotent: a chrome blob that parses but
 * never held `gauge_hole` (already migrated, or a theme that never had it) is skipped without a
 * write, so a second run touches nothing further.
 */
export function migrateV22(db: DB): void {
  const rows = db.prepare('SELECT id, chrome FROM themes').all() as { id: string; chrome: string }[]
  const update = db.prepare('UPDATE themes SET chrome = ? WHERE id = ?')
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.chrome)
    } catch {
      // Unreadable before, unreadable after — same rule migrateV6 applies to an unreadable grid.
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const chrome = parsed as Record<string, unknown>
    if (!('gauge_hole' in chrome)) continue // nothing to strip; also makes a re-run a no-op
    delete chrome.gauge_hole
    update.run(JSON.stringify(chrome), row.id)
  }
}

/**
 * v27 — alert sounds (alert-sound contract): DDL from SCHEMA_V27, then curated builtin seeding on FRESH installs
 * only.
 *
 * `context.fromVersion !== 0` means this hub was already at some earlier version before `migrate()`
 * started — an upgrade — and the whole point of alert-sound contract is that upgrading never changes what an
 * existing room sounds like, so the function returns right after the ALTERs with every row's
 * `sounds` at the column default `'{}'` (classic, everywhere).
 *
 * A FRESH install (`fromVersion === 0`) has no operator customisation to protect yet, so this
 * writes the curated `sounds` map from `BUILTIN_THEMES` onto the matching theme row — except
 * `thm_default`, which stays the untouched fixture the v7 no-op property rests on (the same
 * carve-out `migrateV13` applies to name/board/widgets/chrome/backdrop). Idempotent: writing the
 * same JSON string twice is a no-op in effect, and no `rev` bump is needed either way — a fresh
 * install has no device caches to invalidate yet.
 */
export function migrateV27(db: DB, context: MigrationContext): void {
  // Guarded rather than a blind SCHEMA_V27.exec: the runner only ever reaches this step once per
  // hub, but the exported function is also called directly by tests (the migrateV22.test.ts
  // pattern) against a db that has already been through it — SQLite has no `ADD COLUMN IF NOT
  // EXISTS`, so re-running an unguarded ALTER TABLE would throw "duplicate column name". Both
  // ALTERs in SCHEMA_V27 always land together, so checking one column stands in for both.
  const hasSoundsColumn = (db.pragma('table_info(themes)') as { name: string }[]).some((c) => c.name === 'sounds')
  if (!hasSoundsColumn) db.exec(SCHEMA_V27)
  if (context.fromVersion !== 0) return // upgrades stay classic — alert-sound contract
  const update = db.prepare('UPDATE themes SET sounds = ? WHERE id = ?')
  for (const theme of BUILTIN_THEMES) {
    if (!theme.sounds || theme.id === 'thm_default') continue // default fixture never touched (migrateV13 rule)
    update.run(JSON.stringify(theme.sounds), theme.id)
  }
}

export interface MigrationContext {
  secretBox?: SecretBox
  /** Builds historical fixtures and recovery probes without duplicating shipped migration SQL. */
  targetVersion?: number
  /**
   * `user_version` as read ONCE at the start of this `migrate()` call, before any step ran.
   * `migrate()` always fills this in for every step it invokes — optional here only so a direct
   * unit-test call to an exported step (`migrateV27(db, { fromVersion: 0 })`, the `migrateV22.test`
   * pattern) can supply it without also constructing the rest of the context. `migrateV27` uses it
   * to tell a fresh install (0) from an upgrade (26+): curated builtin sounds are seeded only on
   * the former, so an upgrade never changes what a room already sounds like.
   */
  fromVersion?: number
}

const unavailableSecretBox: SecretBox = {
  seal() { throw new Error('Secret box is unavailable for this migration') },
  open() { throw new Error('Secret box is unavailable for this migration') },
}

type Migration = string | ((db: DB, context: MigrationContext) => void)

const MIGRATIONS: readonly Migration[] = Object.freeze([
  SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, migrateV6, migrateV7, SCHEMA_V8,
  migrateV9, SCHEMA_V10, SCHEMA_V11, migrateV11, migrateV13, SCHEMA_V14, SCHEMA_V15,
  SCHEMA_V16, SCHEMA_V17, SCHEMA_V18,
  (db: DB, context: MigrationContext) => migrateV19(db, context.secretBox ?? unavailableSecretBox),
  SCHEMA_V20, migrateV21, migrateV22, SCHEMA_V23, SCHEMA_V24, SCHEMA_V25, SCHEMA_V26, migrateV27,
])

export const LATEST_VERSION = MIGRATIONS.length

/**
 * Applies every migration above the current user_version, each inside its own transaction so a
 * crash or a failing statement can never leave a half-applied schema recorded as complete.
 * (better-sqlite3's db.transaction rolls back on throw, and DDL is transactional in SQLite.)
 */
export function migrate(db: DB, context: MigrationContext = {}): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const targetVersion = context.targetVersion ?? MIGRATIONS.length
  if (!Number.isInteger(targetVersion) || targetVersion < current || targetVersion > MIGRATIONS.length) {
    throw new Error(`Migration target must be an integer from ${current} through ${MIGRATIONS.length}`)
  }
  // Read once, before any step runs, and pass the SAME value through to every step this call
  // makes — a step must see where this hub started, not what user_version happens to be by the
  // time its own turn comes up mid-loop.
  const fromVersion = current
  const stepContext: MigrationContext = { ...context, fromVersion }
  for (let v = current; v < targetVersion; v++) {
    const step = MIGRATIONS[v]
    const target = v + 1
    db.transaction(() => {
      if (typeof step === 'string') db.exec(step)
      else step(db, stepContext)
      db.pragma(`user_version = ${target}`)
    })()
  }
}
