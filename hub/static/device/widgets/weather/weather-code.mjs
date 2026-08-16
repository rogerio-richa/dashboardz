/**
 * Stable condition families used by the forecast design.
 *
 * These are deliberately not font icons. Every visual below is made from the Canvas subset that
 * the portable recorder can lower to device primitives; the only text fallback is the ASCII `?`.
 */
export function conditionVisual(code) {
  switch (code) {
    case 'clear': return 'sun'
    case 'mostly_clear':
    case 'partly_cloudy': return 'partly-cloudy'
    case 'cloudy': return 'cloud'
    case 'fog': return 'fog'
    case 'drizzle':
    case 'rain':
    case 'showers': return 'rain'
    case 'snow': return 'snow'
    case 'thunderstorm': return 'storm'
    default: return 'unknown'
  }
}

export function conditionLabel(code) {
  switch (code) {
    case 'clear': return 'Clear'
    case 'mostly_clear': return 'Mostly clear'
    case 'partly_cloudy': return 'Partly cloudy'
    case 'cloudy': return 'Cloudy'
    case 'fog': return 'Fog'
    case 'drizzle': return 'Drizzle'
    case 'rain': return 'Rain'
    case 'snow': return 'Snow'
    case 'showers': return 'Showers'
    case 'thunderstorm': return 'Thunderstorm'
    default: return 'Unknown'
  }
}

function line(g, x1, y1, x2, y2) {
  g.beginPath()
  g.moveTo(x1, y1)
  g.lineTo(x2, y2)
  g.stroke()
}

function sun(g, cx, cy, radius, color) {
  g.strokeStyle = color
  g.lineWidth = Math.max(1, radius * 0.11)
  g.lineCap = 'round'
  g.beginPath()
  g.arc(cx, cy, radius * 0.45, 0, Math.PI * 2)
  g.stroke()
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4
    line(
      g,
      cx + Math.cos(angle) * radius * 0.65,
      cy + Math.sin(angle) * radius * 0.65,
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
    )
  }
}

function cloud(g, cx, cy, radius, color) {
  g.fillStyle = color
  g.beginPath()
  g.arc(cx - radius * 0.38, cy + radius * 0.12, radius * 0.34, 0, Math.PI * 2)
  g.arc(cx, cy - radius * 0.08, radius * 0.48, 0, Math.PI * 2)
  g.arc(cx + radius * 0.42, cy + radius * 0.12, radius * 0.31, 0, Math.PI * 2)
  g.rect(cx - radius * 0.68, cy + radius * 0.08, radius * 1.36, radius * 0.36)
  g.fill()
}

function snowflake(g, cx, cy, radius) {
  line(g, cx - radius, cy, cx + radius, cy)
  line(g, cx, cy - radius, cx, cy + radius)
  line(g, cx - radius * 0.72, cy - radius * 0.72, cx + radius * 0.72, cy + radius * 0.72)
  line(g, cx + radius * 0.72, cy - radius * 0.72, cx - radius * 0.72, cy + radius * 0.72)
}

export function drawCondition(g, code, cx, cy, size, ink, dim) {
  if (!(size > 0)) return
  const radius = size / 2
  const visual = conditionVisual(code)

  if (visual === 'sun') {
    sun(g, cx, cy, radius * 0.78, ink)
    return
  }
  if (visual === 'partly-cloudy') {
    sun(g, cx - radius * 0.32, cy - radius * 0.25, radius * 0.48, dim)
    cloud(g, cx + radius * 0.1, cy + radius * 0.12, radius * 0.78, ink)
    return
  }
  if (visual === 'fog') {
    g.strokeStyle = dim
    g.lineWidth = Math.max(1, radius * 0.12)
    g.lineCap = 'round'
    for (const offset of [-0.42, 0, 0.42]) {
      line(g, cx - radius * 0.72, cy + radius * offset, cx + radius * 0.72, cy + radius * offset)
    }
    return
  }
  if (visual === 'cloud') {
    cloud(g, cx, cy, radius * 0.9, ink)
    return
  }
  if (visual === 'rain') {
    cloud(g, cx, cy - radius * 0.24, radius * 0.72, ink)
    g.strokeStyle = dim
    g.lineWidth = Math.max(1, radius * 0.12)
    g.lineCap = 'round'
    for (const offset of [-0.42, 0, 0.42]) {
      line(g, cx + radius * offset, cy + radius * 0.28, cx + radius * (offset - 0.12), cy + radius * 0.72)
    }
    return
  }
  if (visual === 'snow') {
    cloud(g, cx, cy - radius * 0.28, radius * 0.68, ink)
    g.strokeStyle = dim
    g.lineWidth = Math.max(1, radius * 0.08)
    for (const offset of [-0.38, 0.38]) snowflake(g, cx + radius * offset, cy + radius * 0.55, radius * 0.15)
    return
  }
  if (visual === 'storm') {
    cloud(g, cx, cy - radius * 0.28, radius * 0.72, ink)
    g.fillStyle = dim
    g.beginPath()
    g.moveTo(cx + radius * 0.04, cy + radius * 0.08)
    g.lineTo(cx - radius * 0.25, cy + radius * 0.55)
    g.lineTo(cx + radius * 0.02, cy + radius * 0.5)
    g.lineTo(cx - radius * 0.08, cy + radius)
    g.lineTo(cx + radius * 0.38, cy + radius * 0.34)
    g.lineTo(cx + radius * 0.12, cy + radius * 0.39)
    g.closePath()
    g.fill()
    return
  }

  g.strokeStyle = dim
  g.lineWidth = Math.max(1, radius * 0.1)
  g.beginPath()
  g.arc(cx, cy, radius * 0.72, 0, Math.PI * 2)
  g.stroke()
  g.fillStyle = ink
  g.font = `600 ${Math.max(10, Math.round(size * 0.55))}px system-ui`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('?', cx, cy)
}
