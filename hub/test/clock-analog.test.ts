import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import analog from '../static/device/widgets/clock/analog.mjs'

function recorder() {
  const ops: { op: string; args: unknown[] }[] = []
  const g = {
    font: '', textAlign: '', textBaseline: '', lineWidth: 1, lineCap: '',
    fillStyle: '', strokeStyle: '',
    save: () => ops.push({ op: 'save', args: [] }),
    restore: () => ops.push({ op: 'restore', args: [] }),
    translate: (...a: unknown[]) => ops.push({ op: 'translate', args: a }),
    rotate: (...a: unknown[]) => ops.push({ op: 'rotate', args: a }),
    beginPath: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, rect: () => {},
    roundRect: () => {}, fillRect: () => {},
    fillText: (...a: unknown[]) => ops.push({ op: 'fillText', args: a }),
    measureText: (s: string) => ({ width: s.length * 8 }),
  }
  return { g, ops, rotations: () => ops.filter((o) => o.op === 'rotate').map((o) => o.args[0] as number) }
}

const ctx = (overrides = {}) => ({
  tokens: {
    face: '#fffdf5', rim: '#1a1a1a', tick: '#1a1a1a',
    numeral: '#1a1a1a', hand_hour: '#1a1a1a', hand_minute: '#1a1a1a',
  },
  config: {},
  box: { w: 200, h: 200, t: 1.0 },
  now: Date.UTC(2026, 7, 2, 3, 30, 0),
  state: {},
  motion: 'full',
  ...overrides,
})

const rad = (deg: number) => deg * Math.PI / 180

describe('analog clock design', () => {
  it('declares every token it draws with', () => {
    expect(Object.keys(analog.meta.tokens).sort())
      .toEqual(['face', 'hand_hour', 'hand_minute', 'numeral', 'rim', 'tick'])
  })

  it('prefers a square cell', () => {
    expect(analog.meta.suggested_ratio).toBe(1.0)
  })

  it('draws exactly the four numerals from the reference', () => {
    const r = recorder()
    analog.draw(r.g, ctx(), 0)
    const texts = r.ops.filter((o) => o.op === 'fillText').map((o) => o.args[0])
    expect(texts).toEqual(['12', '3', '6', '9'])
  })

  it('rotates the hands to the angles handAngles computes', () => {
    const r = recorder()
    // 03:30 local — hour hand 105 degrees, minute hand 180 degrees
    const local = new Date(2026, 7, 2, 3, 30, 0).getTime()
    analog.draw(r.g, ctx({ now: local }), 0)
    const rots = r.rotations()
    expect(rots).toContain(rad(105))
    expect(rots).toContain(rad(180))
  })

  it('draws two hands, not three — the reference has no second hand', () => {
    const r = recorder()
    const local = new Date(2026, 7, 2, 3, 30, 0).getTime()
    analog.draw(r.g, ctx({ now: local }), 0)
    // Tick marks (the eight non-numeral hour positions) also rotate, at fixed 30-degree
    // multiples, so a raw rotate() count no longer isolates the hands. Excluding those known
    // tick angles still lets a stray third hand — any other rotation — fail this assertion.
    const tickAngles = new Set([1, 2, 4, 5, 7, 8, 10, 11].map((h) => rad(h * 30)))
    const hands = r.rotations().filter((a) => !tickAngles.has(a))
    expect(hands).toHaveLength(2)
  })

  it('draws a tick mark at each of the eight non-numeral hour positions', () => {
    const r = recorder()
    analog.draw(r.g, ctx(), 0)
    const tickAngles = new Set([1, 2, 4, 5, 7, 8, 10, 11].map((h) => rad(h * 30)))
    const ticks = r.rotations().filter((a) => tickAngles.has(a))
    expect(ticks).toHaveLength(8)
  })

  it('balances every save with a restore, so hand rotation cannot leak into the next cell', () => {
    const r = recorder()
    analog.draw(r.g, ctx(), 0)
    const saves = r.ops.filter((o) => o.op === 'save').length
    const restores = r.ops.filter((o) => o.op === 'restore').length
    expect(saves).toBe(restores)
  })

  it('shrinks to the smaller axis so a wide cell still draws a circular face', () => {
    const r = recorder()
    expect(() => analog.draw(r.g, ctx({ box: { w: 600, h: 120, t: 1.0 } }), 0)).not.toThrow()
    const translates = r.ops.filter((o) => o.op === 'translate')
    expect(translates[0].args).toEqual([300, 60])
  })
})
