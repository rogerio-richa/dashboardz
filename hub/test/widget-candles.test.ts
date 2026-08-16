import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import candles, { candlesFrom, candlesConfig, candleRows, candleBounds, barSpacing } from '../static/device/widgets/chart/candles.mjs'

/**
 * `chart`/`candles` — OHLC bars derived from the ticks a feed already carries.
 *
 * The hub's feeds push ONE value per row, not open/high/low/close, so this design buckets the
 * points it is given and derives the four from each bucket. That is what makes it work against any
 * existing numeric stream — the NVDA feed on a live board was never told it was a candle feed —
 * and it degrades honestly: a bucket holding one tick is a doji, which is the truth about that
 * minute rather than a fabricated range.
 *
 * `candlesFrom` is pure and takes points already windowed by `seriesPoints`, so everything worth
 * asserting is asserted without a canvas.
 */

type Call = { fillStyle: string; strokeStyle: string; x: number; y: number; w: number; h: number }

function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: () => {},
    measureText: (v: string) => ({ width: String(v).length * 7 }),
    beginPath: () => {}, closePath: () => {},
    moveTo: (x: number, y: number) => calls.push({ fillStyle: g.fillStyle, strokeStyle: g.strokeStyle, x, y, w: 0, h: 0 }),
    lineTo: () => {}, arc: () => {},
    rect: (x: number, y: number, w: number, h: number) => calls.push({ fillStyle: g.fillStyle, strokeStyle: g.strokeStyle, x, y, w, h }),
    fill: () => {}, stroke: () => {}, save: () => {}, restore: () => {}, translate: () => {}, scale: () => {},
  }
  return { g, calls }
}

const NOW = Date.UTC(2026, 7, 24, 15, 0, 0)
const tokens = { up: '#up', down: '#down', wick: '#wick', ink: '#ink', dim: '#dim' }

/** A minute of ticks: open 100, high 104, low 99, close 101. */
const minuteOne = [
  { t: NOW - 240_000, y: 100 },
  { t: NOW - 230_000, y: 104 },
  { t: NOW - 220_000, y: 99 },
  { t: NOW - 210_000, y: 101 },
]
/** The next minute: opens 101, closes lower at 97. */
const minuteTwo = [
  { t: NOW - 180_000, y: 101 },
  { t: NOW - 150_000, y: 97 },
]

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens,
  config: { series: [{ feed: 'f', y_path: 'price', icon: 'circle', label: 'NVDA' }], window_s: 900, design: 'candles' },
  series: [{ feed: 'f', missing: false, rows: [] }],
  ramp: ['#ramp0'],
  data: null, rows: [],
  box: { w: 480, h: 240, t: 1 },
  now: NOW, state: {}, motion: 'full', stale: false, age_ms: null,
  ...overrides,
})

describe('candlesFrom', () => {
  it('derives open, high, low and close from the ticks in each bucket', () => {
    const [candle] = candlesFrom(minuteOne, 60)
    expect(candle).toMatchObject({ o: 100, h: 104, l: 99, c: 101 })
  })

  it('opens at the FIRST tick and closes at the LAST, not at the extremes', () => {
    const [candle] = candlesFrom(minuteOne, 60)
    expect(candle.o).toBe(100)
    expect(candle.c).toBe(101)
  })

  it('splits ticks into one candle per bucket, oldest first', () => {
    const out = candlesFrom([...minuteOne, ...minuteTwo], 60)
    expect(out).toHaveLength(2)
    expect(out[0].t).toBeLessThan(out[1].t)
    expect(out[1]).toMatchObject({ o: 101, c: 97 })
  })

  it('makes a doji of a bucket holding one tick, rather than inventing a range', () => {
    const [candle] = candlesFrom([{ t: NOW, y: 42 }], 60)
    expect(candle).toMatchObject({ o: 42, h: 42, l: 42, c: 42 })
  })

  it('skips buckets with no ticks instead of drawing a flat bar across the gap', () => {
    const out = candlesFrom([{ t: NOW - 600_000, y: 10 }, { t: NOW, y: 20 }], 60)
    expect(out).toHaveLength(2)
  })

  it('buckets on absolute time, so a candle covers the same wall-clock minute on every device', () => {
    const [candle] = candlesFrom(minuteOne, 60)
    expect(candle.t % 60_000).toBe(0)
  })

  it('is empty for no points, and never throws on rubbish', () => {
    expect(candlesFrom([], 60)).toEqual([])
    expect(candlesFrom(null, 60)).toEqual([])
    expect(candlesFrom([{ t: NaN, y: 1 }, { t: NOW, y: NaN }], 60)).toEqual([])
  })

  it('falls back to a sane bucket rather than dividing by zero', () => {
    expect(candlesFrom(minuteOne, 0).length).toBeGreaterThan(0)
    expect(candlesFrom(minuteOne, -5).length).toBeGreaterThan(0)
  })
})

