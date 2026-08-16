/**
 * Shrink-to-fit text, word-wrapping, and the age caption's wording — the helpers every text-bearing
 * design needs and none of them should own.
 *
 * These lived as byte-identical copies in `text/block.mjs`, `value/tile.mjs`, `gauge/ring.mjs`,
 * `gauge/bar.mjs` and `calendar/agenda.mjs`, each justifying the copy differently: one said "a
 * design reaches for nothing beyond `g`/`ctx`", another said the opposite for the same helper, a
 * third called itself "the one sanctioned exception, not a precedent". Three rationales for one
 * decision, in files an outside author is meant to copy from, is worse than either answer alone.
 *
 * The settled rule (see `docs/architecture/widgets.md`): a design may import pure helper modules —
 * ones that compute and return values, touch no DOM, no network and no clock, and behave
 * identically under a recording surface. This is such a module. It reaches for nothing but the `g`
 * it is handed.
 *
 * Fitting belongs here rather than in each design because it is not a stylistic choice: how a label
 * shrinks and where it ellipsises is something a board should do the same way everywhere, and five
 * copies are five chances for it to stop being the same.
 */

/**
 * The largest size at or below `start` (never below `floor`) at which `value` fits `maxWidth`, and
 * the text to draw at it — ellipsised at the floor when even that does not fit.
 *
 * Binary search rather than stepping down a pixel at a time: a long title in a narrow cell would
 * otherwise cost dozens of `measureText` calls per frame, and `measureText` is the expensive part.
 */
export function fitted(g, value, start, floor, maxWidth, weight) {
  const startPx = Math.max(floor, Math.round(start))
  const measuredWidth = (candidate, px) => {
    g.font = `${weight} ${px}px system-ui`
    return g.measureText(candidate).width
  }
  if (maxWidth <= 0) return { text: '', px: floor }
  if (measuredWidth(value, startPx) <= maxWidth) return { text: value, px: startPx }

  if (startPx > floor && measuredWidth(value, floor) <= maxWidth) {
    let fits = floor
    let doesNotFit = startPx
    while (fits + 1 < doesNotFit) {
      const candidate = Math.floor((fits + doesNotFit) / 2)
      if (measuredWidth(value, candidate) <= maxWidth) fits = candidate
      else doesNotFit = candidate
    }
    return { text: value, px: fits }
  }

  // Code points, not code units: slicing mid-surrogate produces a replacement glyph on the wall.
  g.font = `${weight} ${floor}px system-ui`
  const suffix = '...'
  const points = Array.from(value)
  let fits = 0
  let doesNotFit = points.length
  while (fits < doesNotFit) {
    const candidate = Math.ceil((fits + doesNotFit) / 2)
    const clipped = `${points.slice(0, candidate).join('')}${suffix}`
    if (g.measureText(clipped).width <= maxWidth) fits = candidate
    else doesNotFit = candidate - 1
  }
  return { text: fits ? `${points.slice(0, fits).join('')}${suffix}` : '', px: floor }
}

/** `fitted` plus the actual paint. Returns the fit so a caller can advance its own cursor by it. */
export function paintText(g, value, x, y, options) {
  const weight = options.weight ?? 400
  const fit = fitted(g, value, options.px, options.floor, options.maxWidth, weight)
  if (!fit.text) return fit
  g.fillStyle = options.color
  g.font = `${weight} ${fit.px}px system-ui`
  g.textAlign = options.align ?? 'left'
  g.textBaseline = options.baseline ?? 'top'
  g.fillText(fit.text, x, y)
  return fit
}

/**
 * A single line, ellipsised to fit at a FIXED size — the counterpart to `fitted`, which shrinks the
 * size itself. Wrapping needs a fixed px per line, so it cannot use `fitted`'s shrink.
 */
function ellipsizeLine(g, line, px, weight, maxWidth) {
  g.font = `${weight} ${px}px system-ui`
  if (g.measureText(line).width <= maxWidth) return line
  const points = Array.from(line)
  let fits = 0
  let doesNotFit = points.length
  while (fits < doesNotFit) {
    const candidate = Math.ceil((fits + doesNotFit) / 2)
    const clipped = `${points.slice(0, candidate).join('')}...`
    if (g.measureText(clipped).width <= maxWidth) fits = candidate
    else doesNotFit = candidate - 1
  }
  return fits ? `${points.slice(0, fits).join('')}...` : '...'
}

/**
 * Word-wrap into as many lines as `text` needs, at a fixed `px`. Unbounded by design — the caller
 * (`wrapClamped`) decides how many of these lines actually get drawn; deciding it here would mean
 * measuring twice to also learn "was there more".
 */
