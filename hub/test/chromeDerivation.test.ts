import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { derivedChrome, BUILTIN_BOARD, BUILTIN_CHROME } from '../static/device/theme.mjs'

/**
 * Chrome is DERIVED from the palette.
 *
 * BUILTIN_CHROME is a hardcoded DARK map, so a theme that authors just its eight palette colours
 * would render as a light board wearing dark-theme furniture:
 * hairline white at 8% (invisible on cream), a dark slate border. Every theme therefore had to
 * hand-author colours it should never have needed to, and anyone editing only the palette got a
 * broken board. That is the single biggest obstacle to "ship a few good themes, then let people
 * customise".
 */
const TOSCANA = {
  bg: '#f4ecd8', surface: '#fffdf5', ink: '#4a3728', dim: '#9a8a72',
  accent: '#b5651d', info: '#4a90d9', warn: '#c8860a', critical: '#b3261e', scrim: 0.35,
}

const lum = (hex: string) => {
  const h = hex.slice(1, 7)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('chrome derived from the palette', () => {
  it('produces a colour literal for every chrome key', () => {
    const out = derivedChrome(TOSCANA, {})
    expect(Object.keys(out).sort()).toEqual(Object.keys(BUILTIN_CHROME).sort())
    for (const [k, v] of Object.entries(out)) {
      expect(v, k).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
    }
  })

  /**
   * THE POINT. On a light palette every derived surface must be light — under the old fallback
   * these were all dark and the board was unreadable.
   */
  it('gives a light palette light furniture', () => {
    const out = derivedChrome(TOSCANA, {}) as Record<string, string>
    for (const key of ['border', 'surface_warn', 'surface_critical', 'takeover_hint_bg']) {
      expect(lum(out[key]), `${key} should be light`).toBeGreaterThan(0.5)
      expect(lum(BUILTIN_CHROME[key]), `${key} was dark before`).toBeLessThan(0.5)
    }
  })

  it('gives a dark palette dark furniture', () => {
    const out = derivedChrome(BUILTIN_BOARD, {}) as Record<string, string>
    for (const key of ['border', 'surface_warn', 'surface_critical', 'takeover_hint_bg']) {
      expect(lum(out[key]), `${key} should be dark`).toBeLessThan(0.5)
    }
  })

  /** Text on the critical colour has to survive both a dark red and a bright amber. */
  it('picks readable text for the critical colour', () => {
    expect(derivedChrome({ ...TOSCANA, critical: '#b3261e' }, {}).on_critical).toBe('#ffffff')
    expect(derivedChrome({ ...TOSCANA, critical: '#ffd400' }, {}).on_critical).toBe('#000000')
  })

  it('lets an explicit override win', () => {
    expect(derivedChrome(TOSCANA, { border: '#123456' }).border).toBe('#123456')
    // ...but only a real colour: junk falls through to derivation rather than being written out.
    expect(derivedChrome(TOSCANA, { border: 'not-a-colour' }).border).not.toBe('not-a-colour')
  })

  /**
   * Bad data already in the DB must never crash a read path (house rule), and a board that cannot
   * be derived from degrades to today's dark furniture rather than to nothing.
   */
  it('falls back to the built-in map when the board is unusable', () => {
    expect(derivedChrome({ ink: 'nope', bg: null }, {}).hairline).toBe(BUILTIN_CHROME.hairline)
    expect(derivedChrome(null, {}).border).toBe(BUILTIN_CHROME.border)
    expect(derivedChrome(undefined, undefined).muted).toBe(BUILTIN_CHROME.muted)
  })
})
