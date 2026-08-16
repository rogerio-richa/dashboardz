/**
 * vintage-dial: a gauge drawn as a brass dial. Part of the "vintage" example theme pack.
 *
 * A pack design is one file with no imports, so the small helpers it needs (reading the value at
 * the bound path, formatting it) live here. It reads the gauge's own settings (label, unit, min,
 * max, decimals, thresholds) and one setting of its own, design_options.needle, always with a
 * default, so a missing or wrong value never breaks drawing.
 */

const meta = {
  id: 'vintage-dial',
  widget: 'gauge',
  label: 'Brass dial',
  suggested_ratio: 1.2,
  minimum_px: { w: 120, h: 100 },
  tokens: {
    rim: { type: 'color', default: '@accent' },
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    info: { type: 'color', default: '@info' },
    warn: { type: 'color', default: '@warn' },
    critical: { type: 'color', default: '@critical' },
  },
  options: {
    label: { type: 'text', label: 'Label', default: '' },
    unit: { type: 'text', label: 'Unit', default: '' },
    min: { type: 'number', label: 'Min', default: 0 },
    max: { type: 'number', label: 'Max', default: 100 },
    decimals: { type: 'number', label: 'Decimals', min: 0, max: 3 },
    warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' },
    crit: { type: 'number', label: 'Crit', path: 'thresholds.crit' },
    // This design's own setting: the hub stores it under design_options without knowing it.
    needle: { type: 'select', label: 'Needle', default: 'spade', choices: ['spade', 'arrow'], path: 'design_options.needle' },
  },
  animations: { transition: [], persistent: [] },
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)

/** The value at a dotted path ("cpu.temp") in the feed's data; the data itself for no path. */
function valueAt(data, path) {
  if (!path) return data
  let node = data
  for (const key of path.split('.')) {
    const r = record(node)
    if (!r) return undefined
    node = r[key]
  }
  return node
}

function format(value, decimals) {
  if (Number.isInteger(decimals)) return value.toFixed(decimals)
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

// The dial sweeps 240 degrees, from lower left (150 deg) clockwise to lower right (30 deg).
const START = (150 * Math.PI) / 180
const SWEEP = (240 * Math.PI) / 180

function draw(g, ctx) {
  const c = record(ctx.config) ?? {}
  const t = ctx.tokens
  const thresholds = record(c.thresholds) ?? {}
  const min = finite(c.min) ? c.min : 0
  const max = finite(c.max) ? c.max : 100
  const span = max > min ? max - min : 1
  const raw = valueAt(ctx.data, typeof c.path === 'string' ? c.path : '')
  const available = finite(raw)
  const fraction = available ? Math.min(1, Math.max(0, (raw - min) / span)) : 0
  const crit = finite(thresholds.crit) ? thresholds.crit : null
  const warn = finite(thresholds.warn) ? thresholds.warn : null
  const severity = !available ? 'info' : crit !== null && raw >= crit ? 'critical' : warn !== null && raw >= warn ? 'warn' : 'info'
  const needleStyle = record(c.design_options)?.needle === 'arrow' ? 'arrow' : 'spade'

  const { w, h } = ctx.box
  // The rim is a full circle, so it must fit the card both ways.
  const r = Math.max(10, Math.min(w, h) / 2 - 6)
  const cx = w / 2
  const cy = h / 2

  g.save()
  if (ctx.stale) g.globalAlpha = 0.55

  // Brass rim and the scale arc.
  g.strokeStyle = t.rim
  g.lineWidth = Math.max(2, r * 0.06)
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke()
  g.strokeStyle = t.dim
  g.lineWidth = Math.max(1, r * 0.015)
  g.beginPath(); g.arc(cx, cy, r * 0.82, START, START + SWEEP); g.stroke()

  // Ticks: eleven, every tenth of the range; the ends and the middle are long.
  g.lineCap = 'round'
  for (let i = 0; i <= 10; i++) {
    const a = START + (SWEEP * i) / 10
    const long = i % 5 === 0
    const inner = r * (long ? 0.68 : 0.74)
    g.strokeStyle = long ? t.ink : t.dim
    g.lineWidth = Math.max(1, r * (long ? 0.03 : 0.018))
    g.beginPath()
    g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    g.lineTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82)
    g.stroke()
  }

  // Warn and critical zones on the scale, in their alert colours.
  const zone = (from, to, color) => {
    if (from === null) return
    const a0 = START + SWEEP * Math.min(1, Math.max(0, (from - min) / span))
    const a1 = START + SWEEP * Math.min(1, Math.max(0, ((to ?? max) - min) / span))
    if (a1 <= a0) return
    g.strokeStyle = color
    g.lineWidth = Math.max(2, r * 0.05)
    g.beginPath(); g.arc(cx, cy, r * 0.88, a0, a1); g.stroke()
  }
  zone(warn, crit, t.warn)
  zone(crit, null, t.critical)

  // Label above the hub, value below it.
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const label = typeof c.label === 'string' ? c.label : ''
  if (label) {
    g.fillStyle = t.dim
    g.font = `${Math.round(r * 0.14)}px Georgia, serif`
    g.fillText(label, cx, cy - r * 0.38)
  }
  const unit = typeof c.unit === 'string' ? c.unit : ''
  g.fillStyle = t.ink
  g.font = `600 ${Math.round(r * 0.26)}px Georgia, serif`
  g.fillText(available ? `${format(raw, c.decimals)}${unit ? ` ${unit}` : ''}` : '--', cx, cy + r * 0.45)

  // The needle, in the colour of the current severity.
  const needleColor = t[severity]
  const a = START + SWEEP * fraction
  g.translate(cx, cy)
  g.rotate(a)
  g.fillStyle = needleColor
  g.strokeStyle = needleColor
  if (needleStyle === 'arrow') {
    g.lineWidth = Math.max(1.5, r * 0.025)
    g.beginPath(); g.moveTo(-r * 0.12, 0); g.lineTo(r * 0.62, 0); g.stroke()
    g.beginPath(); g.moveTo(r * 0.76, 0); g.lineTo(r * 0.6, -r * 0.06); g.lineTo(r * 0.6, r * 0.06); g.closePath(); g.fill()
  } else {
    g.beginPath(); g.moveTo(r * 0.74, 0); g.lineTo(0, -r * 0.05); g.lineTo(-r * 0.16, 0); g.lineTo(0, r * 0.05); g.closePath(); g.fill()
  }
  g.rotate(-a)
  g.fillStyle = t.rim
  g.beginPath(); g.arc(0, 0, Math.max(3, r * 0.07), 0, Math.PI * 2); g.fill()
  g.restore()
}

export default { meta, draw }
