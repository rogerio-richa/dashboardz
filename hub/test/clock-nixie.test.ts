import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import nixie from '../static/device/widgets/clock/nixie.mjs'

/**
 * The nixie tube clock, the first design to draw from a raster asset.
 *
 * A real nixie does not flip or slide: the outgoing cathode's glow DECAYS while the incoming one
 * strikes, and for a moment both are visible. That crossfade is the design's whole mechanism, so
 * the recorder below captures `globalAlpha` alongside every `drawImage` — a recorder that only
 * collected source rects could not see the effect at all.
 *
 * The sheet is 6x2 cells of 104x158 at origin (4, 0), measured off the artwork rather than
 * assumed: the outer cells' GLOW is clipped at the sheet edge, but the middle pitches are exactly
 * 104 and the cards themselves are intact. Glyph order is `1 2 3 4 5 6 / 7 8 9 0 . :` — so zero
 * lives at index 9, not index 0, and that off-by-one is exactly the kind of thing worth pinning.
 */
const CELL_W = 104
const CELL_H = 158
const ORIGIN_X = 4

const cellOf = (index: number) => ({
  sx: ORIGIN_X + (index % 6) * CELL_W,
  sy: Math.floor(index / 6) * CELL_H,
})
const DIGIT_CELL = (d: number) => cellOf(d === 0 ? 9 : d - 1)
const COLON_CELL = cellOf(11)

interface Blit { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number; alpha: number }

function recorder() {
  const blits: Blit[] = []
  const texts: { text: string; alpha: number }[] = []
  const fills: string[] = []
  let alpha = 1
  let depth = 0
  let minDepth = 0
  const stack: number[] = []
  const g = {
    font: '', textAlign: '', textBaseline: '', lineWidth: 1, lineCap: '', strokeStyle: '',
    fillStyle: '',
    get globalAlpha() { return alpha },
    set globalAlpha(v: number) { alpha = v },
    save: () => { stack.push(alpha); depth++ },
    restore: () => { alpha = stack.pop() ?? 1; depth--; minDepth = Math.min(minDepth, depth) },
    scale: () => {}, setTransform: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, closePath: () => {}, stroke: () => {}, fill: () => {},
    rect: () => {}, moveTo: () => {}, lineTo: () => {}, arc: () => {}, clearRect: () => {},
    fillText: (text: string) => { texts.push({ text, alpha }) },
    measureText: (s: string) => ({ width: s.length * 10 }),
    drawImage: (_img: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
      blits.push({ sx, sy, sw, sh, dx, dy, dw, dh, alpha })
    },
  }
  return { g, blits, texts, fills, depth: () => depth, minDepth: () => minDepth, alpha: () => alpha }
}

const TOKENS = { tube: '#12141c', glow: '#ff7a1a' }
const SHEET = { width: 632, height: 316 }
const BOX = { w: 680, h: 200 }

/** Date.UTC so the minute boundary — and therefore the crossfade window — is the same everywhere. */
const AT = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 7, 4, h, m, s, ms)

const ctxAt = (now: number, extra: Partial<Record<string, unknown>> = {}) => ({
  box: { ...BOX }, tokens: TOKENS, now, motion: 'full', assets: { glyphs: SHEET }, ...extra,
})

/** The four HH:MM digits, read through the same local-time API the design reads. */
const digitsAt = (now: number) => {
  const d = new Date(now)
  return [Math.floor(d.getHours() / 10), d.getHours() % 10, Math.floor(d.getMinutes() / 10), d.getMinutes() % 10]
}

