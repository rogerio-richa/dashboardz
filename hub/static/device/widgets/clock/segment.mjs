import { segmentsFor } from '../clock-geometry.mjs'

/**
 * LED seven-segment display. Drawn as geometry, NOT as a font: a segment clock built from
 * polygons cannot be defeated by a missing typeface, and it keeps the deferred fonts slice
 * deferred (starter catalogue).
 *
 * The unlit segments are painted faintly behind the lit ones — without them the display reads as
 * red text; with them, it reads as hardware. It is the detail that sells the design.
 *
 * They are DERIVED, not a token: the lit colour at 12% alpha, which is what an unlit
 * seven-segment element physically is. The seeded colorset was the only thing that could set it to
 * anything but `@surface` — a hand-picked dim red per theme.
 * With colorsets gone (v11) deriving it means the display tracks ANY palette for free, and there
 * is one fewer knob whose wrong value makes a clock look broken.
 *
 * digit_change is a TRANSITION: a lit segment fades in and an extinguished one fades out over
 * DIGIT_MS after the minute rolls over.
 *
 * Its progress is derived from `ctx.now` — hub time — and NOT from `elapsedMs`:
 * The frame clock cannot express this transition: paintWidgets re-registers every
 * cell on every 1s render, restarting elapsed at 0, so an elapsed-driven crossfade replayed once
 * a second forever and spent its first DIGIT_MS showing the PREVIOUS minute at 15:30:20. Hub time
 * puts the window exactly where the digits actually change, once per minute.
 *
 * It also buys the thing the frame clock could not give at all: "the offset can jump, including
 * backwards... a design must snap on a jump, not animate through it" (time behavior for clocks).
 * `now` jumping two minutes moves `sinceBoundary` within the same minute, so the display snaps to
 * the corrected time; only a real rollover lands inside the window, and there is no accumulated
 * state to run forty flips through.
 *
 * Still a pure function of its inputs (contract): a dropped frame is self-correcting and a
 * test asserts the resting and mid-crossfade states by choosing `now`, with no clock running.
 */
const DIGIT_MS = 180

const meta = {
  id: 'segment',
  widget: 'clock',
  label: 'LED segment',
  suggested_ratio: 2.0,
  tokens: {
    segment_on: { type: 'color', default: '@ink' },
    bezel: { type: 'color', default: '@surface' },
    colon: { type: 'color', default: '@accent' },
  },
  animations: { transition: ['digit_change'], persistent: [] },
}
// The reference's alarm bell and AM marker need a 12/24h setting to be meaningful, and that is
// the lane sequenced after theming. No token is declared for them until they are drawn — a
// declared-but-unread token is exactly what the dead-knob test exists to catch.

/** Segment polygons in a 0..1 box, order [a,b,c,d,e,f,g] — see clock-geometry.mjs. */
const T = 0.16 // segment thickness as a fraction of digit width
const SEG_PATHS = [
  [[T, 0], [1 - T, 0], [1 - T * 1.5, T], [T * 1.5, T]],                       // a
  [[1, T], [1, 1 - T], [1 - T, 1 - T * 1.5], [1 - T, T * 1.5]],               // b
  [[1, 1 + T], [1, 2 - T], [1 - T, 2 - T * 1.5], [1 - T, 1 + T * 1.5]],       // c
  [[T, 2], [1 - T, 2], [1 - T * 1.5, 2 - T], [T * 1.5, 2 - T]],               // d
  [[0, 1 + T], [0, 2 - T], [T, 2 - T * 1.5], [T, 1 + T * 1.5]],               // e
  [[0, T], [0, 1 - T], [T, 1 - T * 1.5], [T, T * 1.5]],                       // f
  [[T, 1], [1 - T, 1], [1 - T * 1.5, 1 + T / 2], [T * 1.5, 1 + T / 2]],       // g
]

function polygon(g, pts, x, y, w, h) {
  g.beginPath()
  g.moveTo(x + pts[0][0] * w, y + pts[0][1] * h)
  for (let i = 1; i < pts.length; i++) g.lineTo(x + pts[i][0] * w, y + pts[i][1] * h)
  g.closePath()
  g.fill()
}

