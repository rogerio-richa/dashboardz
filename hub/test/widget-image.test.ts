import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'
// @ts-expect-error plain JS module without types
import frame, { fitRect, normalizeImage } from '../static/device/widgets/image/frame.mjs'
// @ts-expect-error plain JS module without types
import { bitmapDeps, loadCellBitmaps } from '../static/device/widgets/index.mjs'
// @ts-expect-error plain JS module without types
import { bitmapFor, resetBitmaps } from '../static/device/widgets/bitmaps.mjs'
// @ts-expect-error plain JS module without types
import { formatAge } from '../static/device/widgets/text-fit.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'

/**
 * `image` — the eleventh design migrated off device.js's DOM branches, and the one that also owns
 * the REAL bitmap wiring (`loadCellBitmaps`/`bitmapDeps` in widgets/index.mjs, called from
 * device.js). tab state builds `bitmaps.mjs` and `ctx.bitmap` as a pure cache lookup; this suite
 * covers both halves — what the design draws, and what actually fills the cache.
 *
 * The design half is recorder-based like every other design suite (widget-stream.test.ts's shape):
 * no canvas, no DOM, just a `g` that writes down what it was asked to paint.
 */

type Painted = { text: string; x: number; y: number; fillStyle: string; alpha: number; font: string }
type Drawn = { image: unknown; args: number[]; alpha: number }

/** `font` is captured for the same reason the three sibling design suites capture it: a size
 *  regression in a SHARED text-fit helper must fail in the designs that depend on it, not only in
 *  the helper's own suite (see the quiet-line size test below). */
function recorder() {
  const texts: Painted[] = []
  const images: Drawn[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string, x: number, y: number) =>
      texts.push({ text, x, y, fillStyle: g.fillStyle, alpha: g.globalAlpha, font: g.font }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    drawImage: (image: unknown, ...args: number[]) => images.push({ image, args, alpha: g.globalAlpha }),
    beginPath: () => {}, rect: () => {}, fill: () => {},
  }
  return { g, texts, images }
}

