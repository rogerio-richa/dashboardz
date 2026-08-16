/**
 * `chart` / `candles` — OHLC bars, derived from the ticks the feed already carries.
 *
 * TWO SOURCES, AND ONLY ONE OF THEM IS REALLY A CANDLE CHART.
 *
 * `mode: 'ohlc'` — each ROW IS A BAR: `{t, o, h, l, c}` pushed by whatever holds the real data. This
 * is the correct one, and the default for anything a person would call a candle chart. Aggregation
 * belongs where the trades are: only the source knows the interval's true high and low, and only
 * the source can supply history the hub never held.
 *
 * `mode: 'ticks'` (the fallback) — buckets a plain value feed and derives the four: first tick
 * opens, last closes, extremes wick. It is an APPROXIMATION and should be described as one. The max
 * of the SAMPLES is not the interval's high — every extreme between samples is invisible — and a
 * stream keeps at most 500 rows, so the push interval hard-caps how far back it can see. A 4h bar
 * from a feed sampling every few seconds cannot exist: the data was never retained. Use it for a
 * quick shape of a value feed you already have, not to chart an instrument.
 *
 * ONE SERIES. `chart` allows up to four, and overlaid candle bodies are unreadable — two
 * instruments' bars at the same x are a smear, not a comparison. This design draws the FIRST
 * configured series and ignores the rest, which is a deliberate narrowing rather than an oversight:
 * a candle chart of two things is two charts.
 *
 * Everything shared with `plot` is imported, not restated — `chartConfig` for the series list and
 * the window, `seriesPoints` for the wire's newest-first rows flipped to oldest-first with the
 * window applied, `chartBounds` for the y extent, `axisLabel` for the gutter. This file owns the
 * bucketing and the bars, nothing else.
 */
import { chartConfig, seriesPoints, axisLabel, applyScale, FLOOR_LABEL } from '../../layout-core.mjs'
import { centredNotice, quietLine, paintText } from '../text-fit.mjs'

/** One minute, the interval every candle chart opens on. */
const DEFAULT_BUCKET_S = 60
/**
 * A day. The interval a chart is read at is the operator's call — 4h bars over a week is an
 * ordinary way to look at an instrument — and the real limit is not this number but how much
 * history the FEED retains: a stream caps at 500 rows, so the push interval decides how far back a
 * candle chart can see. A 4h bucket over a feed pushing every 5s is one bar, whatever this says.
 */
const MAX_BUCKET_S = 86_400
const MIN_BODY_PX = 1
const MODES = ['ticks', 'ohlc']

