/**
 * Nixie tubes — cold-cathode glow, one stacked wire numeral per tube.
 *
 * THE FIRST DESIGN THAT DRAWS FROM ARTWORK, and the reason the asset channel exists. Everything
 * that makes a nixie look like a nixie is in the physics of the object: the honeycomb anode mesh,
 * the unlit cathodes crowding behind the lit one, the orange bloom on the glass, the depth of a
 * numeral sitting some millimetres behind the one in front of it. None of that is code-drawable
 * within the portable subset, and a polygon approximation of it would be a worse lie than a
 * photograph — so this design ships a sprite sheet and lights it, and `segment.mjs` remains the
 * design that proves a clock can be drawn from nothing but geometry.
 *
 * THE SHEET, measured rather than assumed: 6x2 cells of 104x158 at origin (4, 0), glyph order
 * `1 2 3 4 5 6 / 7 8 9 0 . :`. Zero is the TENTH glyph, not the first — the sheet is ordered the
 * way the numerals are stacked inside a real tube, and reading it as 0-9 would put a 1 wherever a
 * 0 belongs. The outer cells' GLOW is clipped at the sheet edge (the artwork is 632 wide against
 * 6 x 104 = 624), but the middle pitches are exactly 104 and every card is intact, so a uniform
 * grid is correct and the clipping costs a few pixels of bloom on the first and last tube.
 *
 * THE MECHANISM IS A CROSSFADE, and it is what makes this design worth having over a static
 * sprite. A nixie does not flip, slide, or blank: the outgoing cathode's glow DECAYS while the
 * incoming one strikes, and for a moment you can see both. `globalAlpha` has been in the portable
 * subset since portable drawing subset and nothing had used it. Because every cell carries its own tube body, fading
 * one whole cell into another also crossfades the body — which is free, and correct, since the
 * bodies are near-identical.
 *
 * 260ms, not the split-flap's 420: a cathode strikes fast, and a nixie that lingers reads as a
 * dissolve rather than a discharge.
 *
 * Timing comes from `ctx.now`, never `elapsedMs` — this keeps jumps from making the segment
 * clock show the previous minute. paintWidgets restarts `elapsed` at 0 on every 1s render, so an
 * elapsed-driven fade would replay once a second forever.
 *
 * HH:MM only. A seconds tube would hold the shared board loop at full rate every second instead of
 * twice a minute, and a nixie's cathodes have a finite life — running the units-of-seconds tube is
 * how real clocks kill them.
 */

const STRIKE_MS = 260

// Cell geometry of the shipped sheet. See the measurement note above.
const CELL_W = 104
const CELL_H = 158
const ORIGIN_X = 4
const COLS = 6
const COLON_INDEX = 11

const meta = {
  id: 'nixie',
  widget: 'clock',
  label: 'Nixie tube',
  // Five tubes at the cell's own 104:158, plus a hair of gap between them.
  suggested_ratio: 3.4,
  /**
   * Used ONLY by the codeform below, which runs until the sheet has decoded and forever if it
   * failed. The artwork itself is never recoloured (asset ownership rule): a nixie's orange is the neon in the
   * tube, not a theme decision, and tinting a photograph of a glow produces neither.
   */
  tokens: {
    tube: { type: 'color', default: '@surface' },
    glow: { type: 'color', default: '@accent' },
  },
  assets: { glyphs: 'nixie-glyphs.png' },
  animations: { transition: ['digit_change'], persistent: [] },
}

/**
 * Where a glyph sits on the sheet. Index order is the sheet's own — `1..6` then `7 8 9 0 . :` —
 * so a digit maps through `0 -> 9`, everything else through `d - 1`.
 */
const cellAt = (index) => ({
  sx: ORIGIN_X + (index % COLS) * CELL_W,
  sy: Math.floor(index / COLS) * CELL_H,
})
const digitCell = (d) => cellAt(d === 0 ? 9 : d - 1)

/**
 * Milliseconds since the minute rolled over — the same reasoning and the same implementation as
 * segment.mjs and flip.mjs: epoch ms modulo a minute needs no Date and no timezone, because every
 * real UTC offset is a whole number of minutes. The double modulo keeps a pre-epoch `now`
 * non-negative, where JS's `%` returns a negative remainder that would read as "before the
 * boundary" forever.
 */
const sinceRollover = (now) => ((now % 60_000) + 60_000) % 60_000

