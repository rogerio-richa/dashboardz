import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { applyBoardToCss, applyChromeToCss, currentBoard, currentChrome, currentWidgets, noteThemeRef, _reset, BUILTIN_BOARD, BUILTIN_CHROME } from '../static/device/theme.mjs'
// @ts-expect-error plain JS module without types
import { designFor, paintWidgets, stopAllWidgets } from '../static/device/widgets/index.mjs'
// `themeSeriesRamp` moved out of the deleted `charts.mjs` and into `widgets/tokens.mjs` — next to
// `builtinRamp`, the fallback it selects between, and to the `valid('color', …)`
// check its own COLOR_RE copy would duplicate.
// @ts-expect-error plain JS module without types
import { builtinRamp, themeSeriesRamp } from '../static/device/widgets/tokens.mjs'

describe('board -> substitution points', () => {
  it('maps every board colour onto its CSS custom property', () => {
    const set: Record<string, string> = {}
    applyBoardToCss({ ...BUILTIN_BOARD, bg: '#101010', surface: '#202020', ink: '#303030' }, (k: string, v: string) => { set[k] = v })
    expect(set['--bg']).toBe('#101010')
    expect(set['--card']).toBe('#202020')
    expect(set['--text']).toBe('#303030')
    expect(Object.keys(set).sort()).toEqual(['--bg', '--card', '--critical', '--dim', '--info', '--text', '--warn'])
  })

  it('a theme entry selects the design for a clock cell', () => {
    expect(designFor({ widget: 'clock', config: {} }, { clock: 'analog' }).meta.id).toBe('analog')
  })

  it('the cell overrides the theme', () => {
    expect(designFor({ widget: 'clock', config: { design: 'segment' } }, { clock: 'analog' }).meta.id).toBe('segment')
  })

  it('falls back to the library default when neither names one', () => {
    expect(designFor({ widget: 'clock', config: {} }, {}).meta.id).toBe('digital')
  })

  /**
   * The stand-in must be unbuildable, and the test must prove that an unknown design falls back to
   * digital rather than assume it.
   */
  it('an unknown theme design falls back, and its colours simply do not match', () => {
    const absent = '__no_such_design__'
    expect(designFor({ widget: 'clock', config: { design: absent } }).meta.id).not.toBe(absent)
    expect(designFor({ widget: 'clock', config: {} }, { clock: absent }).meta.id).toBe('digital')
  })

  it('an empty-string cell design does not suppress the theme\'s design', () => {
    expect(designFor({ widget: 'clock', config: { design: '' } }, { clock: 'analog' }).meta.id).toBe('analog')
  })

  // A fetched board can omit a key (nothing today validates that every
  // one of the ten is present — isValidDocument only checks `board` is an object). Writing
  // `undefined` straight onto a CSS custom property is invalid at computed-value time and drops
  // that property to its initial value — worse than never theming it at all.
  it('falls back to the built-in board colour for any key the fetched board omits', () => {
    const { warn, ...partialBoard } = BUILTIN_BOARD
    const set: Record<string, string> = {}
    applyBoardToCss(partialBoard, (k: string, v: string) => { set[k] = v })
    expect(set['--warn']).toBe(BUILTIN_BOARD.warn)
    expect(set['--warn']).not.toBe(undefined)
  })

  // The same defence applies to a value that is PRESENT but cannot render.
  // Nothing guaranteed these were colours — the admin API typed them as bare strings until this
  // same round added a `pattern`, so a hub that predates it can still hold `ink: "not-a-colour"`.
  // Written straight through, that sets `--text: not-a-colour`, which is invalid at
  // computed-value time and drops the WHOLE property to its initial value.
  it('falls back to the built-in board colour for any key holding a non-colour', () => {
    const set: Record<string, string> = {}
    applyBoardToCss({ ...BUILTIN_BOARD, ink: 'not-a-colour', bg: 'rgb(0 0 0', warn: 42 }, (k: string, v: string) => { set[k] = v })
    expect(set['--text']).toBe(BUILTIN_BOARD.ink)
    expect(set['--bg']).toBe(BUILTIN_BOARD.bg)
    expect(set['--warn']).toBe(BUILTIN_BOARD.warn)
  })

  it('accepts every colour literal shape the canvas half accepts (#rgb, #rrggbb, #rrggbbaa)', () => {
    const set: Record<string, string> = {}
    applyBoardToCss({ ...BUILTIN_BOARD, ink: '#fff', bg: '#010203', dim: '#01020304' }, (k: string, v: string) => { set[k] = v })
    expect(set['--text']).toBe('#fff')
    expect(set['--bg']).toBe('#010203')
    expect(set['--dim']).toBe('#01020304')
  })

  /**
   * The two colour-validity conventions are duplicated across a boundary neither side can import
   * over (theme.mjs is browser-loaded plain ESM; tokens.mjs does not export its regex and must not
   * grow an export for this). Pinned by source text, exactly as BUILTIN_BOARD is pinned to its hub
   * twin by a `toEqual`: if this fails, the two halves no longer agree on what a colour is, and the
   * same stored theme will degrade differently depending on which one reads it. Edit both or neither.
   */
  it('the board validator and the canvas token validator share one colour shape', () => {
    const RE = /const COLOR_RE = (\/\S+\/i)\n/
    const themeSrc = RE.exec(readFileSync('static/device/theme.mjs', 'utf8'))![1]
    const tokensSrc = RE.exec(readFileSync('static/device/widgets/tokens.mjs', 'utf8'))![1]
    expect(themeSrc).toBe(tokensSrc)
  })

  /**
   * There were THREE copies of that regex, and the third — `charts.mjs`'s private one, inside
   * `themeSeriesRamp` — is gone rather than repointed. `themeSeriesRamp` moved into `tokens.mjs`
   * and now validates through the same `valid('color', …)` every token default already goes
   * through, so the copy it needed no longer exists. Asserted, not assumed: two copies is the
   * claim, and a third reappearing anywhere under `static/device/` fails here.
   */
  it('has exactly two copies of the colour shape left, and they are the two above', () => {
    const files = readdirSync('static/device', { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('.mjs') || p.endsWith('.js'))
      .filter((p) => /const COLOR_RE =/.test(readFileSync(`static/device/${p}`, 'utf8')))
    expect(files.sort()).toEqual(['theme.mjs', 'widgets/tokens.mjs'])
  })
})

/**
 * The CANVAS substitution point. This file was titled "board ->
 * substitution points" but tested only ONE of the two: the CSS custom properties, plus designFor,
 * which selects a DESIGN and never touches a colour. Every paintWidgets call site in the suite
 * passed a built-in palette constant, never a theme's board — so the half where a board reaches a
   * canvas design, through resolveTokens, was completely untested; this regression has two halves:
 * degrading differently) lived there in earlier versions.
 *
 * Driven end to end through the REAL modules: a theme document fetched by the REAL noteThemeRef,
 * read back through the REAL currentBoard(), painted by the REAL paintWidgets into the REAL
 * digital design, and asserted on the colours that design actually assigned to `fillStyle`.
 * Nothing about the resolution path is stubbed — only `document.querySelectorAll` (paintWidgets'
 * single DOM dependency) and the 2d context, which records instead of rasterising.
 */
function recordingCanvas(idx: number) {
  const painted: string[] = []
  const g = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (k === 'measureText' ? (s: string) => ({ width: s.length * 4 }) : () => {}),
    set: (_t, k, v) => { if (k === 'fillStyle' || k === 'strokeStyle') painted.push(String(v)); return true },
  })
  return { painted, canvas: { width: 0, height: 0, style: {}, dataset: { cell: String(idx) }, getContext: () => g } }
}

