/**
 * `gauge`/`battery` — the ring design's arithmetic bent into a battery card: a three-quarter
 * horseshoe (open at the bottom, 135°..405°), the percentage large in the middle, a lightning
 * bolt when the node reports external power, and the pack voltage under the number. Built for the
 * Meshtastic telemetry payload (integrations/meshtastic/monitor.py) but degrades to a plain
 * horseshoe gauge on any numeric feed: no `plugged_in` → no bolt, no `voltage` → no voltage line.
 *
 * Those two extras are read off the payload by FIXED name (`plugged_in`, `voltage`), siblings of
 * whatever `config.path` resolves — deliberately NOT `meta.options` knobs: an option must name a
 * config key the save schema already accepts (`cellSchema.ts`'s gauge branch,
 * `additionalProperties: false`), and adding schema knobs for one integration's field names is
 * exactly the coupling a design-local read avoids. A payload that spells them differently simply
 * doesn't get the extras.
 *
 * Severity is `normalizeGauge`'s unchanged (`./shared.mjs`): `gaugeSeverity` is high-is-bad
 * (`value >= crit → critical`), which cannot express "low battery is bad" — so the Meshtastic
 * battery cell ships with no thresholds and the arc stays `info`, exactly the mock's always-green
 * arc. Low-is-bad severity would be a `shared.mjs` feature, not a design hack here.
 *
 * `ctx.stale`/`ctx.age_ms` follow ring.mjs exactly: stale dims only the value text; the age
 * caption renders whenever the feed has ever been pushed to.
 */
import { FLOOR_VALUE, FLOOR_LABEL } from '../../layout-core.mjs'
import { normalizeGauge } from './shared.mjs'
import { fitted, formatAge, paintText } from '../text-fit.mjs'

const meta = {
  id: 'battery',
  widget: 'gauge',
  label: 'Battery',
  // Matches definitions.mjs's own `gauge` entry — same discipline ring.mjs states.
  suggested_ratio: 2,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    info: { type: 'color', default: '@info' },
    warn: { type: 'color', default: '@warn' },
    critical: { type: 'color', default: '@critical' },
    hole: { type: 'color', default: '@bg' },
  },
  // Byte-for-byte ring.mjs's options: same widget, same schema branch, same knobs — see ring.mjs
  // for why `decimals`/`warn`/`crit` declare no default and where the bounds come from.
  options: {
    label: { type: 'text', label: 'Label', default: '' },
    unit: { type: 'text', label: 'Unit', default: '' },
    min: { type: 'number', label: 'Min', default: 0 },
    max: { type: 'number', label: 'Max', default: 100 },
    decimals: { type: 'number', label: 'Decimals', min: 0, max: 3 },
    warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' },
    crit: { type: 'number', label: 'Crit', path: 'thresholds.crit' },
  },
  animations: { transition: [], persistent: [] },
}

// Horseshoe geometry: sweep from 135° through the top to 45° (i.e. 0.75π .. 2.25π), open at the
// bottom — the mock's gauge shape. Severity colour resolution matches ring.mjs's honest version.
const ARC_START = Math.PI * 0.75
const ARC_SPAN = Math.PI * 1.5

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** `min`/`max`/`unit` for the end labels, read with the SAME finite-number check and defaults
 *  (0/100/'') as `normalizeGauge` (`./shared.mjs`) uses internally — `normalizeGauge` itself
 *  doesn't return `min`/`max`, so this restates just that half of its read rather than the whole
 *  function. Any numeric range/unit a cell configures shows up honestly at the horseshoe's ends,
 *  instead of the old hard-coded `0%`/`100%`. */
function endRange(config) {
  const c = config !== null && typeof config === 'object' && !isArray(config) ? config : {}
  const min = finite(c.min) ? c.min : 0
  const max = finite(c.max) ? c.max : 100
  const unit = typeof c.unit === 'string' ? c.unit : ''
  return { min, max, unit }
}