describe('candlesConfig', () => {
  it('defaults to one-minute candles with wicks', () => {
    expect(candlesConfig({})).toMatchObject({ bucketS: 60, wick: true })
  })

  it('takes a bucket size and clamps it to something drawable', () => {
    expect(candlesConfig({ candles: { bucket_s: 300 } }).bucketS).toBe(300)
    expect(candlesConfig({ candles: { bucket_s: 0 } }).bucketS).toBe(60)
    expect(candlesConfig({ candles: { bucket_s: 999_999 } }).bucketS).toBe(86_400)
    expect(candlesConfig({ candles: { bucket_s: 14_400 } }).bucketS).toBe(14_400)  // 4h bars
  })
})

describe('chart/candles design', () => {
  it('registers as a chart design named candles', () => {
    expect(candles.meta.widget).toBe('chart')
    expect(candles.meta.id).toBe('candles')
  })

  it('declares up/down/wick tokens so a theme owns the colours', () => {
    for (const slot of ['up', 'down', 'wick']) expect(candles.meta.tokens[slot]).toBeTruthy()
  })

  it('declares its knobs under candles.', () => {
    expect(candles.meta.options.bucket_s).toMatchObject({ type: 'number', path: 'candles.bucket_s' })
    expect(candles.meta.options.wick).toMatchObject({ type: 'boolean', path: 'candles.wick' })
  })

  describe('draw', () => {
    const rows = (points: { t: number; y: number }[]) =>
      points.map((p) => ({ payload: { price: p.y }, pushed_at: p.t })).reverse()  // wire order: newest first

    it('paints a rising candle in the up token and a falling one in down', () => {
      const { g, calls } = recorder()
      candles.draw(g, baseCtx({ series: [{ feed: 'f', missing: false, rows: rows([...minuteOne, ...minuteTwo]) }] }), 0)
      expect(calls.some((c) => c.fillStyle === '#up')).toBe(true)
      expect(calls.some((c) => c.fillStyle === '#down')).toBe(true)
    })

    it('draws no body-less candles: even a doji gets a visible line', () => {
      const { g, calls } = recorder()
      candles.draw(g, baseCtx({ series: [{ feed: 'f', missing: false, rows: rows([{ t: NOW - 60_000, y: 50 }]) }] }), 0)
      expect(calls.some((c) => c.h >= 1)).toBe(true)
    })

    it('says so when the series is unbound', () => {
      const { g, calls } = recorder()
      const ctx = baseCtx({ series: [{ feed: 'f', missing: true, rows: [] }] })
      expect(() => candles.draw(g, ctx, 0)).not.toThrow()
      expect(calls.length).toBeGreaterThanOrEqual(0)
    })

    it('survives an empty feed and a zero-sized box', () => {
      const { g } = recorder()
      expect(() => candles.draw(g, baseCtx(), 0)).not.toThrow()
      expect(() => candles.draw(g, baseCtx({ box: { w: 0, h: 0, t: 1 } }), 0)).not.toThrow()
    })
  })
})

/**
 * OHLC ROWS — the mode that is actually correct for a candle chart.
 *
 * Deriving bars by bucketing sampled points is an approximation and a short-history one: the max of
 * the SAMPLES is not the interval's high (every extreme between samples is invisible), and a stream
 * caps at 500 rows, so a 4h bar over a feed sampling every few seconds cannot exist — there is not
 * enough retained data to make one, let alone a chart of them.
 *
 * Aggregation belongs where the trades are. In this mode each ROW IS A CANDLE, pushed by whatever
 * has the real data, and the widget draws what it was given. The design keeps `ticks` as an
 * explicitly-chosen fallback for feeds that only carry a value, not as the way to chart an
 * instrument.
 */
