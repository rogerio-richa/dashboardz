import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import segment from '../static/device/widgets/clock/segment.mjs'
// @ts-expect-error plain JS module without types
import { segmentsFor } from '../static/device/widgets/clock-geometry.mjs'

function recorder() {
  const fills: string[] = []
  // Every fill() with the fillStyle and globalAlpha in force when it landed — the crossfade is
  // expressed entirely in alpha, so a `fills` list of colour strings alone cannot see it.
  const ops: { style: string; alpha: number }[] = []
  const pts: { x: number; y: number }[] = []
  let cur = ''
  const g = {
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1, lineWidth: 1,
    set fillStyle(v: string) { cur = v; fills.push(v) },
    get fillStyle() { return cur },
    strokeStyle: '',
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, closePath: () => {},
    fill: () => { ops.push({ style: cur, alpha: g.globalAlpha }) },
    stroke: () => {},
    moveTo: (x: number, y: number) => { pts.push({ x, y }) },
    lineTo: (x: number, y: number) => { pts.push({ x, y }) },
    arc: () => {}, rect: () => {},
    fillRect: () => {}, roundRect: () => {}, fillText: () => {},
    measureText: (s: string) => ({ width: s.length * 10 }),
  }
  return { g, fills, ops, pts, current: () => cur }
}

// Four DISTINCT colours: every fill() below is attributed to the pass that issued it by the
// fillStyle in force when it landed, so the colon must not share the segment colour.
const TOKENS = { segment_on: '#ff2b2b', bezel: '#161616', colon: '#22ccff' }
/** The alpha the design paints an unlit element at — see segment.mjs. */
const UNLIT_ALPHA = 0.12

/**
 * Times are built with Date.UTC so `now % 60_000` — and therefore the whole crossfade window — is
 * identical on every machine: a minute boundary in epoch ms is a minute boundary in every real
 * timezone, because every modern UTC offset is a whole number of minutes. Nothing below asserts a
 * literal digit; where the displayed value matters it is derived from `new Date(now)` in the test,
 * the same local-time API the design itself reads, avoiding timezone-dependent segment counts.
 */
const BOUNDARY = Date.UTC(2026, 7, 2, 3, 31, 0)
const AT_REST = BOUNDARY + 20_000

const ctx = (overrides = {}) => ({
  tokens: TOKENS,
  config: {},
  box: { w: 400, h: 200, t: 1.0 },
  now: AT_REST,
  state: {},
  motion: 'full',
  ...overrides,
})

/**
 * Reconstructs the four displayed digits from the fill stream. `digit()` paints an unlit
 * `segment_off` base for every segment and then, only for a segment with any light in it, a
 * `segment_on` pass at the segment's alpha — so each `segment_off` fill opens a segment slot and
 * a following `segment_on` fill fills it in.
 */
function display(ops: { style: string; alpha: number }[]) {
  const segs: { lit: boolean; alpha: number }[] = []
  for (const op of ops) {
    if (op.style !== TOKENS.segment_on) continue
    // The unlit base is the SAME colour at a low alpha now (v11 — segment_off is derived, not a
    // token), so slots are opened and filled by alpha rather than by two distinct colours.
    if (op.alpha <= UNLIT_ALPHA) segs.push({ lit: false, alpha: 0 })
    else if (segs.length) segs[segs.length - 1] = { lit: true, alpha: op.alpha }
  }
  return [0, 1, 2, 3].map((i) => segs.slice(i * 7, i * 7 + 7))
}

/** The digits the clock ought to be showing at `now`, read the same way the design reads them. */
function expectedDigits(now: number) {
  const d = new Date(now)
  const hh = d.getHours(), mm = d.getMinutes()
  return [Math.floor(hh / 10), hh % 10, Math.floor(mm / 10), mm % 10]
}

