import { useEffect, useRef, useState, type ReactNode } from 'react'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../../../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { lookup, register } from '../../../static/device/widgets/registry.mjs'
// @ts-expect-error plain JS module without types
import { builtinRamp, resolveTokens } from '../../../static/device/widgets/tokens.mjs'
// @ts-expect-error plain JS module without types
import { prepare } from '../../../static/device/widgets/surface.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_BINDINGS, feedModesFor } from '../../../static/device/widgets/bindings.mjs'
// @ts-expect-error plain JS module without types
import { BUILTIN_BOARD } from '../../../static/device/theme.mjs'

interface WidgetDefinition {
  id: string
  label: string
}

interface WidgetDesign {
  meta: {
    id: string
    widget: string
    tokens?: Record<string, unknown>
    assets?: Record<string, string>
  }
  draw: (surface: CanvasRenderingContext2D, context: Record<string, unknown>, elapsed: number) => void
}

export interface WidgetPreviewProps {
  widget: string
  design?: string
  config: Record<string, unknown>
  data: unknown
  width: number
  height: number
}

const definitions = WIDGET_DEFINITIONS as WidgetDefinition[]
const designs = CATALOGUE as WidgetDesign[]
const EMPTY_ASSETS: Readonly<Record<string, CanvasImageSource>> = Object.freeze({})
const BARE_FILENAME = /^(?!\.{1,2}$)[a-z0-9][a-z0-9._-]*$/i

// The device registers this same catalogue before looking designs up. Registration is idempotent:
// the registry keys by widget and design id, so another admin preview replaces the same entry.
for (const candidate of designs) register(candidate)

const designKey = (design: WidgetDesign | null) => design ? `${design.meta.widget}/${design.meta.id}` : ''
const assetUrl = (widget: string, file: string) => (
  `/device/widgets/${encodeURIComponent(widget)}/assets/${encodeURIComponent(file)}`
)
const currentDpr = (): number => {
  const value = globalThis.devicePixelRatio
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * The honest `ctx.feed` for a cell that has no wire behind it at all.
 *
 * A gallery preview has no feed map, so nothing can be "missing" from it — and reporting the LOUD
 * state (`missing: true`) would paint every design's authoring error over the gallery, which is the
 * bug the channel-parity guard in this file's test suite exists for. What a preview genuinely shows
 * is a cell wired to a feed that EXISTS and has never been pushed to: the quiet line every design
 * draws for a source created five minutes ago.
 *
 * Two things follow from the channel's own vocabulary (widgets/index.mjs's `feedSignalFor`):
 *
 *   - `null` for a widget that binds no single feed — `clock` and `alert_feed` bind none, `chart`
 *     binds PER SERIES — which is exactly what the device hands those widgets. On this channel
 *     `null` means NOT APPLICABLE, so this is now a safe and accurate thing to say; it was not
 *     while `null` also meant "your feed is gone".
 *   - a real `mode`, taken from the widget's own declared bindings rather than left `null`. The
 *     previous version of this line passed `mode: null`, which the contract defines as "a mode this
 *     build cannot name" — a second meaning loaded onto one sentinel, and a lie about a preview that
 *     knows perfectly well what kind of feed the widget takes. It also matters now that it is read:
 *     `table` and `value_tile` take their quiet never-pushed line only for a mode they can consume,
 *     so `mode: null` would have previewed both as the loud notice.
 *
 * `feedModesFor` is the same declaration the picker and the hub's own save-time check read, so the
 * preview cannot drift from what an operator is actually allowed to bind here.
 *
 * THE SEMANTIC WIDGETS ARE THE EXCEPTION, and getting them wrong was a latent sixth instance of the
 * bug this whole function exists to prevent. `weather_forecast`, `news_list` and `calendar_events`
 * are absent from `WIDGET_BINDINGS` entirely — they bind by CONTRACT, not by mode, so
 * `feedModesFor` returns `[]` for them. But `semanticConfig` in `hub/src/routes/admin.ts` makes
 * `feed` REQUIRED on those cells, so on a real board `feedForCell` finds a wire and the device hands
 * them a genuine `{missing:false, …}`. Returning `null` here said "binds no feed" about three
 * widgets that always bind one — legal on the channel, and harmless only for exactly as long as no
 * semantic design reads it.
 *
 * Their mode is not fixed per widget: it follows the contract (`weather_forecast` and
 * `calendar_events` resolve to `value`, `news_list` to `stream` — see `hub/src/data/contracts.ts`).
 * That mapping is server-side and this bundle cannot import it, so the mode is inferred from the
 * definition's own `sample_data` shape, which is the SAME inference `rowsForPreview` below already
 * makes for the same reason: an array of rows is a stream, anything else is a value. One rule, one
 * place to be wrong.
 */