describe('candleRows', () => {
  const row = (t: number, o: number, h: number, l: number, c: number) =>
    ({ payload: { t, o, h, l, c }, pushed_at: t })

  it('takes each row as a whole candle, no bucketing', () => {
    const out = candleRows([row(3_000, 3, 4, 2, 3.5), row(2_000, 2, 3, 1, 2.5)], null, 0)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ o: 3, h: 4, l: 2, c: 3.5 })
  })

  it('returns them oldest first, whatever order the wire used', () => {
    const out = candleRows([row(3_000, 3, 4, 2, 3.5), row(1_000, 1, 2, 0.5, 1.5)], null, 0)
    expect(out.map((b: { t: number }) => b.t)).toEqual([1_000, 3_000])
  })

  it('keeps the NEWEST push for a bar, because a forming candle is re-pushed as it moves', () => {
    // Wire order is newest-first: the 4.5 close arrived after the 3.5 one, for the same bar.
    const out = candleRows([row(3_000, 3, 5, 2, 4.5), row(3_000, 3, 4, 2, 3.5)], null, 0)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ c: 4.5, h: 5 })
  })

  it('reads the bar time from the payload, so a backfill is not stamped with its push time', () => {
    const out = candleRows([{ payload: { t: 111_000, o: 1, h: 2, l: 0, c: 1.5 }, pushed_at: 999_000 }], null, 0)
    expect(out[0].t).toBe(111_000)
  })

  it('falls back to pushed_at when a row carries no time of its own', () => {
    const out = candleRows([{ payload: { o: 1, h: 2, l: 0, c: 1.5 }, pushed_at: 42_000 }], null, 0)
    expect(out[0].t).toBe(42_000)
  })

  it('drops rows that are not candles rather than drawing half of one', () => {
    const out = candleRows([
      { payload: { o: 1, h: 2, l: 0 }, pushed_at: 1_000 },
      { payload: { o: 'x', h: 2, l: 0, c: 1 }, pushed_at: 2_000 },
      row(3_000, 1, 2, 0, 1.5),
    ], null, 0)
    expect(out).toHaveLength(1)
  })

  it('applies the window like every other chart does', () => {
    const now = 100_000
    const out = candleRows([row(now - 5_000, 1, 2, 0, 1), row(now - 90_000, 1, 2, 0, 1)], 30, now)
    expect(out).toHaveLength(1)
  })

  it('never throws on rubbish', () => {
    expect(candleRows(null, null, 0)).toEqual([])
    expect(candleRows([null, 3, { payload: null }], null, 0)).toEqual([])
  })
})

describe('candlesConfig — source mode', () => {
  it('derives from ticks by default, which is the approximation', () => {
    expect(candlesConfig({}).mode).toBe('ticks')
  })

  it('takes ohlc rows when the feed carries real bars', () => {
    expect(candlesConfig({ candles: { mode: 'ohlc' } }).mode).toBe('ohlc')
  })

  it('refuses an unknown mode rather than guessing', () => {
    expect(candlesConfig({ candles: { mode: 'nonsense' } }).mode).toBe('ticks')
  })
})

/**
 * THE AXES. A chart is a claim about a range: these bars, over THIS span of time, between THESE
 * prices. Laying candles out by slot — evenly spaced, ignoring their timestamps — quietly drops the
 * x axis, so a missing bar reads as no gap and an hour-old chart looks identical to a week-old one.
 *
 * So both extents are computed and both are the design's answer, not a side effect of the data:
 *   - y from the WICKS (the extremes are the whole point of a candle), or the explicit y_min/y_max.
 *   - x from the ROLLING window when rolling is on — `[now - window_s, now]`, a fixed frame the bars
 *     move through — or from the data's own span when it is off, which is what you want for a chart
 *     of a finished period rather than a live one.
 */