/** An ImageBitmap-shaped drawable: `width`/`height` and nothing else, like the real thing. */
const bitmap = (w: number, h: number) => ({ width: w, height: h })

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim' },
  config: { feed: 'f' },
  data: null,
  rows: null,
  // `ctx.feed` — the bound feed's delivery facts, or null when the cell binds none.
  feed: { missing: false, mode: 'image', pushed_at: null, image_rev: 3 },
  bitmap: bitmap(400, 200),
  box: { w: 300, h: 300, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

const drawWith = (overrides: Record<string, unknown> = {}) => {
  const r = recorder()
  frame.draw(r.g, baseCtx(overrides), 0)
  return r
}

describe('image design — meta', () => {
  it('registers as image/frame', () => {
    expect(frame.meta.widget).toBe('image')
    expect(frame.meta.id).toBe('frame')
  })

  it('declares `fit` as its ONE flat option, matching imageConfig\'s accepted set', () => {
    expect(Object.keys(frame.meta.options)).toEqual(['fit'])
    expect(frame.meta.options.fit).toEqual({
      type: 'select', label: 'Fit', default: 'contain', choices: ['contain', 'cover'],
    })
  })

  it('carries the same suggested_ratio the widget definition advertises', () => {
    const definition = WIDGET_DEFINITIONS.find((d: { id: string }) => d.id === 'image')
    expect(frame.meta.suggested_ratio).toBe(definition.suggested_ratio)
  })
})

/**
 * The four states the DOM branch drew, and the ONE fact that separates the first two.
 *
 * `ctx.bitmap`, `ctx.stale` and `ctx.age_ms` cannot tell "this cell is bound to a feed that does
 * not exist" from "the feed exists and has never been pushed to": both are `bitmap: null,
 * stale: false, age_ms: null`. `ctx.feed` (the wire's delivery facts, or `null`) is what makes them
 * distinct — see frame.mjs's own docstring. `ctx.feed` carries the complete wire object, and NONE
 * of the states
 * below moved. That is what this suite is now also pinning.
 */
describe('normalizeImage — the four states', () => {
  it('no feed at all (ctx.feed === null) is "missing"', () => {
    expect(normalizeImage(null, null, {}).state).toBe('missing')
  })

  /**
   * BOTH loud inputs, and only one of them is the channel reporting a fault.
   *
   * `null` means "this cell binds no single feed" — not applicable, the same thing it means on
   * `ctx.rows`/`ctx.series`. An image widget with nothing bound is still an authoring mistake, so
   * THIS DESIGN rules it loud; the channel did not. `missing: true` is the channel's own loud state
   * and lands in the same notice, because the sentence that fixes both is the same one.
   */
  it('a bound feed the device does not have (missing: true) is "missing" too', () => {
    expect(normalizeImage(null, { missing: true, mode: null, pushed_at: null, image_rev: null }, {}).state)
      .toBe('missing')
    // ...and it is not reached by accident: the same object without the flag is the quiet state.
    expect(normalizeImage(null, { missing: false, mode: null, pushed_at: null, image_rev: null }, {}).state)
      .toBe('empty')
  })

  it('reads the rev off a full `ctx.feed`, not just the retired `{ rev }` shape', () => {
    const feed = (image_rev: number) => ({ missing: false, mode: 'image', pushed_at: 1_000, image_rev })
    expect(normalizeImage(null, feed(0), {}).state).toBe('empty')
    expect(normalizeImage(null, feed(4), {}).state).toBe('loading')
    expect(normalizeImage(bitmap(10, 5), feed(4), {}).state).toBe('ready')
  })

  /**
   * The raw-feed rule on the new channel: `image` is MODE-BLIND. A value
   * feed bound to an image cell exists (so `ctx.feed` is not null) and carries no `image_rev` (so
   * `rev` is 0), which is the QUIET never-pushed line — never the loud "Feed missing". The DOM
   * branch looked up `feeds[cfg.feed]` and never checked `mode`, and that is preserved.
   */
  it('gives a VALUE feed bound to an image cell the QUIET state, not the loud one', () => {
    const valueFeed = { missing: false, mode: 'value', pushed_at: 1_775_000_000_000, image_rev: null }
    expect(normalizeImage(null, valueFeed, {}).state).toBe('empty')
  })

  it('does not read pushed_at: a pushed image feed still on rev 0 is "empty", not "loading"', () => {
    // `rev`, not `pushed_at`, is this design's never-pushed test — the bitmap endpoint is keyed on
    // the rev and `loadBitmapFor` refuses to fetch at 0, so the two facts are not interchangeable.
    expect(normalizeImage(null, { missing: false, mode: 'image', pushed_at: 1_000, image_rev: 0 }, {}).state)
      .toBe('empty')
  })

  it('image_rev 0 (a real feed, never pushed to) is "empty", NOT "missing"', () => {
    expect(normalizeImage(null, { image_rev: 0 }, {}).state).toBe('empty')
  })

  it('a rev with nothing decoded yet is "loading", NOT "empty"', () => {
    expect(normalizeImage(null, { image_rev: 4 }, {}).state).toBe('loading')
  })

  it('a decoded bitmap is "ready"', () => {
    const n = normalizeImage(bitmap(10, 5), { image_rev: 4 }, {})
    expect(n.state).toBe('ready')
    expect(n.natural).toEqual({ w: 10, h: 5 })
  })

  it('keeps drawing the LAST GOOD bitmap while a newer rev is still in flight', () => {
    // The contract the DOM branch kept ("a failed image fetch keeps showing the last good
    // bitmap"): `ctx.bitmap` is whatever decoded last, whatever rev the wire is on now.
    expect(normalizeImage(bitmap(10, 5), { image_rev: 99 }, {}).state).toBe('ready')
  })

  it('a non-numeric or absent rev reads as never-pushed rather than throwing', () => {
    for (const wire of [{}, { image_rev: null }, { image_rev: 'three' }, { image_rev: Number.NaN }])
      expect(normalizeImage(null, wire, {}).state).toBe('empty')
  })

  it('a drawable with no usable intrinsic size is "loading", not a half-drawn frame', () => {
    for (const drawable of [{}, { width: 0, height: 0 }, { width: 10, height: Number.NaN }])
      expect(normalizeImage(drawable, { image_rev: 1 }, {}).state).toBe('loading')
  })

  it('reads an HTMLImageElement\'s naturalWidth/Height ahead of its width/height attributes', () => {
    // The real `decode` returns an <img>, whose width/height reflect ATTRIBUTES; naturalWidth is
    // the intrinsic size. An ImageBitmap has only width/height, so both are read, in that order.
    const img = { naturalWidth: 40, naturalHeight: 20, width: 0, height: 0 }
    expect(normalizeImage(img, { image_rev: 1 }, {}).natural).toEqual({ w: 40, h: 20 })
  })

  it('defaults fit to contain and accepts only cover as the alternative', () => {
    expect(normalizeImage(null, null, {}).fit).toBe('contain')
    expect(normalizeImage(null, null, { fit: 'cover' }).fit).toBe('cover')
    expect(normalizeImage(null, null, { fit: 'stretch' }).fit).toBe('contain')
  })
})

/**
 * `fitRect` is the whole geometry, pure and surface-free: source rect + destination rect, i.e.
 * exactly `drawImage`'s 9-argument form. `contain` letterboxes (whole source, smaller
 * destination); `cover` crops (smaller source, whole destination). Both preserve aspect.
 */
describe('fitRect — contain', () => {
  const box = { w: 300, h: 300 }

  it('fits a wide image inside the box and centres it vertically', () => {
    const r = fitRect('contain', box, { w: 400, h: 200 })
    expect(r).toEqual({ sx: 0, sy: 0, sw: 400, sh: 200, dx: 0, dy: 75, dw: 300, dh: 150 })
  })

  it('fits a tall image inside the box and centres it horizontally', () => {
    const r = fitRect('contain', box, { w: 200, h: 400 })
    expect(r).toEqual({ sx: 0, sy: 0, sw: 200, sh: 400, dx: 75, dy: 0, dw: 150, dh: 300 })
  })

  it('never crops: the source rect is always the whole image', () => {
    for (const natural of [{ w: 400, h: 200 }, { w: 200, h: 400 }, { w: 37, h: 91 }]) {
      const r = fitRect('contain', box, natural)
      expect({ sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh })
        .toEqual({ sx: 0, sy: 0, sw: natural.w, sh: natural.h })
    }
  })

  it('never overflows the box, and preserves the source aspect ratio exactly', () => {
    for (const natural of [{ w: 400, h: 200 }, { w: 200, h: 400 }, { w: 37, h: 91 }, { w: 5, h: 5 }]) {
      const r = fitRect('contain', { w: 240, h: 160 }, natural)
      expect(r.dw).toBeLessThanOrEqual(240 + 1e-9)
      expect(r.dh).toBeLessThanOrEqual(160 + 1e-9)
      expect(r.dw / r.dh).toBeCloseTo(natural.w / natural.h, 9)
      // One dimension must actually TOUCH the box, or it is not a fit, it is a shrink.
      expect(Math.abs(r.dw - 240) < 1e-9 || Math.abs(r.dh - 160) < 1e-9).toBe(true)
    }
  })
})

describe('fitRect — cover', () => {
  it('fills the box completely and crops the source, centred', () => {
    const r = fitRect('cover', { w: 300, h: 300 }, { w: 400, h: 200 })
    expect(r).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200, dx: 0, dy: 0, dw: 300, dh: 300 })
  })

  it('crops the other axis for a tall image', () => {
    const r = fitRect('cover', { w: 300, h: 300 }, { w: 200, h: 400 })
    expect(r).toEqual({ sx: 0, sy: 100, sw: 200, sh: 200, dx: 0, dy: 0, dw: 300, dh: 300 })
  })

  it('always paints edge to edge, and the visible crop keeps the BOX aspect ratio', () => {
    for (const natural of [{ w: 400, h: 200 }, { w: 200, h: 400 }, { w: 37, h: 91 }]) {
      const r = fitRect('cover', { w: 240, h: 160 }, natural)
      expect({ dx: r.dx, dy: r.dy, dw: r.dw, dh: r.dh }).toEqual({ dx: 0, dy: 0, dw: 240, dh: 160 })
      expect(r.sw / r.sh).toBeCloseTo(240 / 160, 9)
      // The crop stays inside the source in both axes.
      expect(r.sx + r.sw).toBeLessThanOrEqual(natural.w + 1e-9)
      expect(r.sy + r.sh).toBeLessThanOrEqual(natural.h + 1e-9)
    }
  })

  it('is NOT contain: a mismatched aspect gives a different rectangle', () => {
    const box = { w: 300, h: 300 }
    const natural = { w: 400, h: 200 }
    expect(fitRect('cover', box, natural)).not.toEqual(fitRect('contain', box, natural))
  })

  it('agrees with contain when the aspects already match — no crop, no letterbox', () => {
    const same = { w: 200, h: 100 }
    expect(fitRect('cover', { w: 400, h: 200 }, same)).toEqual(fitRect('contain', { w: 400, h: 200 }, same))
  })
})

