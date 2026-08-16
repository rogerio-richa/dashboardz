import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { feedPlan, feedConfig, feedAlerts, stateAck, FEED_CARD, FEED_COUNTER, feedTextSizes, feedCardHeight } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { resolvePath, displayValue, axisLabel, applyScale, cardPlan, isStale, feedScalarSource, gaugeFraction, gaugeSeverity } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { streamListConfig, tableConfig } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { SCALE_MIN, SCALE_MAX, FLOOR_VALUE, FLOOR_LABEL, AGE_CHIP_PX, STREAM_RAMP, TABLE_RAMP, STREAM_CARD_TITLE, STREAM_CARD_BODY, TABLE_ROW, TABLE_HEADER, CELL_PAD } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { CHART_ICONS, CHART_MAX_MARKS, chartConfig, seriesPoints, chartBounds, markEvery, imageConfig } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { CHART_RAMP, CHART_ICON_FLOOR, BAR_MIN_W, BAR_MAX_W, chartAllSeriesMissing, chartIsStale, chartStaleAgeMs, barWidth, barOffset, clampPlotY } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { RECT_MIN, quantize, rectValid, rectsOverlap, safeRect, rectToPx } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { sizeT, rampAt, rampValues, fitSteps, clockTimePx, clockDatePx, chartMaxMarksAt, CLOCK_RAMP } from '../static/device/layout-core.mjs'
import { CHART_ICONS as ADMIN_CHART_ICONS } from '../src/screens/cellSchema.js'

describe('feedPlan (shared layout contract)', () => {
  it('everything fits: no counter row', () => {
    expect(feedPlan(3 * FEED_CARD, 3, true)).toEqual({ visible: 3, hidden: 0 })
  })
  it('overflow with counter: space is reserved BEFORE deciding how many fit', () => {
    // Cell of 3 cards' height minus nothing: 7 alerts. Without reservation 3 would fit; the
    // reserved counter row leaves floor((396-28)/132) = 2 … unless the cell is taller.
    // A cell that fits 3 of 7 alerts shows exactly "and 4 more" — build that cell:
    const h = 3 * FEED_CARD + FEED_COUNTER
    expect(feedPlan(h, 7, true)).toEqual({ visible: 3, hidden: 4 })
  })
  it('overflow with counter disabled: silent clip at fit', () => {
    expect(feedPlan(3 * FEED_CARD, 7, false)).toEqual({ visible: 3, hidden: 4 })
  })
  it('tiny cell never goes negative', () => {
    expect(feedPlan(10, 5, true)).toEqual({ visible: 0, hidden: 5 })
  })
})

describe('feedConfig / feedAlerts', () => {
  it('applies defaults and tolerates garbage', () => {
    // `scale` joined this shape with the existing data-widget contract (alert_feed honours scale like the data
    // widgets); the default keeps every pre-existing board rendering identically.
    expect(feedConfig({})).toEqual({ minSeverity: 'info', titleLines: 1, bodyLines: 2, counter: true, scale: 1 })
    expect(feedConfig(null)).toEqual({ minSeverity: 'info', titleLines: 1, bodyLines: 2, counter: true, scale: 1 })
    expect(feedConfig({ scale: 1.5 }).scale).toBe(1.5)
    expect(feedConfig({ scale: 'big' }).scale, 'garbage scale falls back to 1').toBe(1)
    expect(feedConfig({ min_severity: 'warn', clamp: { body_lines: 3 }, overflow: { counter: false } }))
      .toEqual({ minSeverity: 'warn', titleLines: 1, bodyLines: 3, counter: false, scale: 1 })
  })
  it('filters by min severity and sorts newest first; unknown severity counts as info', () => {
    const a = (id: string, severity: string, t: number) => ({ id, severity, updated_at: t })
    const alerts = [a('i', 'info', 1), a('w', 'warn', 2), a('c', 'critical', 3), a('x', 'mystery', 9)]
    expect(feedAlerts(alerts, 'warn').map((al: any) => al.id)).toEqual(['c', 'w'])
    expect(feedAlerts(alerts, 'info').map((al: any) => al.id)).toEqual(['x', 'c', 'w', 'i'])
  })
})