describe('segment clock design', () => {
  it('declares every token it draws with', () => {
    expect(Object.keys(segment.meta.tokens).sort())
      .toEqual(['bezel', 'colon', 'segment_on'])
  })

  it('reads every token it declares — no dead knobs', () => {
    const r = recorder()
    const distinct = { segment_on: '#111111', bezel: '#333333', colon: '#444444' }
    segment.draw(r.g, ctx({ tokens: distinct }), 0)
    for (const v of Object.values(distinct)) expect(r.fills).toContain(v)
  })

  it('prefers a 2:1 cell and does not distort', () => {
    expect(segment.meta.suggested_ratio).toBe(2.0)
  })

  it('declares the digit-change transition and no persistent animation', () => {
    expect(segment.meta.animations.transition).toContain('digit_change')
    expect(segment.meta.animations.persistent).toEqual([])
  })

  /**
   * Unlit segments are DERIVED now (v11): the lit colour at 12% alpha rather than a `segment_off`
   * token. So the test is about the ALPHA, not a second colour — the display still reads as
   * hardware, and it does so under any palette instead of needing a hand-picked shade per theme.
   */
  it('paints unlit segments faintly behind the lit ones, so it reads as hardware', () => {
    const r = recorder()
    segment.draw(r.g, ctx(), 0)
    const dim = r.ops.filter((o) => o.style === TOKENS.segment_on && o.alpha > 0 && o.alpha < 0.5)
    const lit = r.ops.filter((o) => o.style === TOKENS.segment_on && o.alpha === 1)
    expect(dim.length).toBe(4 * 7)   // every segment of every digit gets an unlit base
    expect(lit.length).toBeGreaterThan(0)
  })

  it('paints the bezel', () => {
    const r = recorder()
    segment.draw(r.g, ctx(), 0)
    expect(r.fills).toContain('#161616')
  })

  // Counting every g.fill() call would include the lit segments, whose number depends on
  // getHours()/getMinutes() — LOCAL time — and therefore varies by timezone. The invariant is the
  // unlit base pass: `digit()` draws each segment TWICE (an unlit segment_off base, then an
  // segment_on pass only for segments that are actually lit), so the total is
  // 1 (bezel) + 28 (unlit base, every segment of every digit) + (however many are lit) + 2 (colon
  // dots).
  //
  // This test counts the unlit base pass: it fires exactly once per segment per digit
  // (4 digits * 7 segments = 28) no matter what time it is or what timezone the test runs in. The
  // four token colors are chosen distinct so each g.fill() call can be attributed to the pass that
  // issued it by reading the fillStyle in force at the moment fill() lands.
  it('draws every segment of every digit exactly once per frame', () => {
    const r = recorder()
    const tokens = { segment_on: '#ff2b2b', bezel: '#161616', colon: '#22ccff' }
    let offFills = 0, onFills = 0, bezelFills = 0, colonFills = 0
    r.g.fill = () => {
      const cur = r.current()
      if (cur === tokens.segment_on) {
        if (r.g.globalAlpha <= UNLIT_ALPHA) offFills++
        else onFills++
      } else if (cur === tokens.bezel) bezelFills++
      else if (cur === tokens.colon) colonFills++
    }
    segment.draw(r.g, ctx({ tokens }), 0)
    expect(offFills).toBe(4 * 7)   // every segment of every digit gets its unlit base exactly once
    expect(onFills).toBeGreaterThan(0)
    expect(bezelFills).toBe(1)
    expect(colonFills).toBe(2)
  })

  it('is a pure function of its inputs — same ctx, same calls', () => {
    const a = recorder(); segment.draw(a.g, ctx(), 120)
    const b = recorder(); segment.draw(b.g, ctx(), 120)
    expect(a.fills).toEqual(b.fills)
  })

  it('renders a resting state when motion is off', () => {
    const r = recorder()
    expect(() => segment.draw(r.g, ctx({ motion: 'none' }), 0)).not.toThrow()
    expect(r.fills).toContain('#ff2b2b')
  })
})

/**
 * The transition is driven by `ctx.now`, so the window exists exactly once where the minute rolls
 * over rather than restarting on every render.
 */