describe('fitRect — degenerate inputs', () => {
  it('returns null rather than a NaN rectangle', () => {
    expect(fitRect('contain', { w: 0, h: 100 }, { w: 10, h: 10 })).toBeNull()
    expect(fitRect('contain', { w: 100, h: 100 }, { w: 0, h: 10 })).toBeNull()
    expect(fitRect('cover', { w: 100, h: 100 }, { w: 10, h: Number.NaN })).toBeNull()
    expect(fitRect('cover', undefined, { w: 10, h: 10 })).toBeNull()
    expect(fitRect('contain', { w: 100, h: 100 }, null)).toBeNull()
  })
})

describe('image design — what each state paints', () => {
  it('draws the LOUD notice, and no bitmap, when no image feed is bound', () => {
    const r = drawWith({ feed: null, bitmap: null })
    expect(r.images).toEqual([])
    expect(r.texts.map((t) => t.text)).toEqual(['Feed missing', 'Bind this cell to an image feed'])
    expect(r.texts[0].fillStyle).toBe('#ink') // headline is ink: this is an authoring mistake
    expect(r.texts[1].fillStyle).toBe('#dim')
  })

  it('draws the QUIET never-pushed line verbatim, in dim, and no bitmap', () => {
    const r = drawWith({ feed: { missing: false, mode: 'image', pushed_at: null, image_rev: null }, bitmap: null })
    expect(r.images).toEqual([])
    expect(r.texts).toHaveLength(1)
    expect(r.texts[0].text).toBe('— no image yet')
    expect(r.texts[0].fillStyle).toBe('#dim')
  })

  it('draws the loading line verbatim while a rev is bound but nothing has decoded', () => {
    const r = drawWith({ feed: { missing: false, mode: 'image', pushed_at: 1, image_rev: 2 }, bitmap: null })
    expect(r.images).toEqual([])
    expect(r.texts).toHaveLength(1)
    expect(r.texts[0].text).toBe('loading image…')
    expect(r.texts[0].fillStyle).toBe('#dim')
  })

  /**
   * THE SIZE of both quiet lines, not just their wording — and the scale-1 half of that size, which
   * is this design's own deliberate difference from the other three `quietLine` callers.
   *
   * `quietLine` is shared with `stream/list.mjs`, `table/grid.mjs` and `alert/feed.mjs`
   * (text-fit.mjs), and every design must pin these lines' TEXT and `tokens.dim` COLOUR as well as
   * the shared size, so a helper change cannot silently affect four widgets.
   *
   * `400 12px system-ui`: `Math.min(16, box.w * 0.04) * scale` = `min(16, 300*0.04)` = 12, at the
   * literal `scale` of 1 this design passes. The three sibling designs pass their config's own
   * `n.scale` there and their suites pin scale 2 doubling the line; `image` has never had a `scale`
   * knob (`imageConfig` reads `feed` and `fit`, nothing else — see frame.mjs's docstring), so a
   * `scale` in its config must change NOTHING here. That is asserted rather than assumed: it is
   * the exact difference a future "make these four tests uniform" tidy-up would erase.
   */
  it('draws both quiet lines at the shared helper\'s size, always at scale 1', () => {
    const empty = drawWith({ feed: { missing: false, mode: 'image', pushed_at: null, image_rev: null }, bitmap: null })
    expect(empty.texts[0].font).toBe('400 12px system-ui')

    const loading = drawWith({ feed: { missing: false, mode: 'image', pushed_at: 1, image_rev: 2 }, bitmap: null })
    expect(loading.texts[0].font).toBe('400 12px system-ui')

    const withScale = drawWith({
      config: { feed: 'f', scale: 2 },
      feed: { missing: false, mode: 'image', pushed_at: null, image_rev: null },
      bitmap: null,
    })
    expect(withScale.texts[0].font).toBe('400 12px system-ui')
  })

  it('draws the bitmap through fitRect once decoded', () => {
    const r = drawWith({ box: { w: 300, h: 300, t: 1 } })
    expect(r.images).toHaveLength(1)
    expect(r.images[0].image).toEqual(bitmap(400, 200))
    expect(r.images[0].args).toEqual([0, 0, 400, 200, 0, 75, 300, 150])
    expect(r.texts).toEqual([]) // no chip: age_ms is null (never pushed / no timestamp)
  })

  it('routes `fit` through to the geometry — cover crops where contain letterboxes', () => {
    const contain = drawWith({ config: { feed: 'f', fit: 'contain' } })
    const cover = drawWith({ config: { feed: 'f', fit: 'cover' } })
    expect(contain.images[0].args).toEqual([0, 0, 400, 200, 0, 75, 300, 150])
    expect(cover.images[0].args).toEqual([100, 0, 200, 200, 0, 0, 300, 300])
  })

  it('draws nothing at all into a box with no area', () => {
    for (const box of [{ w: 0, h: 300, t: 1 }, { w: 300, h: 0, t: 1 }]) {
      const r = drawWith({ box })
      expect(r.images).toEqual([])
      expect(r.texts).toEqual([])
    }
  })
})

