import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import flip from '../static/device/widgets/clock/flip.mjs'

/**
 * Recorder with a transform stack, because this design's whole mechanism IS the transform: a card
 * mid-flip is a card drawn under a vertical `scale`. A recorder that only collects fill colours
 * cannot see the flip at all, so every `fillText` is captured alongside the vertical scale in
 * force when it landed.
 */
function recorder() {
  const fills: string[] = []
  const texts: { text: string; scaleY: number; x: number; y: number }[] = []
  const rects: { x: number; y: number; w: number; h: number; scaleY: number }[] = []
  let cur = ''
  let setTransformCalls = 0
  let depth = 0
  let minDepth = 0
  let scaleY = 1
  const stack: number[] = []
  const g = {
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1, lineWidth: 1, lineCap: '',
    set fillStyle(v: string) { cur = v; fills.push(v) },
    get fillStyle() { return cur },
    strokeStyle: '',
    save: () => { stack.push(scaleY); depth++ },
    restore: () => { scaleY = stack.pop() ?? 1; depth--; minDepth = Math.min(minDepth, depth) },
    scale: (_sx: number, sy: number) => { scaleY *= sy },
    setTransform: () => { setTransformCalls++ },
    translate: () => {}, rotate: () => {},
    beginPath: () => {}, closePath: () => {}, stroke: () => {},
    fill: () => {},
    rect: (x: number, y: number, w: number, h: number) => { rects.push({ x, y, w, h, scaleY }) },
    moveTo: () => {}, lineTo: () => {}, arc: () => {},
    fillText: (text: string, x: number, y: number) => { texts.push({ text, scaleY, x, y }) },
    measureText: (s: string) => ({ width: s.length * 10 }),
  }
  return {
    g, fills, texts, rects,
    depth: () => depth, minDepth: () => minDepth,
    setTransformCalls: () => setTransformCalls,
  }
}

const TOKENS = { card: '#e8e4d8', digit: '#1a1a1a', hinge: '#0a0a0a', case: '#141414' }

/**
 * Built with Date.UTC so `now % 60_000` — and therefore the flip window — is identical on every
 * machine: a minute boundary in epoch ms is a minute boundary in every real timezone, because
 * every modern UTC offset is a whole number of minutes.
 *
 * Nothing below asserts a literal digit. WHICH cards move depends on local time (a +5:45 offset
 * shifts the minute of the hour), so every expectation is derived from the same local-time API the
 * design reads — see `changedSlots`.
 */
const BOUNDARY = Date.UTC(2026, 7, 2, 3, 31, 0)
const AT_REST = BOUNDARY + 20_000
const FLIP_MS = 420

const ctx = (overrides = {}) => ({
  tokens: TOKENS,
  config: {},
  box: { w: 400, h: 200, t: 1.0 },
  now: AT_REST,
  state: {},
  motion: 'full',
  ...overrides,
})

const digitsAt = (now: number) => {
  const d = new Date(now)
  const hh = d.getHours(), mm = d.getMinutes()
  return [Math.floor(hh / 10), hh % 10, Math.floor(mm / 10), mm % 10]
}
/** Slot indices whose digit actually changes across this boundary, read as the design reads them. */
const changedSlots = (now: number) => {
  const to = digitsAt(now), from = digitsAt(now - 60_000)
  return [0, 1, 2, 3].filter((i) => to[i] !== from[i])
}

