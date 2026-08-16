import { describe, it, expect } from 'vitest'
import {
  suggestedRatio, ratioToRect, renderedRatio, isOffRatio, TARGET_SHAPES, type Aspect,
} from './layout-edit'
import { moveRect, resizeRect } from './layout-edit'
import { snapMove, snapResize, SNAP } from './layout-edit'

const A16x10: Aspect = { w: 16, h: 10 }
const A9x20: Aspect = { w: 9, h: 20 }

describe('suggestedRatio', () => {
  it('gives the clock a wide 2:1', () => {
    expect(suggestedRatio('clock', {})).toBe(2)
  })
  // `config.style` no longer affects the suggestion: `style`
  // is retired in favour of `design`, and both `gauge/ring.mjs` and `gauge/bar.mjs` declare the
  // SAME `suggested_ratio: 2` — the old DOM branch's square ring ratio (1) is gone along with it.
  it('gives every gauge the same 2:1 ratio regardless of config, ring included', () => {
    expect(suggestedRatio('gauge', {})).toBe(2)
    expect(suggestedRatio('gauge', { design: 'bar' })).toBe(2)
    expect(suggestedRatio('gauge', { design: 'ring' })).toBe(2)
  })
  it('gives the chart 16:9', () => {
    expect(suggestedRatio('chart', {})).toBeCloseTo(16 / 9, 10)
  })
})

describe('ratioToRect', () => {
  // The whole reason the target-shape selector exists: a pixel ratio only becomes a
  // fractional rect once you know the screen shape. w/h = R / A.
  it('resolves a 2:1 clock to w/h 1.25 on a 16:10 screen', () => {
    const r = ratioToRect(2, A16x10)
    expect(r.w / r.h).toBeCloseTo(1.25, 6)
  })
  it('resolves the SAME 2:1 clock to a very different rect on 9:20', () => {
    const r = ratioToRect(2, A9x20)
    // R / A = 2 / (9/20) = 4.444. Nothing clamps here, so the ratio IS preserved exactly —
    // the point is that the same widget yields h = 0.32 on 16:10 and h = 0.09 here.
    expect(r.w).toBeCloseTo(0.4, 6)
    expect(r.h).toBeCloseTo(0.09, 6)
    expect(r.w / r.h).toBeCloseTo(4.444, 2)
  })
  it('puts the larger axis at 0.4 when nothing clamps', () => {
    const r = ratioToRect(1, A16x10)   // w/h = 1/1.6 = 0.625 -> h is larger
    expect(Math.max(r.w, r.h)).toBeCloseTo(0.4, 6)
  })
  it('never returns a rect below RECT_MIN or outside the board', () => {
    for (const shape of TARGET_SHAPES) {
      for (const ratio of [0.1, 1, 2, 16 / 9, 40]) {
        const r = ratioToRect(ratio, shape.aspect)
        expect(r.w).toBeGreaterThanOrEqual(0.05)
        expect(r.h).toBeGreaterThanOrEqual(0.05)
        expect(r.x + r.w).toBeLessThanOrEqual(1)
        expect(r.y + r.h).toBeLessThanOrEqual(1)
      }
    }
    // At extreme ratios the floor wins and the ratio is deliberately NOT preserved: placement is
    // a starting point, not a guarantee, and isOffRatio will show the truth. 40:1 on 16:10 wants
    // h = 0.016; RECT_MIN lifts it to 0.05 and w/h lands at 8, not 25.
    const extreme = ratioToRect(40, A16x10)
    expect(extreme.h).toBeCloseTo(0.05, 6)
    expect(extreme.w / extreme.h).toBeCloseTo(8, 6)
  })
  it('returns values already on the 0.001 grid', () => {
    const r = ratioToRect(16 / 9, A9x20)
    for (const v of [r.x, r.y, r.w, r.h]) expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-9)
  })
})

