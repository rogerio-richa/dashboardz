import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scannableSource } from './source-scan.js'
// @ts-expect-error plain JS module without types
import { registered } from '../static/device/widgets/index.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'

/**
 * portable drawing subset: a design draws through a portable subset so `g` can be a recording surface for a device
 * with no JavaScript engine (ESP32-class) or node-canvas for e-ink.
 *
 * THE LINE IS "WHAT A RECORDER CAN LOWER", NOT "WHAT AN MCU IMPLEMENTS NATIVELY" (portable drawing boundary). A
 * recording surface sits between the design and the firmware and may rewrite what it sees, so an
 * operation earns its place here if the recorder can express it in primitives firmware already
 * has. `scale` qualifies: the recorder multiplies its own matrix and firmware never learns the op
 * existed. Curve ops would qualify too — a recorder flattens a bezier to `lineTo` segments — and
 * are deliberately still absent, because no design needs them yet and an unused entry only weakens
 * the guard.
 *
 * Gradients, filters, blend modes, `clip()` and `shadowBlur` do NOT lower cheaply and stay out.
 * `clip()` in particular is what stops clock/flip.mjs rendering a true half-card Solari flip; the
 * whole-card squash it uses instead is the price of this boundary, paid knowingly.
 */
const ALLOWED = new Set([
  'arc', 'beginPath', 'closePath', 'clearRect', 'drawImage', 'fill', 'fillStyle', 'fillText',
  'font', 'globalAlpha', 'lineCap', 'lineTo', 'lineWidth', 'measureText', 'moveTo', 'rect',
  'restore', 'rotate', 'save', 'scale', 'setTransform', 'stroke', 'strokeStyle', 'textAlign',
  'textBaseline', 'translate',
])

function mjsUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? mjsUnder(p) : p.endsWith('.mjs') ? [p] : []
  })
}

const files = mjsUnder('static/device/widgets')

/**
 * Every widget TYPE that has a canvas design, discovered from the design files themselves rather
 * than typed into this test. Each `files` entry is dynamically imported —
 * cheap and side-effect-free, since index.mjs already imported and registered these same modules
 * by the time this file's top-level static import ran, so Node resolves every one of these
 * dynamic imports to its already-cached module instance rather than re-executing it — and any
 * module whose default export carries `meta.widget` (`export default { meta, draw }`, the design
 * shape registry.mjs requires) contributes that widget name. Files with no such export
 * (registry.mjs, tokens.mjs, surface.mjs, loop.mjs, clock-geometry.mjs, index.mjs) contribute
 * nothing. This is what actually closes the escape hatch a hardcoded widget-type list left open:
 * `registered(widget)` alone only protects a new DESIGN under an ALREADY-listed widget type: a
 * design that introduces a brand-new widget type needs no line added here to be covered, because
 * walking `files` — the same list the portable-subset check above already walks — is what finds
 * it.
 */
const widgetTypes = new Set<string>()
/**
 * The subset of `files` that ARE designs, discovered the same way and in the same pass — a module
 * qualifies by carrying `meta.widget`, not by living under a path some test hardcoded. The "no
 * browser API" check scans every design, so a design living outside `widgets/clock/` is covered and
 * every design runs on a recording surface with no DOM at all — see portable drawing subset above.
 */
const designFiles: string[] = []
for (const file of files) {
  const mod = await import(pathToFileURL(resolve(file)).href)
  const widget = mod?.default?.meta?.widget
  if (typeof widget === 'string') {
    widgetTypes.add(widget)
    designFiles.push(file)
  }
}