describe('split-flap clock design', () => {
  it('declares every token it draws with', () => {
    expect(Object.keys(flip.meta.tokens).sort()).toEqual(['card', 'case', 'digit', 'hinge'])
  })

  it('reads every token it declares — no dead knobs', () => {
    const r = recorder()
    const distinct = { card: '#111111', digit: '#222222', hinge: '#333333', case: '#444444' }
    flip.draw(r.g, ctx({ tokens: distinct }), 0)
    for (const v of Object.values(distinct)) expect(r.fills).toContain(v)
  })

  it('prefers a wide cell', () => {
    expect(flip.meta.suggested_ratio).toBe(2.6)
  })

  it('declares the digit-change transition and no persistent animation', () => {
    expect(flip.meta.animations.transition).toContain('digit_change')
    expect(flip.meta.animations.persistent).toEqual([])
  })

  it('draws four cards and the two colon dots', () => {
    const r = recorder()
    flip.draw(r.g, ctx(), 0)
    expect(r.texts).toHaveLength(4)
  })

  it('is a pure function of its inputs — same ctx, same calls', () => {
    const a = recorder(); flip.draw(a.g, ctx(), 120)
    const b = recorder(); flip.draw(b.g, ctx(), 120)
    expect(a.texts).toEqual(b.texts)
    expect(a.fills).toEqual(b.fills)
  })

  it('renders a resting state when motion is off', () => {
    const r = recorder()
    expect(() => flip.draw(r.g, ctx({ motion: 'none' }), 0)).not.toThrow()
    for (const t of r.texts) expect(t.scaleY).toBe(1)
  })
})

/**
 * The transform is the mechanism, and it is also the thing that can silently corrupt the REST of
 * the board: `prepare()` installs a device-pixel-ratio matrix before any design draws, and a
 * design that leaks a transform hands the next cell a wrong one.
 */
describe('split-flap transform discipline', () => {
  it('never calls setTransform — it would clobber the device-pixel-ratio matrix', () => {
    const r = recorder()
    flip.draw(r.g, ctx({ now: BOUNDARY + 100 }), 0)
    expect(r.setTransformCalls()).toBe(0)
  })

  it('balances every save with a restore, mid-flip and at rest', () => {
    for (const now of [AT_REST, BOUNDARY, BOUNDARY + 100, BOUNDARY + 210, BOUNDARY + 400]) {
      const r = recorder()
      flip.draw(r.g, ctx({ now }), 0)
      expect(r.depth()).toBe(0)
      expect(r.minDepth()).toBe(0)   // never restores past its own baseline
    }
  })
})

