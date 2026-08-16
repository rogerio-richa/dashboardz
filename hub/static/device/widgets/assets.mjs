/**
 * Raster assets for widget designs (asset ownership rule: designs may use images; assets belong to the DESIGN, not
 * the theme, and are never recoloured).
 *
 * `drawImage` has been in the portable subset since portable drawing subset, but nothing could ever supply an image:
 * a design receives only `g` and `ctx`, and a test forbids designs from touching `document` or
 * `new Image()` because `g` has to be swappable for a recording surface with no DOM. So the
 * operation was permitted and unreachable. This module is the missing half — the HOST loads, and
 * the design just draws.
 *
 * A design declares what it wants the same way it declares colours:
 *
 *   meta: {
 *     tokens: { digit: { type: 'color', default: '@ink' } },   // palette-driven, code-drawn
 *     assets: { glyphs: 'nixie-glyphs.png' },                  // static, never themed
 *   }
 *
 * The value is a BARE FILENAME, resolved by this module to `widgets/<meta.widget>/assets/<file>`.
 * Designs never spell a URL: a path they composed themselves would be a path they could escape,
 * and it would also be the one piece of a design that could not survive being replayed on
 * firmware. `new URL(..., import.meta.url)` keeps that resolution correct wherever the device page
 * is mounted. This module may touch browser APIs precisely because it is NOT a design — the
 * no-browser-API guard selects modules carrying `meta.widget`, so hosts are exempt and designs
 * stay clean.
 *
 * LOADING IS ASYNCHRONOUS AND `draw` IS NOT, which is the whole ergonomic problem. `assetsFor`
 * therefore never blocks and never returns a half-loaded handle: a name is present once its image
 * is decoded and simply ABSENT until then, or forever if it failed. So every design must render
 * something without its assets and merely look better with them — the same degradation rule that
 * governs an unknown design id. A decode that finishes ANNOUNCES itself ([onAssetReady]) so the
 * board repaints the moment artwork lands without making a timer load-bearing for static screens.
 *
 * A failure is remembered as a failure. Without that, a 404 would re-request on every single
 * frame of an animating cell.
 */

/** url -> { state: 'loading' | 'ready' | 'failed', image } */
const cache = new Map()

const EMPTY = Object.freeze({})

/**
 * Called once whenever an image finishes decoding. The board sets this to a repaint; nothing else
 * observes it. Deliberately a single slot rather than a listener list — there is one board, and a
 * list would invite the leak of a screen that swapped out without unsubscribing.
 */
let onReady = () => {}

/** Register what to do when an asset lands. Pass nothing to go back to doing nothing. */
export function onAssetReady(fn) {
  onReady = typeof fn === 'function' ? fn : () => {}
}

// Swappable so the hub's Node test suite — which has no DOM and no Image — can drive the whole
// state machine synchronously. Same shape as loop.mjs's `_setRaf`, and for the same reason.
let makeImage = () => new Image()

function urlFor(widget, file) {
  return new URL(`./${widget}/assets/${file}`, import.meta.url).href
}

function begin(url) {
  const entry = { state: 'loading', image: null }
  cache.set(url, entry)
  let img
  try {
    img = makeImage()
  } catch {
    // No image constructor at all (a recording surface, or Node without the test hook installed).
    // Not an error: assets are optional by construction, so the design draws its codeform.
    entry.state = 'failed'
    return entry
  }
  img.onload = () => {
    entry.state = 'ready'
    entry.image = img
    // Announced after the entry is complete, so a repaint triggered from here sees the asset.
    try {
      onReady()
    } catch (err) {
      // A failing repaint must not poison the cache entry that just succeeded.
      console.error('asset repaint failed', err)
    }
  }
  img.onerror = () => { entry.state = 'failed'; entry.image = null }
  img.src = url
  return entry
}

/**
 * The `ctx.assets` map for one design: every declared asset that is decoded and ready, keyed by
 * the name the design declared. Kicks off any load not already started or finished.
 *
 * Lazy by design — only the designs actually being painted fetch anything, so a board showing a
 * digital clock never downloads a nixie sheet.
 */
export function assetsFor(meta) {
  const declared = meta?.assets
  if (!declared || typeof declared !== 'object') return EMPTY
  const out = {}
  for (const [name, file] of Object.entries(declared)) {
    if (typeof file !== 'string' || file === '') continue
    const url = urlFor(meta.widget, file)
    const entry = cache.get(url) ?? begin(url)
    if (entry.state === 'ready' && entry.image) out[name] = entry.image
  }
  return out
}

/** Test-only: the cache is module-global, so suites must be able to start clean. */
export function _reset() {
  cache.clear()
  onReady = () => {}
}

/** Test-only: supply a fake image constructor whose onload/onerror the test fires by hand. */
export function _setImageFactory(fn) {
  makeImage = fn ?? (() => new Image())
}