describe('renderedRatio / isOffRatio', () => {
  it('measures the ratio the device will actually draw, not raw w/h', () => {
    // A square-looking rect on a 9:20 screen is nothing like square in pixels.
    expect(renderedRatio({ x: 0, y: 0, w: 0.5, h: 0.5 }, A9x20)).toBeCloseTo(0.45, 6)
  })
  it('does not flag a card that matches its widget', () => {
    const r = ratioToRect(2, A16x10)
    expect(isOffRatio(r, 'clock', {}, A16x10)).toBe(false)
  })
  it('flags a clock squeezed into a tall narrow box', () => {
    expect(isOffRatio({ x: 0, y: 0, w: 0.2, h: 0.8 }, 'clock', {}, A9x20)).toBe(true)
  })
  it('tolerates small drift within 10%', () => {
    const r = ratioToRect(2, A16x10)
    const nudged = { ...r, w: r.w * 1.05 }
    expect(isOffRatio(nudged, 'clock', {}, A16x10)).toBe(false)
  })
})

describe('moveRect', () => {
  const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }
  it('translates by a fractional delta and snaps to the 0.001 grid', () => {
    expect(moveRect(r, 0.1004, -0.05)).toEqual({ x: 0.3, y: 0.15, w: 0.4, h: 0.4 })
  })
  it('clamps at the board edges without shrinking the card', () => {
    const m = moveRect(r, 5, 5)
    expect(m).toEqual({ x: 0.6, y: 0.6, w: 0.4, h: 0.4 })
    expect(m.x + m.w).toBeCloseTo(1, 9)
  })
  it('clamps at the origin too', () => {
    expect(moveRect(r, -5, -5)).toEqual({ x: 0, y: 0, w: 0.4, h: 0.4 })
  })
})

describe('resizeRect', () => {
  const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }
  it('grows from the SE corner without moving the origin', () => {
    const out = resizeRect(r, 'se', 0.1, 0.1, null)
    expect(out).toEqual({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 })
  })
  it('moves the origin when dragging the NW corner', () => {
    const out = resizeRect(r, 'nw', 0.1, 0.1, null)
    expect(out).toEqual({ x: 0.3, y: 0.3, w: 0.3, h: 0.3 })
  })
  it('resizes one axis only from an edge handle', () => {
    expect(resizeRect(r, 'e', 0.1, 0.3, null)).toEqual({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 })
    expect(resizeRect(r, 's', 0.3, 0.1, null)).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.5 })
  })
  it('holds the locked ratio on a corner drag, driven by the dominant axis', () => {
    // lockRatio is expressed as w/h in FRACTION space, already resolved for the target shape.
    const out = resizeRect(r, 'se', 0.2, 0, 1)
    expect(out.w).toBeCloseTo(out.h, 9)
  })
  it('never shrinks below RECT_MIN', () => {
    const out = resizeRect(r, 'se', -5, -5, null)
    expect(out.w).toBeCloseTo(0.05, 9)
    expect(out.h).toBeCloseTo(0.05, 9)
  })
  it('never grows past the board edge', () => {
    const out = resizeRect(r, 'se', 5, 5, null)
    expect(out.x + out.w).toBeCloseTo(1, 9)
    expect(out.y + out.h).toBeCloseTo(1, 9)
  })
  it('keeps the far edge pinned when dragging NW to the limit', () => {
    const out = resizeRect(r, 'nw', 5, 5, null)
    expect(out.x + out.w).toBeCloseTo(0.6, 9)
    expect(out.w).toBeCloseTo(0.05, 9)
  })
  it('keeps the right edge pinned when a west drag is clamped at the origin', () => {
    const out = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'w', -0.3, 0, null)
    expect(out.x).toBeCloseTo(0, 9)
    expect(out.x + out.w).toBeCloseTo(0.6, 9)
  })
  it('keeps the bottom edge pinned when a north drag is clamped at the origin', () => {
    const out = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'n', 0, -0.3, null)
    expect(out.y).toBeCloseTo(0, 9)
    expect(out.y + out.h).toBeCloseTo(0.6, 9)
  })
  it('keeps both pinned edges when a NW drag is clamped at the origin', () => {
    const out = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'nw', -0.3, -0.3, null)
    expect(out.x + out.w).toBeCloseTo(0.6, 9)
    expect(out.y + out.h).toBeCloseTo(0.6, 9)
  })
  it('treats a non-positive lockRatio as unlocked instead of emitting NaN', () => {
    const out = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'se', -0.4, 0, 0)
    expect(Number.isNaN(out.w)).toBe(false)
    expect(Number.isNaN(out.h)).toBe(false)
    expect(out.h).toBeCloseTo(0.4, 9)
    expect(out.w).toBeCloseTo(0.05, 9)
  })
})