const meta = {
  id: 'candles',
  widget: 'chart',
  label: 'Candles',
  suggested_ratio: 2 / 1,
  tokens: {
    up: { type: 'color', default: '@info' },
    down: { type: 'color', default: '@critical' },
    // The wick is deliberately its own slot rather than a tint of the body: on a real chart it is
    // the quieter mark, and a theme that wants both the same can say so.
    wick: { type: 'color', default: '@dim' },
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    mode: { type: 'select', label: 'Source', choices: MODES, default: 'ticks', path: 'candles.mode' },
    bucket_s: { type: 'number', label: 'Candle interval (s) — ticks mode only', default: DEFAULT_BUCKET_S, path: 'candles.bucket_s' },
    wick: { type: 'boolean', label: 'Draw wicks', default: true, path: 'candles.wick' },
    rolling: { type: 'boolean', label: 'Rolling window (ends now)', default: true, path: 'candles.rolling' },
  },
  animations: { transition: [], persistent: [] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** This design's own settings, defaulted as the option declarations promise. */
export function candlesConfig(config) {
  // Named for the container it holds and aliased with `&&`/ternary — the shape knob-coverage's
  // analyser follows. See `stream/ticker.mjs` for why that matters.
  const c = config && typeof config === 'object' ? config : {}
  const candles = c.candles && typeof c.candles === 'object' ? c.candles : {}
  const raw = finite(candles.bucket_s) && candles.bucket_s > 0 ? candles.bucket_s : DEFAULT_BUCKET_S
  return {
    bucketS: Math.min(MAX_BUCKET_S, Math.max(1, Math.round(raw))),
    wick: typeof candles.wick === 'boolean' ? candles.wick : true,
    // Unknown values fall back to `ticks` rather than guessing: a typo must not silently switch a
    // board between an exact chart and an approximate one.
    mode: MODES.includes(candles.mode) ? candles.mode : 'ticks',
    // Rolling by DEFAULT: a wall chart is a window on the recent past, and the alternative — framing
    // whatever the feed happens to hold — silently rescales the x axis every time a bar arrives.
    rolling: typeof candles.rolling === 'boolean' ? candles.rolling : true,
  }
}

/**
 * Points → candles, oldest first.
 *
 * Buckets are anchored to ABSOLUTE time (`floor(t / bucketMs) * bucketMs`), not to the first point:
 * two devices showing the same feed then draw the same bars on the same boundaries, and a candle
 * covers the minute a human would call that minute. Buckets with no ticks are skipped rather than
 * carried forward as flat bars — a gap in the data is not a period of no movement, and drawing one
 * as the other is the kind of lie a chart must not tell.
 */
export function candlesFrom(points, bucketS) {
  const arr = Array.isArray(points) ? points : []
  const bucketMs = (finite(bucketS) && bucketS > 0 ? bucketS : DEFAULT_BUCKET_S) * 1000
  const byBucket = new Map()
  for (const p of arr) {
    if (!p || !finite(p.t) || !finite(p.y)) continue
    const key = Math.floor(p.t / bucketMs) * bucketMs
    const cell = byBucket.get(key)
    if (!cell) byBucket.set(key, { t: key, o: p.y, h: p.y, l: p.y, c: p.y })
    else {
      cell.c = p.y
      if (p.y > cell.h) cell.h = p.y
      if (p.y < cell.l) cell.l = p.y
    }
  }
  return [...byBucket.values()].sort((a, b) => a.t - b.t)
}

/**
 * Rows that ARE candles → bars, oldest first.
 *
 * Each row carries `{t, o, h, l, c}`; `t` is the BAR's own time, not the push time, which is what
 * lets a sender backfill history in one burst and lets a forming bar be re-pushed as it moves. Rows
 * arrive newest-first, so the first sighting of a bar time is the freshest and later ones are
 * ignored — a re-pushed candle updates in place instead of stacking duplicates.
 *
 * A row missing any of the four is DROPPED rather than half-drawn: a candle with no low is not a
 * candle, and inventing the missing side is exactly what this mode exists to avoid.
 */
export function candleRows(rows, windowS, hubNow) {
  const arr = Array.isArray(rows) ? rows : []
  const cutoff = finite(windowS) && finite(hubNow) ? hubNow - windowS * 1000 : null
  const seen = new Map()
  for (const row of arr) {
    const payload = row && typeof row === 'object' ? row.payload : null
    if (!payload || typeof payload !== 'object') continue
    const t = finite(payload.t) ? payload.t : (finite(row.pushed_at) ? row.pushed_at : null)
    if (t === null) continue
    if (cutoff !== null && t < cutoff) continue
    if (![payload.o, payload.h, payload.l, payload.c].every(finite)) continue
    if (seen.has(t)) continue
    seen.set(t, { t, o: payload.o, h: payload.h, l: payload.l, c: payload.c })
  }
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

/**
 * The interval these bars are on, read off the bars themselves.
 *
 * An OHLC feed's rows carry their own interval — nothing in the config knows whether they are 1m or
 * 4h — so the spacing is the MEDIAN gap between consecutive bars. Median, not mean or first-gap: a
 * single missing bar doubles one gap, and that must not double the drawn width of every bar.
 */
export function barSpacing(bars) {
  const ts = (Array.isArray(bars) ? bars : []).map((b) => b?.t).filter(finite).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) gaps.push(ts[i] - ts[i - 1])
  if (gaps.length === 0) return DEFAULT_BUCKET_S * 1000
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

/**
 * BOTH extents, decided rather than inferred.
 *
 * A chart is a claim about a range — these bars, over this span of time, between these prices — and
 * laying candles out by slot (evenly spaced, timestamps ignored) quietly drops the x axis: a missing
 * bar reads as no gap, and an hour of data looks the same as a week of it.
 *
 *   - y comes from the WICKS, because the extremes are the whole point of a candle, unless the cell
 *     names an explicit `y_min`/`y_max`, which always wins.
 *   - x comes from the ROLLING window when rolling is on: `[now - window_s, now]`, a fixed frame the
 *     bars march leftward through, which is what a wall chart wants. With rolling off it comes from
 *     the data's own span, plus one bar width so the newest bar has room to finish — the framing for
 *     a period that has ENDED rather than one still running.
 *
 * Never returns a zero-width span in either axis: a flat series and a single bar are both ordinary,
 * and dividing by that span is the next thing every caller does.
 */
export function candleBounds(bars, { rolling, windowS, now, barMs, yMin, yMax } = {}) {
  const arr = (Array.isArray(bars) ? bars : []).filter((b) => b && finite(b.t))
  const at = finite(now) ? now : 0
  const width = finite(barMs) && barMs > 0 ? barMs : DEFAULT_BUCKET_S * 1000

  let tMin, tMax
  if (rolling && finite(windowS) && windowS > 0) {
    tMax = at
    tMin = at - windowS * 1000
  } else if (arr.length > 0) {
    tMin = Math.min(...arr.map((b) => b.t))
    tMax = Math.max(...arr.map((b) => b.t)) + width
  } else {
    tMax = at
    tMin = at - width
  }
  if (!(tMax > tMin)) { tMin = tMax - width }

  const highs = arr.map((b) => b.h).filter(finite)
  const lows = arr.map((b) => b.l).filter(finite)
  let lo = finite(yMin) ? yMin : (lows.length ? Math.min(...lows) : 0)
  let hi = finite(yMax) ? yMax : (highs.length ? Math.max(...highs) : 1)
  if (!(hi > lo)) { lo -= 1; hi += 1 }
  return { tMin, tMax, yMin: lo, yMax: hi }
}

function draw(g, ctx, _elapsedMs) {
  const { box, tokens, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const cfg = chartConfig(config)
  const set = candlesConfig(config)
  const scale = cfg.scale
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  const entries = Array.isArray(ctx.series) ? ctx.series : []
  const first = cfg.series[0]
  if (!first) {
    centredNotice(g, 'No series', 'Bind this chart to a feed', box, tokens, pad, scale)
    return
  }
  if (entries[0]?.missing !== false) {
    centredNotice(g, 'Feed missing', 'Bind this chart to a stream feed', box, tokens, pad, scale)
    return
  }

  const at = finite(now) ? now : 0
  const wire = entries[0].rows ?? []
  const bars = set.mode === 'ohlc'
    ? candleRows(wire, cfg.windowS, at)
    : candlesFrom(seriesPoints(wire, first.yPath, cfg.windowS, at), set.bucketS)
  if (bars.length === 0) {
    quietLine(g, 'Nothing pushed yet', box, tokens, pad, scale)
    return
  }

  const barMs = barSpacing(bars)
  const bounds = candleBounds(bars, {
    rolling: set.rolling, windowS: cfg.windowS, now: at, barMs, yMin: cfg.yMin, yMax: cfg.yMax,
  })
  const labelPx = Math.max(FLOOR_LABEL, applyScale(11, scale, FLOOR_LABEL))
  const gutter = Math.max(28, g.measureText(axisLabel(bounds.yMax)).width + 8)
  const plot = {
    x: pad + gutter,
    y: pad,
    w: Math.max(1, box.w - pad * 2 - gutter),
    h: Math.max(1, box.h - pad * 2 - labelPx * 1.6),
  }

  // Axis gutter: the extremes only. A wall panel read from across the room does not want five.
  paintText(g, axisLabel(bounds.yMax), plot.x - 6, plot.y + labelPx * 0.5,
    { px: labelPx, floor: FLOOR_LABEL, maxWidth: gutter, color: tokens.dim, align: 'right', baseline: 'middle', weight: 400 })
  paintText(g, axisLabel(bounds.yMin), plot.x - 6, plot.y + plot.h - labelPx * 0.5,
    { px: labelPx, floor: FLOOR_LABEL, maxWidth: gutter, color: tokens.dim, align: 'right', baseline: 'middle', weight: 400 })

  const yAt = (value) => {
    const span = bounds.yMax - bounds.yMin || 1
    return plot.y + plot.h - ((value - bounds.yMin) / span) * plot.h
  }

  // Bars sit at their TIME, not in a slot: x is an axis here, so a missing bar leaves a hole and a
  // sparse week does not stretch to fill the same width as a busy hour. Width comes from the
  // interval the bars are actually on, so they read as adjacent without overlapping.
  const tSpan = bounds.tMax - bounds.tMin
  const xAt = (t) => plot.x + ((t - bounds.tMin) / tSpan) * plot.w
  const bodyW = Math.max(1, Math.min((barMs / tSpan) * plot.w * 0.7, plot.w))

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    // Centre the body in the interval the bar COVERS (t is its opening edge).
    const cx = xAt(bar.t + barMs / 2)
    if (cx < plot.x - bodyW || cx > plot.x + plot.w + bodyW) continue
    const rising = bar.c >= bar.o
    const colour = rising ? tokens.up : tokens.down

    if (set.wick && bar.h !== bar.l) {
      g.strokeStyle = tokens.wick
      g.lineWidth = Math.max(1, bodyW * 0.12)
      g.beginPath()
      g.moveTo(cx, yAt(bar.h))
      g.lineTo(cx, yAt(bar.l))
      g.stroke()
    }

    // A doji has no body to speak of, so it gets a hairline: a candle that draws nothing at all
    // reads as missing data, which is the one thing it is not.
    const top = yAt(Math.max(bar.o, bar.c))
    const height = Math.max(MIN_BODY_PX, Math.abs(yAt(bar.o) - yAt(bar.c)))
    g.fillStyle = colour
    g.beginPath()
    g.rect(cx - bodyW / 2, top, bodyW, height)
    g.fill()
  }

  // The label sits under the plot, naming what these bars are and how wide each one is — the two
  // things a candle chart is useless without.
  // In ticks mode the label says `~1m`: the tilde is not decoration, it is the design telling the
  // viewer these bars are sampled rather than traded. An OHLC feed's bars carry their own interval,
  // so naming one here would be this design asserting something it does not know.
  const interval = set.bucketS >= 3_600 ? `${Math.round(set.bucketS / 3_600)}h`
    : set.bucketS >= 60 ? `${Math.round(set.bucketS / 60)}m` : `${set.bucketS}s`
  const caption = set.mode === 'ohlc' ? '' : ` · ~${interval}`
  // TOP-left, not bottom-left: the bottom row belongs to the time axis, and both drawn there put the
  // series name straight through the x-min stamp (seen on a real board — "NVDA 4h" over "17/8").
  paintText(g, `${first.label || first.yPath || 'series'}${caption}`, plot.x + 2, plot.y + labelPx * 0.6,
    { px: labelPx, floor: FLOOR_LABEL, maxWidth: plot.w * 0.5, color: tokens.dim, align: 'left', baseline: 'middle', weight: 400 })

  // The x extent, stated. A time axis nobody can read is a decoration: these two labels are what
  // make "how far back does this go" answerable from across the room, and they are the same numbers
  // `candleBounds` laid the bars out against.
  const span = bounds.tMax - bounds.tMin
  const stamp = (t) => {
    const d = new Date(t)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    // Over a day of span the clock stops being the useful half of the timestamp.
    return span > 86_400_000 ? `${d.getDate()}/${d.getMonth() + 1}` : `${hh}:${mm}`
  }
  paintText(g, stamp(bounds.tMin), plot.x, plot.y + plot.h + labelPx * 0.9,
    { px: labelPx, floor: FLOOR_LABEL, maxWidth: plot.w * 0.3, color: tokens.dim, align: 'left', baseline: 'middle', weight: 400 })
  paintText(g, set.rolling ? 'now' : stamp(bounds.tMax), plot.x + plot.w, plot.y + plot.h + labelPx * 0.9,
    { px: labelPx, floor: FLOOR_LABEL, maxWidth: plot.w * 0.3, color: tokens.dim, align: 'right', baseline: 'middle', weight: 400 })
}

export default { meta, draw }
