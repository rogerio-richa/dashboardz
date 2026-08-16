/**
 * `image` — the latest bitmap pushed to an image feed, fitted into the cell.
 *
 * This design uses the portable canvas path rather than the hand-written DOM branch (device.js), and is the only one whose
 * pixels come off the network rather than out of a payload. Structurally it follows
 * `stream/list.mjs` and `alert/feed.mjs`: a pure `normalizeImage(bitmap, wire, config)` making
 * every read-path decision, and a `draw` that only paints what normalize decided. The geometry is
 * split out again into `fitRect`, which is pure arithmetic over two rectangles and is therefore
 * unit-testable with no surface at all.
 *
 * THE DESIGN DOES NOT LOAD ANYTHING. `draw` is synchronous and the network is not, so the host owns
 * the fetch/decode/backoff state machine (`widgets/bitmaps.mjs`), the browser primitives it runs on
 * (`bitmapDeps`, widgets/index.mjs) and the sweep that kicks it off per board (`loadCellBitmaps`,
 * called from device.js's renderGrid). All this design ever sees is `ctx.bitmap`: the drawable
 * that is decoded RIGHT NOW, or `null`. That is the same "present once decoded, absent until then"
 * contract `ctx.assets` keeps for design-shipped sprites (assets.mjs), and it is why "nothing
 * decoded yet" is a normal first frame here rather than an error.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY `ctx.feed` IS READ HERE, and why `ctx.bitmap` alone could not carry this widget.
 *
 * The DOM branch drew FOUR states and the plan's channel list (`ctx.bitmap`, `ctx.stale`,
 * `ctx.age_ms`) can only express three of them: a cell bound to a feed the device does not have and
 * a real feed that has never been pushed to are BOTH `bitmap: null, stale: false, age_ms: null`,
 * yet they are opposite messages — one is an authoring mistake to fix loudly, the other is the
 * normal state of a feed nobody has posted to yet and must stay quiet.
 *
 * `ctx.feed` is what separates them, and it says which of THREE things it is (see `feedSignalFor`,
 * widgets/index.mjs): `null` when the cell binds no single feed at all, `missing: true` when it
 * binds an id this device does not have, otherwise the wire's delivery facts — of which this design
 * reads exactly one, `image_rev` (`null` for a feed that has never been pushed or is not an image
 * feed at all). It carries facts, not the wire wrapper, the same discipline `ctx.rows` follows in
 * shaping `{payload, pushed_at}`.
 *
 * BOTH `null` AND `missing: true` DRAW THE LOUD NOTICE HERE, and only one of them is the channel
 * saying something is wrong. An `image` cell binding no feed at all is `null` — not applicable, as
 * far as the channel is concerned — but an image widget with nothing bound is still an authoring
 * mistake nobody can fix by pushing data, so this design's own rule is loud for it. That decision
 * belongs here, per widget, which is exactly why the channel stopped making it.
 * `chart` reads the identical `null` and correctly draws nothing special at all.
 *
 * The shared feed channel carries the same two states that image rendering needs, with the
 * revision under the name that says which mode it belongs to. Every single-feed widget can use
 * the distinction without a widget-specific channel.
 *
 * It is mode-BLIND on purpose: a cell pointed at a VALUE feed gets a feed that exists with no
 * `image_rev`, and therefore the quiet line — which is what the DOM branch did (it looked up
 * `feeds[cfg.feed]` and never checked `mode`). `table` and `value_tile` deliberately do NOT copy
 * that: an image feed is unusable to them and their own DOM branches stayed loud for it. The
 * channel reports the mode and each design rules on it; see `feedSignalFor`.
 *
 * WHY `image_rev` AND NOT `ctx.feed.pushed_at` for the never-pushed test, now that both are on the
 * channel: they are not the same fact for an image feed. `pushed_at` moves for any push; `image_rev`
 * is what the bitmap endpoint is keyed on and what `loadBitmapFor` refuses to fetch at 0. Switching
 * to `pushed_at` would be a behaviour change on a wire where the two can disagree, and this
 * design's states are preserved verbatim.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The four states, preserved exactly as the DOM branch drew them (device.js's old `image` branch):
 *   - `ctx.feed === null` (an unbound cell) or `ctx.feed.missing` (a feed this device does not
 *     have) → the LOUD "Feed missing" notice, the same severity and the same two-line treatment
 *     `stream_list`/`table` give their own missing feed.
 *   - no usable `image_rev` (a real feed, never pushed to) → the QUIET `— no image yet` line,
 *     verbatim including the em dash, matching the old `<div class="clock-date">` treatment —
 *     never-pushed is quiet, not a failure.
 *   - a rev is bound but nothing has decoded → the QUIET `loading image…` line, verbatim.
 *   - decoded → the bitmap, fitted per `fit`, dimmed when `ctx.stale`, with the age chip under it.
 *
 * A NEW REV DOES NOT GO BACK TO "loading". `ctx.bitmap` is whatever decoded LAST, whatever rev the
 * wire is on now, so a push whose fetch is still in flight — or has failed and is parked in
 * bitmaps.mjs's backoff — keeps showing the previous picture. That is the DOM branch's own
 * contract ("a failed image fetch keeps showing the last good bitmap") and it falls out of reading
 * `ctx.bitmap` rather than the rev, so do not "fix" this by comparing the two.
 *
 * `scale` is not a knob for this widget (`imageConfig` reads `feed` and `fit`, nothing else), so
 * the notices paint at scale 1.
 *
 * Two colour-free decisions worth stating, because both look like places a design would reach for
 * a token and must not:
 *   - STALENESS DIMS, IT DOES NOT RECOLOUR. `.stale { opacity: .5 }` (index.html) applied to the
 *     `<img>`, so this sets `globalAlpha` around the `drawImage` and restores it — a colour change
 *     would be a different visual language from every other stale widget on the board.
 *   - THE LETTERBOX IS NOT PAINTED. index.html's own rule said it: `background: transparent` on
 *     `.feed-image`, because the bars ARE the cell's normal background. Filling them with an `ink`
 *     or `dim` token would put a rectangle on the board that has never been there.
 */
