/**
 * Split-flap board, the kind that used to clatter above a train station platform.
 *
 * WHY THIS IS A SQUASH AND NOT A TRUE SOLARI FLIP. A real split-flap card is hinged across its
 * middle: the top half of the outgoing character falls to reveal the top half of the incoming one,
 * while the bottom stays put until the flap lands. Rendering that means showing HALF a glyph, which
 * means clipping — and `clip()` is barred from the portable subset (portable drawing subset) because it does not lower
 * onto a firmware primitive the way `scale` and `translate` do. Drawing order cannot substitute:
 * the two halves mutually overlap, so whichever is drawn second spills over the other.
 *
 * So the whole card squashes about its own centre line instead: the outgoing digit collapses to
 * the hinge, and the incoming one grows back out of it. It is the standard 2D approximation, it
 * needs one `scale` call and no clipping, and at 420ms it reads as a flip. The hinge rule stays
 * fixed across the slot while the card moves behind it, which is what sells the mechanism.
 *
 * UNLIKE `segment.mjs`, THIS DESIGN USES A REAL TYPEFACE. Segment draws polygons precisely so a
 * missing font cannot defeat it. A split-flap board's charm IS its typography, so the trade is
 * made deliberately here and it is the "text fidelity" cost portable drawing subset already names: firmware would
 * substitute its own bitmap font, changing the glyphs but not the layout.
 *
 * Timing comes from `ctx.now`, never from `elapsedMs` — this keeps jumps from making the
 * segment clock show the previous minute. paintWidgets restarts `elapsed` at 0 on every 1s render,
 * so an elapsed-driven flip would replay once a second forever. Hub time puts the window exactly
 * where the digits actually change. A `now` that jumps lands outside the window and the board
 * snaps, rather than running forty flips to catch up (time behavior for clocks).
 *
 * HH:MM only, no seconds — station boards do not show them, and a seconds card would hold the
 * shared board loop at full rate every second instead of twice a minute.
 */

const FLIP_MS = 420

const meta = {
  id: 'flip',
  widget: 'clock',
  label: 'Split-flap',
  suggested_ratio: 2.6,
  tokens: {
    card: { type: 'color', default: '@surface' },
    digit: { type: 'color', default: '@ink' },
    hinge: { type: 'color', default: '@bg' },
    case: { type: 'color', default: '@bg' },
  },
  animations: { transition: ['digit_change'], persistent: [] },
}

/**
 * Milliseconds since the minute rolled over — identical reasoning and identical implementation to
 * segment.mjs's: epoch ms modulo a minute needs no Date and no timezone, because every real UTC
 * offset is a whole number of minutes. The double modulo keeps a pre-epoch `now` non-negative,
 * where JS's `%` returns a negative remainder that would read as "before the boundary" forever.
 */
const sinceRollover = (now) => ((now % 60_000) + 60_000) % 60_000

/** Digits of HH:MM at an instant, read through the same local-time API the board displays. */
function digitsAt(now) {
  const d = new Date(now)
  const hh = d.getHours(), mm = d.getMinutes()
  return [Math.floor(hh / 10), hh % 10, Math.floor(mm / 10), mm % 10]
}

/**
 * The card's vertical scale and the glyph on it, for one slot.
 *
 * A slot whose digit did not change this minute never moves — the tens-of-hours card sits still
 * for ten hours at a time, and animating it would be wrong as well as wasteful. Only a slot that
 * actually changed runs the two phases: the outgoing digit falls to the hinge (accelerating, as
 * gravity would), then the incoming one rises back out of it (decelerating, as it lands).
 */
function flapState(current, previous, progress) {
  if (current === previous || progress >= 1) return { scaleY: 1, glyph: current }
  if (progress < 0.5) {
    const t = progress * 2
    return { scaleY: 1 - t * t, glyph: previous }
  }
  const t = (progress - 0.5) * 2
  return { scaleY: 1 - (1 - t) * (1 - t), glyph: current }
}

