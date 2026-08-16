import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import ticker, { tickerOffset, tickerPlan, anchoredOffset, _resetTickerAnchors } from '../static/device/widgets/stream/ticker.mjs'

/**
 * `stream_list`/`ticker` — the marquee. Two things here are worth more than the painting:
 *
 * 1. `tickerOffset` is a PURE function of elapsed-ms, speed and content width (animation contract
 *    rule). That is what makes the strip resumable after a dropped frame and testable with no
 *    clock — the same discipline `clock/segment.mjs` follows for its digit ease.
 * 2. `isAnimating` says false at `speed: 0` and under `motion: 'none'`. `loop.mjs`'s rule is
 *    that the board idles to ZERO frames when nothing moves, and a marquee is the one design that
 *    could pin a 24/7 panel at full rate forever. A static strip must cost nothing.
 */

type Call = { fillStyle: string; font: string; text: string; x: number }

function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string, x: number) => calls.push({ fillStyle: g.fillStyle, font: g.font, text, x }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, rect: () => {},
    stroke: () => {}, fill: () => {},
    save: () => {}, restore: () => {}, clip: () => {},
  }
  return { g, calls }
}

const tokens = { ink: '#ink', dim: '#dim', up: '#up', down: '#down' }
type Part = { text: string; tone: string }
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)
const rows = [
  { payload: { sym: 'AAPL', chg: '+1.2%' }, pushed_at: NOW - 1_000 },
  { payload: { sym: 'MSFT', chg: '-0.8%' }, pushed_at: NOW - 2_000 },
]
const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens,
  config: { feed: 'f-quotes', title_path: 'sym', body_path: 'chg' },
  data: null,
  rows,
  feed: { missing: false, mode: 'stream', pushed_at: NOW - 1_000, image_rev: null },
  box: { w: 400, h: 60, t: 1 },
  now: NOW, state: {}, motion: 'full', stale: false, age_ms: null,
  ...overrides,
})

