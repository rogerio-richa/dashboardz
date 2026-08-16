import { beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import chat, { _resetChatScrollState } from '../static/device/widgets/stream/chat.mjs'

type Call = { fillStyle: string; font: string; text: string }
type Stroke = { style: string; alpha: number }

function recorder() {
  const calls: Call[] = []
  const strokes: Stroke[] = []
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string) => calls.push({ fillStyle: g.fillStyle, font: g.font, text }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {},
    arc: () => {}, rect: () => {},
    stroke: () => strokes.push({ style: g.strokeStyle, alpha: g.globalAlpha }),
    fill: () => {},
  }
  return { g, calls, strokes }
}

const tokens = { ink: '#ink', dim: '#dim', badge: '#badge' }
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const rows = [
  { payload: { from: 'NodeAlpha', short: 'Alpha', text: 'Testing the new antenna setup' }, pushed_at: NOW - 2 * 60_000 },
  { payload: { from: 'BetaRelay', short: 'Beta', text: 'SNR is solid across town' }, pushed_at: NOW - 7 * 60_000 },
]
const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens,
  config: { feed: 'f-chat', title_path: 'short', body_path: 'text' },
  data: null,
  rows,
  feed: { missing: false, mode: 'stream', pushed_at: NOW - 2 * 60_000, image_rev: null },
  box: { w: 400, h: 400, t: 1 },
  now: NOW, state: {}, motion: 'full', stale: false, age_ms: null,
  ...overrides,
})

describe('stream/chat design', () => {
  beforeEach(() => _resetChatScrollState())

  it('registers as a stream_list design named chat', () => {
    expect(chat.meta.widget).toBe('stream_list')
    expect(chat.meta.id).toBe('chat')
  })

  it('declares the same options as scroll (scrollable: no counter knob), so the schema contract holds', async () => {
    // @ts-expect-error plain JS module without types
    const scroll = (await import('../static/device/widgets/stream/scroll.mjs')).default
    expect(chat.meta.options).toEqual(scroll.meta.options)
  })

  it('scrolls: a drag moves older rows into view, exactly like the scroll design', () => {
    const manyRows = Array.from({ length: 30 }, (_, i) => ({
      payload: { from: `Node${i}`, short: `N${i}`, text: `message ${i}` },
      pushed_at: NOW - i * 60_000,
    }))
    const first = recorder()
    chat.draw(first.g, baseCtx({ rows: manyRows, box: { w: 400, h: 200, t: 1 } }))
    expect(first.calls.some((c) => c.text === '@N0:')).toBe(true)
    expect(first.calls.some((c) => c.text === '@N20:')).toBe(false)

    // Finger up (negative dy) = toward older rows; the handler reports a repaint is needed.
    const cell = { config: { feed: 'f-chat' } }
    // Large enough to clamp to the bottom of the queue (30 rows × 96px cards ≫ viewport).
    expect(chat.pointer.move(cell, -5000)).toBe(true)

    const after = recorder()
    chat.draw(after.g, baseCtx({ rows: manyRows, box: { w: 400, h: 200, t: 1 } }))
    expect(after.calls.some((c) => c.text === '@N0:')).toBe(false)
    expect(after.calls.some((c) => c.text === '@N29:')).toBe(true)
  })

  it('paints @sender: bold in ink and the message text', () => {
    const { g, calls } = recorder()
    chat.draw(g, baseCtx())
    const sender = calls.find((c) => c.text === '@Alpha:')
    expect(sender?.fillStyle).toBe('#ink')
    expect(sender?.font.startsWith('700')).toBe(true)
    expect(calls.some((c) => c.text.includes('Testing the new antenna'))).toBe(true)
  })

  it('paints an HH:MM time column in dim', () => {
    const { g, calls } = recorder()
    chat.draw(g, baseCtx())
    const times = calls.filter((c) => /^\d{2}:\d{2}$/.test(c.text))
    expect(times.length).toBeGreaterThanOrEqual(2)
    expect(times.every((c) => c.fillStyle === '#dim')).toBe(true)
  })

  it('draws a translucent hairline under each visible row', () => {
    const { g, strokes } = recorder()
    chat.draw(g, baseCtx())
    const hairlines = strokes.filter((s) => s.style === '#dim' && s.alpha < 1)
    expect(hairlines.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the loud/quiet states of the widget', () => {
    const missing = recorder()
    chat.draw(missing.g, baseCtx({ rows: null, feed: null }))
    expect(missing.calls.some((c) => c.text === 'Feed missing')).toBe(true)

    const empty = recorder()
    chat.draw(empty.g, baseCtx({ rows: [], feed: { missing: false, mode: 'stream', pushed_at: null, image_rev: null } }))
    expect(empty.calls.some((c) => c.text === '— no rows yet')).toBe(true)
  })
})