/** One full-cell digital clock: `time` defaults to `@ink`, `date` to `@dim` — two board keys. */
const CELLS = [{ widget: 'clock', config: { design: 'digital' } }]
const BOXES = [{ rect: { x: 0, y: 0, w: 1, h: 1 }, px: { left: 0, top: 0, width: 400, height: 200 }, t: 1 }]
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0)

/**
 * Loads `board`/`chrome` the way a device actually does — a real theme document through the real
 * noteThemeRef — so everything downstream reads the PRODUCTION `currentBoard()`/`currentChrome()`
 * objects rather than a literal a test author typed. That distinction is not cosmetic: it is the
   * whole failure, and a second module exercises the same fallback (see the series-ramp suite at
   * the bottom of this file).
 */
async function loadTheme(board: object, chrome: object = {}) {
  _reset()
  const doc = { id: 'thm_x', rev: 1, board, chrome, widgets: {}, bg: { kind: 'none' } }
  await noteThemeRef({ id: 'thm_x', rev: 1 }, {
    fetchFn: async () => ({ ok: true, json: async () => doc }), now: () => 0,
  })
}

/** Fetches `board` as a real theme document, then paints it and returns what got painted. */
async function paintThemedBoard(board: object) {
  await loadTheme(board)
  const rec = recordingCanvas(0)
  ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => [rec.canvas] }
  paintWidgets(CELLS, BOXES, currentBoard(), () => NOW, currentWidgets())
  return rec.painted
}

