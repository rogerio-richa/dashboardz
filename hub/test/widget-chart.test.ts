import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'
// @ts-expect-error plain JS module without types
import plot, { drawIcon, normalizeChart } from '../static/device/widgets/chart/plot.mjs'
// @ts-expect-error plain JS module without types
import { CHART_ICONS, axisLabel } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { formatAge } from '../static/device/widgets/text-fit.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'
// @ts-expect-error plain JS module without types
import { registered } from '../static/device/widgets/index.mjs'

/**
 * `chart` — the twelfth and final design migrated off device.js's DOM branches
 * (`widgets/chart/plot.mjs`).
 *
 * Recorder-based like every other design suite: no canvas and no DOM, just a `g` that writes down
 * what it was asked to paint, so a claim about the drawing is checked against the drawing rather
 * than against a comment.
 *
 * This file ALSO absorbs `chart-icons.test.ts`, which tested `charts.mjs`'s `drawIcon` directly.
 * Two of its three parts moved here and one was retired deliberately:
 *   - the twelve-icon check is behavioural. A regex for `case 'name':` in the source cannot tell a
 *     deleted branch from one that still exists but draws the wrong
 *     shape. It is now behavioural: every name must produce a path, and every non-`circle` name must
 *     produce a DIFFERENT path from `circle` — which is exactly what a deleted `case` falls through
 *     to.
 *   - the `heart`/`drop` winding recorder tests retain the same behavior. They are the one thing
 *     about those two icons that is algebraic rather than mechanical.
 *   - the "does not use bezierCurveTo/quadraticCurveTo/fillRect" source scan is RETIRED, not lost:
 *     `plot.mjs` lives under `static/device/widgets/`, which `portable-subset.test.ts` walks in full,
 *     rejecting ANY `g.<op>` outside the 26-op ALLOWED set. All three banned names are outside it,
 *     so that guard is now a strict superset of the retired one and applies to every future design
 *     rather than to one hand-listed file.
 */

type Text = {
  text: string; x: number; y: number
  fill: string; font: string; align: string; baseline: string; alpha: number
}
type Op = {
  op: string; args: number[]
  fill: string; stroke: string; lineWidth: number; alpha: number
}