function previewFeed(widget: string, sampleData: unknown): Record<string, unknown> | null {
  const perSeries = (WIDGET_BINDINGS as Record<string, { per_series?: boolean }>)[widget]?.per_series
  if (perSeries) return null
  const modes = feedModesFor(widget) as string[]
  const definition = (WIDGET_DEFINITIONS as { id: string; consumes?: unknown }[])
    .find((d) => d.id === widget)
  // Binds nothing at all (`clock`, `alert_feed`): the device says `null` and so do we.
  if (modes.length === 0 && definition?.consumes === undefined) return null
  const mode = modes.length > 0 ? modes[0] : (Array.isArray(sampleData) ? 'stream' : 'value')
  // `image_rev: null` is what keeps `image` on `— no image yet` rather than `loading image…`, which
  // is what the retired `image_feed: { rev: 0 }` did before the channel was generalised.
  return { missing: false, mode, pushed_at: null, image_rev: null }
}

/**
 * The best `ctx.rows` a preview can offer without a real wire. On-device,
 * `paintWidgets` (widgets/index.mjs) builds `ctx.rows` from the feed's own `{payload, pushed_at}`
 * rows via `rowsForCell` — `null` for a cell that is not stream-bound, `[]` for a well-formed empty
 * stream, else the rows themselves. A preview has no wire, only `data` — already shaped like
 * `dataForCell`'s own output (an array of row payloads for a stream feed, the payload itself
 * otherwise; the same shape/mode ambiguity `value/tile.mjs`'s own docstring names, since nothing in
 * `data` says which feed mode it came from). Array-shaped `data` is therefore read as stream rows,
 * each given a `pushed_at` of `now` — there is no real push time to offer, so every row reads as
 * fresh ("now") rather than inventing staggered ages nobody asked for. Non-array `data` (a value
 * feed's own payload, typed-in text, or nothing bound at all) gives `null`, the same "not
 * stream-bound" state `rowsForCell` gives a value-mode or unbound cell.
 */
const rowsForPreview = (value: unknown, now: number): { payload: unknown; pushed_at: number }[] | null =>
  Array.isArray(value) ? value.map((payload) => ({ payload, pushed_at: now })) : null

/** One sample point per minute, newest first — the same wire order a real stream feed arrives in. */
const PREVIEW_STEP_MS = 60_000

/**
 * The best `ctx.series` a preview can offer, and why it is NOT `rowsForPreview` repeated.
 *
 * The channel's SHAPE was already right here — one positional entry per configured series — but the
 * SAMPLE was the same rows in every one of them, and for a chart that is not a preview of anything.
 * Two things go wrong, and both are invisible in any other widget:
 *
 * 1. EVERY ROW SHARED ONE TIMESTAMP. `rowsForPreview` stamps every row `now`, deliberately, because
 *    for `stream_list` a fabricated age is a number an operator would read and believe. A chart's x
 *    axis IS time: with zero span, `chartBounds` pads ±1ms and every point lands on the same x, so
 *    the gallery would show a vertical stack in the middle of an empty frame rather than a plot.
 *    So the sample's rows are spread one minute apart here, ending at `now`. That is fabrication,
 *    but no more so than the sample payloads themselves — and the alternative misrepresents the
 *    widget completely, which is the failure mode this whole component exists to avoid.
 * 2. IDENTICAL SERIES DREW ON TOP OF EACH OTHER. In `line` style, N series of identical points are N
 *    coincident polylines: the operator sees one line, in the LAST series' colour, and the ramp
 *    cycling — the single most visible property of a multi-series chart, and the reason `ctx.ramp`
 *    exists at all — is invisible. Each series is therefore PHASE-SHIFTED by its own index into the
 *    same sample array. No value is invented: every point is a real `sample_data` payload, just
 *    entered at a different offset, so the lines separate without the preview claiming any number
 *    the definition did not ship.
 *
 * `missing` is always false: a preview has no feed map, so there is no feed to be absent from it,
 * and reporting one missing would paint the loud "Feed missing" notice over the whole gallery card —
 * exactly the class of regression the channel-parity guard in this file's test exists for.
 */