describe('image design — staleness dims, it does not recolour', () => {
  it('paints the bitmap at half alpha when the wire is stale', () => {
    // `.stale { opacity: .5 }` (index.html) applied to the <img>, and nothing else.
    const r = drawWith({ stale: true })
    expect(r.images[0].alpha).toBe(0.5)
  })

  it('paints at full alpha when the wire is fresh', () => {
    expect(drawWith({ stale: false }).images[0].alpha).toBe(1)
  })

  it('restores globalAlpha afterwards, so the next cell is not painted through this one\'s dimming', () => {
    const r = recorder()
    frame.draw(r.g, baseCtx({ stale: true }), 0)
    expect(r.g.globalAlpha).toBe(1)
  })

  it('does NOT dim the age chip — the stale class was on the image, never on the chip', () => {
    const r = drawWith({ stale: true, age_ms: 120_000 })
    expect(r.images[0].alpha).toBe(0.5)
    expect(r.texts).toHaveLength(1)
    expect(r.texts[0].alpha).toBe(1)
  })
})

describe('image design — the age chip', () => {
  it('paints the chip in formatAge\'s wording, under the image, only once decoded', () => {
    const r = drawWith({ age_ms: 3 * 60_000 })
    expect(r.texts.map((t) => t.text)).toEqual([formatAge(3 * 60_000)])
    expect(r.texts[0].fillStyle).toBe('#dim')
    // Under the image, not over it: the DOM cell was a flex column, img then chip.
    expect(r.texts[0].y).toBeGreaterThanOrEqual(r.images[0].args[5] + r.images[0].args[7])
  })

  it('reserves the chip band so the image never paints over it', () => {
    const withChip = drawWith({ age_ms: 1_000, bitmap: bitmap(100, 100) })
    const without = drawWith({ age_ms: null, bitmap: bitmap(100, 100) })
    const bottom = (r: ReturnType<typeof drawWith>) => r.images[0].args[5] + r.images[0].args[7]
    expect(bottom(withChip)).toBeLessThan(bottom(without))
    expect(bottom(withChip)).toBeLessThanOrEqual(withChip.texts[0].y)
  })

  it('paints no chip at all when the feed has never been pushed to (age_ms null)', () => {
    expect(drawWith({ age_ms: null }).texts).toEqual([])
  })
})