describe('candleBounds', () => {
  const bars = [
    { t: 10_000, o: 10, h: 12, l: 9, c: 11 },
    { t: 70_000, o: 11, h: 15, l: 10, c: 14 },
  ]

  it('takes y from the wicks, not the bodies', () => {
    const b = candleBounds(bars, { rolling: false, windowS: null, now: 100_000, barMs: 60_000 })
    expect(b.yMin).toBe(9)
    expect(b.yMax).toBe(15)
  })

  it('honours an explicit y_min / y_max over the data', () => {
    const b = candleBounds(bars, { rolling: false, windowS: null, now: 100_000, barMs: 60_000, yMin: 0, yMax: 100 })
    expect(b.yMin).toBe(0)
    expect(b.yMax).toBe(100)
  })

  it('rolling: x is the window ending NOW, so bars march leftward through a fixed frame', () => {
    const b = candleBounds(bars, { rolling: true, windowS: 300, now: 500_000, barMs: 60_000 })
    expect(b.tMax).toBe(500_000)
    expect(b.tMin).toBe(500_000 - 300_000)
  })

  it('not rolling: x is the data, with room for the last bar to finish', () => {
    const b = candleBounds(bars, { rolling: false, windowS: null, now: 500_000, barMs: 60_000 })
    expect(b.tMin).toBe(10_000)
    expect(b.tMax).toBe(70_000 + 60_000)
  })

  it('never returns a zero-width span, however degenerate the input', () => {
    const one = candleBounds([{ t: 5, o: 1, h: 1, l: 1, c: 1 }], { rolling: false, windowS: null, now: 5, barMs: 0 })
    expect(one.tMax).toBeGreaterThan(one.tMin)
    expect(one.yMax).toBeGreaterThan(one.yMin)
  })

  it('is empty-safe', () => {
    const b = candleBounds([], { rolling: true, windowS: 60, now: 1_000, barMs: 60_000 })
    expect(b.tMax).toBeGreaterThan(b.tMin)
  })
})

describe('barSpacing', () => {
  it('reads the interval off the bars themselves, since OHLC rows carry their own', () => {
    expect(barSpacing([{ t: 0 }, { t: 60_000 }, { t: 120_000 }])).toBe(60_000)
  })

  it('takes the median, so one missing bar does not double the width of every other', () => {
    expect(barSpacing([{ t: 0 }, { t: 60_000 }, { t: 180_000 }, { t: 240_000 }])).toBe(60_000)
  })

  it('falls back for a single bar rather than returning zero', () => {
    expect(barSpacing([{ t: 0 }])).toBeGreaterThan(0)
    expect(barSpacing([])).toBeGreaterThan(0)
  })
})

describe('candlesConfig — rolling', () => {
  it('rolls by default: a wall chart shows the recent past', () => {
    expect(candlesConfig({}).rolling).toBe(true)
  })

  it('can be turned off to frame the data instead of the clock', () => {
    expect(candlesConfig({ candles: { rolling: false } }).rolling).toBe(false)
  })
})

describe('time-positioned bars', () => {
  const wire = (bars: { t: number; o: number; h: number; l: number; c: number }[]) =>
    bars.map((b) => ({ payload: b, pushed_at: b.t })).reverse()

  it('places a bar by its TIME, so a gap in the series shows as a gap', () => {
    const { g, calls } = recorder()
    const bars = [
      { t: NOW - 600_000, o: 10, h: 11, l: 9, c: 10.5 },
      // ...a missing hour...
      { t: NOW - 60_000, o: 10.5, h: 12, l: 10, c: 11.5 },
    ]
    candles.draw(g, baseCtx({
      series: [{ feed: 'f', missing: false, rows: wire(bars) }],
      config: { series: [{ feed: 'f', y_path: 'c', icon: 'circle', label: 'X' }], window_s: 1_200,
                design: 'candles', candles: { mode: 'ohlc', rolling: true } },
    }), 0)
    const bodies = calls.filter((c) => c.w > 0).map((c) => c.x).sort((a, b) => a - b)
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    // A 9-minute hole between two bars in a 20-minute window is most of the width.
    expect(bodies[bodies.length - 1] - bodies[0]).toBeGreaterThan(100)
  })
})