describe('nixie clock', () => {
  it('declares the sheet as an asset, and colours only its fallback', () => {
    expect(nixie.meta.id).toBe('nixie')
    expect(nixie.meta.widget).toBe('clock')
    expect(nixie.meta.assets).toEqual({ glyphs: 'nixie-glyphs.png' })
    // asset ownership rule: an asset belongs to the design and is never recoloured. Tokens exist for the codeform
    // that runs when the sheet has not arrived, so they must not be needed to draw the artwork.
    expect(Object.keys(nixie.meta.tokens).sort()).toEqual(['glow', 'tube'])
  })

  it('lights four digits and a colon from the sheet', () => {
    const r = recorder()
    const now = AT(14, 37, 30)
    nixie.draw(r.g, ctxAt(now), 0)

    expect(r.blits).toHaveLength(5)
    const expected = digitsAt(now).map(DIGIT_CELL)
    const [h1, h2, colon, m1, m2] = [r.blits[0], r.blits[1], r.blits[2], r.blits[3], r.blits[4]]
    expect([h1.sx, h1.sy]).toEqual([expected[0].sx, expected[0].sy])
    expect([h2.sx, h2.sy]).toEqual([expected[1].sx, expected[1].sy])
    expect([colon.sx, colon.sy]).toEqual([COLON_CELL.sx, COLON_CELL.sy])
    expect([m1.sx, m1.sy]).toEqual([expected[2].sx, expected[2].sy])
    expect([m2.sx, m2.sy]).toEqual([expected[3].sx, expected[3].sy])
    for (const b of r.blits) {
      expect([b.sw, b.sh]).toEqual([CELL_W, CELL_H])
      expect(b.alpha).toBe(1)
    }
  })

  /** Zero is the tenth glyph on the sheet, not the first. */
  it('reads zero from the sheet position zero actually occupies', () => {
    expect(DIGIT_CELL(0)).toEqual({ sx: ORIGIN_X + 3 * CELL_W, sy: CELL_H })
    const r = recorder()
    const now = AT(10, 0, 30)
    nixie.draw(r.g, ctxAt(now), 0)
    const d = digitsAt(now)
    r.blits.filter((_, i) => i !== 2).forEach((b, slot) => {
      expect({ sx: b.sx, sy: b.sy }, `slot ${slot} digit ${d[slot]}`).toEqual(DIGIT_CELL(d[slot]))
    })
  })

  it('never draws outside the sheet', () => {
    const r = recorder()
    nixie.draw(r.g, ctxAt(AT(23, 59, 30)), 0)
    for (const b of r.blits) {
      expect(b.sx).toBeGreaterThanOrEqual(0)
      expect(b.sy).toBeGreaterThanOrEqual(0)
      expect(b.sx + b.sw).toBeLessThanOrEqual(SHEET.width)
      expect(b.sy + b.sh).toBeLessThanOrEqual(SHEET.height)
    }
  })

  /**
   * The mechanism. On the minute, the slot that changed shows BOTH cathodes at once — the old one
   * decaying, the new one striking — and every other slot stays exactly as it was.
   */
  it('crossfades the changed slot, and leaves the others alone', () => {
    const now = AT(14, 38, 0, 80) // 80ms into the new minute
    const r = recorder()
    nixie.draw(r.g, ctxAt(now), 0)

    const before = digitsAt(now - 60_000)
    const after = digitsAt(now)
    const changed = [0, 1, 2, 3].filter((i) => before[i] !== after[i])
    expect(changed.length, 'a minute boundary must change at least one slot').toBeGreaterThan(0)

    // One blit per unchanged slot, two per changed slot, plus the colon.
    expect(r.blits).toHaveLength(5 + changed.length)

    for (const slot of changed) {
      const outgoing = r.blits.filter((b) => b.sx === DIGIT_CELL(before[slot]).sx && b.sy === DIGIT_CELL(before[slot]).sy)
      const incoming = r.blits.filter((b) => b.sx === DIGIT_CELL(after[slot]).sx && b.sy === DIGIT_CELL(after[slot]).sy)
      expect(outgoing.length, `outgoing ${before[slot]}`).toBeGreaterThan(0)
      expect(incoming.length, `incoming ${after[slot]}`).toBeGreaterThan(0)
      // Mid-fade both are partly lit, and neither is fully opaque.
      expect(outgoing[0].alpha).toBeGreaterThan(0)
      expect(outgoing[0].alpha).toBeLessThan(1)
      expect(incoming[0].alpha).toBeGreaterThan(0)
      expect(incoming[0].alpha).toBeLessThan(1)
    }
  })

  it('settles to one fully lit cathode per tube once the fade is over', () => {
    const r = recorder()
    nixie.draw(r.g, ctxAt(AT(14, 38, 5)), 0)
    expect(r.blits).toHaveLength(5)
    for (const b of r.blits) expect(b.alpha).toBe(1)
  })

  it('restores globalAlpha, so the next widget is not painted through a half-lit tube', () => {
    const r = recorder()
    nixie.draw(r.g, ctxAt(AT(14, 38, 0, 80)), 0)
    expect(r.alpha()).toBe(1)
    expect(r.depth()).toBe(0)
    expect(r.minDepth()).toBe(0)
  })

  it('animates only inside the strike window, and never when motion is off', () => {
    expect(nixie.isAnimating(ctxAt(AT(14, 38, 0, 40)))).toBe(true)
    expect(nixie.isAnimating(ctxAt(AT(14, 38, 30)))).toBe(false)
    expect(nixie.isAnimating(ctxAt(AT(14, 38, 0, 40), { motion: 'none' }))).toBe(false)
  })

  it('holds the last digit still when motion is off', () => {
    const r = recorder()
    nixie.draw(r.g, ctxAt(AT(14, 38, 0, 80), { motion: 'none' }), 0)
    expect(r.blits).toHaveLength(5)
    for (const b of r.blits) expect(b.alpha).toBe(1)
  })

  /**
   * The degradation rule assets.mjs is built on: a name is absent until its image has decoded, and
   * forever if it failed. A board must show a clock either way — 404 or not.
   */
  it('draws a readable clock before the sheet arrives, without touching drawImage', () => {
    const r = recorder()
    nixie.draw(r.g, ctxAt(AT(14, 37, 30), { assets: {} }), 0)
    expect(r.blits).toHaveLength(0)
    expect(r.texts.length).toBeGreaterThan(0)
    expect(r.texts.map((t) => t.text).join('')).toContain(':')
  })

  it('keeps its aspect rather than stretching, whatever shape the cell is', () => {
    const wide = recorder()
    nixie.draw(wide.g, { ...ctxAt(AT(14, 37, 30)), box: { w: 2000, h: 200 } }, 0)
    const tall = recorder()
    nixie.draw(tall.g, { ...ctxAt(AT(14, 37, 30)), box: { w: 400, h: 900 } }, 0)
    for (const b of [...wide.blits, ...tall.blits]) {
      // Every tube is drawn at the sheet cell's own aspect, whatever shape the cell is.
      expect(b.dw / b.dh).toBeCloseTo(CELL_W / CELL_H, 2)
    }
  })

  /** A 0.05-high banner cell rounds to nothing on a short screen; that must not invert anything. */
  it('draws nothing into a collapsed box', () => {
    for (const box of [{ w: 0, h: 100 }, { w: 100, h: 0 }, { w: -5, h: -5 }]) {
      const r = recorder()
      nixie.draw(r.g, { ...ctxAt(AT(14, 37, 30)), box }, 0)
      expect(r.blits).toHaveLength(0)
      expect(r.texts).toHaveLength(0)
    }
  })
})