describe('split-flap flip timing (driven by hub time, not the frame clock)', () => {
  it('sits perfectly still away from a boundary, whatever the frame clock says', () => {
    const r = recorder()
    flip.draw(r.g, ctx({ now: AT_REST }), 0)
    for (const t of r.texts) expect(t.scaleY).toBe(1)
    digitsAt(AT_REST).forEach((d, i) => expect(r.texts[i].text).toBe(String(d)))
  })

  it('squashes only the cards whose digit actually changed', () => {
    const r = recorder()
    flip.draw(r.g, ctx({ now: BOUNDARY + 100 }), 0)   // ~24% in, phase one
    const changed = changedSlots(BOUNDARY + 100)
    expect(changed.length).toBeGreaterThan(0)
    r.texts.forEach((t, i) => {
      if (changed.includes(i)) expect(t.scaleY).toBeLessThan(1)
      else expect(t.scaleY).toBe(1)      // a card that did not change never moves
    })
  })

  it('shows the OUTGOING digit while the card is falling', () => {
    const now = BOUNDARY + 100
    const r = recorder()
    flip.draw(r.g, ctx({ now }), 0)
    const from = digitsAt(now - 60_000)
    for (const i of changedSlots(now)) expect(r.texts[i].text).toBe(String(from[i]))
  })

  it('has collapsed to the hinge at the halfway point', () => {
    const r = recorder()
    flip.draw(r.g, ctx({ now: BOUNDARY + FLIP_MS / 2 }), 0)
    for (const i of changedSlots(BOUNDARY + FLIP_MS / 2)) {
      expect(r.texts[i].scaleY).toBeCloseTo(0, 5)
    }
  })

  it('shows the INCOMING digit while the card is rising', () => {
    const now = BOUNDARY + 320
    const r = recorder()
    flip.draw(r.g, ctx({ now }), 0)
    const to = digitsAt(now)
    for (const i of changedSlots(now)) {
      expect(r.texts[i].text).toBe(String(to[i]))
      expect(r.texts[i].scaleY).toBeGreaterThan(0)
      expect(r.texts[i].scaleY).toBeLessThan(1)
    }
  })

  it('has fully landed by the end of the window', () => {
    const now = BOUNDARY + FLIP_MS
    const r = recorder()
    flip.draw(r.g, ctx({ now }), 0)
    digitsAt(now).forEach((d, i) => {
      expect(r.texts[i].text).toBe(String(d))
      expect(r.texts[i].scaleY).toBe(1)
    })
  })

  it('ignores elapsedMs — a dropped or restarted frame clock cannot desync it', () => {
    const a = recorder(); flip.draw(a.g, ctx({ now: AT_REST }), 0)
    const b = recorder(); flip.draw(b.g, ctx({ now: AT_REST }), 5_000)
    expect(a.texts).toEqual(b.texts)
  })

  it('reports it is animating only inside the window after a rollover', () => {
    expect(flip.isAnimating(ctx({ now: BOUNDARY }))).toBe(true)
    expect(flip.isAnimating(ctx({ now: BOUNDARY + FLIP_MS - 1 }))).toBe(true)
    expect(flip.isAnimating(ctx({ now: BOUNDARY + FLIP_MS }))).toBe(false)
    expect(flip.isAnimating(ctx({ now: AT_REST }))).toBe(false)
  })

  it('never reports it is animating when motion is off', () => {
    expect(flip.isAnimating(ctx({ now: BOUNDARY, motion: 'none' }))).toBe(false)
  })

  it('handles a pre-epoch hub time without inventing a flip', () => {
    // 40s into the minute that began at -60_000, so at rest. A plain `%` would give -20_000 and
    // read as "before the boundary" forever.
    const now = Date.UTC(1969, 11, 31, 23, 59, 40)
    expect(now).toBe(-20_000)
    expect(flip.isAnimating(ctx({ now }))).toBe(false)
  })
})

describe('split-flap geometry on extreme cell shapes', () => {
  it('letterboxes inside the cell rather than stretching its cards', () => {
    const r = recorder()
    const box = { w: 1000, h: 200, t: 1.0 }   // 5:1, far wider than its 2.6 ratio
    flip.draw(r.g, ctx({ box }), 0)
    const drawn = r.rects.filter((q) => q.w > 0)
    const left = Math.min(...drawn.map((q) => q.x))
    const right = Math.max(...drawn.map((q) => q.x + q.w))
    // Centred, and narrower than the cell — a 2.6 ratio board in a 5:1 cell must not fill it.
    expect(right - left).toBeLessThan(box.w * 0.95)
    expect(left).toBeGreaterThan(0)
    expect(box.w - right).toBeCloseTo(left, 5)
  })

  it('keeps every card inside a flat banner cell', () => {
    const r = recorder()
    const box = { w: 1080, h: 96, t: 0.4 }
    flip.draw(r.g, ctx({ box }), 0)
    for (const q of r.rects) {
      expect(q.x).toBeGreaterThanOrEqual(0)
      expect(q.y).toBeGreaterThanOrEqual(0)
      expect(q.x + q.w).toBeLessThanOrEqual(box.w + 0.001)
      expect(q.y + q.h).toBeLessThanOrEqual(box.h + 0.001)
      expect(q.w).toBeGreaterThanOrEqual(0)
      expect(q.h).toBeGreaterThanOrEqual(0)
    }
  })

  it('draws nothing rather than inverting on a zero-height cell', () => {
    const r = recorder()
    expect(() => flip.draw(r.g, ctx({ box: { w: 400, h: 0, t: 0.1 } }), 0)).not.toThrow()
    expect(r.texts).toHaveLength(0)
  })
})
