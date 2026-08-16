/**
 * `chart` — up to four data series plotted over time, as lines or bars.
 *
 * This design uses the same renderer as the other widgets rather than a hand-written branch in
 * device.js: with `chart` on the
 * contract there is no widget-specific DOM left in `device.js` at all, and `widgetHtml` is now
 * nothing but "canvas, too small, or unsupported".
 *
 * It is also the least of a rewrite. `charts.mjs`'s `drawChart` already painted a `<canvas>`, and
 * its drawing is inside the portable subset — `heart`/`drop` use arcs and triangles instead of
 * beziers, and `fillRect` is rewritten
 * as `rect` + `fill`. What actually changed here is where the data and the colours come from:
 *   - the FEEDS, which `drawChart` reached into directly (`feeds[s.feed].rows`), now arrive as
 *     `ctx.series` — one positional entry per configured series;
 *   - the COLOURS, which `drawChart` resolved itself (theme ramp, else the palette's built-in four),
 *     now arrive as `ctx.ramp` — a non-empty array of any length, indexed `ramp[i % ramp.length]`;
 *   - the SIZE, which `drawChart` measured off the canvas element, is `ctx.box`.
 * Everything else — `axisLabel`'s gutter formatting, the legend's icon-and-label row, `window_s`
 * clipping, explicit `y_min`/`y_max` overriding the computed extent, both styles — is carried over
 * unchanged, and most of it was already pure and shared in `layout-core.mjs`.
 *
 * Structurally this follows `image/frame.mjs` and `alert/feed.mjs`: a pure `normalizeChart(series,
 * config, now)` making every read-path decision — which state, which points survive the window,
 * what the axis spans, what each legend row says — and a `draw` that only paints what normalize
 * decided. `drawIcon` is exported alongside it for the same reason `frame.mjs` exports `fitRect`:
 * the nonzero-winding union in the `heart` and `drop` branches is algebraic, not mechanical, and
 * asserting on it through a whole `draw` would bury the one thing worth asserting.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT `chartAllSeriesMissing` MEANS NOW, AND THE VALUE-FEED QUESTION IT ANSWERS BY NOT ASKING.
 *
 * The loud "Feed missing" notice appears ONLY when EVERY series is unresolvable. A chart with one
 * dead series and one live one draws the live one — that is the whole point of the rule, and of
 * `ctx.series` keeping a positional slot (and therefore a ramp colour and a legend row) for the
 * dead one instead of compacting it away.
 *
 * `ctx.series` marks `missing: true` for exactly one condition: the series' feed id is absent from
 * the device's feed map. A series bound to a feed that EXISTS but is a VALUE feed arrives as
 * `{ missing: false, rows: [] }` — indistinguishable, on this channel, from a present-but-empty
 * stream. That is not a hole this design papers over; it is the rule restated. `chartAllSeriesMissing`
 * has always tested `Object.keys(feeds).includes(s.feed)` and has never looked at `mode`, so a chart
 * bound solely to a value feed has always drawn the frame plus `no data`, never the loud box, and
 * the `missing` flag reproduces that test exactly. `ctx.rows` has a third state for this because a
 * SINGLE-feed design must tell "you bound the wrong kind of feed" from "nothing has arrived";
 * `ctx.series` needs none, because the only question asked of it here — "does this device have that
 * feed at all" — has the same answer either way. Adding a third state would be a behaviour change
 * (a value-bound chart would start shouting), not an honesty fix.
 *
 * `ctx.feed` IS NOT READ HERE, AND IS ALWAYS `null` FOR A CHART. That channel answers "does the
 * feed named by `config.feed` exist" for a SINGLE-feed cell; a chart has never had a `config.feed`,
 * so the host hands over `null`, which on that channel means NOT APPLICABLE — exactly what `null`
 * means on `ctx.rows` and `ctx.series` too. It is not a report that anything is wrong: the channel's
 * loud state is `ctx.feed.missing`, and a chart never sees it. Reading `null` as "this cell's feed
 * is gone" would paint a missing-feed notice over every correctly configured chart on every board —
 * the exact mistake the channel's `missing` flag exists to make unavailable (widgets/index.mjs's
 * `feedSignalFor`). The same question, per series, is already answered by
 * `ctx.series[i].missing`. The parallel is `ctx.stale`, which a chart also gets through a per-series
 * aggregate rather than the single-feed rule (`seriesStaleFor`, widgets/index.mjs).
 *
 * The rule itself is not restated here: `normalizeChart` CALLS `chartAllSeriesMissing`, rebuilding
 * the "ids this device has" list from the channel's own `missing` flags. That keeps the one
 * vectored statement of the rule in `layout-core.mjs` where the vectors can reach it, instead of a
 * second `every(...)` here that would be free to drift.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * STALENESS RIDES ON `ctx.stale`/`ctx.age_ms`, NOT ON A CHART-ONLY CHANNEL. A chart binds its feeds
 * per series, so the host resolves the chart's own aggregate before handing it over — `stale` is the
 * OR of every bound series' `isStale`, `age_ms` the age of the STALEST STALE series, `null` when
 * nothing is stale (`chartIsStale`/`chartStaleAgeMs`, and see `seriesStaleFor` in widgets/index.mjs).
 * Two consequences worth stating because they look like bugs otherwise:
 *   - The whole chart dims together at `globalAlpha` 0.5 — one stale input, one dimmed plot. That is
 *     `.stale { opacity: .5 }` applied to the whole `<canvas class="chart">`, which is what the DOM
 *     renderer did; dimming only the stale series would be a new visual language.
 *   - The age chip is STALE-GATED here and nowhere else on the board. `stream_list` and `image` show
 *     an age caption for any pushed feed, fresh or not; `drawChart` drew one only when something was
 *     stale, and `null` is how that arrives. Do not "fix" this into consistency — it is what the
 *     wall has always shown for a chart (contract).
 *
 * NO PER-CANVAS `try`/`catch`. `paintCharts` wrapped every `drawChart` call in one, because
 * `drawChart` ran in a loop inside `render()` where a single throw aborted the rest of the tick —
 * later chart cells never painted AND the takeover block after `renderGrid` never ran, so a critical
 * alert could go undisplayed. `paintWidgets` already isolates a throwing design per cell (it catches,
 * logs `widget paint failed for cell`, and returns — widgets/index.mjs). A local catch here would
 * duplicate a guarantee the host makes and, worse, swallow the log the host would otherwise emit.
 *
 * TEXT IS DRAWN WITH `g.fillText` DIRECTLY, not through `text-fit.mjs`'s `paintText`, and this is
 * the one design where that is right. Every other design places text in a box and lets it shrink to
 * fit; this one places text by MEASUREMENT — the legend advances by `measureText(label).width`, and
 * the axis labels are anchored to plot edges whose margins were derived from the font size. Routing
 * them through `paintText` would apply a shrink-and-ellipsise nothing here has ever done and would
 * change the legend's advance as a side effect (contract). The shared `centredNotice` IS
 * used for the missing-feed state, because that notice is a board-wide look and not this design's to
 * invent (same call `stream_list`/`table`/`image` make).
 *
 * `scale` moves TEXT ONLY (contract, and layout-core.mjs's own chart rule): `axisFont`,
 * `legendFont` and the icon radius pass through `applyScale`, and the margins are DERIVED from the
 * scaled font sizes so the plot area still grows to make room. The icon radius gets `CHART_ICON_FLOOR`
 * rather than `FLOOR_LABEL` — 10 is calibrated for text, and applied to a RADIUS it would force a
 * 20px glyph at scale 0.5.
 */