/**
 * The REAL wiring. `bitmaps.mjs` is dependency-injected so it can be tested with no DOM; these are
 * the two host-side pieces that make it actually run on a device — the cell sweep that decides
 * WHICH feeds to load, and the browser primitives it loads them with.
 */
describe('loadCellBitmaps — which cells trigger a fetch', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    fetchBlob: vi.fn(async (id: string) => `blob:${id}`),
    decode: vi.fn(async (raw: unknown) => ({ drawable: raw })),
    revoke: vi.fn(),
    now: () => 0,
    ...over,
  })

  beforeEach(() => resetBitmaps())

  const imageCell = (feed: string) => ({ widget: 'image', config: { feed } })

  it('loads the bitmap for an image cell bound to a pushed image feed', async () => {
    const d = deps()
    loadCellBitmaps([imageCell('f')], { f: { mode: 'image', image_rev: 7 } }, d)
    await Promise.resolve()
    await Promise.resolve()
    expect(d.fetchBlob).toHaveBeenCalledWith('f')
    expect(bitmapFor('f')).toEqual({ drawable: 'blob:f' })
  })

  it('never fetches at image_rev 0 — never pushed is not a failure', async () => {
    const d = deps()
    loadCellBitmaps([imageCell('f')], { f: { mode: 'image', image_rev: 0 } }, d)
    await Promise.resolve()
    expect(d.fetchBlob).not.toHaveBeenCalled()
  })

  it('never fetches for a feed whose mode is not image, whatever the cell claims to be', async () => {
    const d = deps()
    loadCellBitmaps([imageCell('f')], { f: { mode: 'value', payload: { image_rev: 7 }, image_rev: 7 } }, d)
    await Promise.resolve()
    expect(d.fetchBlob).not.toHaveBeenCalled()
  })

  it('never fetches for a cell that is not an image widget, even bound to an image feed', async () => {
    const d = deps()
    loadCellBitmaps([{ widget: 'value_tile', config: { feed: 'f' } }], { f: { mode: 'image', image_rev: 7 } }, d)
    await Promise.resolve()
    expect(d.fetchBlob).not.toHaveBeenCalled()
  })

  it('fetches once for two cells sharing one feed, and once per distinct feed', async () => {
    const d = deps()
    loadCellBitmaps(
      [imageCell('a'), imageCell('a'), imageCell('b')],
      { a: { mode: 'image', image_rev: 1 }, b: { mode: 'image', image_rev: 1 } },
      d,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(d.fetchBlob.mock.calls.map((c: unknown[]) => c[0])).toEqual(['a', 'b'])
  })

  it('survives a malformed board without throwing — bad data must never blank a panel', () => {
    const d = deps()
    expect(() => loadCellBitmaps(null, {}, d)).not.toThrow()
    expect(() => loadCellBitmaps([null, {}, { widget: 'image' }, imageCell('nope')], {}, d)).not.toThrow()
    expect(d.fetchBlob).not.toHaveBeenCalled()
  })

  /**
   * A below-minimum image cell must not fetch or decode a bitmap that it then covers with
   * `tooSmallHtml`'s notice — every render, forever, on a panel that runs for weeks.
   * `image`'s own `minimum_px` is `{ w: 60, h: 60 }` (definitions.mjs); `boxes[i]` is positional,
   * mirroring device.js's own `cells`/`boxes` pairing (`boxes[i]` sizes `cells[i]`).
   */
  it('never fetches for a below-minimum image cell — the deleted ensureImageLoaded\'s own gate', async () => {
    const d = deps()
    const boxes = [{ px: { width: 59, height: 59 } }]
    loadCellBitmaps([imageCell('f')], { f: { mode: 'image', image_rev: 7 } }, d, boxes)
    await Promise.resolve()
    await Promise.resolve()
    expect(d.fetchBlob).not.toHaveBeenCalled()
  })

  it('fetches a same-size-or-larger image cell — the gate is >= the minimum, not >', async () => {
    const d = deps()
    const boxes = [{ px: { width: 60, height: 60 } }]
    loadCellBitmaps([imageCell('f')], { f: { mode: 'image', image_rev: 7 } }, d, boxes)
    await Promise.resolve()
    await Promise.resolve()
    expect(d.fetchBlob).toHaveBeenCalledWith('f')
  })

  it('a missing `boxes` argument applies no size gate at all — every existing call above relies on this', async () => {
    const d = deps()
    loadCellBitmaps([imageCell('f')], { f: { mode: 'image', image_rev: 7 } }, d)
    await Promise.resolve()
    await Promise.resolve()
    expect(d.fetchBlob).toHaveBeenCalledWith('f')
  })
})