describe('designs draw through the portable subset (portable drawing subset)', () => {
  it('finds the design modules', () => expect(files.length).toBeGreaterThan(0))

  /**
   * What this check does and does not catch: it is a lexical regex over
   * source text, `\bg\.([a-zA-Z]+)`, not a parser — it has no notion of scope, identity, or string
   * literals. It catches the straightforward case, a design calling `g.<op>` directly, which is
   * every design in the catalogue today. It does NOT catch an aliased handle (`const c = g;
   * c.createLinearGradient(...)`) or computed/bracket access (`g['createLinearGradient'](...)`) —
   * both reach a disallowed op while never spelling `g.` followed by the op name, so both are
   * silent escapes one level of indirection removed from the case this guard defeats. It can also
   * FALSE-positive on a disallowed-looking op name inside a comment or string rather than code —
   * not hypothetical: the sibling "no browser API" check two tests below hit exactly this shape in
   * this same diff, on prose in clock/segment.mjs ("...lands inside the window. There is...")
   * matching `\bwindow\.`, which needed a comment reword rather than a code fix. Nothing here
   * currently triggers that false-positive for `g.<op>`, but the failure mode is proven, not
   * theoretical, and worth knowing before trusting a green run of this file as a stronger claim
   * than "no design spells a banned op the straightforward way".
   */
  for (const file of files) {
    it(`${file} uses no operation outside the subset`, () => {
      const src = readFileSync(file, 'utf8')
      const used = [...src.matchAll(/\bg\.([a-zA-Z]+)/g)].map((m) => m[1])
      expect([...new Set(used)].filter((op) => !ALLOWED.has(op))).toEqual([])
    })
  }

  it('the guard can actually fail', () => {
    const used = [...'g.createLinearGradient(0,0,1,1)'.matchAll(/\bg\.([a-zA-Z]+)/g)].map((m) => m[1])
    expect(used.filter((op) => !ALLOWED.has(op))).toEqual(['createLinearGradient'])
  })

  /**
   * The other half of the portable drawing subset checks browser-only globals.
   *
   * A three-name check such as `/\b(document|localStorage)\b|\bwindow\./` would let a design
   * calling `fetch`, `new Image()`, `sessionStorage`, `URL.createObjectURL` or `navigator` sail
   * through. Each of those breaks the promise this check keeps: that a design can be replayed by
   * firmware with no browser under it. The op-list and browser-global checks both enforce it.
   *
   * Two properties make the wider ban safe across all shipped designs:
   *
   *   1. **Comments are stripped.** Designs legitimately DISCUSS these APIs — `image/frame.mjs`'s
   *      docstring explains at length that the HOST does the fetch and the design just draws.
   *      Banning the word without stripping prose would have failed the very design that documents
   *      the rule.
   *   2. **String literals are blanked.** `image/frame.mjs` has `label: 'Image'`; a bare `\bImage\b`
   *      reads that as `new Image()`. Blanking strings is right HERE and wrong in knob-coverage,
   *      where `config['min_severity']` is a genuine read — hence the explicit mode.
   *
   * The patterns target the VIOLATING FORM, not the bare name, because the bare name is often
   * innocent:
   *   - `new Date(ctx.now)` is formatting a timestamp the host supplied — allowed.
   *     `Date.now()` and `new Date()` read a clock — banned. `ctx.now` is the only clock a design
   *     may read, and ten designs rely on that distinction.
   *   - `g.drawImage(...)` is IN the portable subset — allowed. `new Image()` is not.
   */
  const BROWSER_API = new RegExp([
    // Ambient globals a design must never see.
    String.raw`\b(document|window|navigator|localStorage|sessionStorage|indexedDB|caches)\b`,
    String.raw`\b(XMLHttpRequest|WebSocket|EventSource|Worker)\b`,
    // Network and asset loading — the host's job (see widgets/assets.mjs, widgets/bitmaps.mjs).
    String.raw`\bfetch\s*\(`,
    String.raw`\bnew\s+(Image|URL|Worker)\b`,
    String.raw`\bURL\.`,
    String.raw`\bcreateImageBitmap\s*\(`,
    // A design is drawn; it does not schedule itself. isAnimating + ctx.now is the whole mechanism.
    String.raw`\b(setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*\(`,
    // Clock reads, as distinct from timestamp formatting.
    String.raw`\bDate\.now\s*\(`,
    String.raw`\bnew\s+Date\s*\(\s*\)`,
  ].join('|'))

  it('designs reach for no browser API beyond g and ctx', () => {
    // `designFiles`, not a path filter — see its comment above.
    expect(designFiles.length).toBeGreaterThan(0)
    for (const file of designFiles) {
      const code = scannableSource(readFileSync(file, 'utf8'), 'blank')
      const hit = BROWSER_API.exec(code)
      expect(hit?.[0], `${file} reaches for ${hit?.[0]}`).toBeUndefined()
    }
  })

  /**
   * The ban is only worth what it catches. Each of these is a real way a design could break portable drawing subset,
   * and the first five were all MISSED by the previous three-name version — this list is the
   * regression record for that, not a formality.
   */
  it.each([
    ['fetch', `const r = fetch('/api/x')`],
    ['new Image', `const i = new Image()`],
    ['sessionStorage', `sessionStorage.getItem('k')`],
    ['URL.createObjectURL', `const u = URL.createObjectURL(blob)`],
    ['navigator', `if (navigator.onLine) {}`],
    ['document', `document.body.appendChild(x)`],
    ['window', `window.scrollTo(0, 0)`],
    ['Date.now', `const t = Date.now()`],
    ['new Date()', `const d = new Date()`],
    ['setTimeout', `setTimeout(() => {}, 16)`],
    ['createImageBitmap', `createImageBitmap(blob)`],
  ])('the browser-API guard catches %s', (_name, snippet) => {
    expect(BROWSER_API.test(scannableSource(snippet, 'blank'))).toBe(true)
  })

  /**
   * The other direction, which matters just as much: a guard that fails on legitimate code gets
   * loosened by the next person in a hurry, and then it is back to catching nothing.
   */
  it.each([
    ['a timestamp the host supplied', `const d = new Date(ctx.now)`],
    ['a subset drawing op', `g.drawImage(bmp, 0, 0)`],
    ['a label that happens to say Image', `label: 'Image'`],
    ['an identifier containing Image', `normalizeImage(ctx.bitmap, config)`],
    ['Date arithmetic on a supplied value', `new Date(Date.UTC(y, m - 1, d))`],
  ])('the guard does NOT fire on %s', (_name, snippet) => {
    expect(BROWSER_API.test(scannableSource(snippet, 'blank'))).toBe(false)
  })
})