function fillRect(g, x, y, w, h) {
  g.beginPath()
  g.rect(x, y, w, h)
  g.fill()
}

function draw(g, ctx, _elapsedMs) {
  const { box, tokens, now, motion } = ctx
  // A zero-or-negative box is legal (a 0.05-high banner cell rounds to nothing on a short screen)
  // and must not produce negative geometry — the geometry bug that inverted segment.mjs's digits.
  if (!(box.w > 0) || !(box.h > 0)) return

  const digits = digitsAt(now)
  const previous = digitsAt(now - 60_000)
  const progress = motion === 'none' ? 1 : Math.min(1, sinceRollover(now) / FLIP_MS)

  // Letterbox to the design's own ratio rather than stretching: a card stretched to a banner stops
  // looking like a card, and the editor's off-ratio marker stays quiet precisely because this runs.
  // This is the design's own doing, not a declaration — no `distorts` metadata is read, and most
  // designs do not need a flag for the two designs that preserve their own ratio.
  const ratio = meta.suggested_ratio
  const w = box.w / box.h > ratio ? box.h * ratio : box.w
  const h = box.w / box.h > ratio ? box.h : box.w / ratio
  const ox = (box.w - w) / 2
  const oy = (box.h - h) / 2

  const gap = w * 0.022
  const colonW = w * 0.06
  const cardW = (w - gap * 3 - colonW) / 4
  const cardH = h

  g.font = `600 ${Math.floor(cardH * 0.62)}px system-ui`
  g.textAlign = 'center'
  g.textBaseline = 'middle'

  let x = ox
  for (let i = 0; i < 4; i++) {
    const { scaleY, glyph } = flapState(digits[i], previous[i], progress)
    const cy = oy + cardH / 2

    // The empty slot behind the card, so a mid-flip card reveals a recess rather than whatever the
    // board painted underneath.
    g.fillStyle = tokens.case
    fillRect(g, x, oy, cardW, cardH)

    // The card itself, squashed about the hinge. `scale` is why this design needed the portable drawing subset
    // allowlist widened; `save`/`restore` bracket it so the device-pixel-ratio transform that
    // `prepare()` installed survives — which is also why `setTransform` could not be used here.
    g.save()
    g.translate(0, cy)
    g.scale(1, scaleY)
    g.translate(0, -cy)
    g.fillStyle = tokens.card
    fillRect(g, x, oy, cardW, cardH)
    g.fillStyle = tokens.digit
    // Three arguments, never four: fillText's 4th parameter is maxWidth, and passing anything
    // else there (a font string, say) yields NaN and silently draws nothing on a real canvas.
    g.fillText(String(glyph), x + cardW / 2, cy)
    g.restore()

    // The hinge rule belongs to the SLOT, not the card, so it stays put while the card moves
    // behind it. That fixed line against the moving card is what reads as a mechanism.
    g.fillStyle = tokens.hinge
    fillRect(g, x, cy - Math.max(1, cardH * 0.012) / 2, cardW, Math.max(1, cardH * 0.012))

    x += cardW + gap
    if (i === 1) {
      g.fillStyle = tokens.digit
      for (const dy of [cardH * 0.34, cardH * 0.66]) {
        g.beginPath()
        g.arc(x + colonW / 2 - gap / 2, oy + dy, Math.max(1, colonW * 0.11), 0, Math.PI * 2)
        g.fill()
      }
      x += colonW
    }
  }
}

/**
 * Optional part of the design contract: is this design moving RIGHT NOW, for this ctx?
 * paintWidgets registers a frame callback only while this says true and the loop drops it the
 * moment it stops, which is what keeps a calm board at zero frames between minutes.
 */
function isAnimating(ctx) {
  return ctx.motion !== 'none' && sinceRollover(ctx.now) < FLIP_MS
}

export default { meta, draw, isAnimating }