/**
 * `bitmapDeps` — the ONE place the real browser primitives are named, and the place the
 * decode/revoke pairing has to stay consistent.
 *
 * `bitmaps.mjs` hands `revoke` the value `fetchBlob` RETURNED (`current.raw`), never the decoded
 * drawable. So the raw has to be the thing that needs releasing: an object URL, released with
 * `URL.revokeObjectURL`. A `createImageBitmap` decode would make the raw a Blob (which needs no
 * release) while the ImageBitmap that DOES hold memory — and only frees on `.close()` — would
 * never be handed to `revoke` at all. See frame.mjs for the full rule.
 */
describe('bitmapDeps — the real browser primitives', () => {
  const originals = {
    fetch: globalThis.fetch,
    Image: (globalThis as Record<string, unknown>).Image,
    createObjectURL: (URL as unknown as Record<string, unknown>).createObjectURL,
    revokeObjectURL: (URL as unknown as Record<string, unknown>).revokeObjectURL,
  }

  let created: unknown[] = []
  let revoked: string[] = []
  let images: FakeImage[] = []

  class FakeImage {
    src = ''
    decodes = true
    decode() { return this.decodes ? Promise.resolve() : Promise.reject(new Error('corrupt')) }
    constructor() { images.push(this) }
  }

  const stubGlobals = (fetchImpl: unknown, ImageImpl: unknown = FakeImage) => {
    globalThis.fetch = fetchImpl as typeof fetch
    ;(globalThis as Record<string, unknown>).Image = ImageImpl
    ;(URL as unknown as Record<string, unknown>).createObjectURL = (blob: unknown) => {
      created.push(blob)
      return `blob:url-${created.length}`
    }
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = (url: string) => { revoked.push(url) }
  }

  beforeEach(() => {
    created = []; revoked = []; images = []
    globalThis.fetch = originals.fetch
    ;(globalThis as Record<string, unknown>).Image = originals.Image
    ;(URL as unknown as Record<string, unknown>).createObjectURL = originals.createObjectURL
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = originals.revokeObjectURL
  })

  const okResponse = (blob: unknown = { bytes: 1 }) => ({ ok: true, status: 200, blob: async () => blob })

  it('fetches the device-token image endpoint with a Bearer header', async () => {
    const fetchSpy = vi.fn(async () => okResponse())
    stubGlobals(fetchSpy)
    await bitmapDeps(() => 'tok_abc').fetchBlob('feed_1')
    expect(fetchSpy).toHaveBeenCalledWith('/api/feeds/feed_1/image', {
      headers: { authorization: 'Bearer tok_abc' },
    })
  })

  it('reads the token per call, so a device paired after page load still authenticates', async () => {
    // Parameters declared (and ignored) so `mock.calls[n][1]` below is the init object rather than
    // an out-of-range index into a zero-argument call tuple.
    const fetchSpy = vi.fn(async (_url: string, _init?: { headers: Record<string, string> }) => okResponse())
    stubGlobals(fetchSpy)
    let token: string | null = null
    const d = bitmapDeps(() => token)
    await d.fetchBlob('f')
    token = 'tok_later'
    await d.fetchBlob('f')
    expect(fetchSpy.mock.calls[1][1]).toEqual({ headers: { authorization: 'Bearer tok_later' } })
  })

  it('returns an object URL for the blob — the raw `revoke` will later be handed', async () => {
    stubGlobals(vi.fn(async () => okResponse({ bytes: 9 })))
    const raw = await bitmapDeps(() => 't').fetchBlob('f')
    expect(created).toEqual([{ bytes: 9 }])
    expect(raw).toBe('blob:url-1')
  })

  it('throws on a non-ok response, so bitmaps.mjs parks the feed instead of caching a 404', async () => {
    stubGlobals(vi.fn(async () => ({ ok: false, status: 403, blob: async () => ({}) })))
    await expect(bitmapDeps(() => 't').fetchBlob('f')).rejects.toThrow(/403/)
    expect(created).toEqual([]) // and no URL was minted for a body we never accepted
  })

  it('decodes the URL into a drawable, fully decoded before it is cached', async () => {
    stubGlobals(vi.fn(async () => okResponse()))
    const drawable = await bitmapDeps(() => 't').decode('blob:url-1')
    expect(images).toHaveLength(1)
    expect(images[0].src).toBe('blob:url-1')
    expect(drawable).toBe(images[0])
  })

  it('revokes the URL it was handed when the decode FAILS — nothing else ever would', async () => {
    stubGlobals(vi.fn(async () => okResponse()), class extends FakeImage { decodes = false })
    await expect(bitmapDeps(() => 't').decode('blob:url-1')).rejects.toThrow()
    // bitmaps.mjs only revokes a raw it managed to cache, so a failed decode's URL is this
    // function's own to release — otherwise every corrupt push leaks a blob for the page's life.
    expect(revoked).toEqual(['blob:url-1'])
  })

  it('falls back to load/error events on an engine with no img.decode()', async () => {
    class OldImage {
      src = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        images.push(this as unknown as FakeImage)
        queueMicrotask(() => this.onload?.())
      }
    }
    stubGlobals(vi.fn(async () => okResponse()), OldImage)
    await expect(bitmapDeps(() => 't').decode('blob:url-1')).resolves.toBe(images[0])
  })

  it('revoke IS revokeObjectURL, paired with the object URL fetchBlob minted', () => {
    stubGlobals(vi.fn(async () => okResponse()))
    bitmapDeps(() => 't').revoke('blob:url-1')
    expect(revoked).toEqual(['blob:url-1'])
  })

  it('now is the LOCAL clock, never hub time — the backoff measures elapsed time', () => {
    stubGlobals(vi.fn(async () => okResponse()))
    const before = Date.now()
    const t = bitmapDeps(() => 't').now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
})

/**
 * device.js is the host page: it runs DOM code at module top level, so no Node test can import it.
 * These are source-shape assertions over the file with its COMMENTS STRIPPED — the implementation's
 * lesson (screen state's twelve-icon guard, satisfied by a comment that merely mentioned an icon) is that
 * a text guard which prose can satisfy is not a guard.
 *
 * What they cannot prove is that the calls RUN — that is the on-glass gate's job. What they do
 * prove is that the three wiring points exist in code and that the DOM branch they replaced is
 * genuinely gone, which is exactly what a later edit could silently undo.
 */
describe('device.js wiring', () => {
  const SRC = readFileSync('static/device/device.js', 'utf8')
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

  it('imports the announce channel and the two wiring helpers', () => {
    expect(CODE).toMatch(/import \{[^}]*\bonBitmapReady\b[^}]*\} from '\.\/widgets\/bitmaps\.mjs'/)
    expect(CODE).toMatch(/import \{[^}]*\bloadCellBitmaps\b[^}]*\} from '\.\/widgets\/index\.mjs'/)
    expect(CODE).toMatch(/import \{[^}]*\bbitmapDeps\b[^}]*\} from '\.\/widgets\/index\.mjs'/)
  })

  it('builds the real deps from the device token', () => {
    expect(CODE).toMatch(/bitmapDeps\(token\)/)
  })

  it('kicks the load for the board being rendered, gated on the same boxes widgetHtml sizes off', () => {
    // `boxes` (device.js's own per-cell pixel sizes, computed via
    // `rectToPx`) has to ride along so `loadCellBitmaps` can skip a too-small cell the same way the
    // deleted `ensureImageLoaded` did from inside `widgetHtml`.
    expect(CODE).toMatch(/loadCellBitmaps\(cells,\s*feeds,\s*\w+,\s*boxes\)/)
  })

  it('repaints when a decode lands, the way it already does for assets', () => {
    expect(CODE).toMatch(/onBitmapReady\(\(\)\s*=>\s*\{[^}]*render\(\)/)
  })

  it('has no trace of the DOM branch it replaced', () => {
    for (const dead of ['ensureImageLoaded', 'imageUrls', 'imageKeyForFeed', 'imagePending',
      'imageFailedAt', 'IMAGE_RETRY_MS', 'feed-image', 'ageChipHtml'])
      expect(CODE).not.toContain(dead)
  })
})

