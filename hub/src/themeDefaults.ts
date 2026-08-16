/**
 * The built-in board block. These values ARE today's `:root` custom properties in
 * static/device/index.html, and migrateV7.test.ts asserts them against that file rather than
 * against copies — so the two cannot drift. `accent` and `info` share a value only because
 * `--info` currently serves both roles; they are separate fields on purpose.
 */
export interface BoardBlock {
  bg: string; surface: string; ink: string; dim: string; accent: string
  scrim: number
  info: string; warn: string; critical: string
  series: string[]
}

const INFO = '#4a90d9'
const WARN = '#f0a020'
const CRITICAL = '#e0323c'
const DIM = '#8a90a0'

export const BUILTIN_BOARD: BoardBlock = Object.freeze({
  bg: '#0b0d12',
  surface: '#12141c',
  ink: '#e6e9f0',
  dim: DIM,
  accent: INFO,
  scrim: 0.5,
  info: INFO,
  warn: WARN,
  critical: CRITICAL,
  // Deliberately today's cycling, alarm-red third series included: v7 must be a provable no-op.
  // Every other theme sets a sane ramp; fixing `default` is a visible change, not a migration.
  series: [INFO, WARN, CRITICAL, DIM],
}) as BoardBlock

/**
 * The optional chrome map (tab-bar chrome). The tab bar tokenises eleven more `:root` custom properties in
 * index.html that the board block above does not drive — hairlines, muted text, chips, borders,
 * the warn/critical surface tints, the takeover overlay's own palette, and the critical-on-critical
 * text colour. Every key here is OPTIONAL on a theme document: a theme
 * that sets only `board` must render identically to today, so every consumer of a partial chrome
 * map falls back to this built-in PER KEY (never `undefined` — invalid at computed-value time).
 * Pinned byte-for-byte against index.html's `:root` by migrateV7.test.ts, the same way
 * BUILTIN_BOARD is, and against the device-side twin (theme.mjs) by deviceTheme.test.ts.
 */
export interface ChromeBlock {
  hairline: string
  muted: string
  chip: string
  border: string
  surface_warn: string
  surface_critical: string
  takeover_bg: string
  takeover_meta: string
  takeover_body: string
  takeover_hint_bg: string
  on_critical: string
}

export const BUILTIN_CHROME: ChromeBlock = Object.freeze({
  hairline: '#ffffff14',
  muted: '#a8adbd',
  chip: '#c0c5d0',
  border: '#2a2e38',
  surface_warn: '#141826',
  surface_critical: '#1a1216',
  takeover_bg: '#2a080c',
  takeover_meta: '#ff8a90',
  takeover_body: '#ffb4b8',
  takeover_hint_bg: '#1c202a',
  on_critical: '#fff',
}) as ChromeBlock