function recorder() {
  const texts: Text[] = []
  const ops: Op[] = []
  const g = {
    font: '', fillStyle: '', strokeStyle: '', textAlign: '', textBaseline: '',
    lineWidth: 1, globalAlpha: 1,
    fillText: (text: string, x: number, y: number) => texts.push({
      text, x, y,
      fill: g.fillStyle, font: g.font, align: g.textAlign, baseline: g.textBaseline, alpha: g.globalAlpha,
    }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => push('beginPath'),
    closePath: () => push('closePath'),
    moveTo: (...args: number[]) => push('moveTo', args),
    lineTo: (...args: number[]) => push('lineTo', args),
    rect: (...args: number[]) => push('rect', args),
    arc: (...args: number[]) => push('arc', args),
    fill: () => push('fill'),
    stroke: () => push('stroke'),
  }
  function push(op: string, args: number[] = []) {
    ops.push({ op, args, fill: g.fillStyle, stroke: g.strokeStyle, lineWidth: g.lineWidth, alpha: g.globalAlpha })
  }
  return { g, texts, ops }
}

const RAMP = ['#aa0000', '#00bb00', '#0000cc', '#dddd00']
const TOKENS = { ink: '#111111', dim: '#888888' }
const NOW = 1_775_000_000_000

/** Rows as the wire delivers them: newest first, `{ payload, pushed_at }`. */
const rows = (...points: [number, number][]) =>
  points.map(([pushed_at, v]) => ({ payload: { v }, pushed_at }))

const series = (feed: string, entryRows: unknown[] = [], missing = false) => ({ feed, rows: entryRows, missing })

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: TOKENS,
  config: { style: 'line', series: [{ feed: 'a', y_path: 'v', icon: 'circle', label: 'A' }] },
  data: null,
  rows: null,
  alerts: [],
  // What `paintWidgets` genuinely hands a chart: `null`, because a chart binds PER SERIES and has
  // no `config.feed`. On that channel `null` means NOT APPLICABLE — the loud state is
  // `ctx.feed.missing`, which a chart never sees. Present in every ctx this suite builds so the
  // draw tests below are exercising the real value rather than an absent key.
  feed: null,
  series: [series('a', rows([NOW - 2000, 1], [NOW - 1000, 2]))],
  ramp: RAMP,
  box: { w: 300, h: 200, t: 1 },
  now: NOW,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

const drawWith = (overrides: Record<string, unknown> = {}) => {
  const r = recorder()
  plot.draw(r.g, baseCtx(overrides), 0)
  return r
}

/** The geometry `draw` derives for a 300x200 cell at t=1, scale 1 — restated so a test that cares
 *  about a coordinate says which one and why, rather than hiding a magic number. */
const AXIS_FONT = 12
const LEGEND_H = Math.round(12 * 1.8)      // 22
const MARGIN_LEFT = Math.round(12 * 3.5)   // 42
const MARGIN_BOTTOM = Math.round(12 * 1.4) // 17
const PLOT_X = MARGIN_LEFT
const PLOT_Y = 6
const PLOT_H = 200 - 6 - MARGIN_BOTTOM - LEGEND_H // 155

describe('chart design — meta', () => {
  it('registers as chart/plot', () => {
    expect(plot.meta.widget).toBe('chart')
    expect(plot.meta.id).toBe('plot')
  })

  it('is the design a chart cell resolves to, so device.js needs no chart branch', () => {
    // `plot` FIRST: registration order is what makes it the default, so every saved chart cell that
    // names no design keeps drawing exactly as it did before `candles` existed.
    expect(registered('chart').map((d: { meta: { id: string } }) => d.meta.id)).toEqual(['plot', 'candles'])
  })

  it('declares `style` matching chartConfig\'s accepted set', () => {
    expect(plot.meta.options.style).toEqual({
      type: 'select', label: 'Style', default: 'line', choices: ['line', 'bar'],
    })
  })

  /**
   * `series[]` as a declared repeating group. It was the last knob on this design that
   * `meta.options` could not express, and it cost the admin a 74-line hand-written editor
   * (`ChartSeriesEditor.tsx`, deleted) that owned two rules nothing tied to the design:
   *
   *  - the feed is a BINDING. `type: 'feed'` says so, and the admin filters the picker by
   *    `bindings.mjs`'s modes for the host widget rather than by anything restated here — which is
   *    why this test asserts `feed`'s type and NOT a mode list.
   *  - an added row's icon must not collide. `unique` is that rule, and `screens/save.ts` is what
   *    refuses the collision (`chart series icons must be unique`).
   *
   * `choices` is CHART_ICONS itself, not a copy: the enum is already cross-checked byte-identical
   * against `hub/src/routes/admin.ts`'s, so a copy here would be a third place for it to drift.
   */
  it('declares series as a 1..4 list whose feed is a binding and whose icon is unique per row', () => {
    const series = plot.meta.options.series
    expect(series.type).toBe('list')
    expect([series.min, series.max]).toEqual([1, 4])
    expect(Object.keys(series.item)).toEqual(['feed', 'y_path', 'icon', 'label'])
    expect(series.item.feed.type).toBe('feed')
    expect(series.item.icon.choices).toBe(CHART_ICONS)
    expect(series.item.icon.unique).toBe(true)
    // Exactly the schema's `items.required` — `label` is the one optional key.
    expect(Object.entries(series.item).filter(([, f]: [string, any]) => f.required).map(([k]) => k))
      .toEqual(['feed', 'y_path', 'icon'])
  })

  it('carries the same suggested_ratio the widget definition advertises', () => {
    const definition = WIDGET_DEFINITIONS.find((d: { id: string }) => d.id === 'chart')
    expect(plot.meta.suggested_ratio).toBe(definition.suggested_ratio)
  })

  it('declares no series colours as tokens — that is ctx.ramp\'s job', () => {
    // A fixed name->colour vocabulary cannot express "however many colours the board declares", so
    // a `series1`/`series2`/... token set here would be the exact mistake `ctx.ramp` exists to
    // prevent. Only the chart's own chrome is tokenised.
    expect(Object.keys(plot.meta.tokens).sort()).toEqual(['dim', 'ink'])
  })
})

/**
 * `chartAllSeriesMissing`'s semantics, which are the one rule this migration was most able to lose:
 * the loud box ONLY when EVERY series is unresolvable.
 */
describe('normalizeChart — which state, and the value-feed question', () => {
  it('is missing when the config declares no series array at all (ctx.series === null)', () => {
    expect(normalizeChart(null, {}, NOW).state).toBe('missing')
  })

  it('is missing for a declared-but-empty series array', () => {
    expect(normalizeChart([], { series: [] }, NOW).state).toBe('missing')
  })

  it('is missing when EVERY configured series names a feed this device does not have', () => {
    const config = { series: [{ feed: 'gone', y_path: 'v' }, { feed: 'also_gone', y_path: 'v' }] }
    const n = normalizeChart([series('gone', [], true), series('also_gone', [], true)], config, NOW)
    expect(n.state).toBe('missing')
  })

  it('is NOT missing when even one series resolves — a partial chart draws what it has', () => {
    const config = { series: [{ feed: 'gone', y_path: 'v' }, { feed: 'a', y_path: 'v' }] }
    const n = normalizeChart(
      [series('gone', [], true), series('a', rows([NOW - 1000, 5]))],
      config, NOW,
    )
    expect(n.state).toBe('ready')
    // The dead series keeps its slot: its legend row still renders, and — because the slot survives
    // — the live series keeps ramp index 1 rather than sliding to 0 and changing colour.
    expect(n.legend.map((row: { label: string }) => row.label)).toEqual(['gone', 'a'])
    expect(n.series[0].points).toEqual([])
    expect(n.series[1].points).toHaveLength(1)
  })

  it('is empty, not missing, for a present feed with nothing in it', () => {
    const config = { series: [{ feed: 'a', y_path: 'v' }] }
    expect(normalizeChart([series('a', [])], config, NOW).state).toBe('empty')
  })

  /**
   * DECISION (this code): a series bound to a feed that EXISTS but is a VALUE feed arrives as
   * `{ missing: false, rows: [] }` — `ctx.series` has no third state for it and does not need one.
   * `chartAllSeriesMissing` has always tested membership of `Object.keys(feeds)` and has never
   * looked at `mode`, so this chart drew its frame plus `no data` before the migration and must
   * still. Giving `ctx.series` a "bound to the wrong kind of feed" state and shouting about it here
   * would be a behaviour CHANGE, not an honesty fix.
   */
  it('treats a value-feed series as PRESENT-and-empty, never as missing', () => {
    const config = { series: [{ feed: 'a_value_feed', y_path: 'v' }] }
    const n = normalizeChart([series('a_value_feed', [], false)], config, NOW)
    expect(n.state).toBe('empty')
    expect(n.state).not.toBe('missing')
  })

  it('is ready once a single point survives', () => {
    const config = { series: [{ feed: 'a', y_path: 'v' }] }
    const n = normalizeChart([series('a', rows([NOW, 3]))], config, NOW)
    expect(n.state).toBe('ready')
    expect(n.pointCount).toBe(1)
  })
})

describe('normalizeChart — points, window and bounds', () => {
  const config = (extra: Record<string, unknown> = {}) => ({
    series: [{ feed: 'a', y_path: 'v', icon: 'circle' }], style: 'line', ...extra,
  })

  it('clips rows older than window_s and keeps a row exactly AT the cutoff', () => {
    const n = normalizeChart(
      [series('a', rows([NOW - 5_000, 1], [NOW - 10_000, 2], [NOW - 10_001, 3]))],
      config({ window_s: 10 }), NOW,
    )
    // Oldest-first out of seriesPoints: the 10_001ms-old row is gone, the exactly-10s one stays.
    expect(n.series[0].points.map((p: { y: number }) => p.y)).toEqual([2, 1])
  })

  it('keeps everything when no window is configured', () => {
    const n = normalizeChart(
      [series('a', rows([NOW - 5_000, 1], [NOW - 10_001, 3]))],
      config(), NOW,
    )
    expect(n.series[0].points).toHaveLength(2)
  })

  it('skips a row whose y does not resolve to a finite number, never zeroing it', () => {
    const n = normalizeChart(
      [series('a', [
        { payload: { v: 4 }, pushed_at: NOW },
        { payload: { v: 'nope' }, pushed_at: NOW - 1 },
        { payload: {}, pushed_at: NOW - 2 },
      ])],
      config(), NOW,
    )
    expect(n.series[0].points.map((p: { y: number }) => p.y)).toEqual([4])
  })

  it('lets explicit y_min/y_max override the computed extent, independently per bound', () => {
    const points = [series('a', rows([NOW, 5], [NOW - 1000, 1]))]
    expect(normalizeChart(points, config({ y_min: -20, y_max: 20 }), NOW).bounds)
      .toMatchObject({ yMin: -20, yMax: 20 })
    // An explicit min with no max still lets the max come from the points.
    expect(normalizeChart(points, config({ y_min: -20 }), NOW).bounds)
      .toMatchObject({ yMin: -20, yMax: 5 })
    expect(normalizeChart(points, config({ y_max: 20 }), NOW).bounds)
      .toMatchObject({ yMin: 1, yMax: 20 })
  })

  it('labels a series by label, then feed id, then 1-based position', () => {
    const n = normalizeChart(
      [series('a'), series('b'), series('')],
      {
        series: [
          { feed: 'a', y_path: 'v', label: 'Battery' },
          { feed: 'b', y_path: 'v' },
          { feed: '', y_path: 'v' },
        ],
      },
      NOW,
    )
    expect(n.legend.map((row: { label: string }) => row.label)).toEqual(['Battery', 'b', 'series 3'])
  })

  it('survives a garbage clock by keeping every row rather than clipping them all away', () => {
    const n = normalizeChart(
      [series('a', rows([NOW, 1]))],
      config({ window_s: 10 }), Number.NaN,
    )
    expect(n.series[0].points).toHaveLength(1)
  })
})

describe('chart design — the three drawn states', () => {
  /**
   * THE FAILURE MODE `ctx.feed`'s ENCODING EXISTS TO PREVENT, pinned on the one shipped design that
   * would suffer it.
   *
   * A chart's `ctx.feed` is `null` on EVERY board it ever paints, correctly configured or not,
   * because it binds per series and has no `config.feed`. While the channel spelled its loud state
   * `null` too, the published contract read "`ctx.feed === null` — the feed is not there … this is
   * the loud state" — and a per-series design written from that sentence would paint "Feed missing"
   * over a board where every series resolves and every point is plotting.
   *
   * This chart is fully configured and fully resolvable, and its `ctx.feed` is `null`. If any future
   * edit teaches this design (or a design copied from it) to read that as a fault, the notice shows
   * up here instead of on an operator's wall.
   */
  it('draws the plot, never the loud notice, for a resolvable chart whose ctx.feed is null', () => {
    const r = drawWith({ feed: null })
    expect(r.texts.map((t) => t.text)).not.toContain('Feed missing')
    expect(r.texts.map((t) => t.text)).not.toContain('no data')
    expect(r.ops.filter((o) => o.op === 'stroke').length).toBeGreaterThan(0)
  })

  it('paints the shared loud notice, and nothing else, when every series is unresolvable', () => {
    const r = drawWith({
      config: { series: [{ feed: 'gone', y_path: 'v' }] },
      series: [series('gone', [], true)],
    })
    expect(r.texts.map((t) => t.text)).toContain('Feed missing')
    expect(r.texts.map((t) => t.text)).not.toContain('no data')
    // device.js replaced the whole cell with a div here — no canvas, so no axis frame either.
    expect(r.ops.filter((o) => o.op === 'stroke')).toHaveLength(0)
  })

  it('paints the frame, the legend and `no data` for a resolvable chart with no points', () => {
    const r = drawWith({
      config: { series: [{ feed: 'a', y_path: 'v', label: 'Battery' }] },
      series: [series('a', [])],
    })
    expect(r.texts.map((t) => t.text)).toContain('no data')
    // The legend survives the empty state — a series with nothing to plot still says what it is.
    expect(r.texts.map((t) => t.text)).toContain('Battery')
    // The axis frame: one moveTo + two lineTo, stroked once.
    expect(r.ops.filter((o) => o.op === 'stroke').length).toBeGreaterThan(0)
    expect(r.ops.find((o) => o.op === 'moveTo')?.args).toEqual([PLOT_X, PLOT_Y])
  })

  it('plots a line per series and marks it with that series\' icon', () => {
    const r = drawWith()
    const strokes = r.ops.filter((o) => o.op === 'stroke')
    // One stroke for the axis frame (lineWidth 1) plus one for the series polyline (lineWidth 2).
    expect(strokes.map((s) => s.lineWidth)).toEqual([1, 2])
    const line = r.ops.filter((o) => o.op === 'lineTo' && o.lineWidth === 2)
    expect(line).toHaveLength(1) // two points => one moveTo + one lineTo
    // The marker glyph for `circle` is an arc, painted in the series colour.
    expect(r.ops.filter((o) => o.op === 'arc' && o.fill === RAMP[0]).length).toBeGreaterThan(0)
  })

  it('draws bars, not a polyline, in style: bar', () => {
    const r = drawWith({
      config: { style: 'bar', series: [{ feed: 'a', y_path: 'v', icon: 'circle' }] },
    })
    const bars = r.ops.filter((o) => o.op === 'rect' && o.fill === RAMP[0])
    expect(bars).toHaveLength(2) // one per point
    // Every bar hangs from its value down to the x axis, never past it.
    for (const bar of bars) expect(bar.args[1] + bar.args[3]).toBeCloseTo(PLOT_Y + PLOT_H, 6)
    expect(r.ops.filter((o) => o.op === 'stroke' && o.lineWidth === 2)).toHaveLength(0)
  })

  it('never draws a bar with a negative height, even for a reading past y_max', () => {
    // clampPlotY's whole reason: an explicit y_max bounds the AXIS, not the data.
    const r = drawWith({
      config: { style: 'bar', series: [{ feed: 'a', y_path: 'v' }], y_min: 0, y_max: 1 },
      series: [series('a', rows([NOW, 999]))],
    })
    const bars = r.ops.filter((o) => o.op === 'rect' && o.fill === RAMP[0])
    expect(bars).toHaveLength(1)
    expect(bars[0].args[3]).toBeGreaterThanOrEqual(0)
    expect(bars[0].args[1]).toBeGreaterThanOrEqual(PLOT_Y)
  })
})

describe('chart design — colours come from ctx.ramp and cycle', () => {
  it('cycles ramp[i % ramp.length], so a 2-colour ramp paints 4 series a,b,a,b', () => {
    const ramp = ['#111111', '#222222']
    const config = {
      style: 'line',
      series: [
        { feed: 'a', y_path: 'v', icon: 'circle', label: 'A' },
        { feed: 'b', y_path: 'v', icon: 'square', label: 'B' },
        { feed: 'c', y_path: 'v', icon: 'triangle', label: 'C' },
        { feed: 'd', y_path: 'v', icon: 'diamond', label: 'D' },
      ],
    }
    const r = drawWith({
      config,
      ramp,
      series: ['a', 'b', 'c', 'd'].map((feed, i) => series(feed, rows([NOW, i + 1], [NOW - 1000, i]))),
    })
    // The polylines, in series order.
    const polylines = r.ops.filter((o) => o.op === 'stroke' && o.lineWidth === 2)
    expect(polylines.map((o) => o.stroke)).toEqual(['#111111', '#222222', '#111111', '#222222'])
    // ...and the legend labels are painted in the same cycled colours.
    const labels = r.texts.filter((t) => ['A', 'B', 'C', 'D'].includes(t.text))
    expect(labels.map((t) => t.fill)).toEqual(['#111111', '#222222', '#111111', '#222222'])
  })

  it('cycles the same way in bar style, where the fill rather than the stroke carries it', () => {
    // The cycling lives at THREE call sites — the legend, the polyline and the bar fill — and each
    // one has to be asserted separately, or a mutation to the one nothing looked at survives.
    const ramp = ['#111111', '#222222']
    const r = drawWith({
      config: {
        style: 'bar',
        // No `square`: its legend glyph is itself a `rect`, which would land in the same filter as
        // the bars below.
        series: [
          { feed: 'a', y_path: 'v', icon: 'circle', label: 'A' },
          { feed: 'b', y_path: 'v', icon: 'triangle', label: 'B' },
          { feed: 'c', y_path: 'v', icon: 'diamond', label: 'C' },
        ],
      },
      ramp,
      series: ['a', 'b', 'c'].map((feed, i) => series(feed, rows([NOW, i + 1]))),
    })
    const bars = r.ops.filter((o) => o.op === 'rect')
    expect(bars.map((o) => o.fill)).toEqual(['#111111', '#222222', '#111111'])
  })

  it('reads no colour for a series from meta.tokens — a token change cannot recolour a line', () => {
    const r = drawWith({ tokens: { ink: '#000000', dim: '#999999' } })
    const polyline = r.ops.find((o) => o.op === 'stroke' && o.lineWidth === 2)!
    expect(polyline.stroke).toBe(RAMP[0])
    expect(polyline.stroke).not.toBe('#999999')
  })
})

describe('chart design — axis labels, marks and the age chip', () => {
  it('formats the y bounds with axisLabel, whose precision comes from the SPAN', () => {
    const r = drawWith({
      config: { series: [{ feed: 'a', y_path: 'v' }] },
      series: [series('a', rows([NOW, 4.2], [NOW - 1000, 3.7]))],
    })
    const painted = r.texts.map((t) => t.text)
    // A 0.5V span needs its decimals; `displayValue`'s raw float would have printed 4.2 unchanged
    // but 4.199999999999999 for a computed bound, which is the failure axisLabel exists for.
    expect(painted).toContain(axisLabel(4.2, 0.5))
    expect(painted).toContain(axisLabel(3.7, 0.5))
    expect(painted).toContain('4.2')
    expect(painted).toContain('3.7')
  })

  it('right-aligns the y labels into the gutter and left/right-aligns the x times under the plot', () => {
    const r = drawWith()
    const yMax = r.texts.find((t) => t.align === 'right' && t.baseline === 'top' && t.x === PLOT_X - 4)
    expect(yMax).toBeDefined()
    const xStart = r.texts.find((t) => t.align === 'left' && t.x === PLOT_X && t.y === PLOT_Y + PLOT_H + 2)
    expect(xStart).toBeDefined()
  })

  it('thins the per-point markers on a dense series (markEvery)', () => {
    // 100 points, a full-size cell (t = 1) => CHART_MAX_MARKS.full = 24 => every 5th point.
    const dense = Array.from({ length: 100 }, (_, i): [number, number] => [NOW - i * 1000, i])
    const r = drawWith({ series: [series('a', rows(...dense))] })
    expect(r.ops.filter((o) => o.op === 'arc')).toHaveLength(20 + 1) // 20 marks + the legend glyph
  })

  it('draws the age chip ONLY when the host reports an age, at a fixed 10px', () => {
    // Asserted on the chip's SIZE, not its wording. The first draft looked for `10m ago` and was
    // proven vacuous by mutation: drawing the chip unconditionally prints `formatAge(null)`, which
    // is `now`, so a wording assertion sails straight past the bug. Nothing else on this chart is
    // painted at 10px — the axis text is 12px at t=1, scale 1.
    expect(drawWith({ age_ms: null }).texts.filter((t) => t.font === '10px system-ui')).toEqual([])
    const r = drawWith({ age_ms: 600_000 })
    const chip = r.texts.find((t) => t.text === formatAge(600_000))
    expect(chip).toBeDefined()
    // Fixed 10px regardless of `scale` — the `.age-chip` rule every other age caption follows.
    expect(chip!.font).toBe('10px system-ui')
    expect(chip!.fill).toBe(TOKENS.dim)
    expect(chip!.align).toBe('right')
  })

  it('keeps the age chip at 10px even when `scale` grows the rest of the text', () => {
    const r = drawWith({
      age_ms: 600_000,
      config: { series: [{ feed: 'a', y_path: 'v' }], scale: 2 },
    })
    expect(r.texts.find((t) => t.text === formatAge(600_000))!.font).toBe('10px system-ui')
    // ...while the axis text did scale.
    expect(r.texts.some((t) => t.font === `${AXIS_FONT * 2}px system-ui`)).toBe(true)
  })
})

describe('chart design — staleness dims the whole plot', () => {
  it('paints everything at half alpha when the host reports the chart stale, and restores it', () => {
    const r = drawWith({ stale: true, age_ms: 600_000 })
    expect(r.ops.length).toBeGreaterThan(0)
    expect(r.ops.every((o) => o.alpha === 0.5)).toBe(true)
    expect(r.texts.filter((t) => t.text !== '').every((t) => t.alpha === 0.5)).toBe(true)
    // Restored before returning: `g` is shared with whatever paints next.
    expect(r.g.globalAlpha).toBe(1)
  })

  it('restores alpha on the empty path too, not only the plotted one', () => {
    const r = drawWith({ stale: true, series: [series('a', [])] })
    expect(r.texts.some((t) => t.text === 'no data' && t.alpha === 0.5)).toBe(true)
    expect(r.g.globalAlpha).toBe(1)
  })

  it('paints at full alpha when nothing is stale', () => {
    const r = drawWith({ stale: false })
    expect(r.ops.every((o) => o.alpha === 1)).toBe(true)
  })
})

/**
 * The per-canvas `try`/`catch` `paintCharts` carried does NOT come across: `paintWidgets` already
 * catches a throwing design per cell, logs `widget paint failed for cell`, and skips it. A local
 * catch would duplicate that and swallow the log. Asserted behaviourally rather than by grepping the
 * source for `catch`, which this file's own prose would satisfy.
 */
describe('chart design — errors propagate to the host guard', () => {
  it('does not swallow a surface failure', () => {
    const r = recorder()
    r.g.stroke = () => { throw new Error('surface exploded') }
    expect(() => plot.draw(r.g, baseCtx(), 0)).toThrow('surface exploded')
  })
})

describe('drawIcon — twelve distinct glyphs', () => {
  const signature = (name: string) => {
    const r = recorder()
    drawIcon(r.g, name, 100, 100, 10)
    // `String`, not a numeric format: `moon` passes `arc`'s `anticlockwise` flag as a sixth
    // argument, so the signature has to survive a non-number.
    return r.ops.map((o) => `${o.op}(${o.args.map((a) => String(a)).join(',')})`).join('|')
  }

  it('draws all twelve names, and none of them silently falls through to `circle`', () => {
    expect(CHART_ICONS).toHaveLength(12)
    const circle = signature('circle')
    for (const name of CHART_ICONS) {
      const drawn = signature(name)
      expect(drawn, `${name} drew nothing`).not.toBe('')
      if (name !== 'circle') expect(drawn, `${name} fell through to the default branch`).not.toBe(circle)
    }
  })

  it('falls back to `circle` for a name nobody registered', () => {
    expect(signature('not-an-icon')).toBe(signature('circle'))
  })

  it('strokes the three open glyphs and fills the other nine', () => {
    for (const name of CHART_ICONS) {
      const r = recorder()
      drawIcon(r.g, name, 100, 100, 10)
      const finish = r.ops[r.ops.length - 1].op
      expect(finish, name).toBe(['cross', 'sun', 'flag'].includes(name) ? 'stroke' : 'fill')
    }
  })
})

/**
 * `heart` and `drop` are portable-subset rewrites of what were bezier/quadratic curves: a full-sweep
 * `arc` unioned with a triangle by NONZERO WINDING. That union only holds if the triangle winds the
 * same direction the arc does — flip an `anticlockwise` flag, reorder a triangle's vertices, or drop
 * a `closePath` before `fill` and the overlap cancels to a hole instead of filling solid. Nothing
 * else in the suite would notice.
 */
describe('drawIcon — the heart and drop winding union', () => {
  const fullPositiveSweep = (arc: Op) => {
    expect(arc.args[3]).toBe(0)
    expect(arc.args[4]).toBeCloseTo(Math.PI * 2)
    // The derivation depends on the DEFAULT sweep direction (`anticlockwise` absent/false).
    expect(arc.args[5]).toBeUndefined()
  }

  it('heart: two full-sweep lobes + a closed triangle wound right -> tip -> left', () => {
    const r = recorder()
    drawIcon(r.g, 'heart', 100, 100, 10)
    const arcs = r.ops.filter((o) => o.op === 'arc')
    expect(arcs).toHaveLength(2)
    arcs.forEach(fullPositiveSweep)

    expect(r.ops[r.ops.length - 1].op).toBe('fill')
    expect(r.ops[r.ops.length - 2].op).toBe('closePath')
    const [move, first, second] = r.ops.slice(-5, -2)
    expect([move.op, first.op, second.op]).toEqual(['moveTo', 'lineTo', 'lineTo'])
    // Right of centre, then the tip on the centre line, then left — the opposite of `drop`, because
    // heart's tip sits BELOW its lobes.
    expect(move.args[0]).toBeGreaterThan(100)
    expect(first.args[0]).toBe(100)
    expect(second.args[0]).toBeLessThan(100)
  })

  it('drop: one full-sweep base + a closed triangle wound left -> tip -> right', () => {
    const r = recorder()
    drawIcon(r.g, 'drop', 100, 100, 10)
    const arcs = r.ops.filter((o) => o.op === 'arc')
    expect(arcs).toHaveLength(1)
    arcs.forEach(fullPositiveSweep)

    expect(r.ops[r.ops.length - 1].op).toBe('fill')
    expect(r.ops[r.ops.length - 2].op).toBe('closePath')
    const [move, first, second] = r.ops.slice(-5, -2)
    expect([move.op, first.op, second.op]).toEqual(['moveTo', 'lineTo', 'lineTo'])
    expect(move.args[0]).toBeLessThan(100)
    expect(first.args[0]).toBe(100)
    expect(second.args[0]).toBeGreaterThan(100)
  })
})

/**
 * THE WIRING, in a real browser, because nothing above proves any of it is reachable.
 *
 * Every assertion so far calls `plot.draw` directly with a hand-built ctx. That is the right shape
 * for a design suite, and it is also exactly the blind spot this test protects: a design
 * can be perfect and still never be drawn, because `device.js` emits no canvas for it, the catalogue
 * never registers it, or `paintWidgets` hands it something the recorder tests never modelled. jsdom
 * cannot see any of that — it has no layout, so a cell measures 0x0 and the paint is a no-op.
 *
 * So: the REAL device page, over a real static server, driven through the same `__dashboardzHost`
 * seam the Android WebView uses, with a real STATE and a real DATA. Then the canvas's own pixels are
 * read back and counted. `#4a90d9` is `BUILTIN_BOARD.series[0]` — the first ramp colour — and the
 * legend's filled glyph is a solid block of it, so a non-trivial count is proof that the chart drew
 * a SERIES, in a ramp colour, on the cell's own canvas. Console errors are collected too, because
 * `paintWidgets` catches a throwing design and logs it: without this the whole design could throw on
 * every frame and every test above would still be green.
 */
const CHART_CELL = {
  rect: { x: 0, y: 0, w: 1, h: 1 },
  widget: 'chart',
  config: {
    style: 'line',
    series: [{ feed: 'f1', y_path: 'v', icon: 'circle', label: 'Load' }],
  },
}

const pixelCount = `
(() => {
  const canvas = document.querySelector('canvas.widget-canvas[data-cell="0"]')
  if (!canvas) return JSON.stringify({ error: 'no canvas emitted for the chart cell' })
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let painted = 0, series = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    painted++
    if (data[i] === 74 && data[i + 1] === 144 && data[i + 2] === 217) series++
  }
  return JSON.stringify({ painted, series, errors: window.__errs })
})()`

const maybe = hasBrowser() ? it : it.skip

describe('chart on the real device page', () => {
  let server: { url: string; close: () => void }
  beforeAll(async () => { server = await serveStatic(resolve('static')) })
  afterAll(() => server?.close())

  maybe('emits a canvas for a chart cell and paints a series onto it', async () => {
    const at = Date.now()
    const state = {
      type: 'STATE', rev: 1, server_time: at, alerts: [],
      device: { id: 'dev_test', name: 'test', orientation: 'landscape' },
      screen: { id: 'lay_test', name: 'test', orientation: 'landscape', grid: { cells: [CHART_CELL] } },
    }
    const data = {
      type: 'DATA', server_time: at, snapshot: true,
      feeds: {
        f1: {
          id: 'f1', mode: 'stream', stale_after_s: 3_600, pushed_at: at,
          rows: [
            { payload: { v: 6 }, pushed_at: at },
            { payload: { v: 9 }, pushed_at: at - 60_000 },
            { payload: { v: 4 }, pushed_at: at - 120_000 },
          ],
        },
      },
    }
    const deliver = (msg: object) => `__dashboardzDeliver(${JSON.stringify(JSON.stringify(msg))})`

    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 640, 360, `
        window.__errs = []
        window.addEventListener('error', (e) => window.__errs.push(String(e.message)))
        const realError = console.error
        console.error = (...args) => { window.__errs.push(args.map(String).join(' ')); realError(...args) }
        window.__dashboardzHost = { send() {}, ready() {} }
      `)
      await page.evaluate(deliver(state))
      await page.evaluate(deliver(data))
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')

      const result = JSON.parse(await page.evaluate<string>(pixelCount))
      expect(result.error).toBeUndefined()
      expect(result.errors, 'the design threw and paintWidgets logged it').toEqual([])
      expect(result.painted, 'nothing was painted onto the chart canvas').toBeGreaterThan(0)
      expect(result.series, 'nothing was painted in the first ramp colour').toBeGreaterThan(10)
    } finally {
      await page?.close()
    }
  }, 60_000)
})
