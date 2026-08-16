import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import digital from '../static/device/widgets/clock/digital.mjs'

/** Records the drawing calls a design makes, so appearance is asserted without a real canvas. */
function recorder(widths: Record<string, number> = {}) {
  const calls: { op: string; args: unknown[]; font: string }[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    fillText: (...a: unknown[]) => calls.push({ op: 'fillText', args: a, font: g.font }),
    measureText: (s: string) => {
      if (Object.prototype.hasOwnProperty.call(widths, s)) return { width: widths[s] }
      // Width tracks the font actually set (not a constant), so the fit loop really does narrow
      // across candidates rather than only ever seeing fits-or-floor.
      const px = Number(g.font.match(/(\d+)px/)?.[1] ?? 16)
      return { width: s.length * px * 0.3 }
    },
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {},
    arc: () => {}, moveTo: () => {}, lineTo: () => {}, rect: () => {}, fillRect: () => {},
  }
  return { g, calls, texts: () => calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]) }
}

const ctx = (overrides = {}) => ({
  tokens: { ink: '#e6e9f0', dim: '#8a90a0' },
  config: {},
  box: { w: 400, h: 200, t: 1.0 },
  now: Date.UTC(2026, 7, 2, 15, 30, 0),
  state: {},
  motion: 'full',
  ...overrides,
})

describe('digital clock design', () => {
  it('is the default design for the clock widget', () => {
    expect(digital.meta.widget).toBe('clock')
    expect(digital.meta.default).toBe(true)
  })

  it('declares every token it draws with', () => {
    expect(Object.keys(digital.meta.tokens).sort()).toEqual(['date', 'time'])
  })

  it('does not distort, so the off-ratio marker leaves it alone', () => {
  })

  it('draws a time line and a date line', () => {
    const r = recorder()
    digital.draw(r.g, ctx(), 0)
    expect(r.texts()).toHaveLength(2)
  })

  it('shrinks the time to fit a narrow cell rather than overflowing', () => {
    const wide = recorder()
    digital.draw(wide.g, ctx({ box: { w: 400, h: 200, t: 1.0 } }), 0)
    const narrow = recorder()
    digital.draw(narrow.g, ctx({ box: { w: 120, h: 200, t: 1.0 } }), 0)
    const px = (f: string) => Number(f.match(/(\d+)px/)![1])
    expect(px(narrow.calls[0].font)).toBeLessThan(px(wide.calls[0].font))
  })

  it('renders hub time, never the wall clock', () => {
    const r = recorder()
    const fixed = Date.UTC(2026, 7, 2, 15, 30, 0)
    digital.draw(r.g, ctx({ now: fixed }), 0)
    const expected = new Date(fixed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(r.texts()[0]).toBe(expected)
  })

  it('honours the scale knob', () => {
    const px = (calls: { font: string }[]) => Number(calls[0].font.match(/(\d+)px/)![1])
    const plain = recorder()
    digital.draw(plain.g, ctx({ config: {} }), 0)
    const scaled = recorder()
    digital.draw(scaled.g, ctx({ config: { scale: 2 } }), 0)
    expect(px(scaled.calls)).toBeGreaterThan(px(plain.calls))
  })

  it('reads every token it declares — no dead knobs', () => {
    const r = recorder()
    const fills: string[] = []
    Object.defineProperty(r.g, 'fillStyle', { set: (v: string) => fills.push(v), get: () => '' })
    digital.draw(r.g, ctx({ tokens: { time: '#111111', date: '#222222' } }), 0)
    expect(fills).toContain('#111111')
    expect(fills).toContain('#222222')
  })
})