describe('stateAck after browser apply', () => {
  it('omits screen_id for the default layout, includes it otherwise', () => {
    expect(stateAck(7, null)).toEqual({ type: 'STATE_ACK', rev: 7 })
    expect(stateAck(8, 'lay_1')).toEqual({ type: 'STATE_ACK', rev: 8, screen_id: 'lay_1' })
  })

  /**
   * The STATE handler calls
   * `stateAck(rev, tabScreens[0]?.id ?? null, tabScreens.map(s => s.id))` — screen_id is tab 0,
   * never the active tab (`screenDef`). A legacy APK shell may re-encode the board's message and
   * `ignoreUnknownKeys` strips `screen_ids`, leaving only `screen_id` for the
   * hub to compare — and the hub's legacy compare is against tab 0 only (statePush.ts). If the
   * board sent the active tab instead, that legacy compare would fire a phantom
   * "rendering the wrong screen" warning any time the operator is looking at tab 2+.
   */
  it('multi-tab ack: screen_id is tab 0, not the active tab', () => {
    const tabScreens = [{ id: 'lay_0' }, { id: 'lay_1' }, { id: 'lay_2' }]
    const activeTabId = 'lay_2' // operator is looking at the third tab, not the first
    const ack = stateAck(9, tabScreens[0]?.id ?? null, tabScreens.map((s) => s.id))
    expect(ack).toEqual({ type: 'STATE_ACK', rev: 9, screen_id: 'lay_0', screen_ids: ['lay_0', 'lay_1', 'lay_2'] })
    expect(ack.screen_id).not.toBe(activeTabId)
  })
})

// ─── data widgets ────────────────────────────────────────────────────────────
// The vectors are shared by the browser suites, so this suite provides a stable corpus for the
// data-widget rules without duplicating the expected values.
describe('data-widget core (vector-driven)', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/data-widget-vectors.json', import.meta.url), 'utf8'))

  it('resolvePath vectors (JSON has no undefined: expect:null + expectMissing ⇔ undefined)', () => {
    // Both flavours must exist, or the null/missing distinction is untested.
    expect(vectors.resolvePath.some((v: any) => v.expectMissing === true)).toBe(true)
    expect(vectors.resolvePath.some((v: any) => v.expectMissing !== true && v.expect === null)).toBe(true)
    for (const v of vectors.resolvePath) {
      const got = resolvePath(v.payload, v.path)
      if (v.expectMissing) expect(got, v.name).toBeUndefined()
      else if (v.expect === null) expect(got, v.name).toBeNull()
      else expect(got, v.name).toEqual(v.expect)
    }
  })

  it('displayValue vectors', () => {
    for (const v of vectors.displayValue) expect(displayValue(v.value, v.format, v.decimals), v.name).toBe(v.expect)
  })

  /**
   * A chart's y-axis bound is DERIVED — it is the min/max of the points, so it carries whatever
   * float fell out of the arithmetic. `displayValue(v, 'raw', null)` prints that in full, and the
   * label is right-aligned into a gutter 3.5em wide, so a board showed `99288` — the clipped tail
   * of `74.38263382999288`. A plausible-looking number that is not the number.
   */
  it('axisLabel vectors', () => {
    for (const v of vectors.axisLabel) expect(axisLabel(v.value, v.span), v.name).toBe(v.expect)
  })

  it('applyScale vectors', () => {
    for (const v of vectors.applyScale) expect(applyScale(v.px, v.scale, v.floor), v.name).toBe(v.expect)
  })

  it('cardPlan vectors', () => {
    for (const v of vectors.cardPlan)
      expect(cardPlan(v.cellHeight, v.count, v.counterEnabled, v.cardHeight), v.name).toEqual({ visible: v.visible, hidden: v.hidden })
  })

  // `ageChip` itself is gone (retired: byte-identical to text-fit.mjs's `formatAge`, its last
  // production caller migrated to canvas with nothing left calling it) — its vectors moved to
  // formatAge's own suite, hub/test/text-fit.test.ts, rather than being dropped.

  it('gaugeFraction vectors', () => {
    for (const v of vectors.gaugeFraction) expect(gaugeFraction(v.v, v.min, v.max), v.name).toBe(v.expect)
  })

  it('gaugeSeverity vectors', () => {
    for (const v of vectors.gaugeSeverity) expect(gaugeSeverity(v.v, v.warn, v.crit), v.name).toBe(v.expect)
  })

  it('seriesPoints vectors (chart, chart behavior)', () => {
    for (const v of vectors.seriesPoints) expect(seriesPoints(v.rows, v.yPath, v.windowS, v.hubNow), v.name).toEqual(v.expect)
  })

  it('chartBounds vectors (chart, chart behavior)', () => {
    for (const v of vectors.chartBounds) expect(chartBounds(v.allPoints, v.yMin, v.yMax), v.name).toEqual(v.expect)
  })

  it('markEvery vectors (chart, chart behavior)', () => {
    for (const v of vectors.markEvery) expect(markEvery(v.pointCount, v.maxMarks), v.name).toBe(v.expect)
  })

  it('chartAllSeriesMissing vectors (chart behavior)', () => {
    for (const v of vectors.chartAllSeriesMissing) expect(chartAllSeriesMissing(v.series, v.availableFeedIds), v.name).toBe(v.expect)
  })

  it('chartIsStale vectors (chart behavior)', () => {
    for (const v of vectors.chartIsStale) expect(chartIsStale(v.wires, v.hubNow), v.name).toBe(v.expect)
  })

  it('chartStaleAgeMs vectors (chart behavior)', () => {
    for (const v of vectors.chartStaleAgeMs) {
      if (v.expect === null) expect(chartStaleAgeMs(v.wires, v.hubNow), v.name).toBeNull()
      else expect(chartStaleAgeMs(v.wires, v.hubNow), v.name).toBe(v.expect)
    }
  })

  it('barWidth vectors (chart behavior)', () => {
    for (const v of vectors.barWidth) expect(barWidth(v.plotWidthPx, v.pointCount, v.seriesCount), v.name).toBe(v.expect)
  })

  it('barOffset vectors (chart behavior)', () => {
    for (const v of vectors.barOffset) expect(barOffset(v.seriesIndex, v.seriesCount, v.barW), v.name).toBe(v.expect)
  })

  it('clampPlotY vectors (chart behavior)', () => {
    for (const v of vectors.clampPlotY) expect(clampPlotY(v.y, v.plotY, v.plotH), v.name).toBe(v.expect)
  })

  it('cardPlan is feedPlan generalized — alert_feed arithmetic stays byte-identical', () => {
    for (const h of [0, 10, 3 * FEED_CARD, 3 * FEED_CARD + FEED_COUNTER, 1000])
      for (const n of [0, 1, 3, 7, 40])
        for (const counter of [true, false])
          expect(cardPlan(h, n, counter, FEED_CARD), `${h}/${n}/${counter}`).toEqual(feedPlan(h, n, counter))
  })

})

