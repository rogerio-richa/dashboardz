import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { backdropCss, BACKDROP_NAMES, BUILTIN_BOARD } from '../static/device/theme.mjs'

/**
 * Procedural backdrops.
 *
 * DECLARATIVE, not drawing code. portable drawing subset bars gradients from the portable subset, so a canvas backdrop
 * would either violate it or be forced into banded fillRect loops. It does not need to be drawing
 * code — the board is a web page everywhere (web-renderer boundary), so the web renderer emits CSS and a firmware
 * port renders the same NAME its own way. Nothing enters `g`.
 */
const TOSCANA = { bg: '#f4ecd8', surface: '#fffdf5', ink: '#4a3728', accent: '#b5651d' }

describe('procedural backdrops', () => {
  it('offers the names the renderer can actually draw', () => {
    expect(BACKDROP_NAMES).toEqual(['flat', 'wash', 'glow', 'cards', 'grid'])
  })

  it('cards is just the board colour — the card look itself is CSS keyed on the name', () => {
    expect(backdropCss(TOSCANA, 'cards')).toBe(TOSCANA.bg)
  })

  it('derives every backdrop from the palette it is given', () => {
    for (const name of BACKDROP_NAMES) {
      const css = backdropCss(TOSCANA, name)
      expect(css, name).toBeTruthy()
      // Every one mentions the board's own colours — nothing is hardcoded.
      expect(css.toLowerCase(), name).toContain(TOSCANA.bg)
    }
  })

  it('flat is just the board colour', () => {
    expect(backdropCss(TOSCANA, 'flat')).toBe(TOSCANA.bg)
  })

  /**
   * Change a palette colour and the backdrop follows — the property that makes shipping themes
   * cheap, and the reason built-ins need no image files at all.
   */
  it('follows the palette rather than being fixed', () => {
    const a = backdropCss(TOSCANA, 'glow')
    const b = backdropCss({ ...TOSCANA, accent: '#00ff00' }, 'glow')
    expect(a).not.toBe(b)
  })

  /**
   * A client older than a backdrop must render a plain board, never a blank one — the same
   * degradation rule an unknown design id follows.
   */
  it('falls back to flat for a name it does not know', () => {
    expect(backdropCss(TOSCANA, 'holographic')).toBe(TOSCANA.bg)
    expect(backdropCss(TOSCANA, undefined)).toBe(TOSCANA.bg)
    expect(backdropCss(TOSCANA, null)).toBe(TOSCANA.bg)
  })

  /** A backdrop is decoration; it must never be why a board fails to paint. */
  it('degrades to the built-in colour when the board is unusable', () => {
    expect(backdropCss({ bg: 'not-a-colour' }, 'flat')).toBe(BUILTIN_BOARD.bg)
    expect(backdropCss(null, 'wash')).toContain(BUILTIN_BOARD.bg)
    expect(() => backdropCss(undefined, 'grid')).not.toThrow()
  })
})