import {
  applyScale, axisLabel, FLOOR_LABEL, AGE_CHIP_PX, chartConfig, chartAllSeriesMissing, seriesPoints, chartBounds,
  markEvery, CHART_RAMP, CHART_ICON_FLOOR, barWidth, barOffset, clampPlotY, rampValues,
  chartMaxMarksAt, CHART_ICONS,
} from '../../layout-core.mjs'
import { centredNotice, formatAge } from '../text-fit.mjs'

const meta = {
  id: 'plot',
  widget: 'chart',
  label: 'Chart',
  // Matches definitions.mjs's own `chart` entry (suggested_ratio: 16/9) — same discipline every
  // other design follows for its widget type.
  suggested_ratio: 16 / 9,
  tokens: {
    // The chart's own CHROME, and nothing else: `dim` is the axis rule, the axis numbers, the
    // x-axis times, the `no data` line and the age chip — every one of which `drawChart` read from
    // the `--dim` CSS variable. `ink` is the missing-feed notice's headline (centredNotice paints
    // headline in `ink`, detail in `dim`).
    //
    // THE SERIES COLOURS ARE DELIBERATELY NOT TOKENS. `meta.tokens` is a fixed name→colour
    // vocabulary and a chart's series count is config-driven (1-4), so "however many colours the
    // board declares" cannot be expressed here at all — that is `ctx.ramp`, and it is why the
    // channel exists (see widgets/index.mjs's `rampFor`).
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    /**
     * The chart's data, declared. `series[]` is an array of objects, which `meta.options` could not
     * express until `type: 'list'` became available — a REPEATING GROUP whose `min`/`max` are the
     * save schema's own `minItems: 1, maxItems: 4` and whose `item` fields are exactly that
     * schema's `items.properties` (`hub/src/routes/admin.ts`'s `chart` branch,
     * `additionalProperties: false`). `required` marks its `items.required` three, so a row an
     * operator adds can never be missing one.
     *
     * `feed` is a FEED BINDING, not free text, and `type: 'feed'` says so: the admin draws the same
     * `DataSourcePicker` every other data widget gets, filtered by `bindings.mjs`'s declared modes
     * for the HOST widget — `chart: { modes: ['stream'], per_series: true }` — so a series still
     * offers stream feeds and nothing else, and this design never restates the rule.
     *
     * `unique` on `icon` is the one rule a plain select would have lost. `screens/save.ts` refuses
     * two series wearing the same glyph (`chart series icons must be unique`), so an added row must
     * start on one no other row is using; without it the second series a person adds is a 400 on a
     * key they never touched.
     *
     * `label` names ONE entry — the admin builds `Add series`, `Remove series` and each row's field
     * labels out of it.
     */
    series: {
      type: 'list',
      label: 'series',
      min: 1,
      max: 4,
      item: {
        feed: { type: 'feed', label: 'feed', required: true },
        y_path: { type: 'text', label: 'y_path', required: true },
        icon: { type: 'select', label: 'icon', choices: CHART_ICONS, unique: true, required: true },
        label: { type: 'text', label: 'label' },
      },
    },
    // The one flat, top-level, scalar knob. `window_s`/`y_min`/`y_max` are flat and scalar too but
    // are the chart's data window rather than a choice about how it looks, and stay hand-built;
    // `scale` is the shared knob no design declares. `choices` must equal `chartConfig`'s accepted
    // set exactly, which is `bar` or — for anything else at all, including a missing key — `line`.
    style: { type: 'select', label: 'Style', default: 'line', choices: ['line', 'bar'] },
  },
  animations: { transition: [], persistent: [] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * device.js's own `atTime`, restated — the x-axis end labels. Same `toLocaleTimeString` call
 * `clock/digital.mjs` and `calendar/agenda.mjs` already make, which is the settled precedent for a
 * design formatting a time: `Date` is arithmetic, not a browser API, and a recording surface has it.
 */
const atTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Every read-path decision, none of the painting.
 *
 * `series` is `ctx.series` verbatim: `null` when the config declares no series array, else ONE
 * POSITIONAL ENTRY per configured series (`{ feed, rows, missing }`), never compacted. Positional
 * is load-bearing twice over — entry `i` supplies the rows for `chartConfig(config).series[i]`, and
 * `i` is also the ramp index, so a dropped entry would silently recolour everything after it.
 *
 * Three states, exactly the three the DOM path drew:
 *   - `missing` — every series unresolvable (including "no series configured at all", which
 *     `chartAllSeriesMissing` reports for an empty list). device.js returned `feedMissingHtml()` and
 *     never emitted a canvas at all, so this state has no frame, no legend and no age chip.
 *   - `empty` — resolvable, but not one point survived across every series. Frame, age chip, legend,
 *     and a centred `no data`. This is where a series bound to a value feed lands, and where a
 *     `window_s` that has outrun its data lands.
 *   - `ready` — at least one point. Frame, chip, axis labels, plot, legend.
 *
 * A malformed `now` normalises to 0 rather than throwing, which matters here more than usual: `now`
 * is what `window_s` clips against, so a garbage clock must degrade to "keep everything" and not to
 * an empty chart.
 */
export function normalizeChart(series, config, now) {
  const cfg = chartConfig(config)
  const at = finite(now) ? now : 0
  // `Array.isArray` directly, with no try/catch around it. The wrapped
  // version copied from `stream/list.mjs`/`alert/feed.mjs` was dead defence HERE: the one input
  // `Array.isArray` can throw on is a REVOKED Proxy (it throws TypeError on one), and
  // `ctx.series` is built by `seriesForCell` out of freshly-allocated plain arrays — there is no
  // `Proxy` anywhere in `static/device/`, checked before deleting.
  const entries = Array.isArray(series) ? series : []
  const base = { style: cfg.style, scale: cfg.scale }

  // The channel's `missing` flags, put back into `chartAllSeriesMissing`'s own vocabulary (the ids
  // this device HAS) rather than re-deriving its `every(...)` here — see this file's docstring.
  // `entries[i]` can be absent if a host ever hands over a shorter array than the config declares;
  // absent reads as missing, which is the same direction a missing feed id resolves in.
  const available = cfg.series
    .filter((_s, i) => entries[i]?.missing === false)
    .map((s) => s.feed)
  if (chartAllSeriesMissing(cfg.series, available)) return { ...base, state: 'missing', series: [], legend: [] }

  // The legend row for a series is decided here, not at paint time: `label` falls back to the feed
  // id and then to a 1-based position, exactly as `drawLegend` chose it, and a series keeps its row
  // whether or not it has a single point to draw.
  const legend = cfg.series.map((s, i) => ({
    icon: s.icon,
    label: s.label || s.feed || `series ${i + 1}`,
  }))
  // `windowS` clipping and the "a y that is not a finite number is SKIPPED, never zeroed" rule both
  // live in `seriesPoints`, which also flips the wire's newest-first rows to oldest-first so the
  // line is drawn left to right.
  const points = cfg.series.map((s, i) => seriesPoints(entries[i]?.rows ?? [], s.yPath, cfg.windowS, at))
  const all = points.flat()
  const shaped = legend.map((row, i) => ({ ...row, points: points[i] }))

  if (all.length === 0) return { ...base, state: 'empty', series: shaped, legend }
  return {
    ...base,
    state: 'ready',
    series: shaped,
    legend,
    // Explicit `y_min`/`y_max` win over the computed extent, independently per bound, and a
    // degenerate span is padded by ±1 so nothing here can divide by zero — all of it inside
    // `chartBounds`, which is vectored.
    bounds: chartBounds(all, cfg.yMin, cfg.yMax),
    pointCount: all.length,
  }
}

/**
 * The twelve legend/marker glyphs, as ~10px canvas paths (interface contract). One switch, one case
 * per `CHART_ICONS` name — legible as simple filled/outlined geometry at monochrome e-ink scale
 * (rule: layout-core.mjs's chart section).
 *
 * `heart` and `drop` are the only non-obvious cases, and both are portable-subset rewrites of what
 * were bezier/quadratic curves: a full-circle `arc` (or two) unioned with a triangle by NONZERO
 * WINDING. That union only works if the triangle winds the same direction the arc does, which is why
 * each states its vertex order and why a test asserts it — reverse one and the overlap cancels to a
 * hole instead of filling solid.
 */
export function drawIcon(g, name, cx, cy, r = 5) {
  g.beginPath()
  switch (name) {
    case 'square': g.rect(cx - r, cy - r, r * 2, r * 2); break
    case 'triangle':
      g.moveTo(cx, cy - r); g.lineTo(cx + r, cy + r); g.lineTo(cx - r, cy + r); g.closePath()
      break
    case 'diamond':
      g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath()
      break
    case 'star': {
      const outer = r, inner = r * 0.45
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? outer : inner
        const ang = (Math.PI / 5) * i - Math.PI / 2
        const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py)
      }
      g.closePath()
      break
    }
    case 'cross':
      g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r)
      g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r)
      break
    case 'heart': {
      // Two full-circle lobes plus a triangle whose two slanted edges run down to the bottom tip,
      // filled together as one path. Not a pixel match for the old bezier — see this function's
      // docstring: "legible at e-ink scale" is the bar, not curve-identical geometry.
      // Vertex order matters: `arc`'s default sweep winds positive in raw (x,y), so the triangle
      // must be listed right→tip→left (not left→tip→right) to wind the same way — otherwise
      // nonzero fill cancels in the lobe/triangle overlap and punches holes in it.
      const lobeR = r * 0.5
      const lobeY = cy - r * 0.3
      const tipY = cy + r
      g.arc(cx - lobeR, lobeY, lobeR, 0, Math.PI * 2)
      g.arc(cx + lobeR, lobeY, lobeR, 0, Math.PI * 2)
      g.moveTo(cx + r, lobeY)
      g.lineTo(cx, tipY)
      g.lineTo(cx - r, lobeY)
      g.closePath()
      break
    }
    case 'bolt':
      g.moveTo(cx - r * 0.2, cy - r); g.lineTo(cx - r * 0.9, cy + r * 0.2); g.lineTo(cx - r * 0.1, cy + r * 0.2)
      g.lineTo(cx + r * 0.2, cy + r); g.lineTo(cx + r * 0.9, cy - r * 0.2); g.lineTo(cx + r * 0.1, cy - r * 0.2)
      g.closePath()
      break
    case 'drop': {
      // One full-circle arc for the round base plus a triangle running up to the tip, same
      // union-by-nonzero-winding technique as `heart` — but here the tip sits ABOVE the base, which
      // flips which vertex order winds positive, so left→tip→right is correct where heart needs the
      // reverse.
      const baseR = r * 0.55
      const baseY = cy + r * 0.35
      const tipY = cy - r
      g.arc(cx, baseY, baseR, 0, Math.PI * 2)
      g.moveTo(cx - baseR, baseY)
      g.lineTo(cx, tipY)
      g.lineTo(cx + baseR, baseY)
      g.closePath()
      break
    }
    case 'sun':
      g.arc(cx, cy, r * 0.55, 0, Math.PI * 2)
      for (let i = 0; i < 8; i++) {
        const ang = (Math.PI / 4) * i
        g.moveTo(cx + Math.cos(ang) * r * 0.8, cy + Math.sin(ang) * r * 0.8)
        g.lineTo(cx + Math.cos(ang) * r * 1.3, cy + Math.sin(ang) * r * 1.3)
      }
      break
    case 'moon':
      g.arc(cx, cy, r, 0.35 * Math.PI, 1.75 * Math.PI)
      g.arc(cx + r * 0.55, cy, r * 0.85, 1.75 * Math.PI, 0.35 * Math.PI, true)
      g.closePath()
      break
    case 'flag':
      g.moveTo(cx - r, cy - r); g.lineTo(cx - r, cy + r)
      g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy - r * 0.4); g.lineTo(cx - r, cy + r * 0.2)
      break
    case 'circle':
    default: g.arc(cx, cy, r, 0, Math.PI * 2)
  }
  // Three of the twelve are open strokes rather than closed areas — filling them would paint a blob.
  if (name === 'cross' || name === 'sun' || name === 'flag') { g.lineWidth = 1.5; g.stroke() } else g.fill()
}