describe('board -> the canvas substitution point', () => {
  beforeEach(() => _reset())
  afterEach(() => {
    stopAllWidgets()
    delete (globalThis as Record<string, unknown>).document
  })

  it('paints a canvas design in the THEME’s colours, not the built-in ones', async () => {
    const painted = await paintThemedBoard({ ...BUILTIN_BOARD, ink: '#00ff00', dim: '#ff00ff' })
    // `time` resolves @ink, `date` resolves @dim — both off the theme's board, neither built-in.
    expect(painted).toContain('#00ff00')
    expect(painted).toContain('#ff00ff')
    expect(painted).not.toContain(BUILTIN_BOARD.ink)
    expect(painted).not.toContain(BUILTIN_BOARD.dim)
  })

  /**
   * first half. A board can reach the device missing keys — `isValidDocument` only
   * requires `board` to be an object, and the admin API's board schema has no `required` list —
   * and a key the palette lacks resolves through tokens.mjs's LAST_RESORT to `#000000`. On the
   * partial board below that painted the clock's date slot black on a near-black board, while the
   * CSS half of the very same theme correctly used the built-in `--dim`.
   */
  it('a partial board falls back to the built-in per key instead of painting black', async () => {
    const painted = await paintThemedBoard({ bg: '#101010', ink: '#00ff00' })
    expect(painted).toContain('#00ff00')          // the theme's own ink still wins
    expect(painted).toContain(BUILTIN_BOARD.dim)  // the omitted key -> built-in
    expect(painted).not.toContain('#000000')      // ...not LAST_RESORT black on a black board
  })

  /** Second half: present-but-unrenderable degrades identically to absent. */
  it('a non-colour board value falls back to the built-in instead of painting black', async () => {
    const painted = await paintThemedBoard({ ...BUILTIN_BOARD, ink: 'not-a-colour', bg: 'rgb(0 0 0' })
    expect(painted).toContain(BUILTIN_BOARD.ink)
    expect(painted).not.toContain('#000000')
    expect(painted).not.toContain('not-a-colour')
  })

  /**
   * The regression guard, stated as the invariant rather than as a case:
   * whatever a board does to one substitution point it must do to the other. Both scenarios above,
   * asserted as CSS-half === canvas-half rather than against hardcoded expectations — so a future
   * change that "fixes" one half alone fails here even if it satisfies every test above.
   */
  it('both substitution points degrade a bad board identically', async () => {
    for (const board of [{ bg: '#101010', ink: '#00ff00' }, { ...BUILTIN_BOARD, ink: 'not-a-colour' }]) {
      const painted = await paintThemedBoard(board)
      const css: Record<string, string> = {}
      applyBoardToCss(currentBoard(), (k: string, v: string) => { css[k] = v })
      // digital paints `time` (@ink) first, then `date` (@dim).
      expect(painted[0]).toBe(css['--text'])
      expect(painted[1]).toBe(css['--dim'])
    }
  })
})

