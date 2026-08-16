/**
 * `text_block` / `led` — the cell's text as a dot-matrix sign: a grid of round dots, the lit ones
 * spelling the message, the unlit ones left faintly visible so the panel reads as a PANEL rather
 * than as floating text. The second `text_block` design, after `block`.
 *
 * WHY `text_block`. It is the one widget whose content is a config-level XOR — literal `text`, or
 * a `feed`+`path` binding, or a pending binding — so the same design is a fixed sign ("OPEN",
 * "WELCOME HOME") and a live one (a number off a feed) with no new widget type and no migration.
 * Newlines split the message into rows; `led.lines` caps how many are shown.
 *
 * COLOUR, AND THE ESCAPE HATCH. Panel colour normally comes from the theme, through the `on`,
 * `off` and `glow` tokens — that is what the token system is for, and a themed board should be
 * able to restyle its sign. But a sign is also a decoration someone picks a colour for on purpose,
 * so `led.color` takes a full RGB hex and, when set, OVERRIDES the theme for that panel;
 * `led.colors` does the same per line. That is a deliberate hole in theming, not an oversight:
 * a sign set to `#ff0044` stays `#ff0044` under every theme, which is what "pick the colour of my
 * sign" has to mean. Anything that is not a valid hex falls back to the token rather than reaching
 * the canvas — board config carries whatever an operator typed, and it becomes a `fillStyle`.
 *
 * EFFECTS AND THE FRAME BUDGET. `loop.mjs` idles the whole board to zero frames when nothing
 * moves, which matters on a panel that is on 24/7. `effect: 'none'` — the default — paints once
 * and reports `isAnimating` false. `scroll`, `blink` and `rainbow` ask for frames only while they
 * are actually set, and never under the viewer's reduced-motion preference. Every effect is a pure
 * function of elapsed-ms (animation contract), so a dropped frame changes nothing but when
 * the next one lands.
 */
import { glyphFor, GLYPH_H, GLYPH_W } from './led-font.mjs'
import { resolvePath } from '../../layout-core.mjs'
import { centredNotice } from '../text-fit.mjs'

const EFFECTS = ['none', 'scroll', 'blink', 'rainbow', 'wipe', 'snow']
const BORDERS = ['none', 'chase', 'blink', 'alternate']
/** Bulbs are the sign's other hardware: bigger lamps, spaced further apart than the matrix dots. */
const BULB_SPACING = 26
/** How many ring steps a chase advances per second at the default speed. */
const CHASE_STEPS_PER_S = 5
/** One lit bulb in every three: the pattern every fairground sign has used since they were bulbs. */
const CHASE_PERIOD = 3
/** How long a `snow` cycle takes to assemble the whole message, then start over. */
const SNOW_MS = 3_000
/** Dot columns of blank run-out before a `wipe` front comes round again. */
const WIPE_MARGIN = 8
const MAX_LINES = 6
const DEFAULTS = Object.freeze({ lines: 1, effect: 'none', speed: 40, off_dots: true, glow: true, border: 'none' })
/** Blink period: on for the first half, off for the second. */
const BLINK_MS = 1_200