describe('stream/ticker design', () => {
  it('registers as a stream_list design named ticker', () => {
    expect(ticker.meta.widget).toBe('stream_list')
    expect(ticker.meta.id).toBe('ticker')
  })

  it('declares the knobs the admin generates a form from, each nested under ticker.', () => {
    const o = ticker.meta.options
    expect(o.speed).toMatchObject({ type: 'number', path: 'ticker.speed' })
    expect(o.family).toMatchObject({ type: 'select', path: 'ticker.family' })
    expect(o.family.choices).toEqual(['sans', 'mono', 'serif'])
    expect(o.text_px).toMatchObject({ type: 'number', path: 'ticker.text_px' })
    expect(o.separator).toMatchObject({ type: 'text', path: 'ticker.separator' })
    expect(o.direction).toMatchObject({ type: 'select', path: 'ticker.direction' })
    expect(o.direction.choices).toEqual(['left', 'right'])
  })

  /**
   * A crawl belongs in a strip too short for any card list, which is exactly what `stream_list`'s
   * own minimum (160x110) forbids. Minimums are declared per WIDGET, so the first ticker band put
   * on a real panel rendered as "stream_list needs 160x110" — the guard was right about the widget
   * and wrong about this design. A design may now declare its own floor.
   */
  it('declares its own minimum, lower than stream_list\'s, because a crawl fits in a band', () => {
    expect(ticker.meta.minimum_px).toEqual({ w: 120, h: 28 })
  })

  it('declares up/down tokens so a gain and a loss are themeable, not hardcoded', () => {
    expect(ticker.meta.tokens.up).toBeTruthy()
    expect(ticker.meta.tokens.down).toBeTruthy()
  })

  describe('tickerOffset', () => {
    it('advances at exactly speed px per second', () => {
      expect(tickerOffset(1_000, 40, 500)).toBe(40)
      expect(tickerOffset(2_500, 40, 500)).toBe(100)
    })

    it('wraps at the content width so the loop has no visible jump', () => {
      expect(tickerOffset(13_000, 40, 500)).toBe(20)
      expect(tickerOffset(12_500, 40, 500)).toBe(0)
    })

    it('is a pure function of elapsed — a dropped frame changes nothing', () => {
      expect(tickerOffset(3_000, 40, 500)).toBe(tickerOffset(3_000, 40, 500))
      // Skipping frames 1..2 lands in exactly the place drawing them would have.
      expect(tickerOffset(3_000, 40, 500)).toBe(120)
    })

    it('stands still at speed 0, and never divides by a zero content width', () => {
      expect(tickerOffset(9_999, 0, 500)).toBe(0)
      expect(tickerOffset(9_999, 40, 0)).toBe(0)
    })
  })

  describe('isAnimating', () => {
    it('is true while it is scrolling', () => {
      expect(ticker.isAnimating(baseCtx({ config: { feed: 'f', ticker: { speed: 40 } } }))).toBe(true)
    })

    it('is false at speed 0 — a static strip must not pin the loop', () => {
      expect(ticker.isAnimating(baseCtx({ config: { feed: 'f', ticker: { speed: 0 } } }))).toBe(false)
    })

    it('is false under reduced motion', () => {
      expect(ticker.isAnimating(baseCtx({ config: { feed: 'f', ticker: { speed: 40 } }, motion: 'none' }))).toBe(false)
    })

    it('is false with nothing to scroll', () => {
      expect(ticker.isAnimating(baseCtx({ rows: [], config: { feed: 'f', ticker: { speed: 40 } } }))).toBe(false)
    })
  })

  describe('tickerPlan', () => {
    it('lays rows out as title, body, separator, in wire order', () => {
      const plan = tickerPlan(rows, { title_path: 'sym', body_path: 'chg' }, { separator: '·' })
      expect(plan.map((p: Part) => p.text)).toEqual(['AAPL', '+1.2%', '·', 'MSFT', '-0.8%', '·'])
    })

    it('tints a gain and a loss apart, and leaves plain text alone', () => {
      const plan = tickerPlan(rows, { title_path: 'sym', body_path: 'chg' }, { separator: '·' })
      expect(plan.find((p: Part) => p.text === '+1.2%')!.tone).toBe('up')
      expect(plan.find((p: Part) => p.text === '-0.8%')!.tone).toBe('down')
      expect(plan.find((p: Part) => p.text === 'AAPL')!.tone).toBe('ink')
    })

    it('reads a minus sign as a loss too, not just a hyphen', () => {
      const plan = tickerPlan([{ payload: { sym: 'GOLD', chg: '−0.4%' }, pushed_at: NOW }],
        { title_path: 'sym', body_path: 'chg' }, { separator: '·' })
      expect(plan.find((p: Part) => p.text.endsWith('0.4%'))!.tone).toBe('down')
    })
  })

  describe('draw', () => {
    it('paints every row in one line, with the separator between them', () => {
      const { g, calls } = recorder()
      ticker.draw(g, baseCtx(), 0)
      expect(calls.map((c) => c.text)).toContain('AAPL')
      expect(calls.map((c) => c.text)).toContain('·')
      expect(calls.map((c) => c.text)).toContain('MSFT')
    })

    it('honours the family knob — mono means a monospace stack reaches the canvas', () => {
      const { g, calls } = recorder()
      ticker.draw(g, baseCtx({ config: { feed: 'f', title_path: 'sym', body_path: 'chg', ticker: { family: 'mono', text_px: 22 } } }), 0)
      expect(calls[0].font).toContain('monospace')
      expect(calls[0].font).toContain('22px')
    })

    it('colours a gain with the up token and a loss with the down token', () => {
      const { g, calls } = recorder()
      ticker.draw(g, baseCtx(), 0)
      expect(calls.find((c) => c.text === '+1.2%')!.fillStyle).toBe('#up')
      expect(calls.find((c) => c.text === '-0.8%')!.fillStyle).toBe('#down')
    })

    it('moves left as time passes, and the other way when direction is right', () => {
      // Driven by `now` (elapsedMs is ignored), from a reset anchor so both samples sit inside one
      // wrap cycle. The anchor is an integrator, so the order of these two draws is the test.
      const run = (direction: string) => {
        _resetTickerAnchors()
        const cfg = { feed: `f-${direction}`, title_path: 'sym', body_path: 'chg', ticker: { speed: 40, direction } }
        const x = (now: number) => {
          const { g, calls } = recorder()
          ticker.draw(g, baseCtx({ now, config: cfg }), 0)
          return calls.find((c) => c.text === 'AAPL')!.x
        }
        return { start: x(0), later: x(1_000) }
      }
      const left = run('left')
      expect(left.later).toBeLessThan(left.start)
      const right = run('right')
      expect(right.later).toBeGreaterThan(right.start)
    })

    it('says so plainly when the cell is bound to nothing', () => {
      const { g, calls } = recorder()
      ticker.draw(g, baseCtx({ feed: { missing: true, mode: null, pushed_at: null, image_rev: null } }), 0)
      expect(calls.map((c) => c.text).join(' ')).toContain('Feed missing')
    })

    it('draws nothing but stays silent on an empty feed', () => {
      const { g, calls } = recorder()
      ticker.draw(g, baseCtx({ rows: [] }), 0)
      expect(calls.map((c) => c.text).join(' ')).not.toContain('undefined')
    })

    it('survives a zero-sized box without throwing', () => {
      const { g } = recorder()
      expect(() => ticker.draw(g, baseCtx({ box: { w: 0, h: 0, t: 1 } }), 0)).not.toThrow()
    })
  })

  /**
   * THE CONTENT-CHANGE SNAP. A crawl wraps at its CONTENT WIDTH, so `clock % contentW` moves the
   * wrap point whenever the rows change — new symbols, or just a digit more in a percentage. On a
   * live board that read as the banner snapping, and no amount of clock continuity fixes it:
   * the geometry itself moved.
   *
   * So the offset is ANCHORED. It advances from the last anchor at exactly `speed` px/s, and when
   * the content width changes the anchor is re-taken at the CURRENT pixel position — the strip
   * keeps scrolling from where it is while the text under it changes. Module-level state keyed by
   * feed, the same shape `stream/scroll.mjs` keeps its scroll position in.
   */
  describe('anchoredOffset', () => {
    it('advances at speed px per second from its anchor', () => {
      const state = new Map()
      expect(anchoredOffset(state, 'f', 0, 40, 500)).toBe(0)
      expect(anchoredOffset(state, 'f', 1_000, 40, 500)).toBe(40)
      expect(anchoredOffset(state, 'f', 3_000, 40, 500)).toBe(120)
    })

    it('wraps at the content width', () => {
      const state = new Map()
      anchoredOffset(state, 'f', 0, 40, 500)
      expect(anchoredOffset(state, 'f', 13_000, 40, 500)).toBe(20)
    })

    it('does NOT jump when the content width changes under it', () => {
      const state = new Map()
      anchoredOffset(state, 'f', 0, 40, 500)
      const before = anchoredOffset(state, 'f', 5_000, 40, 500)   // 200 into a 500px strip
      const after = anchoredOffset(state, 'f', 5_000, 40, 540)    // same instant, wider content
      expect(after).toBe(before)
    })

    /**
     * The residual snap, reported from a real board: "it stops, goes back a few positions, then
     * resumes". Re-wrapping the offset with the NEW width moves the strip backwards by the
     * DIFFERENCE between the widths — a few pixels of visible reversal. Subtracting whole periods
     * of the current width is the only shift a tiled strip can absorb invisibly.
     */
    it('never moves backwards when the content gets narrower', () => {
      const state = new Map()
      anchoredOffset(state, 'f', 0, 40, 500)
      const before = anchoredOffset(state, 'f', 12_000, 40, 500)  // 480 into a 500px strip
      const after = anchoredOffset(state, 'f', 12_000, 40, 480)   // same instant, narrower content
      // Either it held, or it wrapped by exactly one WHOLE period of the new width.
      const shift = before - after
      expect(shift === 0 || Math.abs(shift - 480) < 1e-9).toBe(true)
    })

    it('keeps advancing across a width change rather than stalling', () => {
      const state = new Map()
      anchoredOffset(state, 'f', 0, 40, 500)
      anchoredOffset(state, 'f', 12_000, 40, 480)
      const a = anchoredOffset(state, 'f', 13_000, 40, 480)
      const b = anchoredOffset(state, 'f', 14_000, 40, 480)
      expect(((b - a) % 480 + 480) % 480).toBeCloseTo(40, 5)
    })

    it('carries on smoothly from the re-anchor rather than restarting', () => {
      const state = new Map()
      anchoredOffset(state, 'f', 0, 40, 500)
      const before = anchoredOffset(state, 'f', 5_000, 40, 540)
      expect(anchoredOffset(state, 'f', 6_000, 40, 540)).toBeCloseTo(before + 40, 5)
    })

    it('keeps each feed on its own anchor', () => {
      const state = new Map()
      anchoredOffset(state, 'a', 0, 40, 500)
      anchoredOffset(state, 'b', 2_000, 40, 500)
      expect(anchoredOffset(state, 'a', 1_000, 40, 500)).toBe(40)
      expect(anchoredOffset(state, 'b', 3_000, 40, 500)).toBe(40)
    })

    it('stands still at speed 0', () => {
      const state = new Map()
      anchoredOffset(state, 'f', 0, 0, 500)
      expect(anchoredOffset(state, 'f', 9_000, 0, 500)).toBe(0)
    })
  })

  /**
   * Tiling has to COVER the cell, not just repeat twice. Two copies are plenty for content wider
   * than the cell and not enough for content narrower than it — and "wrap by one period" is only
   * invisible while whatever leaves one edge is already entering the other.
   */
  it('fills a cell wider than its own content, with no gap at the end', () => {
    const { g, calls } = recorder()
    // Two short rows on a wide cell: content is far narrower than the 1200px box.
    ticker.draw(g, baseCtx({
      box: { w: 1200, h: 60, t: 1 }, now: 0,
      rows: [{ payload: { sym: 'A', chg: '+1%' }, pushed_at: 0 }],
      config: { feed: 'f-wide', title_path: 'sym', body_path: 'chg', ticker: { speed: 40 } },
    }), 0)
    const xs = calls.map((c) => c.x)
    expect(Math.max(...xs)).toBeGreaterThan(1000)
  })

  it('keeps its place on screen when a push rewrites the rows', () => {
    _resetTickerAnchors()
    const draw = (now: number, rowSet: unknown) => {
      const { g, calls } = recorder()
      ticker.draw(g, baseCtx({ now, rows: rowSet, config: { feed: 'f-quotes', title_path: 'sym', body_path: 'chg', ticker: { speed: 40 } } }), 0)
      return calls[0].x
    }
    draw(NOW, rows)
    const before = draw(NOW + 4_000, rows)
    // Same instant, but the feed just replaced its rows with wider text.
    const after = draw(NOW + 4_000, [
      { payload: { sym: 'AAPL', chg: '+12.25%' }, pushed_at: NOW },
      { payload: { sym: 'MSFT', chg: '-10.80%' }, pushed_at: NOW },
    ])
    expect(after).toBeCloseTo(before, 5)
  })
})