const seriesForPreview = (
  config: Record<string, unknown>,
  data: unknown,
  now: number,
): { feed: string; rows: { payload: unknown; pushed_at: number }[]; missing: boolean }[] | null => {
  const declared = (config as { series?: { feed?: string }[] }).series
  if (!Array.isArray(declared)) return null
  const sample = Array.isArray(data) ? data : []
  return declared.map((entry, index) => ({
    feed: typeof entry?.feed === 'string' ? entry.feed : '',
    rows: sample.map((_payload, row) => ({
      payload: sample[(row + index) % sample.length],
      pushed_at: now - row * PREVIEW_STEP_MS,
    })),
    missing: false,
  }))
}

function PreviewFrame({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <div
      className="widget-preview-frame"
      style={{ width: '100%', maxWidth: `${width}px`, aspectRatio: `${width} / ${height}` }}
    >
      {children}
    </div>
  )
}

export default function WidgetPreview({ widget, design, config, data, width, height }: WidgetPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState(false)
  const [dpr, setDpr] = useState(currentDpr)
  const [assetState, setAssetState] = useState<{
    key: string
    values: Readonly<Record<string, CanvasImageSource>>
  }>({ key: '', values: EMPTY_ASSETS })
  const definition = definitions.find((candidate) => candidate.id === widget)
  const label = definition?.label ?? widget
  const selected = lookup(widget, design) as WidgetDesign | null
  const selectedKey = designKey(selected)
  const assets = assetState.key === selectedKey ? assetState.values : EMPTY_ASSETS

  useEffect(() => {
    if (!selected) return
    let live = true
    const key = designKey(selected)
    const declared = Object.entries(selected.meta.assets ?? {})
      .filter(([, file]) => BARE_FILENAME.test(file))
    if (declared.length === 0) return () => { live = false }
    setAssetState({ key, values: EMPTY_ASSETS })

    for (const [name, file] of declared) {
      try {
        const image = new Image()
        image.onload = () => {
          if (!live) return
          setAssetState((current) => current.key === key
            ? { key, values: { ...current.values, [name]: image } }
            : current)
        }
        image.onerror = () => { if (!live) return }
        image.src = assetUrl(selected.meta.widget, file)
      } catch {
        // Assets are optional by contract. The real design's code fallback remains visible.
      }
    }

    return () => { live = false }
  }, [selected])

  useEffect(() => {
    if (!selected) return
    const refreshDpr = () => setDpr((current) => {
      const next = currentDpr()
      return Object.is(current, next) ? current : next
    })
    const resolution = typeof window.matchMedia === 'function'
      ? window.matchMedia(`(resolution: ${dpr}dppx)`)
      : null

    window.addEventListener('resize', refreshDpr)
    resolution?.addEventListener('change', refreshDpr)
    return () => {
      window.removeEventListener('resize', refreshDpr)
      resolution?.removeEventListener('change', refreshDpr)
    }
  }, [dpr, selected])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !selected) return
    try {
      const surface = prepare(canvas, width, height, dpr) as CanvasRenderingContext2D
      const tokens = resolveTokens(selected.meta, {}, BUILTIN_BOARD)
      const now = Date.now()
      selected.draw(surface, {
        tokens,
        config,
        data,
        box: { w: width, h: height, t: 1 },
        now,
        state: {},
        motion: 'none',
        assets,
        // The rest of `paintWidgets`' own drawCtx shape (widgets/index.mjs), so a design behaves
        // identically in preview and on-device rather than branching on fields it can't tell are
        // simply absent here — `stream_list`'s preview rendered its
        // "missing feed" state because `ctx.rows` was never set at all). No live wire exists in a
        // preview, so `stale`/`age_ms` are the same "nothing to be stale about" values an unbound
        // cell gets on-device.
        stale: false,
        age_ms: null,
        // `alerts` carries the sample for the one widget that reads it. This was `[]` while
        // `alert_feed` was still a DOM branch and nothing consumed the channel; leaving it empty
        // A preview without these fields would show operators a permanent "no active alerts" card in the
        // gallery, so preview context mirrors the fields supplied to the device renderer.
        alerts: selected.meta.widget === 'alert_feed' && Array.isArray(data) ? data : [],
        rows: rowsForPreview(data, now),
        /*
         * Every field `paintWidgets` puts on the drawCtx has to appear in this object too,
         * even when the honest preview value is `null`. A design cannot tell "absent because this
         * is a preview" from "absent because there is nothing", so an omission does not degrade —
         * it renders the widget's ERROR state to every operator browsing the gallery.
         *   1. `ctx.rows` (stream data) — `stream_list` previewed as "Feed missing".
         *   2. `ctx.alerts` (screen state) — `alert_feed` previewed as "no active alerts".
         *   3. `ctx.bitmap` + `ctx.image_feed` (image screen state; the second has since been
         *      generalised into `ctx.feed`) — `image` previewed as the LOUD
         *      "Feed missing / Bind this cell to an image feed".
         * `ctx.series` and `ctx.ramp` are also supplied for chart previews.
         *
         * `WidgetPreview.test.tsx` parses `paintWidgets`'
         * own drawCtx literal out of widgets/index.mjs and asserts this object carries exactly the
         * same channel names, so a channel added on the device fails here rather than in front of
         * an operator. (`WidgetGallery.test.tsx` genuinely cannot see any of this — it does not
         * stub `getContext`, so every preview in it lands in the catch below.)
         *
         * A preview has no feed and no decoded bitmap, so the honest pair is "no drawable" plus
         * "a real feed that has never been pushed to" — which is the quiet `— no image yet`, the
         * same thing a freshly created image feed shows on a real board.
         */
        bitmap: null,
        // `ctx.feed` — see previewFeed for what an honest one is when there is no wire at all.
        feed: previewFeed(selected.meta.widget, data),
        // One slot per configured series, positionally — and a DIFFERENT phase of the sample in
        // each, over spread timestamps. See seriesForPreview for why "the same rows in every slot"
        // was the wrong sample for a chart even though it was the right shape.
        series: seriesForPreview(config, data, now),
        // The board's own series ramp, resolved the same way `rampFor` resolves it when a board
        // declares none — never CSS variables, which a design must not read (portable drawing subset).
        ramp: builtinRamp(BUILTIN_BOARD),
      }, 0)
      setFailed((current) => current ? false : current)
    } catch {
      // Preview failures are local to one card, like device paint failures are local to one cell.
      // A missing canvas implementation in a non-browser test host also lands here harmlessly.
      setFailed((current) => current ? current : true)
    } finally {
      // `prepare` owns the logical surface. The admin host separately scales its presentation to
      // the frame so a 300px design remains a 300px draw box without clipping a narrower card.
      canvas.style.width = '100%'
      canvas.style.height = '100%'
    }
  }, [assets, config, data, dpr, height, selected, width])

  /*
   * THE LIGHTWEIGHT PREVIEW IS GONE, and this is the branch that replaced it.
   *
   * `LegacyPreview` drew a widget's FACTS — a badge, a heading, a one-line summary — for every
   * widget type that had no canvas design, on the honest grounds that a fake picture of a gauge
   * would be a worse lie than an admitted non-picture. Every widget type now has a canvas design,
   * so every `WIDGET_DEFINITIONS` entry resolves through `lookup` and this branch has no normal input.
   *
   * `selected` can still be null — for a widget id this build has never heard of, which is a real
   * case a board saved by a newer hub produces — and the honest answer for that is the SAME
   * "Preview unavailable" status a failed draw gets, not a summary of a widget nobody can describe.
   */
  if (!selected) {
    return (
      <PreviewFrame width={width} height={height}>
        <span
          className="widget-preview-unavailable"
          role="status"
          aria-label={`${label} preview unavailable`}
        >
          Preview unavailable
        </span>
      </PreviewFrame>
    )
  }

  return (
    <PreviewFrame width={width} height={height}>
      <canvas
        ref={canvasRef}
        className="widget-preview-canvas"
        aria-label={`${label} preview`}
        aria-hidden={failed || undefined}
      />
      {failed && (
        <span
          className="widget-preview-unavailable"
          role="status"
          aria-label={`${label} preview unavailable`}
        >
          Preview unavailable
        </span>
      )}
    </PreviewFrame>
  )
}