const meta = {
  id: 'led',
  widget: 'text_block',
  label: 'LED sign',
  suggested_ratio: 3 / 1,
  tokens: {
    on: { type: 'color', default: '@accent' },
    off: { type: 'color', default: '@dim' },
    glow: { type: 'color', default: '@accent' },
  },
  options: {
    lines: { type: 'number', label: 'Lines', default: DEFAULTS.lines, path: 'led.lines' },
    color: { type: 'text', label: 'Colour (hex, blank = theme)', path: 'led.color' },
    colors: { type: 'text', label: 'Per-line colours (comma separated)', path: 'led.colors' },
    effect: { type: 'select', label: 'Effect', choices: EFFECTS, default: DEFAULTS.effect, path: 'led.effect' },
    speed: { type: 'number', label: 'Effect speed', default: DEFAULTS.speed, path: 'led.speed' },
    off_dots: { type: 'boolean', label: 'Show unlit dots', default: DEFAULTS.off_dots, path: 'led.off_dots' },
    glow: { type: 'boolean', label: 'Glow', default: DEFAULTS.glow, path: 'led.glow' },
    border: { type: 'select', label: 'Marquee bulbs', choices: BORDERS, default: DEFAULTS.border, path: 'led.border' },
    border_color: { type: 'text', label: 'Bulb colour (hex, blank = the sign\'s)', path: 'led.border_color' },
  },
  animations: { transition: [], persistent: ['scroll', 'blink', 'rainbow'] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * `#rgb` / `#rrggbb` / bare `rrggbb` → `#rrggbb`, anything else → null.
 *
 * Strict on purpose. This value is operator-typed config on its way to becoming a `fillStyle`, and
 * "anything the canvas happens to accept" is a wider surface than a colour knob needs.
 */
export function normaliseHex(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  return null
}

/** The design's settings, defaulted the way the option declarations above promise. */
export function ledConfig(config) {
  // Named for the container it holds, and aliased with `&&`/ternary rather than `?.`/`??`, because
  // that is the shape knob-coverage's analyser follows (see `stream/ticker.mjs` for the long form).
  const c = config && typeof config === 'object' ? config : {}
  const led = c.led && typeof c.led === 'object' ? c.led : {}
  const lines = finite(led.lines) ? Math.max(1, Math.min(MAX_LINES, Math.round(led.lines))) : DEFAULTS.lines
  const speed = finite(led.speed) && led.speed >= 0 ? led.speed : DEFAULTS.speed
  const colors = typeof led.colors === 'string'
    ? led.colors.split(',').map((part) => normaliseHex(part)).filter((hex) => hex !== null)
    : []
  return {
    lines,
    speed,
    colors,
    color: normaliseHex(led.color),
    effect: EFFECTS.includes(led.effect) ? led.effect : DEFAULTS.effect,
    offDots: typeof led.off_dots === 'boolean' ? led.off_dots : DEFAULTS.off_dots,
    border: BORDERS.includes(led.border) ? led.border : DEFAULTS.border,
    borderColor: normaliseHex(led.border_color),
    glow: typeof led.glow === 'boolean' ? led.glow : DEFAULTS.glow,
  }
}

/** The message, split into at most `lines` rows. */
export function ledLines(text, lines) {
  if (typeof text !== 'string' || text.trim() === '') return []
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, Math.max(1, lines))
}

/** Is the panel lit at this instant? Only `blink` ever says no. */
export function litAt(effect, elapsedMs, speed) {
  if (effect !== 'blink') return true
  const rate = speed > 0 ? speed : DEFAULTS.speed
  const period = Math.max(200, BLINK_MS * (DEFAULTS.speed / rate))
  return (((elapsedMs % period) + period) % period) < period / 2
}

/** Hue for a dot at `x`, walking across the panel and around the wheel over time. */
export function hueAt(x, elapsedMs, speed) {
  const rate = speed > 0 ? speed : DEFAULTS.speed
  const hue = x * 1.6 + (elapsedMs / 1000) * rate
  return ((hue % 360) + 360) % 360
}

/**
 * Where the marquee bulbs sit: a ring around the panel edge, evenly spaced, corners included.
 *
 * Spacing is a target, not a promise — each side divides its own length into whole steps so the
 * corners always land on a bulb and no side ends with a half-gap. Returned in ring order (top row
 * left→right, right column, bottom row right→left, left column), which is what makes a chase
 * travel AROUND the sign rather than jump between sides.
 */
export function borderBulbs(w, h, spacing, inset = 0) {
  if (!(w > 0) || !(h > 0) || !(spacing > 0)) return []
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset
  if (!(x1 > x0) || !(y1 > y0)) return []
  const cols = Math.max(1, Math.round((x1 - x0) / spacing))
  const rows = Math.max(1, Math.round((y1 - y0) / spacing))
  const dx = (x1 - x0) / cols
  const dy = (y1 - y0) / rows
  const bulbs = []
  for (let i = 0; i < cols; i++) bulbs.push({ x: x0 + i * dx, y: y0 })
  for (let i = 0; i < rows; i++) bulbs.push({ x: x1, y: y0 + i * dy })
  for (let i = cols; i > 0; i--) bulbs.push({ x: x0 + i * dx, y: y1 })
  for (let i = rows; i > 0; i--) bulbs.push({ x: x0, y: y0 + i * dy })
  return bulbs
}

/**
 * Is bulb `i` lit right now? Pure, on `ctx.now` like everything else here — never `elapsedMs`.
 *
 * `chase` walks a one-in-three run around the ring, `blink` flashes the whole ring together,
 * `alternate` swaps odds and evens. Anything else — including a typo — is dark, because a border
 * nobody asked for is worse than one that fails to appear.
 */
export function bulbLit(mode, i, count, clock, speed) {
  const rate = (speed > 0 ? speed : DEFAULTS.speed) / DEFAULTS.speed * CHASE_STEPS_PER_S
  const step = Math.floor((clock / 1000) * rate)
  if (mode === 'chase') return (((i - step) % CHASE_PERIOD) + CHASE_PERIOD) % CHASE_PERIOD === 0
  if (mode === 'blink') return step % 2 === 0
  if (mode === 'alternate') return (((i + step) % 2) + 2) % 2 === 0
  return false
}

/**
 * A dot's own scramble value in [0,1): stable per position, spread out enough that neighbours do
 * not land together. An integer hash, NOT `Math.random` — a design may not read a clock or a random
 * source (portable drawing subset), and a reveal has to look identical on every device showing the same sign.
 */
function scatter(x, y) {
  let h = (x * 73_856_093) ^ (y * 19_349_663)
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

/**
 * Is this lit dot visible RIGHT NOW under a reveal effect?
 *
 * The entry effects a programmable sign ships with, done per-dot rather than per-panel:
 *   - `wipe` — a front crosses the matrix left to right (the "scan"/"cover" family), with a run of
 *     blank columns after it so the sweep reads as a repeat rather than a stutter.
 *   - `snow` — every dot has its own landing time inside the cycle, so the message assembles out of
 *     scattered dots and then starts over, which is what the manuals call snow.
 *
 * Everything else shows every dot and is handled elsewhere (scroll moves the whole strip, blink
 * gates the whole panel, rainbow only recolours).
 */
export function revealAt(effect, dotCol, dotRow, clock, speed, cols, rows) {
  if (effect === 'wipe') {
    const rate = speed > 0 ? speed : DEFAULTS.speed
    const span = cols + WIPE_MARGIN
    const front = (((clock / 1000) * rate) % span + span) % span
    return dotCol <= front
  }
  if (effect === 'snow') {
    const t = ((clock % SNOW_MS) + SNOW_MS) % SNOW_MS / SNOW_MS
    return t >= scatter(dotCol, dotRow)
  }
  return true
}

function isAnimating(ctx) {
  if (ctx?.motion === 'none') return false
  const set = ledConfig(ctx?.config)
  // A still sign with a chasing border is still animating — the bulbs are the animation.
  if (set.effect === 'none' && set.border === 'none') return false
  return ledLines(contentOf(ctx), set.lines).length > 0
}

/** The cell's content, whichever of `text_block`'s three ways it arrived by. */
function contentOf(ctx) {
  const config = ctx?.config
  const c = config && typeof config === 'object' ? config : {}
  if (typeof c.text === 'string') return c.text
  const path = typeof c.path === 'string' ? c.path : null
  const value = resolvePath(ctx?.data, path)
  if (value === null || value === undefined || typeof value === 'object') return ''
  return String(value)
}

function draw(g, ctx, elapsedMs) {
  const { box, tokens, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const set = ledConfig(config)
  const bulbR = Math.max(2.5, Math.min(7, Math.min(box.w, box.h) * 0.035))
  // The ring eats into the panel: the matrix is inset past it so a bulb never sits on a glyph.
  const ringPad = set.border === 'none' ? 0 : bulbR * 3
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04)) + ringPad
  const scale = finite(config?.scale) && config.scale > 0 ? config.scale : 1
  const lines = ledLines(contentOf(ctx), set.lines)

  if (lines.length === 0) {
    centredNotice(g, 'No text', 'Type text or bind a feed', box, tokens, pad, scale)
    return
  }

  // One dot pitch for the whole panel: the largest that fits both the longest line across and every
  // line down, so a two-line sign and a one-line sign look like the same hardware.
  const cols = Math.max(...lines.map((line) => line.length)) * (GLYPH_W + 1) - 1
  const rows = lines.length * (GLYPH_H + 1) - 1
  const pitch = Math.max(1.5, Math.min((box.w - pad * 2) / cols, (box.h - pad * 2) / rows))
  const radius = Math.max(0.6, pitch * 0.42)
  const originX = (box.w - cols * pitch) / 2 + pitch / 2
  const originY = (box.h - rows * pitch) / 2 + pitch / 2

  // The clock every effect reads: `ctx.now`, never `elapsedMs`. The host re-reads its own clock
  // inside the frame callback, so `ctx.now` is live per frame; `elapsedMs` restarts at every
  // repaint (each data push), and adding the two double-counts and lurches backwards on each
  // restart. See `stream/ticker.mjs` for the long version — it shipped both mistakes first.
  const clock = ctx.now || 0
  // `scroll` walks the message sideways and wraps one span later. TWO copies, one span apart, for
  // the same reason `stream/ticker.mjs` paints two: with a single copy the message drags a hole
  // behind it — it slides off the left while the right stays empty until the offset resets.
  const span = (cols + 4) * pitch
  const travelled = ((((clock / 1000) * set.speed) % span) + span) % span
  const drifts = set.effect === 'scroll' && span > 0 ? [-travelled, -travelled + span] : [0]
  const lit = litAt(set.effect, clock, set.speed)

  for (const drift of drifts) {
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    const lineColour = set.colors[row] ?? set.color
    for (let ch = 0; ch < line.length; ch++) {
      const glyph = glyphFor(line[ch])
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          const dotCol = ch * (GLYPH_W + 1) + gx
          const dotRow = row * (GLYPH_H + 1) + gy
          // A reveal effect can hide a lit dot; an unlit one is unaffected — the panel's dark dots
          // are hardware, not content, so they stay put while the message assembles over them.
          const on = glyph[gy][gx] === 'X' && revealAt(set.effect, dotCol, dotRow, clock, set.speed, cols, rows)
          if (!on && !set.offDots) continue
          const x = originX + dotCol * pitch + drift
          const y = originY + (row * (GLYPH_H + 1) + gy) * pitch
          if (x < -pitch || x > box.w + pitch) continue

          let colour = tokens.off
          if (on && lit) {
            if (set.effect === 'rainbow') colour = `hsl(${Math.round(hueAt(dotCol * pitch, clock, set.speed))}, 90%, 55%)`
            else if (lineColour) colour = lineColour
            else colour = tokens.on
          } else if (on) {
            // Blinking dark: the dot is still there, just not lit — an unlit LED, not a hole.
            colour = tokens.off
          }

          g.fillStyle = colour
          g.globalAlpha = on && lit ? 1 : 0.18
          g.beginPath()
          g.arc(x, y, radius, 0, Math.PI * 2)
          g.fill()
        }
      }
    }
  }
  }
  g.globalAlpha = 1

  // The bloom, painted as a second larger, fainter pass over the lit dots only. Cheap, and the one
  // thing that makes dots read as EMITTING rather than as printed.
  if (set.glow && lit) {
    g.globalAlpha = 0.18
    for (const drift of drifts) {
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row]
      const lineColour = set.colors[row] ?? set.color ?? tokens.glow
      for (let ch = 0; ch < line.length; ch++) {
        const glyph = glyphFor(line[ch])
        for (let gy = 0; gy < GLYPH_H; gy++) {
          for (let gx = 0; gx < GLYPH_W; gx++) {
            const dotCol = ch * (GLYPH_W + 1) + gx
            if (glyph[gy][gx] !== 'X'
              || !revealAt(set.effect, dotCol, row * (GLYPH_H + 1) + gy, clock, set.speed, cols, rows)) continue
            const x = originX + dotCol * pitch + drift
            if (x < -pitch || x > box.w + pitch) continue
            g.fillStyle = set.effect === 'rainbow'
              ? `hsl(${Math.round(hueAt(dotCol * pitch, clock, set.speed))}, 90%, 55%)`
              : lineColour
            g.beginPath()
            g.arc(x, originY + (row * (GLYPH_H + 1) + gy) * pitch, radius * 1.9, 0, Math.PI * 2)
            g.fill()
          }
        }
      }
    }
    }
    g.globalAlpha = 1
  }

  // The marquee ring. Painted LAST so its bloom lies over the matrix edge rather than under it —
  // on a real sign the border lamps are in front of the panel, not behind it.
  if (set.border !== 'none') {
    const bulbs = borderBulbs(box.w, box.h, BULB_SPACING, bulbR * 1.6)
    const bulbColour = set.borderColor ?? set.color ?? tokens.on
    for (let i = 0; i < bulbs.length; i++) {
      const on = bulbLit(set.border, i, bulbs.length, clock, set.speed)
      g.fillStyle = on ? bulbColour : tokens.off
      g.globalAlpha = on ? 1 : 0.22
      g.beginPath()
      g.arc(bulbs[i].x, bulbs[i].y, bulbR, 0, Math.PI * 2)
      g.fill()
      if (on && set.glow) {
        g.globalAlpha = 0.22
        g.beginPath()
        g.arc(bulbs[i].x, bulbs[i].y, bulbR * 2.2, 0, Math.PI * 2)
        g.fill()
      }
    }
    g.globalAlpha = 1
  }
}

export default { meta, draw, isAnimating }