function digit(g, value, prev, x, y, w, h, tokens, progress) {
  const on = segmentsFor(value)
  const was = segmentsFor(prev)
  for (let s = 0; s < 7; s++) {
    // A segment that is changing eases between off and on; a stable one sits at its own value.
    const from = was[s], to = on[s]
    const lit = from === to ? to : from + (to - from) * progress
    // The unlit base: the LIT colour at low alpha, so the display reads as hardware under any
    // palette. `segment_off` remains the explicit override for a design that wants one.
    g.globalAlpha = 0.12
    g.fillStyle = tokens.segment_on
    polygon(g, SEG_PATHS[s], x, y, w, h / 2)
    g.globalAlpha = 1
    if (lit > 0) {
      g.globalAlpha = lit
      g.fillStyle = tokens.segment_on
      polygon(g, SEG_PATHS[s], x, y, w, h / 2)
    }
  }
  g.globalAlpha = 1
}

/**
 * Milliseconds since the minute rolled over. Epoch ms modulo a minute, so it needs no Date and no
 * timezone: every real UTC offset is a whole number of minutes, which makes a minute boundary the
 * same instant everywhere. The double modulo keeps it non-negative for a pre-epoch `now`, where
 * JS's `%` returns a negative remainder and would read as "before the boundary" forever.
 */
const sinceRollover = (now) => ((now % 60_000) + 60_000) % 60_000

/**
 * Optional part of the design contract (widgets/index.mjs): is this design animating RIGHT NOW,
 * for this ctx? paintWidgets registers a frame callback only while this says true, and the loop
 * drops the callback when it stops saying true, which is what keeps a calm board at zero frames.
 */
function isAnimating(ctx) {
  return ctx.motion !== 'none' && sinceRollover(ctx.now) < DIGIT_MS
}

function draw(g, ctx, _elapsedMs) {
  const { box, tokens, now, motion } = ctx
  const d = new Date(now)
  const hh = d.getHours(), mm = d.getMinutes()
  const digits = [Math.floor(hh / 10), hh % 10, Math.floor(mm / 10), mm % 10]
  // The previous minute's digits, so a changing digit knows what it is easing FROM. They only
  // reach the screen inside the DIGIT_MS window below; outside it `progress` is 1 and they are
  // not read at all.
  const p = new Date(now - 60_000)
  const ph = p.getHours(), pm = p.getMinutes()
  const prev = [Math.floor(ph / 10), ph % 10, Math.floor(pm / 10), pm % 10]

  const progress = motion === 'none' ? 1 : Math.min(1, sinceRollover(now) / DIGIT_MS)

  g.fillStyle = tokens.bezel
  g.beginPath()
  g.rect(0, 0, box.w, box.h)
  g.fill()

  // Horizontal insets come from box.w and the vertical inset from box.h. They use separate
  // `pad` derived from box.w, which inverted the digits on any cell wider than it is tall: a legal
  // full-width h=0.05 banner on 1080x1920 gave px 1080x96, pad 64.8 and digitH -33.6, so every
  // segment drew upward from its own baseline. digitH is proportional to
  // box.h now and so cannot go negative; the clamp holds that true if the inset is ever rederived.
  const pad = box.w * 0.06
  const padY = box.h * 0.06
  const gap = box.w * 0.03
  const colonW = box.w * 0.05
  const digitW = (box.w - pad * 2 - gap * 3 - colonW) / 4
  const digitH = Math.max(0, box.h - padY * 2)
  const top = padY

  let x = pad
  for (let i = 0; i < 4; i++) {
    digit(g, digits[i], progress >= 1 ? digits[i] : prev[i], x, top, digitW, digitH, tokens, progress)
    x += digitW + gap
    if (i === 1) {
      g.fillStyle = tokens.colon
      for (const cy of [top + digitH * 0.32, top + digitH * 0.68]) {
        g.beginPath()
        g.arc(x + colonW / 2 - gap / 2, cy, colonW * 0.16, 0, Math.PI * 2)
        g.fill()
      }
      x += colonW
    }
  }
}

export default { meta, draw, isAnimating }