/** Same rule as shared.mjs's scalarSource: a stream-bound gauge reads its newest row. */
function scalarSource(data) {
  return isArray(data) ? data[0] : data
}

function severityColor(tokens, severity) {
  return severity === 'critical' ? tokens.critical : severity === 'warn' ? tokens.warn : tokens.info
}

/** The bolt, as a filled polygon in a box of width `w`/height `h` whose top-centre is (cx, top).
 *  Plain moveTo/lineTo/fill — the portable subset has no curves, and a bolt doesn't need them. */
function paintBolt(g, cx, top, w, h, color) {
  const x = (fx) => cx + (fx - 0.5) * w
  const y = (fy) => top + fy * h
  g.beginPath()
  g.moveTo(x(0.62), y(0))
  g.lineTo(x(0.18), y(0.58))
  g.lineTo(x(0.46), y(0.58))
  g.lineTo(x(0.38), y(1))
  g.lineTo(x(0.82), y(0.42))
  g.lineTo(x(0.54), y(0.42))
  g.closePath()
  g.fillStyle = color
  g.fill()
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeGauge(data, config)
  const src = scalarSource(data)
  const payload = src !== null && typeof src === 'object' && !isArray(src) ? src : null
  const voltage = payload && typeof payload.voltage === 'number' && Number.isFinite(payload.voltage) ? payload.voltage : null
  const plugged = payload ? payload.plugged_in === true : false

  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))
  const usableWidth = Math.max(0, box.w - pad * 2)
  const usableHeight = Math.max(0, box.h - pad * 2)

  const stale = ctx.stale === true
  const ageMs = typeof ctx.age_ms === 'number' ? ctx.age_ms : null
  const showAge = ageMs !== null
  const showLabel = n.label !== ''
  const valueColor = stale ? tokens.dim : tokens.ink

  const labelPx = Math.max(FLOOR_LABEL, Math.round(Math.min(usableHeight * 0.1, usableWidth * 0.08) * n.scale))
  const agePx = FLOOR_LABEL
  const endPx = FLOOR_LABEL
  const gap = Math.max(2, Math.round(labelPx * 0.5))

  // The horseshoe's open mouth is real estate: the 0%/100% end labels AND the age caption all
  // live inside the ring's own bounding box (at the mouth), so the ring claims nearly the whole
  // cell height instead of reserving stacked rows beneath itself — the difference between a
  // cramped dial and a readable one on a carded 2x2 cell.
  const labelBlock = showLabel ? labelPx + gap : 0
  const ringD = Math.max(48, Math.round(Math.min(
    usableHeight - labelBlock - Math.max(4, Math.round(endPx * 0.5)),
    usableWidth * 0.95,
  ) * n.scale))
  let y = box.h / 2 - (labelBlock + ringD) / 2

  if (showLabel) {
    paintText(g, n.label, box.w / 2, y, {
      px: labelPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 600,
    })
    y += labelPx + gap
  }

  const cx = box.w / 2
  const cy = y + ringD / 2
  const lineWidth = Math.max(4, Math.round(ringD * 0.13))
  const r = Math.max(1, (ringD - lineWidth) / 2)

  // Hole first, same reasoning (and token) as ring.mjs.
  g.beginPath()
  g.fillStyle = tokens.hole
  g.arc(cx, cy, Math.max(0, r - lineWidth / 2), 0, Math.PI * 2)
  g.fill()

  // Track: the three-quarter horseshoe.
  g.beginPath()
  g.lineWidth = lineWidth
  g.lineCap = 'round'
  g.strokeStyle = tokens.dim
  g.arc(cx, cy, r, ARC_START, ARC_START + ARC_SPAN)
  g.stroke()

  // Value arc, coloured by severity (normalizeGauge forces `info` on an empty track).
  if (n.fraction > 0) {
    g.beginPath()
    g.lineWidth = lineWidth
    g.lineCap = 'round'
    g.strokeStyle = severityColor(tokens, n.severity)
    g.arc(cx, cy, r, ARC_START, ARC_START + n.fraction * ARC_SPAN)
    g.stroke()
  }

  // Inside the hole, a vertical stack: bolt?, percentage, voltage?. Sized off the ring so the
  // stack always sits within the horseshoe's mouth.
  const valuePx = Math.max(FLOOR_VALUE, Math.round(ringD * 0.28 * n.scale))
  const voltPx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.5))
  const boltH = Math.round(ringD * 0.16)
  const innerGap = Math.max(3, Math.round(ringD * 0.04))
  const stackH = (plugged ? boltH + innerGap : 0) + valuePx + (voltage !== null ? innerGap + voltPx : 0)
  let iy = cy - stackH / 2

  if (plugged) {
    paintBolt(g, cx, iy, Math.round(boltH * 0.62), boltH, tokens.ink)
    iy += boltH + innerGap
  }

  // The value's budget is the full content width, not the ring's inner circle: on a small carded
  // cell the hole alone would ellipsize "100%" at FLOOR_VALUE, and the mock's own number spans
  // nearly arc-to-arc. Centred on the ring, any overhang drapes across the arc sides
  // symmetrically; text paints last, so it wins over the stroke.
  const innerWidth = Math.max(24, usableWidth)
  const unitText = n.available && n.unit !== '' ? n.unit : ''
  const valueFit = fitted(g, n.value + unitText, valuePx, FLOOR_VALUE, innerWidth, 700)
  paintText(g, valueFit.text, cx, iy, {
    px: valueFit.px, floor: FLOOR_VALUE, maxWidth: innerWidth,
    color: valueColor, align: 'center', baseline: 'top', weight: 700,
  })
  iy += valueFit.px

  if (voltage !== null) {
    iy += innerGap
    paintText(g, `${voltage.toFixed(2)}V`, cx, iy, {
      px: voltPx, floor: FLOOR_LABEL, maxWidth: innerWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 400,
    })
  }

  // End labels at the horseshoe's mouth, under each open end — the configured min/max/unit, not
  // a hard-coded '0%'/'100%', so a unitless or non-percent range (any numeric gauge, per the
  // design's own docstring) reads honestly too.
  const endY = cy + r * Math.sin(ARC_START) + lineWidth
  const endX = r * Math.cos(ARC_START)
  const range = endRange(config)
  paintText(g, `${range.min}${range.unit}`, cx + endX, endY, {
    px: endPx, floor: FLOOR_LABEL, maxWidth: usableWidth / 2,
    color: tokens.dim, align: 'center', baseline: 'top', weight: 400,
  })
  paintText(g, `${range.max}${range.unit}`, cx - endX, endY, {
    px: endPx, floor: FLOOR_LABEL, maxWidth: usableWidth / 2,
    color: tokens.dim, align: 'center', baseline: 'top', weight: 400,
  })
  // The age caption sits BETWEEN the end labels, in the mouth's unused centre — same row, same
  // size, same colour — instead of costing the ring a whole extra line beneath itself. Measured,
  // not assumed: on a dial too small for all three, the age (the least load-bearing of them)
  // stays unpainted rather than crowding the range labels.
  if (showAge) {
    const ageText = formatAge(ageMs)
    g.font = `400 ${agePx}px system-ui`
    const ageW = g.measureText(ageText).width
    const endW = Math.max(g.measureText(`${range.min}${range.unit}`).width, g.measureText(`${range.max}${range.unit}`).width)
    const clearance = (Math.abs(endX) - endW / 2) * 2 - ageW
    if (clearance >= 12) {
      paintText(g, ageText, cx, endY, {
        px: agePx, floor: FLOOR_LABEL, maxWidth: ageW + 2,
        color: tokens.dim, align: 'center', baseline: 'top', weight: 400,
      })
    }
  }
}

export default { meta, draw }