describe('snapMove', () => {
  const neighbour = { x: 0, y: 0, w: 0.5, h: 1 }
  it('snaps a near-flush left edge onto the neighbour\'s right edge', () => {
    const out = snapMove({ x: 0.508, y: 0, w: 0.4, h: 1 }, [neighbour])
    expect(out.x).toBeCloseTo(0.5, 9)
    expect(out.w).toBeCloseTo(0.4, 9)   // move must never resize
  })
  it('snaps the trailing edge to the board edge', () => {
    const out = snapMove({ x: 0.592, y: 0, w: 0.4, h: 1 }, [])
    expect(out.x + out.w).toBeCloseTo(1, 9)
  })
  it('leaves a rect alone when nothing is within the threshold', () => {
    const r = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }
    expect(snapMove(r, [neighbour])).toEqual(r)
  })
  it('snaps x and y independently', () => {
    const out = snapMove({ x: 0.008, y: 0.409, w: 0.2, h: 0.2 }, [{ x: 0.7, y: 0.4, w: 0.2, h: 0.2 }])
    expect(out.x).toBeCloseTo(0, 9)
    expect(out.y).toBeCloseTo(0.4, 9)
  })
})

describe('snapResize', () => {
  it('snaps only the dragged edge and leaves the anchored one alone', () => {
    const out = snapResize({ x: 0.2, y: 0, w: 0.294, h: 1 }, [{ x: 0.5, y: 0, w: 0.5, h: 1 }], 'e')
    expect(out.x).toBeCloseTo(0.2, 9)
    expect(out.x + out.w).toBeCloseTo(0.5, 9)
  })
  it('allocates the final third as the exact remaining width', () => {
    // Cards 1 and 2 already sit at 0.333 each. Drag card 3's left edge near 0.666 and its right
    // edge near the board edge: w falls out as 0.334 without anyone typing it.
    const others = [{ x: 0, y: 0, w: 0.333, h: 1 }, { x: 0.333, y: 0, w: 0.333, h: 1 }]
    const dragged = snapResize({ x: 0.671, y: 0, w: 0.325, h: 1 }, others, 'w')
    const final = snapResize(dragged, others, 'e')
    expect(final.x).toBeCloseTo(0.666, 9)
    expect(final.w).toBeCloseTo(0.334, 9)
  })
  // Regression: a snap that would carve the DRAGGED edge below RECT_MIN gets floored — but the
  // floor must re-pin against the edge the handle never touched. Flooring w in place (leaving x at
  // the raw snap hit) drags the east edge along with it, which is exactly the anchored-edge-shift
  // the handle is supposed to be immune to. Found by fuzzing snapResize against its own stated
  // guarantee (same bug class as resizeRect's origin-clamp pin from stream data channel).
  it('re-pins the anchored east edge when a west snap would floor below RECT_MIN', () => {
    const out = snapResize({ x: 0.228, y: 0, w: 0.052, h: 1 }, [{ x: 0.24, y: 0, w: 0.3, h: 1 }], 'w')
    expect(out.w).toBeCloseTo(0.05, 9)
    expect(out.x + out.w).toBeCloseTo(0.28, 9)   // anchored edge: must equal the ORIGINAL right edge
  })
  it('re-pins the anchored bottom edge when a north snap would floor below RECT_MIN', () => {
    const out = snapResize({ x: 0, y: 0.228, w: 1, h: 0.052 }, [{ x: 0, y: 0.24, w: 1, h: 0.3 }], 'n')
    expect(out.h).toBeCloseTo(0.05, 9)
    expect(out.y + out.h).toBeCloseTo(0.28, 9)   // anchored edge: must equal the ORIGINAL bottom edge
  })
})

describe('SNAP', () => {
  it('is 0.015 in fraction space', () => expect(SNAP).toBe(0.015))
})
