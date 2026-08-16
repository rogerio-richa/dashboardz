import { conditionLabel, drawCondition } from './weather-code.mjs'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MIN_DAYS = 5
const MAX_DAYS = 7
const LABEL_FLOOR = 10
// Provider-owned display copy is bounded before every paint so fitting cost cannot grow with input.
const DISPLAY_CODE_POINT_LIMIT = 512

const meta = {
  id: 'forecast',
  widget: 'weather_forecast',
  label: 'Forecast',
  suggested_ratio: 16 / 9,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  animations: { transition: [], persistent: [] },
}

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const record = (value) =>
  value !== null && typeof value === 'object' && !isArray(value) ? value : null

function ownData(value, key) {
  const target = value !== null && typeof value === 'object' ? value : null
  if (!target) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function arrayValues(value, limit) {
  if (!isArray(value)) return []
  const length = ownData(value, 'length')
  if (!Number.isSafeInteger(length) || length < 0) return []
  const values = []
  for (let index = 0; index < Math.min(length, limit); index++) {
    const candidate = ownData(value, String(index))
    if (candidate !== undefined) values.push(candidate)
  }
  return values
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null

function displayText(value) {
  if (typeof value !== 'string') return null
  let prefix = ''
  let codePoints = 0
  let exceeded = false
  for (const point of value) {
    if (codePoints === DISPLAY_CODE_POINT_LIMIT) {
      exceeded = true
      break
    }
    prefix += point
    codePoints++
  }
  const normalized = prefix.trim()
  if (!normalized) return null
  return exceeded ? `${normalized}...` : normalized
}

function parsedIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const instant = new Date(Date.UTC(year, month - 1, day))
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) return null
  return { value, year, month, day, weekday: WEEKDAYS[instant.getUTCDay()] }
}

/** Calendar labels are derived from the provider's ISO date components, never from hub local time. */
export function formatIsoDate(value) {
  const date = parsedIsoDate(value)
  return date ? { weekday: date.weekday, day: String(date.day) } : null
}

const requestedDays = (config) => {
  const days = ownData(config, 'days')
  return Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS ? days : MIN_DAYS
}
const normalizedScale = (config) => {
  const scale = ownData(config, 'scale')
  return finite(scale) ? Math.min(2, Math.max(0.5, scale)) : 1
}