/**
 * THE WIRING, END TO END, IN A REAL BROWSER — the one test that can fail if any single link in the
 * chain is missing, and the reason it exists is that every link above is unit-tested in isolation
 * and a chain of individually-correct links that is never connected is exactly what this code
 * inherited (`ctx.bitmap` shipped in tab state and was permanently `null`, with a green suite).
 *
 * It drives the REAL device page — `device.js`, `renderGrid`, `loadCellBitmaps`, `bitmapDeps`,
 * `bitmaps.mjs`, `onBitmapReady`, `paintWidgets` and the design — against a server that answers
 * `/api/feeds/:id/image` only for a correct Bearer header, and asserts that a picture arrives on
 * the canvas.
 *
 * The board is ONE image cell on purpose. `image` is not in `REPAINT_MS` (widgets/repaint.mjs), so
 * a board with nothing else on it gets no timer repaint at all: after the DATA push there is no
 * other path that can redraw the cell. The pixel therefore turns red if and only if the decode
 * ANNOUNCED itself and something repainted on it — which is precisely the subscription a future
 * edit could drop with every other test in this file still green.
 *
 * Driven mode (`__dashboardzHost`) is what makes it possible without a hub, the same seam
 * board-overflow.test.ts uses — with `token()` added, since an authed image fetch is the point.
 */