describe('segment clock transition timing (driven by hub time, not by the frame clock)', () => {
  it('shows the CURRENT minute at a time nowhere near a boundary, whatever the frame clock says', () => {
    const r = recorder()
    segment.draw(r.g, ctx({ now: AT_REST }), 0) // elapsed 0: the freshly-restarted frame clock
    const shown = display(r.ops)
    expectedDigits(AT_REST).forEach((d, i) => {
      expect(shown[i].map((s) => (s.lit ? 1 : 0))).toEqual([...segmentsFor(d)])
    })
  })

  it('lights every segment of a resting display fully — no residual crossfade', () => {
    const r = recorder()
    segment.draw(r.g, ctx({ now: AT_REST }), 0)
    for (const seg of display(r.ops).flat()) if (seg.lit) expect(seg.alpha).toBe(1)
  })

  it('is mid-crossfade just after a minute rolls over', () => {
    const r = recorder()
    segment.draw(r.g, ctx({ now: BOUNDARY + 45 }), 0) // 45 / 180 = a quarter of the way through
    const partial = display(r.ops).flat().filter((s) => s.lit && s.alpha > 0 && s.alpha < 1)
    expect(partial.length).toBeGreaterThan(0)
  })

  it('has finished the crossfade by the end of the window', () => {
    const r = recorder()
    segment.draw(r.g, ctx({ now: BOUNDARY + 180 }), 0)
    const shown = display(r.ops)
    expectedDigits(BOUNDARY + 180).forEach((d, i) => {
      expect(shown[i].map((s) => (s.lit ? 1 : 0))).toEqual([...segmentsFor(d)])
    })
  })

  it('ignores elapsedMs — a dropped frame or a restarted frame clock cannot desync it', () => {
    const a = recorder(); segment.draw(a.g, ctx({ now: AT_REST }), 0)
    const b = recorder(); segment.draw(b.g, ctx({ now: AT_REST }), 5_000)
    expect(a.ops).toEqual(b.ops)
  })

  it('reports it is animating only inside the window after a rollover', () => {
    expect(segment.isAnimating(ctx({ now: BOUNDARY }))).toBe(true)
    expect(segment.isAnimating(ctx({ now: BOUNDARY + 179 }))).toBe(true)
    expect(segment.isAnimating(ctx({ now: BOUNDARY + 180 }))).toBe(false)
    expect(segment.isAnimating(ctx({ now: AT_REST }))).toBe(false)
  })

  it('never reports it is animating when motion is off', () => {
    expect(segment.isAnimating(ctx({ now: BOUNDARY, motion: 'none' }))).toBe(false)
  })

  it('handles a pre-epoch hub time without inventing a transition', () => {
    // now = -20_000: 40s into the minute that began at -60_000, so at rest. A plain `%` would
    // give -20_000 here and read as "before the boundary".
    const now = Date.UTC(1969, 11, 31, 23, 59, 40)
    expect(now).toBe(-20_000)
    expect(segment.isAnimating(ctx({ now }))).toBe(false)
  })
})

/**
 * `pad` was derived from box.w and then subtracted from box.h, so a
 * legal full-width banner cell (screensApi accepts h as low as 0.05) drove digitH negative and
 * the segments drew upward out of the digit's own box.
 */
describe('segment clock geometry on extreme cell shapes', () => {
  it('keeps its digits inside a flat banner cell instead of inverting them', () => {
    const r = recorder()
    const box = { w: 1080, h: 96, t: 0.4 } // 1080x1920 portrait screen, h = 0.05 of it
    segment.draw(r.g, ctx({ box }), 0)
    const ys = r.pts.map((p) => p.y)
    const xs = r.pts.map((p) => p.x)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(box.h)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThanOrEqual(box.w)
    // The digits must actually FILL the banner. Under the bug the drawn span was 33.6px of a
    // 96px cell, hanging upward from an inset of 64.8 — inside the cell by luck, not by design.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(box.h * 0.5)
    expect(Math.min(...ys)).toBeLessThan(box.h * 0.2)
  })

  it('does not invert on a zero-height cell', () => {
    const r = recorder()
    expect(() => segment.draw(r.g, ctx({ box: { w: 400, h: 0, t: 0.1 } }), 0)).not.toThrow()
    for (const p of r.pts) expect(p.y).toBeGreaterThanOrEqual(0)
  })
})