describe('type ramps + sizing constants (browser contract tables)', () => {
  // `VALUE_RAMP`/`GAUGE_RAMP`/`TEXT_RAMP` were pinned here too, until `value_tile`, `gauge` and
  // `text_block` became canvas designs. A design has no discrete full/half/quadrant bucket to ramp
  // through — it sizes continuously off `box.w`/`box.h` — so all three tables lost their last
  // reader and were deleted. `FLOOR_VALUE`/`FLOOR_LABEL` below did NOT: the designs still import
  // them as their shrink-to-fit floors.
  it('exact contract values', () => {
    expect([SCALE_MIN, SCALE_MAX, FLOOR_VALUE, FLOOR_LABEL]).toEqual([0.5, 2, 16, 10])
    expect([STREAM_CARD_TITLE, STREAM_CARD_BODY, TABLE_ROW, TABLE_HEADER, CELL_PAD]).toEqual([48, 96, 44, 36, 16])
  })

  // AGE_CHIP_PX coincides with FLOOR_LABEL's value (both 10) but is a distinct constant: this one
  // the fixed, never-scaled age chip size, that one the floor SCALED text shrinks to. Pinned
  // separately so a future edit to either cannot silently move the other.
  it('AGE_CHIP_PX is its own constant, not a second name for FLOOR_LABEL', () => {
    expect(AGE_CHIP_PX).toBe(10)
  })

  // `scale` is a live knob on stream_list and table — admin accepted it and both normalizers
  // returned it, but row text did not consume it. These two ramps make the knob live; they have
  // the same plain-constant-table status as the four ramps above, so they are pinned here rather
  // than vectored (a raw table has no input/output relationship to vector).
  it('stream_list + table ramps (`scale` is live on both widgets)', () => {
    expect(STREAM_RAMP).toEqual({
      full: { title: 14, body: 12 }, half: { title: 13, body: 11 }, quadrant: { title: 12, body: 10 },
    })
    // Header and cell text use one size (13 at full): the header is distinguished by color/weight,
    // not size, so this is a scalar-per-fraction ramp like TEXT_RAMP.
    expect(TABLE_RAMP).toEqual({ full: 13, half: 12, quadrant: 11 })

    // FULL at scale 1 must reproduce EXACTLY the sizes that were hardcoded before these ramps
    // existed, or every already-saved board silently reflows the moment this ships.
    expect(applyScale(STREAM_RAMP.full.title, 1, FLOOR_LABEL)).toBe(14)
    expect(applyScale(STREAM_RAMP.full.body, 1, FLOOR_LABEL)).toBe(12)
    expect(applyScale(TABLE_RAMP.full, 1, FLOOR_LABEL)).toBe(13)

    // Both ramps floor at FLOOR_LABEL, never FLOOR_VALUE: these are dense list/table sizes living
    // in the same 10..14 band as the existing label/meta ramp entries. FLOOR_VALUE (16) would both
    // RAISE the unscaled default (14 → 16) and flatten scale 0.5 onto scale 1.0, i.e. the knob
    // would not shrink at all — the dead-knob case covered here.
    expect(applyScale(STREAM_RAMP.full.title, SCALE_MIN, FLOOR_LABEL)).toBe(FLOOR_LABEL)
    expect(applyScale(STREAM_RAMP.full.title, SCALE_MAX, FLOOR_LABEL)).toBe(28)
    expect(applyScale(TABLE_RAMP.quadrant, SCALE_MAX, FLOOR_LABEL)).toBe(22)
    // Every member stays at or above FLOOR_LABEL unscaled, so scale 1 is never itself floored.
    for (const f of ['full', 'half', 'quadrant'] as const)
      expect([STREAM_RAMP[f].title, STREAM_RAMP[f].body, TABLE_RAMP[f]].every((n: number) => n >= FLOOR_LABEL), f).toBe(true)
  })

  it('chart constants (chart behavior): 12 distinct icon names, max-marks per fraction', () => {
    expect(CHART_ICONS).toEqual(['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'heart', 'bolt', 'drop', 'sun', 'moon', 'flag'])
    expect(CHART_ICONS).toHaveLength(12)
    expect(new Set(CHART_ICONS).size).toBe(12)
    expect(CHART_MAX_MARKS).toEqual({ full: 24, half: 12, quadrant: 8 })
  })

  // The route schema's AJV icon enum duplicates this exact array (it
  // can't import a browser-loaded .mjs into TS/Node — see the comment on cellSchema.ts's own
  // CHART_ICONS export, which admin.ts's route schemas consume). THIS is the real cross-check
  // that keeps the two lists honest — a comment alone cannot catch drift, only a test that reads
  // both sources can.
  it('cellSchema.ts CHART_ICONS is byte-identical to layout-core.mjs CHART_ICONS (change both or neither)', () => {
    expect(ADMIN_CHART_ICONS).toEqual(CHART_ICONS)
  })

  it('chart scale ramp + floors + bar width clamp (chart behavior honors `scale`)', () => {
    expect(CHART_RAMP).toEqual({
      full: { axisFont: 12, legendFont: 12, icon: 6 }, half: { axisFont: 11, legendFont: 11, icon: 5 }, quadrant: { axisFont: 10, legendFont: 10, icon: 4 },
    })
    expect(CHART_ICON_FLOOR).toBe(3)
    expect([BAR_MIN_W, BAR_MAX_W]).toEqual([2, 10])
  })
})

describe('config normalizers tolerate garbage (feedConfig discipline)', () => {
  const streamDefaults = { feed: null, titlePath: 'title', bodyPath: null, titleLines: 1, bodyLines: 2, counter: true, scale: 1 }
  const tableDefaults = { feed: null, path: null, columns: [], headers: true, counter: true, scale: 1 }

  // `valueConfig`, `gaugeConfig` and `textConfig` had their own blocks here. All three normalized
  // config for DOM branches that no longer exist: `value_tile`, `gauge` and `text_block` are canvas
  // designs now, and each does its own normalizing (`normalizeValue`, `normalizeGauge`,
  // `normalizeText`) with its own suite. The three functions had no caller left outside this file,
  // so they were deleted and these blocks went with them. `streamListConfig`/`tableConfig` below
  // are still live — device.js calls both — as are `chartConfig`/`imageConfig`.

  it('streamListConfig defaults', () => {
    expect(streamListConfig(null)).toEqual(streamDefaults)
    expect(streamListConfig({ title_path: 9, body_path: 9, clamp: 'nope', overflow: 'nope' })).toEqual(streamDefaults)
    expect(streamListConfig({ feed: 'f', title_path: 'msg', body_path: 'detail', clamp: { body_lines: 3 }, overflow: { counter: false }, scale: 0.5 }))
      .toEqual({ feed: 'f', titlePath: 'msg', bodyPath: 'detail', titleLines: 1, bodyLines: 3, counter: false, scale: 0.5 })
  })

  it('tableConfig defaults', () => {
    expect(tableConfig(null)).toEqual(tableDefaults)
    expect(tableConfig({ columns: 'nope', headers: 'yes', path: '' })).toEqual(tableDefaults)
    expect(tableConfig({ feed: 'f', path: 'items', columns: [{ header: 'Name', path: 'n' }, { header: 'Qty', path: 'q', align: 'right' }, 'junk'], headers: false, overflow: { counter: false }, scale: 2 }))
      .toEqual({
        feed: 'f', path: 'items', headers: false, counter: false, scale: 2,
        columns: [{ header: 'Name', path: 'n', align: 'left' }, { header: 'Qty', path: 'q', align: 'right' }],
      })
  })

  it('scale is clamped to SCALE_MIN..SCALE_MAX by every normalizer; garbage falls back to 1', () => {
    for (const norm of [streamListConfig, tableConfig, chartConfig]) {
      expect(norm({ scale: 9 }).scale).toBe(SCALE_MAX)
      expect(norm({ scale: 0.01 }).scale).toBe(SCALE_MIN)
      expect(norm({ scale: 'big' }).scale).toBe(1)
    }
  })

  it('never throws on hostile shapes', () => {
    for (const bad of [undefined, null, 0, '', 'x', [], true, NaN, { columns: {} }, { clamp: 5 }, { thresholds: [] }, { overflow: [] }, { series: {} }])
      for (const norm of [streamListConfig, tableConfig, chartConfig, imageConfig])
        expect(() => norm(bad)).not.toThrow()
  })
})

describe('chartConfig / imageConfig tolerate garbage (chart behavior — chart + image widgets)', () => {
  const chartDefaults = { series: [], style: 'line', windowS: null, yMin: null, yMax: null, scale: 1 }
  const imageDefaults = { feed: null, fit: 'contain' }

  it('chartConfig defaults on missing/garbage config', () => {
    expect(chartConfig(null)).toEqual(chartDefaults)
    expect(chartConfig({})).toEqual(chartDefaults)
    expect(chartConfig({ series: 'nope', style: 'pie', window_s: 'soon', y_min: 'x', y_max: 'y', scale: 'big' })).toEqual(chartDefaults)
  })

  it('chartConfig normalizes a real series list, caps at 4, and falls back to the first icon on a bad one', () => {
    const cfg = chartConfig({
      series: [
        { feed: 'f1', y_path: 'cpu', icon: 'circle', label: 'CPU' },
        { feed: 'f2', y_path: 'mem', icon: 'square' },
        { feed: 'f3', y_path: 'a', icon: 'not-an-icon' },
        { feed: 'f4', y_path: 'b', icon: 'star' },
        { feed: 'f5', y_path: 'c', icon: 'heart' },
      ],
      style: 'bar', window_s: 60, y_min: 0, y_max: 100, scale: 1.5,
    })
    expect(cfg.series).toHaveLength(4)
    expect(cfg.series.map((s: any) => s.feed)).toEqual(['f1', 'f2', 'f3', 'f4'])
    expect(cfg.series[2].icon).toBe('circle')
    expect(cfg.series[0]).toEqual({ feed: 'f1', yPath: 'cpu', icon: 'circle', label: 'CPU' })
    expect(cfg.series[1].label).toBeNull()
    expect(cfg).toMatchObject({ style: 'bar', windowS: 60, yMin: 0, yMax: 100, scale: 1.5 })
  })

  it('chartConfig tolerates a non-integer window_s (falls back to null) but keeps any real integer as given', () => {
    expect(chartConfig({ window_s: 1.5 }).windowS).toBeNull()
    expect(chartConfig({ window_s: 5 }).windowS).toBe(5)
    expect(chartConfig({ window_s: -5 }).windowS).toBe(-5)
  })

  it('chartConfig drops non-object series entries rather than throwing', () => {
    expect(chartConfig({ series: [null, 'junk', 42, { feed: 'f1', y_path: 'x', icon: 'circle' }] }).series)
      .toEqual([{ feed: 'f1', yPath: 'x', icon: 'circle', label: null }])
  })

  it('imageConfig defaults and fit enum', () => {
    expect(imageConfig(null)).toEqual(imageDefaults)
    expect(imageConfig({})).toEqual(imageDefaults)
    expect(imageConfig({ fit: 'cover' })).toEqual({ feed: null, fit: 'cover' })
    expect(imageConfig({ feed: 'f1', fit: 'stretch' })).toEqual({ feed: 'f1', fit: 'contain' })
  })
})

describe('scalar source + staleness (contract: latest reading, then the stale window)', () => {
  it('feedScalarSource picks the payload / the newest row / undefined', () => {
    expect(feedScalarSource({ mode: 'value', payload: { cpu: 37.2 }, pushed_at: 1, stale_after_s: null })).toEqual({ cpu: 37.2 })
    expect(feedScalarSource({ mode: 'value', payload: null, pushed_at: null, stale_after_s: null })).toBeNull()
    // rows arrive newest first, so "the latest reading" is rows[0]
    expect(feedScalarSource({ mode: 'stream', rows: [{ payload: { t: 'new' }, pushed_at: 2 }, { payload: { t: 'old' }, pushed_at: 1 }] }))
      .toEqual({ t: 'new' })
    expect(feedScalarSource({ mode: 'stream', rows: [] })).toBeUndefined()
    expect(feedScalarSource({ mode: 'stream' })).toBeUndefined()
    expect(feedScalarSource({ mode: 'image', image_rev: 4 })).toBeUndefined()
    expect(feedScalarSource(null)).toBeUndefined()
    expect(feedScalarSource('nonsense')).toBeUndefined()
  })

  it('isStale is false when unconfigured or never pushed, true strictly past the window', () => {
    const at = 1_000_000
    expect(isStale({ pushed_at: at, stale_after_s: null }, at + 999_999)).toBe(false)
    expect(isStale({ pushed_at: null, stale_after_s: 120 }, at)).toBe(false)
    expect(isStale({ pushed_at: at, stale_after_s: 120 }, at + 119_999)).toBe(false)
    expect(isStale({ pushed_at: at, stale_after_s: 120 }, at + 120_000)).toBe(false)
    expect(isStale({ pushed_at: at, stale_after_s: 120 }, at + 120_001)).toBe(true)
    expect(isStale({ pushed_at: at, stale_after_s: 0 }, at + 1)).toBe(true)
    expect(isStale(null, at)).toBe(false)
    expect(isStale({}, at)).toBe(false)
  })
})

describe('scale for alert_feed — vector-driven', () => {
  // Clock's scale story is fully on the continuous-`t` clockTimePx/clockDatePx pair (see
  // 'clockTimePx vectors' / 'clockDatePx vectors' below) — there is no separate fraction-bucketed
  // clockTimeSize/clockDateSize path; renderGrid never computes a board-wide fraction.
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/data-widget-vectors.json', import.meta.url), 'utf8'))
  it('feedTextSizes vectors', () => {
    for (const v of vectors.feedTextSizes)
      expect(feedTextSizes(v.scale), v.name).toEqual({ title: v.title, body: v.body, meta: v.meta })
  })
  it('feedCardHeight vectors', () => {
    for (const v of vectors.feedCardHeight) expect(feedCardHeight(v.scale), v.name).toBe(v.expect)
  })
})

describe('rect geometry', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/data-widget-vectors.json', import.meta.url), 'utf8'))

  it('quantize rounds to 3dp', () => {
    expect(quantize(0.3333333)).toBe(0.333)
    expect(quantize(0.1 + 0.2)).toBe(0.3)
    expect(quantize(1)).toBe(1)
  })

  it('rectValid enforces the numeric contract', () => {
    expect(rectValid({ x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(rectValid({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toBe(true)
    expect(rectValid({ x: 0, y: 0, w: RECT_MIN, h: RECT_MIN })).toBe(true)
    expect(rectValid({ x: 0, y: 0, w: 0.049, h: 1 })).toBe(false)   // below RECT_MIN
    expect(rectValid({ x: 0.6, y: 0, w: 0.5, h: 1 })).toBe(false)   // x+w > 1
    expect(rectValid({ x: 0, y: 0.6, w: 1, h: 0.5 })).toBe(false)   // y+h > 1
    expect(rectValid({ x: 0.3333, y: 0, w: 0.5, h: 1 })).toBe(false) // not a 0.001 multiple
    expect(rectValid({ x: -0.1, y: 0, w: 0.5, h: 1 })).toBe(false)
    expect(rectValid({ x: 0, y: 0, w: 0.5 })).toBe(false)            // missing h
    expect(rectValid(null)).toBe(false)
  })

  it('rectsOverlap treats touching edges as disjoint', () => {
    const left = { x: 0, y: 0, w: 0.5, h: 1 }
    const right = { x: 0.5, y: 0, w: 0.5, h: 1 }
    expect(rectsOverlap(left, right)).toBe(false)
    expect(rectsOverlap(right, left)).toBe(false)
    expect(rectsOverlap(left, { x: 0.499, y: 0, w: 0.5, h: 1 })).toBe(true)
    expect(rectsOverlap(left, left)).toBe(true)
    // disjoint on Y only
    expect(rectsOverlap({ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 })).toBe(false)
  })

  it('safeRect coerces garbage without throwing', () => {
    expect(safeRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(safeRect(undefined)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(safeRect({ x: 'a', y: null, w: NaN, h: 0.5 })).toEqual({ x: 0, y: 0, w: 1, h: 0.5 })
    expect(safeRect({ x: 0.8, y: 0, w: 0.9, h: 1 })).toEqual({ x: 0.8, y: 0, w: 0.2, h: 1 })
    // out-of-range x is pulled back so the card stays ON screen, never pushed past the edge
    expect(safeRect({ x: 2, y: -1, w: 5, h: 5 })).toEqual({ x: 0.95, y: 0, w: 0.05, h: 1 })
  })

  it('safeRect always returns a rectValid result, even off-grid input (regression: quantizing w/h alone let an off-grid x push x+w past 1)', () => {
    // Neither 0.1234 nor 0.0635 is a multiple of 0.001 — a float-only clamp of w/h against an
    // un-snapped x/y can push x+w (or y+h) up to half a thousandth past 1, a card drawn past the
    // screen edge. safeRect must snap EVERY component onto the grid, x/y included, not just w/h.
    for (const x of [0.1234, 0.0635, 0.99999, 0.333333, 0.0001]) {
      for (const y of [0.1234, 0.0635, 0.99999, 0.333333, 0.0001]) {
        const r = safeRect({ x, y, w: 0.9, h: 0.9 })
        expect(rectValid(r), `x=${x} y=${y} -> ${JSON.stringify(r)}`).toBe(true)
      }
    }
  })

  it('rectToPx vectors', () => {
    for (const v of vectors.rectToPx) {
      expect(rectToPx(v.rect, v.screenW, v.screenH), v.name).toEqual(v.expect)
    }
  })
})

// ─── continuous size scalar ─────────────────────────────────────────────────
// Replaces cellFraction's full|half|quadrant buckets with sizeT(w,h), a continuous scalar the
// three existing ramp steps become ANCHORS on. This browser file and the vectors are the current
// source of truth. The Kotlin twin in core/Layout.kt was retired with the Compose board.

describe('continuous size scalar + ramp interpolation', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/data-widget-vectors.json', import.meta.url), 'utf8'))

  it('sizeT puts the four old templates exactly on the three anchors', () => {
    expect(sizeT(1, 1)).toBe(1)        // 1x1 -> full
    expect(sizeT(0.5, 1)).toBe(0.75)   // 2x1 -> half
    expect(sizeT(1, 0.5)).toBe(0.75)   // 1x2 -> half
    expect(sizeT(0.5, 0.5)).toBe(0.5)  // 2x2 -> quadrant
  })

  it('rampAt reproduces the anchors exactly and interpolates between them', () => {
    expect(rampAt(120, 72, 48, 1)).toBe(120)
    expect(rampAt(120, 72, 48, 0.75)).toBe(72)
    expect(rampAt(120, 72, 48, 0.5)).toBe(48)
    expect(rampAt(120, 72, 48, 0.875)).toBe(96)   // midpoint of half..full
    expect(rampAt(120, 72, 48, 0.625)).toBe(60)   // midpoint of quadrant..half
  })

  it('rampAt clamps outside the anchor range', () => {
    expect(rampAt(120, 72, 48, 0.2)).toBe(48)
    expect(rampAt(120, 72, 48, 0)).toBe(48)
    expect(rampAt(120, 72, 48, 1.5)).toBe(120)
  })

  // Both halves still covered after the tile ramps went: `TABLE_RAMP` is the surviving SCALAR ramp
  // (it was `TEXT_RAMP`/`VALUE_RAMP` here before those were deleted), `CLOCK_RAMP` the surviving
  // object ramp. `rampValues` itself is very much live — `stream/list.mjs`, `table/grid.mjs` and
  // `chart/plot.mjs` all call it. (It was `device.js` and `charts.mjs` before the canvas renderer moved
  // the last DOM-rendered widget onto the design contract; device.js reads no ramp at all now.)
  it('rampValues handles scalar and object ramps, per member', () => {
    expect(rampValues(TABLE_RAMP, 1)).toBe(13)
    expect(rampValues(TABLE_RAMP, 0.5)).toBe(11)
    expect(rampValues(STREAM_RAMP, 1)).toEqual({ title: 14, body: 12 })
    expect(rampValues(STREAM_RAMP, 0.5)).toEqual({ title: 12, body: 10 })
    expect(rampValues(CLOCK_RAMP, 0.75)).toEqual({ time: 72, date: 14 })
  })

  it('clockTimePx and clockDatePx apply scale on top of the interpolated size', () => {
    expect(clockTimePx(1, 1)).toBe(120)
    expect(clockTimePx(0.5, 1)).toBe(48)
    expect(clockTimePx(1, 2)).toBe(240)
    expect(clockTimePx(0.5, 0.5)).toBe(24)
    expect(clockDatePx(1, 1)).toBe(16)
    expect(clockTimePx(0.585, 1)).toBe(56) // the full-width clock strip: (1 + 0.17) / 2
  })

  it('fitSteps descends by 2 to the floor and always includes the floor', () => {
    expect(fitSteps(24, 16)).toEqual([24, 22, 20, 18, 16])
    expect(fitSteps(17, 16)).toEqual([17, 16])
    expect(fitSteps(16, 16)).toEqual([16])
    expect(fitSteps(10, 16)).toEqual([16])
  })

  it('chartMaxMarksAt interpolates the mark budget', () => {
    expect(chartMaxMarksAt(1)).toBe(24)
    expect(chartMaxMarksAt(0.75)).toBe(12)
    expect(chartMaxMarksAt(0.5)).toBe(8)
  })

  it('sizeT vectors', () => {
    for (const v of vectors.sizeT) expect(sizeT(v.w, v.h), v.name).toBe(v.expect)
  })

  it('rampAt vectors', () => {
    for (const v of vectors.rampAt) expect(rampAt(v.full, v.half, v.quadrant, v.t), v.name).toBeCloseTo(v.expect, 10)
  })

  it('fitSteps vectors', () => {
    for (const v of vectors.fitSteps) expect(fitSteps(v.start, v.floor), v.name).toEqual(v.expect)
  })

  // These pixel-size helpers are vector-driven like every other section here. They keep clock text
  // and date text sized from the cell dimensions while the tab bar uses its own layout.
  it('clockTimePx vectors', () => {
    for (const v of vectors.clockTimePx) expect(clockTimePx(v.t, v.scale), v.name).toBe(v.expect)
  })

  it('clockDatePx vectors', () => {
    for (const v of vectors.clockDatePx) expect(clockDatePx(v.t, v.scale), v.name).toBe(v.expect)
  })
})
