import { readdirSync, readFileSync, statSync } from 'node:fs'
// @ts-expect-error plain JS module without types
import { ALLOWED_G_OPS, BROWSER_API } from '../packs/scan.mjs'
// @ts-expect-error plain JS module without types
import { unpaintedTokens } from '../packs/design.mjs'
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
// The subset itself lives in hub/packs/scan.mjs, shared with the theme-pack checker.
const ALLOWED = ALLOWED_G_OPS

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
  // The ban itself lives in hub/packs/scan.mjs, shared with the theme-pack checker.

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
        // The sample contexts (empty, sample, threshold variants, one per alert severity, rows with
        // a scripted gesture, chart series) live in hub/packs/design.mjs, shared with the
        // theme-pack checker, so a pack is held to exactly this guard.
        expect(unpaintedTokens(design)).toEqual([])
      })
    }
  }
})