/**
 * Catalogue-wide dead-slot guard, owed since lane 2a: each design's own suite proves its own
 * tokens are read, but nothing checked the catalogue as a whole. It matters more now that
 * colorsets exist — a colorset can only fill a slot the design actually draws with, so a
 * declared-but-unread slot is an authoring dead end nobody would notice until someone tries to
 * theme it.
 *
 * Walks `registered(widget)` rather than a hardcoded file list (per knob-coverage.test.ts's own
 * lesson: a fixed path list is exactly how a new design escapes a guard) so a design added later
 * is covered automatically, with no test file to remember to update. The outer loop walks
 * `widgetTypes` — discovered above by importing every design file and
 * reading `meta.widget` off it, not typed into this test — so a design that introduces a
 * brand-new widget TYPE is covered the moment its file exists too, closing the same escape hatch
 * one level up from the design list registry.mjs's `registered(widget)` already covers.
 *
 * Each declared token is resolved to a distinct, recognisable sentinel value and `g` is a Proxy
 * that records every value ever assigned to `fillStyle`/`strokeStyle` — the only two properties a
 * portable-subset design can paint a token's colour through. A token whose sentinel never shows up
 * in `seen` was declared but never drawn with.
 */
describe('every declared slot is read by the design declaring it', () => {
  for (const widget of widgetTypes) {
    for (const design of registered(widget)) {
      it(`${widget}/${design.meta.id} reads every slot it declares`, () => {
        const declared = Object.keys(design.meta.tokens)
        const seen: string[] = []
        const tokens = Object.fromEntries(declared.map((s, i) => [s, `#${String(i).padStart(6, '0')}`]))
        const g = new Proxy({}, {
          get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}),
          set: (_t, k, v) => { if (k === 'fillStyle' || k === 'strokeStyle') seen.push(String(v)); return true },
        })
        /*
         * Drive the design across several contexts and union what it painted, rather than judging
         * it on one draw.
         *
         * One draw with `config: {}, data: null` is not enough, and the way it failed is worth
         * recording: a gauge resolves `info` severity in that context and never touches `warn` or
         * `critical`, so both designs grew a helper that assigned all three tokens to `strokeStyle`
         * in sequence — three throwaway writes whose only purpose was to be seen here — and shipped
         * with a comment recommending the trick. The guard was passing because the designs had
         * learned to satisfy it, which is the one thing a guard must never teach.
         *
         * So: the empty context, the widget's own declared sample, and — where the sample describes
         * a numeric range — two more with thresholds pushed under the sampled value so the warn and
         * critical branches genuinely run. A design that still leaves a token unpainted across all
         * of them is declaring something it does not draw.
         */
        const definition = WIDGET_DEFINITIONS.find((d: { id: string }) => d.id === widget)
        const sampleConfig = definition?.sample_config ?? {}
        const sampleData = definition?.sample_data ?? null
        const contexts: { config: unknown; data: unknown }[] = [
          { config: {}, data: null },
          { config: sampleConfig, data: sampleData },
        ]
        const { min, max } = sampleConfig as { min?: number; max?: number }
        if (typeof min === 'number' && typeof max === 'number') {
          const span = max - min
          contexts.push({ config: { ...sampleConfig, thresholds: { warn: min, crit: max + span } }, data: sampleData })
          contexts.push({ config: { ...sampleConfig, thresholds: { warn: min, crit: min } }, data: sampleData })
        }

        /*
         * `alerts`, not just `data`. `alert_feed` binds no feed — its data arrives on `ctx.alerts`
         * (the additive channel), so driving it with `data` alone leaves it in its "no active
         * alerts" state forever, painting `dim` and nothing else. It would then look like a design
         * declaring four tokens it never draws, when in truth the guard was never handing it
         * anything to draw.
         *
         * Fed from the same `sample_data` every other widget's sample comes from, so this stays one
         * rule rather than a special case keyed on the widget name: for a widget whose sample is an
         * array, that array is offered on BOTH channels and each design reads whichever one it
         * actually consumes.
         */
        const sampleAlerts = Array.isArray(sampleData) ? sampleData : []
        /*
         * One context per severity present in the sample, each carrying ONLY that severity's
         * alerts — the direct analogue of the threshold variants above, and necessary for the same
         * reason. A 400x200 box fits ONE 132px alert card, so handing the design all three sample
         * alerts at once paints exactly one stripe and reports the other two tokens as undrawn.
         * Widening the box instead would hide the general problem behind a number: what the guard
         * needs is a context in which each branch is the one being taken, not a cell big enough to
         * take them all at once.
         */
        const severities = [...new Set(sampleAlerts
          .map((a: { severity?: string }) => a?.severity)
          .filter((s): s is string => typeof s === 'string'))]
        const alertRuns = severities.length > 0
          ? severities.map((s) => sampleAlerts.filter((a: { severity?: string }) => a?.severity === s))
          : [sampleAlerts]

        for (const { config, data } of contexts) {
          for (const alerts of alertRuns) {
            design.draw(g, {
              tokens, config, data, alerts: data === null ? [] : alerts,
              rows: null, box: { w: 400, h: 200, t: 1 },
              now: Date.UTC(2026, 7, 3, 12, 0, 0), state: {}, motion: 'full',
              stale: false, age_ms: null,
            }, 0)
          }
        }

        /*
         * `rows` + a scripted gesture, for the same reason `alerts` joined above: an INTERACTIVE
         * stream design (one declaring the `pointer` group) has branches that only run after a
         * gesture — `stream/scroll.mjs`'s unseen badge paints only while scrolled away from the
         * top with newer rows arrived since — and the plain contexts above never hand it anything
         * but its "missing feed" notice. So: a ready draw on the widget's own sample rows, the
         * drag the pointer contract would deliver, then a draw with newer arrivals. Generic on
         * `design.pointer` + an array sample, not on a design name, so the next interactive
         * stream design is covered the moment its file exists.
         *
         * WIDENED (ticker): the ready-rows draw now happens for ANY design with an array sample,
         * and only the GESTURE half stays behind `design.pointer`. A non-interactive stream design
         * has row-only branches too — `stream/ticker.mjs` picks its `up`/`down` tint from the row
         * body it is painting, which no empty-feed context can ever reach — and under the old gate
         * those slots read as declared-but-never-painted while the design was in fact painting them
         * on every real board. Drawing rows costs nothing for a design that ignores them.
         */
        if (Array.isArray(sampleData) && sampleData.length > 0) {
          const probeConfig = { ...(sampleConfig as object), feed: 'slot-probe' }
          const probeFeed = { missing: false, mode: 'stream', pushed_at: 1_000, image_rev: null }
          const sampleRows = (newestAt: number, count: number) => Array.from({ length: count }, (_, i) =>
            ({ payload: sampleData[i % sampleData.length], pushed_at: newestAt - i }))
          const rowsCtx = (rows: unknown) => ({
            tokens, config: probeConfig, data: null, alerts: [], rows, feed: probeFeed,
            box: { w: 400, h: 200, t: 1 }, now: Date.UTC(2026, 7, 3, 12, 0, 0),
            state: {}, motion: 'full', stale: false, age_ms: null,
          })
          design.draw(g, rowsCtx(sampleRows(1_000, 10)), 0)
          if (design.pointer) {
            design.pointer.move?.({ config: probeConfig }, -200)
            design.draw(g, rowsCtx(sampleRows(1_002, 10)), 0)
          }
        }

        /*
         * `series`, the third channel — same rule as `alerts` and `rows` above: a widget whose
         * sample is an array offers that array on every channel, and each design reads whichever it
         * consumes. Without it no CHART design can have its data-path tokens covered, because a
         * chart's data arrives on `ctx.series` and the contexts above leave it undefined — every
         * such design bails to its "feed missing" notice and looks like it declares tokens it never
         * paints. `chart/candles` colours its bars from `up`/`down`/`wick` (a candle's colour is
         * semantic, not a series identity, so it does not use the ramp) and was the design that
         * found this hole.
         *
         * One row per bucket-width so the bars alternate rising and falling: a single candle would
         * only ever exercise one of the two colours.
         */
        if (Array.isArray(sampleData) && sampleData.length > 0) {
          // Several points per bucket, and every other bucket walked BACKWARDS through the sample.
          // One point per bucket makes every candle a rising doji: no falling body, no wick, and a
          // design that paints `down`/`wick` correctly still reports them as never painted.
          const seriesRows = []
          for (let bucket = 0; bucket < 6; bucket++) {
            const values = bucket % 2 === 0 ? sampleData : [...sampleData].reverse()
            for (let k = 0; k < values.length; k++) {
              seriesRows.push({ payload: values[k], pushed_at: (bucket * 60 + k * 15 + 1) * 1_000 })
            }
          }
          design.draw(g, {
            tokens, config: { ...(sampleConfig as object), window_s: 3_600 }, data: null, alerts: [], rows: [],
            series: [{ feed: 'sample', rows: [...seriesRows].reverse(), missing: false }],
            ramp: ['#4a90d9'],
            box: { w: 480, h: 240, t: 1 }, now: 13 * 60_000,
            state: {}, motion: 'full', stale: false, age_ms: null,
          }, 0)
        }

        const unread = declared.filter((s) => !seen.includes(tokens[s]))
        expect(unread).toEqual([])
      })
    }
  }
})