function numberText(value) {
  if (!finite(value)) return null
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function detailLines(day, units, config) {
  const details = []
  const humidity = ownData(day, 'humidity_mean_pct')
  const precipitation = ownData(day, 'precipitation_probability_pct')
  const wind = ownData(day, 'wind_speed_max')
  if (ownData(config, 'show_humidity') === true && finite(humidity)) {
    details.push(`Humidity ${Math.round(humidity)}%`)
  }
  if (ownData(config, 'show_precipitation') === true && finite(precipitation)) {
    details.push(`Rain ${Math.round(precipitation)}%`)
  }
  if (ownData(config, 'show_wind') === true && finite(wind) && units.wind) {
    details.push(`Wind ${numberText(wind)} ${units.wind}`)
  }
  const pollen = record(ownData(day, 'pollen'))
  if (ownData(config, 'show_pollen') === true && pollen) {
    const pollenLevel = ownData(pollen, 'level')
    const level = ['low', 'moderate', 'high', 'very_high'].includes(pollenLevel) ? pollenLevel : null
    if (level) details.push(`Pollen ${level.replace('_', ' ')}`)
  }
  return details
}

function normalizedAttribution(data) {
  const attribution = record(ownData(data, 'attribution'))
  const label = displayText(ownData(attribution, 'label'))
  return label ? { label, url: text(ownData(attribution, 'url')) } : null
}

function normalizeDay(candidate, units, config) {
  const day = record(candidate)
  if (!day) return null
  const date = parsedIsoDate(ownData(day, 'date'))
  const high = numberText(ownData(day, 'high'))
  const low = numberText(ownData(day, 'low'))
  const condition = record(ownData(day, 'condition'))
  if (!date || high === null || low === null || !condition) return null
  const conditionCode = ownData(condition, 'code')
  const code = typeof conditionCode === 'string' ? conditionCode : 'unknown'
  return {
    date: date.value,
    weekday: date.weekday,
    dayOfMonth: String(date.day),
    high,
    low,
    conditionCode: code,
    conditionLabel: conditionLabel(code),
    details: detailLines(day, units, config),
  }
}

/**
 * Total read-path normalizer. Contract-valid data takes the straight path; malformed stored/live
 * values lose only the affected day or optional detail and never escape as a drawing exception.
 */
export function normalizeForecast(value, config) {
  const data = record(value)
  const safeConfig = record(config) ?? {}
  const attribution = normalizedAttribution(data)
  const rawUnits = record(ownData(data, 'units'))
  const rawTemperature = ownData(rawUnits, 'temperature')
  const rawWind = ownData(rawUnits, 'wind_speed')
  const temperature = rawTemperature === 'F' ? 'F' : rawTemperature === 'C' ? 'C' : ''
  const wind = rawWind === 'mph' ? 'mph' : rawWind === 'km/h' ? 'km/h' : ''
  const units = { temperature, wind }
  const limit = requestedDays(safeConfig)
  const candidates = arrayValues(ownData(data, 'days'), MAX_DAYS)
  const days = []
  for (const candidate of candidates) {
    const day = normalizeDay(candidate, units, safeConfig)
    if (day) days.push(day)
    if (days.length === limit) break
  }
  return {
    available: days.length >= MIN_DAYS,
    location: displayText(ownData(record(ownData(data, 'location')), 'name')) ?? 'Forecast',
    units,
    days,
    attribution,
    scale: normalizedScale(safeConfig),
  }
}

/** Full is earned only when every column and the vertical stack have room for secondary detail. */
export function forecastTier(box, dayCount) {
  const width = finite(box?.w) ? box.w : 0
  const height = finite(box?.h) ? box.h : 0
  const count = Number.isInteger(dayCount) && dayCount > 0 ? dayCount : MIN_DAYS
  return height >= 220 && width / count >= 86 ? 'full' : 'compact'
}

function fontPx(base, scale, floor = LABEL_FLOOR) {
  return Math.max(floor, Math.round(base * scale))
}

function fitted(g, value, start, floor, maxWidth) {
  const startPx = Math.max(floor, Math.round(start))
  const measuredWidth = (candidate, px) => {
    g.font = `400 ${px}px system-ui`
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

  g.font = `400 ${floor}px system-ui`
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

function paintText(g, value, x, y, options) {
  const fit = fitted(g, value, options.px, options.floor ?? LABEL_FLOOR, options.maxWidth)
  if (!fit.text) return fit
  g.fillStyle = options.color
  g.font = `${options.weight ?? 400} ${fit.px}px system-ui`
  g.textAlign = options.align ?? 'center'
  g.textBaseline = options.baseline ?? 'top'
  g.fillText(fit.text, x, y)
  return fit
}

function compactAttribution(label) {
  return label.replace(/^weather\s+data\s+by\s+/i, '').replace(/^data\s+by\s+/i, '')
}

function attributionPx(box, scale) {
  return fontPx(Math.min(box.w * 0.022, box.h * 0.075), scale, LABEL_FLOOR)
}

function drawAttribution(g, attribution, tier, box, pad, scale, color, plannedPx) {
  if (!attribution) return 0
  const px = plannedPx ?? attributionPx(box, scale)
  const label = tier === 'compact' ? compactAttribution(attribution.label) : attribution.label
  paintText(g, label, box.w - pad, box.h - pad, {
    px, floor: LABEL_FLOOR, maxWidth: box.w - pad * 2,
    color, align: 'right', baseline: 'bottom', weight: 400,
  })
  return Math.max(14, px * 1.35)
}

function betweenFloorAndPreferred(preferred, floor, fit) {
  return Math.max(floor, Math.floor(floor + (Math.max(floor, preferred) - floor) * fit))
}

function compactLayout(box, pad, columnWidth, scale, hasAttribution) {
  const available = Math.max(0, box.h - pad * 2)
  const preferred = {
    footer: attributionPx(box, scale),
    date: fontPx(Math.min(columnWidth * 0.17, available * 0.095), scale),
    temperature: fontPx(Math.min(columnWidth * 0.19, available * 0.105), scale),
    icon: Math.max(16, Math.min(columnWidth * 0.42, available * 0.38) * scale),
  }
  const at = (fit) => {
    const footerPx = betweenFloorAndPreferred(preferred.footer, LABEL_FLOOR, fit)
    const datePx = betweenFloorAndPreferred(preferred.date, LABEL_FLOOR, fit)
    const temperaturePx = betweenFloorAndPreferred(preferred.temperature, LABEL_FLOOR, fit)
    const iconSize = betweenFloorAndPreferred(preferred.icon, 16, fit)
    const footerHeight = hasAttribution ? Math.max(14, footerPx * 1.35) : 0
    const stackHeight = datePx * 1.2 + iconSize + 2 + temperaturePx * 1.2 + temperaturePx
    return { footerPx, footerHeight, datePx, temperaturePx, iconSize, stackHeight }
  }
  for (let fit = 1; fit >= 0; fit -= 0.01) {
    const plan = at(fit)
    if (pad * 2 + plan.footerHeight + plan.stackHeight <= box.h + 0.001) return plan
  }
  return at(0)
}

function fullLayout(box, pad, columnWidth, scale, hasAttribution, detailCount) {
  const available = Math.max(0, box.h - pad * 2)
  const preferred = {
    footer: attributionPx(box, scale),
    header: fontPx(Math.min(box.w * 0.035, box.h * 0.085), scale, 12),
    date: fontPx(Math.min(columnWidth * 0.17, available * 0.095), scale),
    temperature: fontPx(Math.min(columnWidth * 0.19, available * 0.105), scale, 11),
    condition: fontPx(Math.min(columnWidth * 0.135, available * 0.075), scale),
    detail: fontPx(Math.min(columnWidth * 0.105, available * 0.06), scale),
    icon: Math.max(16, Math.min(columnWidth * 0.42, available * 0.28) * scale),
  }
  const at = (fit) => {
    const footerPx = betweenFloorAndPreferred(preferred.footer, LABEL_FLOOR, fit)
    const headerPx = betweenFloorAndPreferred(preferred.header, 12, fit)
    const datePx = betweenFloorAndPreferred(preferred.date, LABEL_FLOOR, fit)
    const temperaturePx = betweenFloorAndPreferred(preferred.temperature, 11, fit)
    const conditionPx = betweenFloorAndPreferred(preferred.condition, LABEL_FLOOR, fit)
    const detailPx = betweenFloorAndPreferred(preferred.detail, LABEL_FLOOR, fit)
    const iconSize = betweenFloorAndPreferred(preferred.icon, 16, fit)
    const footerHeight = hasAttribution ? Math.max(14, footerPx * 1.35) : 0
    const headerHeight = headerPx * 1.25
    const stackHeight = datePx * 2.25 + iconSize + 2 + conditionPx * 1.3
      + temperaturePx * 1.35 + detailCount * detailPx * 1.25
    return {
      footerPx, footerHeight, headerPx, headerHeight, datePx, temperaturePx,
      conditionPx, detailPx, iconSize, stackHeight,
    }
  }
  for (let fit = 1; fit >= 0; fit -= 0.01) {
    const plan = at(fit)
    if (pad * 2 + plan.footerHeight + plan.headerHeight + plan.stackHeight <= box.h + 0.001) return plan
  }
  return at(0)
}

function compactDetail(value) {
  return value
    .replace(/^Humidity /, 'Hum ')
    .replace(/^Wind (\S+) /, 'Wind $1')
    .replace(/^Pollen moderate$/, 'Pollen mod.')
    .replace(/^Pollen very high$/, 'Pollen v.high')
}

function drawUnavailable(g, normalized, box, tokens, pad) {
  const tier = forecastTier(box, Math.max(MIN_DAYS, normalized.days.length))
  const footer = drawAttribution(g, normalized.attribution, tier, box, pad, normalized.scale, tokens.dim)
  const usableHeight = Math.max(0, box.h - footer - pad * 2)
  const headlinePx = fontPx(Math.min(box.w * 0.055, usableHeight * 0.16), normalized.scale, 12)
  const bodyPx = fontPx(Math.min(box.w * 0.03, usableHeight * 0.095), normalized.scale, LABEL_FLOOR)
  const total = headlinePx + bodyPx + 8
  const top = pad + Math.max(0, (usableHeight - total) / 2)
  paintText(g, 'Forecast unavailable', box.w / 2, top, {
    px: headlinePx, floor: 12, maxWidth: box.w - pad * 2, color: tokens.ink, weight: 600,
  })
  paintText(g, 'Weather data will appear here', box.w / 2, top + headlinePx + 8, {
    px: bodyPx, floor: LABEL_FLOOR, maxWidth: box.w - pad * 2, color: tokens.dim,
  })
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return

  const normalized = normalizeForecast(data, config)
  const pad = Math.max(6, Math.min(18, Math.min(box.w, box.h) * 0.045))
  if (!normalized.available) {
    drawUnavailable(g, normalized, box, tokens, pad)
    return
  }

  const tier = forecastTier(box, normalized.days.length)
  const bodyWidth = box.w - pad * 2
  const columnWidth = bodyWidth / normalized.days.length
  const innerWidth = Math.max(0, columnWidth - Math.max(4, columnWidth * 0.1))
  const hasAttribution = normalized.attribution !== null
  const detailCount = normalized.days.reduce((count, day) => Math.max(count, day.details.length), 0)
  const layout = tier === 'full'
    ? fullLayout(box, pad, columnWidth, normalized.scale, hasAttribution, detailCount)
    : compactLayout(box, pad, columnWidth, normalized.scale, hasAttribution)
  let top = pad

  if (tier === 'full') {
    paintText(g, normalized.location, pad, top, {
      px: layout.headerPx, floor: 12, maxWidth: bodyWidth, color: tokens.ink, align: 'left', weight: 600,
    })
    top += layout.headerHeight
  }

  normalized.days.forEach((day, index) => {
    const left = pad + columnWidth * index
    const center = left + columnWidth / 2
    let y = top

    const dateLabel = tier === 'compact' ? `${day.weekday} ${day.dayOfMonth}` : day.weekday
    paintText(g, dateLabel, center, y, {
      px: layout.datePx, maxWidth: innerWidth, color: tokens.dim, weight: 600,
    })
    y += tier === 'full' ? layout.datePx * 1.15 : layout.datePx * 1.2
    if (tier === 'full') {
      paintText(g, day.dayOfMonth, center, y, {
        px: layout.datePx, maxWidth: innerWidth, color: tokens.dim,
      })
      y += layout.datePx * 1.1
    }

    const iconCenterY = y + layout.iconSize / 2
    drawCondition(g, day.conditionCode, center, iconCenterY, layout.iconSize, tokens.ink, tokens.dim)
    y += layout.iconSize + 2

    if (tier === 'full') {
      paintText(g, day.conditionLabel, center, y, {
        px: layout.conditionPx, maxWidth: innerWidth, color: tokens.ink,
      })
      y += layout.conditionPx * 1.3
    }

    if (tier === 'full') {
      const unit = normalized.units.temperature ? `°${normalized.units.temperature}` : '°'
      paintText(g, `${day.high}/${day.low}${unit}`, center, y, {
        px: layout.temperaturePx, floor: 11, maxWidth: innerWidth, color: tokens.ink, weight: 600,
      })
      y += layout.temperaturePx * 1.35
      for (const detail of day.details) {
        const label = columnWidth < 100 ? compactDetail(detail) : detail
        paintText(g, label, center, y, {
          px: layout.detailPx, maxWidth: innerWidth, color: tokens.dim,
        })
        y += layout.detailPx * 1.25
      }
    } else {
      paintText(g, `H ${day.high}°`, center, y, {
        px: layout.temperaturePx, floor: LABEL_FLOOR, maxWidth: innerWidth, color: tokens.ink, weight: 600,
      })
      y += layout.temperaturePx * 1.2
      const lowUnit = normalized.units.temperature ? `°${normalized.units.temperature}` : '°'
      paintText(g, `L ${day.low}${lowUnit}`, center, y, {
        px: layout.temperaturePx, floor: LABEL_FLOOR, maxWidth: innerWidth, color: tokens.ink, weight: 600,
      })
    }
  })

  drawAttribution(
    g, normalized.attribution, tier, box, pad, normalized.scale, tokens.dim, layout.footerPx,
  )
}

export default { meta, draw }
