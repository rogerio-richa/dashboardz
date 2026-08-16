import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import battery from '../static/device/widgets/gauge/battery.mjs'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../static/device/widgets/catalogue.mjs'

type Call = { fillStyle: string; text: string }
type StrokeCall = { style: string; arc: { cx: number; cy: number; r: number; start: number; end: number } | null }
type FillCall = { style: string; rect: { x: number; y: number; w: number; h: number } | null; arc: StrokeCall['arc'] }

/** Same recorder shape as widget-gauge.test.ts — captures painted text colours plus enough
 *  path/stroke ops to tell the track, value arc, hole fill and bolt fill apart. `fill()` with
 *  neither a rect nor a *new* arc since the last beginPath is how the bolt (a moveTo/lineTo
 *  polygon) shows up, so beginPath clears the last-seen geometry. */
function recorder() {
  const calls: Call[] = []
  const strokes: StrokeCall[] = []
  const fills: FillCall[] = []
  let lastArc: StrokeCall['arc'] = null
  let lastRect: FillCall['rect'] = null
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string) => calls.push({ fillStyle: g.fillStyle, text }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => { lastArc = null; lastRect = null },
    closePath: () => {},
    moveTo: () => {}, lineTo: () => {},
    arc: (cx: number, cy: number, r: number, start: number, end: number) => { lastArc = { cx, cy, r, start, end } },
    rect: (x: number, y: number, w: number, h: number) => { lastRect = { x, y, w, h } },
    stroke: () => strokes.push({ style: g.strokeStyle, arc: lastArc }),
    fill: () => fills.push({ style: g.fillStyle, rect: lastRect, arc: lastArc }),
  }
  return { g, calls, strokes, fills }
}

const tokens = { ink: '#ink', dim: '#dim', info: '#info', warn: '#warn', critical: '#crit', hole: '#hole' }
const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens,
  config: { path: 'battery_pct', min: 0, max: 100, label: 'Battery Gauge', unit: '%' },
  data: { battery_pct: 84, voltage: 4.123, plugged_in: true },
  box: { w: 300, h: 260, t: 1 },
  now: 0, state: {}, motion: 'full', stale: false, age_ms: null,
  ...overrides,
})

describe('gauge/battery design', () => {
  it('registers as a gauge design named battery, after bar and ring', () => {
    expect(battery.meta.widget).toBe('gauge')
    expect(battery.meta.id).toBe('battery')
    const gaugeIds = CATALOGUE.filter((d: { meta: { widget: string } }) => d.meta.widget === 'gauge')
      .map((d: { meta: { id: string } }) => d.meta.id)
    expect(gaugeIds[0]).toBe('bar') // default preserved
    expect(gaugeIds).toContain('battery')
  })

  it('draws a three-quarter track, not a full circle', () => {
    const { g, strokes } = recorder()
    battery.draw(g, baseCtx())
    const track = strokes.find((s) => s.style === '#dim' && s.arc)
    expect(track).toBeTruthy()
    expect(track!.arc!.end - track!.arc!.start).toBeCloseTo(Math.PI * 1.5, 5)
  })

  it('fills the value arc with the severity colour over the same span fraction', () => {
    const { g, strokes } = recorder()
    battery.draw(g, baseCtx())
    const value = strokes.find((s) => s.style === '#info' && s.arc)
    expect(value).toBeTruthy()
    expect(value!.arc!.end - value!.arc!.start).toBeCloseTo(0.84 * Math.PI * 1.5, 5)
  })

  it('paints the bolt only when plugged in', () => {
    const plugged = recorder()
    battery.draw(plugged.g, baseCtx())
    // The bolt is the one ink-coloured polygon fill (no rect, no arc recorded for it).
    expect(plugged.fills.filter((f) => f.style === '#ink' && !f.rect && !f.arc)).toHaveLength(1)

    const unplugged = recorder()
    battery.draw(unplugged.g, baseCtx({ data: { battery_pct: 84, voltage: 4.123, plugged_in: false } }))
    expect(unplugged.fills.filter((f) => f.style === '#ink' && !f.rect && !f.arc)).toHaveLength(0)
  })

  it('paints the voltage line when voltage is present, and skips it when absent', () => {
    const withV = recorder()
    battery.draw(withV.g, baseCtx())
    expect(withV.calls.some((c) => c.text === '4.12V' && c.fillStyle === '#dim')).toBe(true)

    const withoutV = recorder()
    battery.draw(withoutV.g, baseCtx({ data: { battery_pct: 84 } }))
    expect(withoutV.calls.some((c) => c.text.endsWith('V'))).toBe(false)
  })

  it('paints the 0% / 100% end labels and the big percentage', () => {
    const { g, calls } = recorder()
    battery.draw(g, baseCtx())
    expect(calls.some((c) => c.text === '0%')).toBe(true)
    expect(calls.some((c) => c.text === '100%')).toBe(true)
    expect(calls.some((c) => c.text === '84%' && c.fillStyle === '#ink')).toBe(true)
  })

  it('derives the end labels from a custom min/max/unit instead of hard-coded 0%/100%', () => {
    const { g, calls } = recorder()
    battery.draw(g, baseCtx({ config: { path: 'battery_pct', min: 3, max: 4.3, label: 'Battery Gauge', unit: 'V' } }))
    expect(calls.some((c) => c.text === '3V')).toBe(true)
    expect(calls.some((c) => c.text === '4.3V')).toBe(true)
    expect(calls.some((c) => c.text === '0%')).toBe(false)
    expect(calls.some((c) => c.text === '100%')).toBe(false)
  })

  it('shows a full 100% reading untruncated in a panel-sized cell', () => {
    const { g, calls } = recorder()
    battery.draw(g, baseCtx({
      data: { battery_pct: 100, voltage: 4.34, plugged_in: true },
      box: { w: 290, h: 134, t: 1 },
    }))
    expect(calls.some((c) => c.text === '100%')).toBe(true)
    expect(calls.some((c) => c.text.includes('…'))).toBe(false)
  })

  it('shows a full 100% reading in a carded 2x2 dial cell (content box after card insets)', () => {
    const { g, calls } = recorder()
    battery.draw(g, baseCtx({
      data: { battery_pct: 100, voltage: 4.31, plugged_in: true },
      box: { w: 121, h: 111, t: 1 },
    }))
    expect(calls.some((c) => c.text === '100%')).toBe(true)
    expect(calls.some((c) => c.text.includes('…'))).toBe(false)
  })

  it('survives no data at all: empty track, no bolt, no voltage, em-dash value', () => {
    const { g, strokes, calls, fills } = recorder()
    battery.draw(g, baseCtx({ data: null }))
    expect(strokes.filter((s) => s.style === '#info')).toHaveLength(0)
    expect(fills.filter((f) => f.style === '#ink' && !f.rect && !f.arc)).toHaveLength(0)
    expect(calls.some((c) => c.text === '—')).toBe(true)
  })
})