function wrapAll(g, text, px, weight, maxWidth) {
  g.font = `${weight} ${px}px system-ui`
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word
    if (current !== '' && g.measureText(attempt).width > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = attempt
    }
    // A lone word wider than the whole line (a long unbroken token — the JSON-fallback case has no
    // spaces at all): flush and ellipsise it now rather than leaving it to overhang every line it
    // would otherwise be prefixed onto.
    if (current === word && g.measureText(current).width > maxWidth) {
      lines.push(ellipsizeLine(g, current, px, weight, maxWidth))
      current = ''
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * `-webkit-line-clamp`'s canvas equivalent: at most `maxLines` lines, the last one ellipsised when
 * there was more text than fit — the multi-line counterpart to `fitted`'s single-line
 * shrink-then-ellipsise.
 *
 * This lived in `stream/list.mjs`, whose docstring justified keeping it local on the grounds that
 * this module's contract named exactly three helpers and "wrapping to N lines was never one of
 * them". That held while there was one consumer. `alert_feed`'s `clamp.title_lines`/`body_lines`
 * are the same `-webkit-line-clamp` translation, so the choice became "promote it or copy it" —
 * and a byte-identical copy in a second design is the precise thing this module was created to end
 * (see the header above). Promoted rather than copied; the contract now names four.
 */
const DISPLAY_CODE_POINT_LIMIT = 512
export function wrapClamped(g, text, px, weight, maxWidth, maxLines) {
  if (!text || maxLines <= 0 || maxWidth <= 0) return []
  const points = Array.from(text)
  const clamped = points.length > DISPLAY_CODE_POINT_LIMIT ? points.slice(0, DISPLAY_CODE_POINT_LIMIT).join('') : text
  const all = wrapAll(g, clamped, px, weight, maxWidth)
  if (all.length <= maxLines) return all
  const visible = all.slice(0, maxLines)
  visible[maxLines - 1] = ellipsizeLine(g, visible[maxLines - 1], px, weight, maxWidth)
  return visible
}

/**
 * The two-line centred notice every migrated design draws when it has nothing real to paint — a
 * headline in `ink` over a detail line in `dim`, both shrunk together until the pair fits.
 *
 * Promoted here on exactly the reasoning the header above gives, and for the fifth time: this was
 * byte-identical (verified by hashing each copy) in `text/block.mjs`, `value/tile.mjs`,
 * `calendar/agenda.mjs`, `stream/list.mjs` and `table/grid.mjs`, and `image/frame.mjs` would have
 * been the sixth. What it decides — how loud a notice is, how it shrinks, how much air sits
 * between the two lines — is a board-wide answer, not a per-design one, so six copies were six
 * chances for one cell's "Feed missing" to stop looking like the next cell's.
 *
 * Only the WORDING stays with each design, because that is the part that genuinely differs
 * ("No value" / "Feed missing" / "Nothing on"). `scale` is passed in rather than read, since the
 * designs that have a scale knob apply it here and the ones that do not pass 1.
 */
export function centredNotice(g, headline, detail, box, tokens, pad, scale) {
  const usableHeight = Math.max(0, box.h - pad * 2)
  const headlinePx = Math.max(12, Math.round(Math.min(24, box.w * 0.055, usableHeight * 0.24) * scale))
  const detailPx = Math.max(10, Math.round(Math.min(16, box.w * 0.032, usableHeight * 0.15) * scale))
  const preferredTotal = headlinePx + detailPx + 8
  const fit = preferredTotal > usableHeight && preferredTotal > 0 ? usableHeight / preferredTotal : 1
  const fittedHeadline = Math.max(12, Math.floor(12 + (headlinePx - 12) * fit))
  const fittedDetail = Math.max(10, Math.floor(10 + (detailPx - 10) * fit))
  const top = pad + Math.max(0, (usableHeight - (fittedHeadline + fittedDetail + 8)) / 2)
  paintText(g, headline, box.w / 2, top, {
    px: fittedHeadline, floor: 12, maxWidth: box.w - pad * 2,
    color: tokens.ink, align: 'center', weight: 600,
  })
  paintText(g, detail, box.w / 2, top + fittedHeadline + 8, {
    px: fittedDetail, floor: 10, maxWidth: box.w - pad * 2,
    color: tokens.dim, align: 'center', weight: 400,
  })
}

/**
 * The one-line notice a design paints instead, when its binding is CORRECT but there is nothing to
 * show yet (never-pushed, not a failure) — `centredNotice`'s quiet, one-line sibling: same
 * `tokens.dim`, weight 400, centred/middle placement, and the same `pad`/`scale` shape, just no
 * headline/detail split and a size derived from the cell's WIDTH (there is no second line to share
 * height with).
 *
 * Promoted on `centredNotice`'s own reasoning, from a fifth-time repeat of the SAME story: byte-
 * identical in `stream/list.mjs`, `table/grid.mjs` and `alert/feed.mjs` (only the wording differed),
 * and a near-copy in `image/frame.mjs`'s local `quiet()` that omitted the `* scale` term — because,
 * per that design's own docstring, `image_frame` has no scale knob at all. Rather than flatten that
 * difference away, `scale` is a real parameter here too; `image/frame.mjs` now calls this with a
 * literal `1`, exactly how it already calls `centredNotice` for the identical reason.
 */
export function quietLine(g, text, box, tokens, pad, scale) {
  const px = Math.max(10, Math.round(Math.min(16, box.w * 0.04) * scale))
  paintText(g, text, box.w / 2, box.h / 2, {
    px, floor: 10, maxWidth: Math.max(0, box.w - pad * 2),
    color: tokens.dim, align: 'center', baseline: 'middle', weight: 400,
  })
}

/**
 * How long ago, in the short vocabulary `now` / `Nm ago` / `Nh ago` / `Nd ago` — so a board reads
 * consistently rather than saying "5m ago" in one cell and something else in the next.
 *
 * This absorbed `layout-core.mjs`'s `ageChip`, which computed the identical string on every
 * reachable input (only the input guard differed, `asNumber(x, 0)` vs this function's
 * `Math.max(0, x)` — same output either way) but had gone production-dead: `ageChipHtml`, its last
 * caller in device.js, was deleted when `image` — the last DOM-branch widget — migrated to canvas.
 * `ageChip`'s own vector coverage moved here with it (hub/test/text-fit.test.ts) rather than being
 * dropped.
 *
 * NOT the only age wording on a board: `alert_feed`'s card meta line has always used device.js's
 * own `ago()` (`45s`/`3m`/`2h`, Math.round, no suffix), which is a different vocabulary from this
 * one. `alert/feed.mjs` states its own rather than reusing this, deliberately — see its docstring.
 */
export function formatAge(ageMs) {
  const ms = typeof ageMs === 'number' && Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0
  if (ms < 60_000) return 'now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}