/**
 * The legend row: each series' glyph and its label, laid out left to right and advancing by the
 * label's own measured width. Verbatim from `drawLegend`, including the 4px left inset, the 4px gap
 * between glyph and text and the 18px gap between entries.
 */
function drawLegend(g, legend, ramp, y, fontPx, iconR) {
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.font = `${fontPx}px system-ui`
  g.lineWidth = 1.5
  let x = 4
  legend.forEach((row, i) => {
    const color = ramp[i % ramp.length]
    g.fillStyle = color
    g.strokeStyle = color
    drawIcon(g, row.icon, x + iconR, y, iconR)
    // Re-assigned after drawIcon: the `cross`/`sun`/`flag` branch strokes rather than fills, and a
    // future edit to it must not be able to leave the label painted in the wrong colour.
    g.fillStyle = color
    g.fillText(row.label, x + iconR * 2 + 4, y)
    x += iconR * 2 + 4 + g.measureText(row.label).width + 18
  })
}

function draw(g, ctx) {
  const { box, tokens, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeChart(ctx.series, config, now)

  if (n.state === 'missing') {
    const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))
    // The same two-line notice `stream_list`, `table` and `image` paint for their own wholly
    // unresolvable binding — an authoring mistake a person has to see and fix. `n.scale`, like
    // `stream_list`: this widget has a `scale` knob and it moves text.
    centredNotice(g, 'Feed missing', 'Bind at least one series to a stream feed', box, tokens, pad, n.scale)
    return
  }

  const w = box.w
  const h = box.h
  // `ctx.ramp` is guaranteed non-empty and free of `undefined` by the host (widgets/index.mjs's
  // `rampFor`), so it is indexed unconditionally — re-checking it here would duplicate a host
  // guarantee exactly the way a local try/catch would (see this file's docstring).
  const ramp = ctx.ramp

  // CHART_RAMP is the base-size table, interpolated across the three sizeT anchors
  // (full/half/quadrant), same status as VALUE_RAMP/GAUGE_RAMP/TEXT_RAMP. Margins are DERIVED from
  // the scaled font sizes (documented ratios, not separately ramped) so the plot area grows to make
  // room as text grows — the same pattern as text_block's `lineHeight = ceil(size * 1.4)`.
  const sizes = rampValues(CHART_RAMP, box.t ?? 1)
  const axisFontPx = applyScale(sizes.axisFont, n.scale, FLOOR_LABEL)
  const legendFontPx = applyScale(sizes.legendFont, n.scale, FLOOR_LABEL)
  const iconR = applyScale(sizes.icon, n.scale, CHART_ICON_FLOOR)

  const LEGEND_H = Math.round(legendFontPx * 1.8)
  const MARGIN_LEFT = Math.round(axisFontPx * 3.5)
  const MARGIN_BOTTOM = Math.round(axisFontPx * 1.4)
  const MARGIN_TOP = 6, MARGIN_RIGHT = 8
  const plotX = MARGIN_LEFT, plotY = MARGIN_TOP
  const plotW = Math.max(1, w - MARGIN_LEFT - MARGIN_RIGHT)
  const plotH = Math.max(1, h - MARGIN_TOP - MARGIN_BOTTOM - LEGEND_H)

  // One stale series dims the WHOLE chart, exactly as `.stale { opacity: .5 }` on the canvas did.
  // Restored unconditionally at the end: `g` is shared with whatever paints next, and a leaked 0.5
  // would fade a neighbouring cell for reasons nothing in that cell could explain.
  g.globalAlpha = ctx.stale === true ? 0.5 : 1

  // The frame always draws, in every state that reaches here — a chart with nothing to plot shows
  // its axes and says so, rather than a blank cell (interface contract + rule).
  g.strokeStyle = tokens.dim
  g.fillStyle = tokens.dim
  g.font = `${axisFontPx}px system-ui`
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(plotX, plotY); g.lineTo(plotX, plotY + plotH); g.lineTo(plotX + plotW, plotY + plotH)
  g.stroke()

  const ageMs = finite(ctx.age_ms) ? ctx.age_ms : null
  if (ageMs !== null) {
    // The corner age caption stays a fixed AGE_CHIP_PX regardless of `scale`, matching the
    // `.age-chip` CSS rule every other age caption on the board is sized by — age chips are the
    // one ramp-table category this app has never scaled. Not `FLOOR_LABEL`: that constant is the
    // floor SCALED text shrinks to, a different meaning from this fixed size. `formatAge`
    // (text-fit.mjs) is what `drawChart` paints here.
    g.fillStyle = tokens.dim
    g.font = `${AGE_CHIP_PX}px system-ui`
    g.textAlign = 'right'
    g.textBaseline = 'top'
    g.fillText(formatAge(ageMs), w - 2, 2)
  }

  if (n.state === 'empty') {
    g.fillStyle = tokens.dim
    g.font = `${axisFontPx}px system-ui`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('no data', plotX + plotW / 2, plotY + plotH / 2)
    drawLegend(g, n.legend, ramp, plotY + plotH + MARGIN_BOTTOM, legendFontPx, iconR)
    g.globalAlpha = 1
    return
  }

  const bounds = n.bounds
  const xOf = (t) => plotX + ((t - bounds.tMin) / (bounds.tMax - bounds.tMin)) * plotW
  // clampPlotY: an explicit y_min/y_max bounds the AXIS, not the data, so a reading past it is
  // pinned to the nearest plot edge instead of drawn over the y-axis labels and the age chip. It
  // also makes the bar branch below safe — `plotY + plotH - y` can no longer go negative.
  const yOf = (v) => clampPlotY(plotY + plotH - ((v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * plotH, plotY, plotH)

  g.fillStyle = tokens.dim
  g.font = `${axisFontPx}px system-ui`
  g.textAlign = 'right'
  g.textBaseline = 'top'
  // axisLabel, not displayValue: these bounds are DERIVED from the points, so they carry the whole
  // float the arithmetic produced, and this text is right-aligned into a gutter 3.5em wide. The
  // EXACT bounds stay in `yOf` above — rounding a label must never move a plotted point.
  const ySpan = bounds.yMax - bounds.yMin
  g.fillText(axisLabel(bounds.yMax, ySpan), plotX - 4, plotY)
  g.textBaseline = 'bottom'
  g.fillText(axisLabel(bounds.yMin, ySpan), plotX - 4, plotY + plotH)
  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.fillText(atTime(bounds.tMin), plotX, plotY + plotH + 2)
  g.textAlign = 'right'
  g.fillText(atTime(bounds.tMax), plotX + plotW, plotY + plotH + 2)

  const maxMarks = chartMaxMarksAt(box.t ?? 1)

  if (n.style === 'bar') {
    // No cross-series timestamp bucketing — see the "how to bucket bar series" rule in
    // layout-core.mjs. Each bar sits at its own point's true x, nudged sideways by `barOffset` so
    // same-instant bars from different series fan out instead of fully overlapping.
    const count = n.series.length
    const bw = barWidth(plotW, n.pointCount, count)
    n.series.forEach((s, i) => {
      g.fillStyle = ramp[i % ramp.length]
      const offset = barOffset(i, count, bw)
      for (const p of s.points) {
        const x = xOf(p.t) + offset
        const y = yOf(p.y)
        // `rect` + `fill`, not `fillRect`: the portable subset does not carry `fillRect`.
        g.beginPath()
        g.rect(x - bw / 2, y, bw, plotY + plotH - y)
        g.fill()
      }
    })
  } else {
    n.series.forEach((s, i) => {
      if (s.points.length === 0) return
      const color = ramp[i % ramp.length]
      g.strokeStyle = color
      g.fillStyle = color
      g.lineWidth = 2
      g.beginPath()
      s.points.forEach((p, pi) => {
        const x = xOf(p.t), y = yOf(p.y)
        if (pi === 0) g.moveTo(x, y); else g.lineTo(x, y)
      })
      g.stroke()
      // A dense series shows its glyph only every k-th point so the markers don't smear together;
      // the budget comes from the cell's own size (`chartMaxMarksAt`).
      const every = markEvery(s.points.length, maxMarks)
      s.points.forEach((p, pi) => {
        if (pi % every !== 0) return
        drawIcon(g, s.icon, xOf(p.t), yOf(p.y), iconR)
      })
    })
  }

  drawLegend(g, n.legend, ramp, plotY + plotH + MARGIN_BOTTOM, legendFontPx, iconR)
  g.globalAlpha = 1
}

export default { meta, draw }