import { imageConfig, AGE_CHIP_PX } from '../../layout-core.mjs'
import { centredNotice, formatAge, paintText, quietLine } from '../text-fit.mjs'

const meta = {
  id: 'frame',
  widget: 'image',
  label: 'Image',
  // Matches definitions.mjs's own `image` entry (suggested_ratio: 4/3) — same discipline every
  // other design follows for its widget type.
  suggested_ratio: 4 / 3,
  tokens: {
    // Both are read by the notices only: a bitmap carries its own colour, and nothing here tints
    // it. See the docstring's note on why the letterbox bars are not painted with a token.
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    // The one flat, scalar knob (contract). `feed` is the shared binding every widget has
    // and is not a design option; `choices` must equal `imageConfig`'s accepted set exactly, which
    // is `cover` or — for anything else at all, including a missing key — `contain`.
    fit: { type: 'select', label: 'Fit', default: 'contain', choices: ['contain', 'cover'] },
  },
  animations: { transition: [], persistent: [] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const isRecord = (value) => value !== null && typeof value === 'object'

/**
 * The drawable's intrinsic size, or `null` when it does not have a usable one yet.
 *
 * `naturalWidth`/`naturalHeight` FIRST: the real `decode` returns an `HTMLImageElement`, whose
 * `width`/`height` reflect its (unset, therefore 0-until-loaded) attributes while `naturalWidth` is
 * the intrinsic size. An `ImageBitmap` — the other drawable a host could reasonably wire — has only
 * `width`/`height`, so both are read, in that order. Anything else (a zero, a NaN, an object that
 * is not a drawable at all) reports null, and the caller treats that as "nothing to draw yet"
 * rather than emitting a `drawImage` with NaN in it.
 */
function naturalSize(bitmap) {
  if (!isRecord(bitmap)) return null
  const w = finite(bitmap.naturalWidth) && bitmap.naturalWidth > 0 ? bitmap.naturalWidth : bitmap.width
  const h = finite(bitmap.naturalHeight) && bitmap.naturalHeight > 0 ? bitmap.naturalHeight : bitmap.height
  if (!finite(w) || !finite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

/**
 * Every read-path decision, none of the painting.
 *
 * `bitmap` is `ctx.bitmap` verbatim (tab state's channel) and `feed` is `ctx.feed` verbatim: `null`
 * when this cell binds no feed, `missing: true` when it binds one this device does not have, else
 * the bound feed's delivery facts. See this file's docstring for why both are needed, why this
 * widget is loud for both of the first two, and why a new rev never demotes a decoded bitmap back
 * to `loading`.
 */
export function normalizeImage(bitmap, feed, config) {
  const cfg = imageConfig(config)
  const base = { fit: cfg.fit }

  if (!isRecord(feed) || feed.missing === true) return { ...base, state: 'missing', bitmap: null, natural: null }
  // A malformed or absent rev reads as never-pushed, matching device.js's own `typeof wire.image_rev
  // === 'number' ? wire.image_rev : 0` — garbage in, quiet state out, never a throw. `ctx.feed`
  // normalises it at the seam too (to `null` there, since `0` would be a second way of spelling
  // "absent"); this stays because a design must degrade on its own inputs.
  const rev = finite(feed.image_rev) ? feed.image_rev : 0
  if (rev <= 0) return { ...base, state: 'empty', bitmap: null, natural: null }

  const natural = naturalSize(bitmap)
  if (!natural) return { ...base, state: 'loading', bitmap: null, natural: null }
  return { ...base, state: 'ready', bitmap, natural }
}

/**
 * Where the bitmap lands, as `drawImage`'s 9-argument form: the source rectangle to take and the
 * destination rectangle to put it in. `null` when either rectangle is degenerate, so a caller never
 * emits a draw call with NaN or zero in it.
 *
 * `contain` (CSS `object-fit: contain`, the old inline style's default): scale to the LARGER fit,
 * take the whole source, centre what is left over — letterbox bars, no crop.
 * `cover`: scale to the SMALLER fit, paint the whole destination, take a centred crop of the source
 * — no bars, and the edges of the long axis are cut off.
 *
 * Pure arithmetic on purpose: the geometry is the part most likely to be
 * quietly inverted by a later edit, and it is only testable independently if it never touches `g`.
 */
export function fitRect(fit, box, natural) {
  const bw = box?.w
  const bh = box?.h
  const nw = natural?.w
  const nh = natural?.h
  if (!finite(bw) || !finite(bh) || !finite(nw) || !finite(nh)) return null
  if (bw <= 0 || bh <= 0 || nw <= 0 || nh <= 0) return null

  if (fit === 'cover') {
    const scale = Math.max(bw / nw, bh / nh)
    // Math.min against the natural size keeps a float overshoot from producing a source rectangle
    // wider than the image itself, which browsers pad with transparent pixels.
    const sw = Math.min(nw, bw / scale)
    const sh = Math.min(nh, bh / scale)
    return { sx: (nw - sw) / 2, sy: (nh - sh) / 2, sw, sh, dx: 0, dy: 0, dw: bw, dh: bh }
  }

  const scale = Math.min(bw / nw, bh / nh)
  const dw = nw * scale
  const dh = nh * scale
  return { sx: 0, sy: 0, sw: nw, sh: nh, dx: (bw - dw) / 2, dy: (bh - dh) / 2, dw, dh }
}

/** `.cell .age-chip`'s own 10px font and 2px margin-top (index.html), unscaled — same fixed
 *  treatment `stream_list` gives its own per-row chip, and for the same reason: that CSS rule never
 *  had an inline override, so scaling it here would be a behaviour change. */
const CHIP_GAP = 2
const CHIP_BAND = CHIP_GAP + Math.round(AGE_CHIP_PX * 1.2)

function draw(g, ctx) {
  const { box, tokens, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeImage(ctx.bitmap, ctx.feed, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (n.state === 'missing') {
    centredNotice(g, 'Feed missing', 'Bind this cell to an image feed', box, tokens, pad, 1)
    return
  }
  // `quietLine` (../text-fit.mjs) is `centredNotice`'s one-line sibling; `1` matches the `1` the
  // "missing" branch above already passes `centredNotice`, for the same reason (this design's own
  // docstring: `scale` is not a knob it has ever had, so its notices paint at scale 1).
  if (n.state === 'empty') {
    quietLine(g, '— no image yet', box, tokens, pad, 1)
    return
  }
  if (n.state === 'loading') {
    quietLine(g, 'loading image…', box, tokens, pad, 1)
    return
  }

  // The chip is drawn only in this state, exactly as the DOM branch appended `ageChipHtml(wire)`
  // only to the `<img>` return — and only when the feed has actually been pushed to (`age_ms`
  // null ⇒ never-pushed ⇒ no chip: never-pushed is quiet, not stale.
  const chip = finite(ctx.age_ms) ? formatAge(ctx.age_ms) : null
  // The `<img>` was `flex: 1` in a flex COLUMN with the chip below it, so the picture never had the
  // chip's band to paint into. Reserving it here is what keeps that true on canvas, where nothing
  // stops a draw from covering the text drawn after it.
  const frame = { w: box.w, h: Math.max(0, box.h - (chip === null ? 0 : CHIP_BAND)) }
  const rect = fitRect(n.fit, frame, n.natural)

  if (rect) {
    // Dim, do not recolour (see the docstring). Restored unconditionally: `g` is shared with
    // whatever paints next, and a leaked 0.5 would fade a neighbouring cell for reasons nothing
    // in that cell could explain.
    g.globalAlpha = ctx.stale === true ? 0.5 : 1
    g.drawImage(n.bitmap, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh)
    g.globalAlpha = 1
  }

  if (chip !== null) {
    // Hard left at the cell edge, like the `.age-chip` div in a full-width flex column — NOT inset
    // by `pad`, which is this design's notice padding and was never applied to the DOM chip.
    paintText(g, chip, 0, frame.h + CHIP_GAP, {
      px: AGE_CHIP_PX, floor: AGE_CHIP_PX, maxWidth: box.w,
      color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
    })
  }
}

export default { meta, draw }