describe('an image cell actually shows a picture', () => {
  /**
   * A real, decodable PNG of one solid colour, built here rather than committed as a fixture
   * (feedImage.test.ts's own rule for its sniffing fixtures, applied to a file that must survive
   * an actual decoder rather than a header parser).
   */
  function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    })
    const crc32 = (buf: Buffer) => {
      let c = 0xffffffff
      for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
      return Buffer.concat([len, body, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit truecolour RGB
    const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([
      Buffer.from([0]), // filter: none
      Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb))),
    ])))
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ])
  }

  const RED = solidPng(8, 8, [255, 0, 0])
  const BLUE = solidPng(8, 8, [0, 0, 255])
  const TOKEN = 'tok_e2e'

  const STATE = {
    type: 'STATE', rev: 1, server_time: Date.now(), alerts: [],
    device: { id: 'dev_test', name: 'test', orientation: 'landscape' },
    screen: {
      id: 'lay_img', name: 'test', orientation: 'landscape',
      grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'image', config: { feed: 'f2', fit: 'cover' } }] },
    },
  }
  const dataAtRev = (rev: number) => ({
    type: 'DATA', server_time: Date.now(), snapshot: true,
    feeds: { f2: { id: 'f2', mode: 'image', image_rev: rev, pushed_at: Date.now(), stale_after_s: 3_600 } },
  })
  const deliver = (msg: object) => `__dashboardzDeliver(${JSON.stringify(JSON.stringify(msg))})`

  /** The centre pixel of the one canvas on the board, as [r, g, b, a]. */
  const CENTRE_PIXEL = `
    (() => {
      const c = document.querySelector('canvas.widget-canvas')
      if (!c || !c.width) return null
      const d = c.getContext('2d').getImageData((c.width / 2) | 0, (c.height / 2) | 0, 1, 1).data
      return [d[0], d[1], d[2], d[3]]
    })()`
  /** Poll rather than sleep a fixed time: the fetch, the decode and the repaint are all async. */
  const settleTo = (expr: string, predicate: string) => `
    new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        const v = ${expr}
        if ((${predicate})(v) || Date.now() - started > 8000) resolve(v)
        else setTimeout(tick, 50)
      }
      tick()
    })`

  let server: { url: string; close: () => void }
  let served = RED
  let auth: (string | undefined)[] = []
  let hits = 0

  beforeAll(async () => {
    server = await serveStatic(resolve('static'), {
      '/api/feeds/f2/image': (req, res) => {
        auth.push(req.headers.authorization)
        hits++
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(403).end(); return }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': served.length })
        res.end(served)
      },
    })
  })
  afterAll(() => server?.close())

  const maybe = hasBrowser() ? it : it.skip

  maybe('fetches with the device token, decodes, and repaints the cell with the bitmap', async () => {
    served = RED; auth = []; hits = 0
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 640, 360,
        `window.__dashboardzHost = { send() {}, ready() {}, token: () => '${TOKEN}' }`)
      await page.evaluate(deliver(STATE))
      // Let the STATE's own render and its theme-triggered re-render settle BEFORE the feed
      // arrives, so neither of them can be what paints the picture below.
      await page.evaluate('new Promise(r => setTimeout(r, 300))')

      // Nothing has been pushed yet: the design is on its quiet never-pushed line, not a picture.
      expect(await page.evaluate<number[] | null>(CENTRE_PIXEL)).not.toEqual([255, 0, 0, 255])

      await page.evaluate(deliver(dataAtRev(1)))
      const pixel = await page.evaluate<number[]>(
        settleTo(CENTRE_PIXEL, '(v) => v && v[0] > 200 && v[1] < 60 && v[2] < 60'))

      expect(pixel, 'the image never reached the canvas').toEqual([255, 0, 0, 255])
      expect(auth).toEqual([`Bearer ${TOKEN}`]) // authed, and fetched exactly once

      // A new revision refetches and replaces the picture — the other half of the load rule, and
      // the path bitmaps.mjs revokes the previous object URL on.
      served = BLUE
      await page.evaluate(deliver(dataAtRev(2)))
      const next = await page.evaluate<number[]>(
        settleTo(CENTRE_PIXEL, '(v) => v && v[2] > 200 && v[0] < 60 && v[1] < 60'))
      expect(next, 'a new image_rev did not replace the bitmap').toEqual([0, 0, 255, 255])
      expect(hits).toBe(2)
    } finally {
      await page?.close()
    }
  }, 60_000)
})