// tab-bar chrome: the eleven chrome keys index.html tokenises but the board block does not drive
// (--hairline, --muted, --chip, --border, --surface-warn, --surface-critical, --takeover-bg,
// --takeover-meta, --takeover-body, --takeover-hint-bg, --on-critical).
describe('chrome -> substitution points', () => {
  it('maps every chrome colour onto its CSS custom property', () => {
    const set: Record<string, string> = {}
    applyChromeToCss(BUILTIN_CHROME, BUILTIN_BOARD, (k: string, v: string) => { set[k] = v })
    expect(set['--hairline']).toBe(BUILTIN_CHROME.hairline)
    expect(set['--surface-warn']).toBe(BUILTIN_CHROME.surface_warn)
    expect(set['--takeover-hint-bg']).toBe(BUILTIN_CHROME.takeover_hint_bg)
    expect(set['--on-critical']).toBe(BUILTIN_CHROME.on_critical)
    expect(Object.keys(set).sort()).toEqual([
      '--border', '--chip', '--hairline', '--muted', '--on-critical',
      '--surface-critical', '--surface-warn', '--takeover-bg', '--takeover-body',
      '--takeover-hint-bg', '--takeover-meta',
    ])
  })

  // A theme that sets only `board` (or an empty chrome map) must render EXACTLY today's CSS
  // values — the whole point of chrome being optional.
  /**
   * A theme with no chrome derives its furniture from its own board rather than a hardcoded DARK
   * map, so a light theme does not render with dark-theme furniture.
   *
   * thm_default is the exception and keeps the old values written down explicitly (migration v9),
   * because it is the fixture the v7 no-op property rests on.
   */
  it('a theme with no chrome derives its furniture from its own board', () => {
    const set: Record<string, string> = {}
    applyChromeToCss({}, BUILTIN_BOARD, (k: string, v: string) => { set[k] = v })
    // Every key still resolves to a colour literal...
    for (const key of ['--hairline', '--muted', '--chip', '--border', '--surface-warn',
      '--surface-critical', '--takeover-bg', '--takeover-meta', '--takeover-body',
      '--takeover-hint-bg', '--on-critical']) {
      expect(set[key], key).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
    }
    // ...and the ones that CAN be derived exactly still are: text on critical stays white on this
    // palette.
    expect(set['--on-critical']).toBe('#ffffff')
    // The hairline is now tinted by ink rather than pure white — that is the whole point, since
    // white at 8% is invisible on a light board.
    expect(set['--hairline']).not.toBe(BUILTIN_CHROME.hairline)
  })

  it('thm_default keeps today\'s exact values, because it is the fixture', () => {
    const set: Record<string, string> = {}
    // Migration v9 writes BUILTIN_CHROME onto thm_default; an explicit map still wins outright.
    applyChromeToCss(BUILTIN_CHROME, BUILTIN_BOARD, (k: string, v: string) => { set[k] = v })
    expect(set['--hairline']).toBe(BUILTIN_CHROME.hairline)
    expect(set['--muted']).toBe(BUILTIN_CHROME.muted)
    expect(set['--takeover-bg']).toBe(BUILTIN_CHROME.takeover_bg)
  })

  // Same shape as the board test above, applied to chrome: a partial chrome
  // override map (e.g. a theme that customises only `muted`) must fall back to the built-in for
  // every OTHER key rather than writing `--x: undefined` (invalid at computed-value time, drops
  // the whole property to its initial value — worse than never theming it at all).
  it('derives every key a partial chrome map omits, and honours the one it sets', () => {
    const set: Record<string, string> = {}
    applyChromeToCss({ muted: '#123456' }, BUILTIN_BOARD, (k: string, v: string) => { set[k] = v })
    expect(set['--muted']).toBe('#123456')
    // The rest derive from the board rather than taking a hardcoded dark value.
    for (const key of ['--hairline', '--border', '--surface-warn', '--surface-critical',
      '--takeover-bg', '--takeover-meta', '--takeover-body']) {
      expect(set[key], key).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
    }
    expect(true).toBe(true)
    expect(set['--on-critical']).toBe('#ffffff')
    // No key is EVER written as undefined.
    expect(Object.values(set)).not.toContain(undefined)
  })

  /**
   * A non-colour override is IGNORED and the key derives instead. Deriving preserves a light
   * board's palette when a corrupt override is supplied. The built-in remains the last resort for a
   * board that cannot be derived from at all — covered in chromeDerivation.test.ts.
   */
  it('ignores a non-colour override and derives that key instead', () => {
    const set: Record<string, string> = {}
    applyChromeToCss({ muted: 'rebeccapurple', border: 42 }, BUILTIN_BOARD, (k: string, v: string) => { set[k] = v })
    expect(set['--muted']).not.toBe('rebeccapurple')
    expect(set['--border']).not.toBe(42 as unknown as string)
    for (const key of ['--muted', '--border']) {
      expect(set[key], key).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
    }
  })

  /**
   * Before derivation existed, chrome fell back key-by-key to a hardcoded
   * DARK built-in, so a theme that recoloured `board.bg` and set no chrome stamped dark furniture
   * (a dark ring-gauge hole among them, back when `gauge_hole` still existed) onto a light board.
   * A light theme is the obvious first thing an operator tries, so this was not an exotic
   * combination. Now every key derives from the board instead, and the assertion is about the
   * whole map rather than any one key.
   */
  it('a light board gets light furniture across the whole map', () => {
    const set: Record<string, string> = {}
    const lightBoard = { ...BUILTIN_BOARD, bg: '#fafafa', surface: '#ffffff', ink: '#101010' }
    applyChromeToCss({}, lightBoard, (k: string, v: string) => { set[k] = v })
    const lum = (hex: string) => {
      const h = hex.slice(1, 7)
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    for (const key of ['--border', '--surface-warn', '--surface-critical', '--takeover-hint-bg']) {
      expect(lum(set[key]), `${key} must be light on a light board`).toBeGreaterThan(0.5)
    }
  })

  /**
   * The same literal-vs-production-object distinction as the series ramp: every
   * assertion above hands applyChromeToCss a hand-written chrome map and board; production hands
   * it `currentChrome()` and `currentBoard()`. This drives the real thing, so a change to
   * `currentChrome()` that pre-merged BUILTIN_CHROME — defeating derivation — would fail here even
   * though the literal-fed tests above stayed green.
   */
  describe('through the production objects, not literals', () => {
    beforeEach(() => _reset())

    it('a real light theme with no chrome derives light furniture', async () => {
      await loadTheme({ ...BUILTIN_BOARD, bg: '#fafafa', ink: '#101010' }) // chrome defaults to {}
      const set: Record<string, string> = {}
      applyChromeToCss(currentChrome(), currentBoard(), (k: string, v: string) => { set[k] = v })
      // The hairline follows the board's ink now, not a hardcoded white that vanishes on a light
      // board — the reason derivation exists at all.
      expect(set['--hairline']).not.toBe(BUILTIN_CHROME.hairline)
      expect(set['--hairline'].slice(0, 7)).toBe('#101010')
    })

    it('a real theme’s explicit chrome override still wins', async () => {
      await loadTheme({ ...BUILTIN_BOARD, bg: '#fafafa' }, { muted: '#123456' })
      const set: Record<string, string> = {}
      applyChromeToCss(currentChrome(), currentBoard(), (k: string, v: string) => { set[k] = v })
      expect(set['--muted']).toBe('#123456')
    })
  })
})

/**
 * `board.series` -> the chart series ramp. The deleted `charts.mjs` hardcoded
 * `['--info','--warn','--critical','--dim']`, so the seeded `cypherpunk` theme's real four-colour
 * ramp was read from the database, shipped in the theme document and then silently ignored — and
 * every chart's THIRD series was painted alarm red for no semantic reason, which is the exact bug
 * the board block carrying `series` was meant to fix.
 *
 * `themeSeriesRamp` is the selecting half (null = "use `builtinRamp` instead"). BOTH halves are
 * pure now and both live in `widgets/tokens.mjs`: `ctx.ramp` (stream data) resolves
 * it from the board object itself and the chart is a design that may not read a CSS variable at all.
 * Every consumer indexes with `% ramp.length`, so a ramp of any length cycles.
 */
describe('board.series -> the chart series ramp', () => {
  it('uses a theme ramp of any length, in order', () => {
    expect(themeSeriesRamp({ series: ['#ff2b2b', '#3ad6ff', '#ffb000', '#8affc1'] }))
      .toEqual(['#ff2b2b', '#3ad6ff', '#ffb000', '#8affc1'])
    expect(themeSeriesRamp({ series: ['#fff', '#00ff0080'] })).toEqual(['#fff', '#00ff0080'])
  })

  it('cycles by index with % length, so a short ramp repeats rather than running out', () => {
    const ramp = themeSeriesRamp({ series: ['#111111', '#222222'] })!
    expect([0, 1, 2, 3].map((i) => ramp[i % ramp.length]))
      .toEqual(['#111111', '#222222', '#111111', '#222222'])
  })

  it('the built-in board’s own ramp is a usable ramp, not a fallback trigger', () => {
    expect(themeSeriesRamp(BUILTIN_BOARD)).toEqual(BUILTIN_BOARD.series)
  })

  /**
   * Driven through the PRODUCTION object — `currentBoard()` after a real fetch — not a literal.
   * Every assertion above passes `themeSeriesRamp` a hand-written board, which is
   * exactly the fixture-instead-of-production-object distinction this test covers, and
   * `currentBoard()`'s merge was seeding from the WHOLE built-in board, so it
   * filled `series` from BUILTIN_BOARD for any theme that omitted one. themeSeriesRamp therefore
   * never saw "absent" in production — it saw the built-in literal ramp and returned it — and the
   * fallback became unreachable except for a malformed ramp.
   *
   * The visible effect: a theme that recoloured info/warn/critical/dim but declared no `series`
   * painted its charts in the BUILT-IN colours instead of its own, e.g. a fourth series at
   * `#8a90a0` on a `#fafafa` light board. Every literal-fed test above stayed green throughout.
   */
  describe('through the production board object, not a literal', () => {
    beforeEach(() => _reset())

    const LIGHT = {
      bg: '#fafafa', surface: '#ffffff', ink: '#101010', dim: '#3a4050', accent: '#0066cc',
      scrim: 0.2, info: '#0066cc', warn: '#b35c00', critical: '#c00000',
    }

    it('a theme with no series yields no ramp, so a chart falls back to that theme\'s OWN four colours', async () => {
      await loadTheme(LIGHT) // note: no `series` key at all
      expect(themeSeriesRamp(currentBoard())).toBe(null)
      // ...and this is what the fallback resolves to. The assertion uses the ramp rather than CSS
      // custom properties, because `charts.mjs` read `--info`/`--warn`/`--critical`/`--dim` back out of the
      // DOM; the chart is a design now and may not read a CSS variable at all, so the honest
      // assertion is against `builtinRamp` — the very function `ctx.ramp` falls back to — over the
      // same production board object. Same four colours, one fewer round trip through the DOM.
      expect(builtinRamp(currentBoard())).toEqual(['#0066cc', '#b35c00', '#c00000', '#3a4050'])
      expect(builtinRamp(currentBoard())[3]).not.toBe(BUILTIN_BOARD.dim)
      // The CSS half is still driven from the same board, for the widgets that are still CSS-styled.
      const css: Record<string, string> = {}
      applyBoardToCss(currentBoard(), (k: string, v: string) => { css[k] = v })
      expect([css['--info'], css['--warn'], css['--critical'], css['--dim']])
        .toEqual(['#0066cc', '#b35c00', '#c00000', '#3a4050'])
    })

    it('a theme that DOES declare a ramp still gets it, unmodified', async () => {
      await loadTheme({ ...LIGHT, series: ['#111111', '#222222', '#333333'] })
      expect(themeSeriesRamp(currentBoard())).toEqual(['#111111', '#222222', '#333333'])
    })

    it('a malformed ramp still falls back, even though the key is present', async () => {
      await loadTheme({ ...LIGHT, series: ['#111111', 'not-a-colour'] })
      expect(themeSeriesRamp(currentBoard())).toBe(null)
    })

    // The merge fills COLOUR keys only. `scrim` and `series` are optional: their absence is
    // meaningful to their own consumers, so it must survive currentBoard() rather than being
    // papered over with a built-in.
    it('the colour keys are still all present, and only the colour keys are defaulted in', async () => {
      await loadTheme({ ink: '#00ff00' }) // one colour key, nothing else
      const merged = currentBoard()
      for (const key of ['bg', 'surface', 'ink', 'dim', 'accent', 'info', 'warn', 'critical']) {
        expect(typeof merged[key]).toBe('string')
      }
      expect(merged.ink).toBe('#00ff00')
      expect(merged.dim).toBe(BUILTIN_BOARD.dim)
      expect('series' in merged).toBe(false)
      expect('scrim' in merged).toBe(false)
    })

    it('an unthemed device is unchanged: the built-in ramp equals the built-in CSS vars', () => {
      // No theme fetched at all -> the whole built-in board, `series` included. That ramp is
      // byte-identical to what the CSS-var fallback would resolve to on an unthemed board, so
      // both paths paint the same thing and this is not a behaviour change.
      expect(themeSeriesRamp(currentBoard())).toEqual(BUILTIN_BOARD.series)
      expect(BUILTIN_BOARD.series).toEqual([BUILTIN_BOARD.info, BUILTIN_BOARD.warn, BUILTIN_BOARD.critical, BUILTIN_BOARD.dim])
    })
  })

  it('falls back to the built-in ramp when series is absent, empty or not an array', () => {
    expect(themeSeriesRamp(undefined)).toBe(null)
    expect(themeSeriesRamp({})).toBe(null)
    expect(themeSeriesRamp({ series: [] })).toBe(null)
    expect(themeSeriesRamp({ series: '#ff0000' })).toBe(null)
    expect(themeSeriesRamp({ series: null })).toBe(null)
  })

  // All-or-nothing, deliberately: compacting a partially-bad ramp would silently RE-ORDER the
  // surviving colours relative to what the operator authored, and a wrong-looking chart is harder
  // to diagnose than an un-themed one.
  it('falls back whole when any entry is not a colour, rather than compacting', () => {
    expect(themeSeriesRamp({ series: ['#ff0000', 'not-a-colour', '#00ff00'] })).toBe(null)
    expect(themeSeriesRamp({ series: ['#ff0000', 42] })).toBe(null)
  })
})
