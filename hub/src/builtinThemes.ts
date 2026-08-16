import type { BoardBlock, ChromeBlock } from './themeDefaults.js'
import { BUILTIN_BOARD, BUILTIN_CHROME } from './themeDefaults.js'

/**
 * The themes a hub ships with.
 *
 * Every one of these authors a palette and a backdrop NAME, and nothing else. The twelve chrome
 * colours derive from the palette (theme.mjs's CHROME_FROM_BOARD) and the backdrop is a pure
 * function of it too, so a theme is eight colours, a four-stop ramp, a scrim and one word. That
 * was the whole point of the simplification: 22 hand-authored colours per theme is why there were
 * only ever two.
 *
 * `thm_default` is the exception on every axis and must stay that way — it reproduces today's
 * `:root` block exactly, keeps the explicit chrome map v9 wrote down, and keeps `widgets` empty so
 * clocks land on the registry default. It is the fixture the v7 no-op property rests on.
 *
 * Palettes are chosen against a legibility floor, not by eye alone (builtinThemes.test.ts): body
 * text clears WCAG AA at 4.5:1, and labels, strokes, severity colours and the chart ramp clear 3:1
 * against whatever they are actually drawn on. Two of the four are LIGHT, deliberately — chrome
 * derivation only had dark boards to prove itself against until now, and the failure it replaced
 * was specifically a light board wearing dark-theme furniture.
 */
export interface BuiltinTheme {
  id: string
  name: string
  board: BoardBlock
  /** Design id per widget type (v11). Absent entries follow the registry default. */
  widgets: Record<string, string>
  /** Procedural backdrop name (v10), rendered from the palette above. */
  backdrop: 'flat' | 'wash' | 'glow' | 'grid'
  /**
   * An explicit override map, which only `thm_default` has any business carrying. Present on the
   * type because the escape hatch has to exist; absent everywhere it should be.
   */
  chrome?: ChromeBlock
  /**
   * Suggested event→family sound map (alert-sound contract, v27). Absent means classic — the programmatic tone
   * path — which is what `thm_default` and any theme with no strong sonic character keep. Seeded
   * onto the matching row by `migrateV27`, and only on a FRESH install: an upgrade never changes
   * what an existing room sounds like.
   */
  sounds?: Record<string, string>
}

/**
 * Near-black with neon red ink.
 *
 * Re-authored from v7's seed rather than kept: that palette was written when a theme hand-authored
 * all twelve chrome keys, so nothing in it had to survive derivation, and two things did not.
 * `dim` was `#5a1010` on a `#0a0a0a` board — 1.43:1, which is not dim but absent, and `--dim`
 * carries every secondary label on the board. And `ink` and `critical` were the SAME `#ff2b2b`,
 * which makes `takeover_meta` and `takeover_body` (both `mix(critical, ink, t)`) derive to one
 * identical colour, flattening the critical overlay that alarm-volume rule and native takeover boundary exist to make unmissable.
 *
 * So `ink` brightens to `#ff4d4d` (headroom for the muted/chip blends to stay legible after being
 * mixed 30% toward the background), `dim` becomes a dusty red that can actually be read, and
 * `critical` moves to a hotter magenta-red distinct from the ink it sits next to. `accent` keeps
 * v7's exact `#ff2b2b`, so the board's signature colour is unchanged.
 */
const CYPHERPUNK: BoardBlock = {
  bg: '#0a0a0a',
  surface: '#141414',
  ink: '#ff4d4d',
  dim: '#b06a6a',
  accent: '#ff2b2b',
  scrim: 0.55,
  info: '#3ad6ff',
  warn: '#ffb000',
  critical: '#ff0044',
  series: ['#ff2b2b', '#3ad6ff', '#ffb000', '#8affc1'],
}

/**
 * Cream and terracotta — the warm light theme, and the one the `wash` backdrop was written for
 * (a diagonal lift from `bg` toward `surface` reads as paper rather than as a gradient).
 *
 * Everything here is a mid-to-dark tone on a light board, which is the inverse of every palette
 * that existed before chrome derivation landed. The ramp is deliberately not four hues of one
 * family: terracotta, teal, gold and olive stay distinguishable when a chart draws them as thin
 * strokes on cream.
 */
const TOSCANA: BoardBlock = {
  bg: '#f4ece0',
  surface: '#fbf6ee',
  ink: '#3d2b1f',
  dim: '#7a6349',
  accent: '#b04e1c',
  scrim: 0.35,
  info: '#2f6f6b',
  warn: '#8f6205',
  critical: '#9c2323',
  series: ['#b04e1c', '#2f6f6b', '#8f6205', '#5f7333'],
}

/**
 * Cool light grey with slate ink and a muted blue accent — the restrained light theme, and the
 * only one of the four on `flat`, so the plainest possible backdrop gets shipped and looked at.
 *
 * The Nord family this borrows from is authored for DARK backgrounds, so its aurora colours are
 * pale by construction and every one of them had to be darkened to clear 3:1 on a light board.
 * `#a3be8c`, Nord's green, is 2.4:1 here and is not usable; `#5d8442` is the same hue with the
 * luminance a light theme needs.
 */
const NORDIC: BoardBlock = {
  bg: '#eceff3',
  surface: '#f8fafc',
  ink: '#2e3440',
  dim: '#5d6877',
  accent: '#4c6f96',
  scrim: 0.35,
  info: '#4c6f96',
  warn: '#8a660d',
  critical: '#a5474f',
  series: ['#4c6f96', '#5d8442', '#8a660d', '#8a5a8e'],
}

/**
 * Pure black and phosphor green — the extreme, and the reason `grid` exists: a hairline lattice at
 * 40px on true black is the one backdrop that reads as a CRT rather than as decoration.
 *
 * Amber and red are period-correct rather than a compromise (amber was the other phosphor), and
 * they are the only way `warn` and `critical` can be told apart from everything else on a board
 * where the ink is a single saturated green.
 */
const TERMINAL: BoardBlock = {
  bg: '#000000',
  surface: '#0a0f0a',
  ink: '#33ff33',
  dim: '#23a023',
  accent: '#33ff33',
  scrim: 0.6,
  info: '#00d0ff',
  warn: '#ffb000',
  critical: '#ff3b30',
  series: ['#33ff33', '#ffb000', '#ff3b30', '#00d0ff'],
}

export const BUILTIN_THEMES: readonly BuiltinTheme[] = Object.freeze([
  { id: 'thm_default', name: 'Default', board: BUILTIN_BOARD, widgets: {}, backdrop: 'flat', chrome: BUILTIN_CHROME },
  {
    id: 'thm_cypherpunk', name: 'Cypherpunk', board: CYPHERPUNK, widgets: { clock: 'segment' }, backdrop: 'glow',
    sounds: { critical: '8bit', warn: '8bit', info: '8bit', offline: '8bit', activity: '8bit' },
  },
  {
    id: 'thm_toscana', name: 'Toscana', board: TOSCANA, widgets: { clock: 'analog' }, backdrop: 'wash',
    sounds: { critical: 'bells', warn: 'bells', info: 'bells', offline: 'bells', activity: 'bells' },
  },
  {
    id: 'thm_nordic', name: 'Nordic', board: NORDIC, widgets: { clock: 'digital' }, backdrop: 'flat',
    sounds: { critical: 'bells', warn: 'bells', info: 'bells', offline: 'bells', activity: 'bells' },
  },
  { id: 'thm_terminal', name: 'Terminal', board: TERMINAL, widgets: { clock: 'segment' }, backdrop: 'grid' },
] as BuiltinTheme[])