/** Digits of HH:MM at an instant, read through the same local-time API the board displays. */
function digitsAt(now) {
  const d = new Date(now)
  const hh = d.getHours(), mm = d.getMinutes()
  return [Math.floor(hh / 10), hh % 10, Math.floor(mm / 10), mm % 10]
}

function draw(g, ctx, _elapsedMs) {
  const { box, tokens, now, motion, assets } = ctx
  // A zero-or-negative box is legal (a 0.05-high banner cell rounds to nothing on a short screen)
  // and must not produce negative geometry — the geometry bug that inverted segment.mjs's digits.
  if (!(box.w > 0) || !(box.h > 0)) return

  const digits = digitsAt(now)
  const previous = digitsAt(now - 60_000)
  const progress = motion === 'none' ? 1 : Math.min(1, sinceRollover(now) / STRIKE_MS)

  // Letterbox rather than stretch — the design's own doing, and the editor's off-ratio marker stays
  // quiet precisely because this runs. Aspect preservation belongs to this design, not to metadata;
  // no `distorts` flag is read by the renderer.
  const ratio = meta.suggested_ratio
  const w = box.w / box.h > ratio ? box.h * ratio : box.w
  const h = box.w / box.h > ratio ? box.h : box.w / ratio
  const ox = (box.w - w) / 2
  const oy = (box.h - h) / 2

  // Five tubes across, each at the sheet cell's own aspect so a numeral is never squashed.
  const gap = w * 0.012
  const tubeW = (w - gap * 4) / 5
  const tubeH = tubeW * (CELL_H / CELL_W)
  const top = oy + (h - tubeH) / 2

  const sheet = assets?.glyphs
  if (!sheet) { codeform(g, tokens, digits, ox, top, tubeW, tubeH, gap); return }

  // Slot order is H H : M M, so the colon sits at index 2 of the drawn row.
  let x = ox
  for (let slot = 0; slot < 5; slot++) {
    if (slot === 2) {
      const c = cellAt(COLON_INDEX)
      g.drawImage(sheet, c.sx, c.sy, CELL_W, CELL_H, x, top, tubeW, tubeH)
      x += tubeW + gap
      continue
    }
    const i = slot < 2 ? slot : slot - 1
    const to = digitCell(digits[i])
    if (digits[i] === previous[i] || progress >= 1) {
      g.drawImage(sheet, to.sx, to.sy, CELL_W, CELL_H, x, top, tubeW, tubeH)
    } else {
      // Both cathodes are conducting. save/restore rather than assigning globalAlpha back by hand,
      // so an exception mid-fade cannot leave the next widget painted through a half-lit tube.
      const from = digitCell(previous[i])
      g.save()
      g.globalAlpha = 1 - progress
      g.drawImage(sheet, from.sx, from.sy, CELL_W, CELL_H, x, top, tubeW, tubeH)
      g.globalAlpha = progress
      g.drawImage(sheet, to.sx, to.sy, CELL_W, CELL_H, x, top, tubeW, tubeH)
      g.restore()
    }
    x += tubeW + gap
  }
}

/**
 * What a board shows before the sheet has decoded, and forever if it 404s (assets.mjs: a name is
 * absent until ready, never half-loaded). Deliberately plain — this is the state that says "the
 * artwork has not arrived", and dressing it up as a hand-drawn nixie would hide a real failure
 * behind a passable clock.
 */
function codeform(g, tokens, digits, ox, top, tubeW, tubeH, gap) {
  const text = `${digits[0]}${digits[1]}:${digits[2]}${digits[3]}`
  g.fillStyle = tokens.tube
  let x = ox
  for (let slot = 0; slot < 5; slot++) {
    g.beginPath()
    g.rect(x, top, tubeW, tubeH)
    g.fill()
    x += tubeW + gap
  }
  const width = tubeW * 5 + gap * 4
  g.fillStyle = tokens.glow
  g.font = `600 ${Math.floor(tubeH * 0.56)}px system-ui`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  // Three arguments, never four: fillText's 4th parameter is maxWidth, and passing anything else
  // there yields NaN and silently draws nothing on a real canvas.
  g.fillText(text, ox + width / 2, top + tubeH / 2)
}

/**
 * Optional part of the design contract: is this design moving RIGHT NOW, for this ctx?
 * paintWidgets registers a frame callback only while this says true, and the loop drops it the
 * moment it stops — which is what keeps a calm board at zero frames between minutes.
 */
function isAnimating(ctx) {
  return ctx.motion !== 'none' && sinceRollover(ctx.now) < STRIKE_MS
}

export default { meta, draw, isAnimating }
