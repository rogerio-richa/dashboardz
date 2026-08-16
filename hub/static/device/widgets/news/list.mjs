const MIN_ITEMS = 1
const MAX_ITEMS = 10
const DEFAULT_ITEMS = 5
const CONTRACT_ITEM_LIMIT = 100
const DISPLAY_CODE_POINT_LIMIT = 512
const TITLE_FLOOR = 10
const OPTIONAL_FLOOR = 10
const LINE_GAP = 2

const meta = {
  id: 'list',
  widget: 'news_list',
  label: 'News list',
  suggested_ratio: 3 / 4,
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
  if (!isArray(value)) return null
  const length = ownData(value, 'length')
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null
  const values = []
  for (let index = 0; index < length; index++) {
    const candidate = ownData(value, String(index))
    if (candidate === undefined) return null
    values.push(candidate)
  }
  return values
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Bound provider-owned text before trimming, copying or measuring its complete value. */
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

function validTimestamp(value) {
  return finite(value) && Number.isFinite(new Date(value).getTime()) ? value : null
}

function requestedItems(config) {
  const value = ownData(config, 'items')
  return Number.isInteger(value) && value >= MIN_ITEMS && value <= MAX_ITEMS
    ? value : DEFAULT_ITEMS
}

function normalizedScale(config) {
  const value = ownData(config, 'scale')
  return finite(value) ? Math.min(2, Math.max(0.5, value)) : 1
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeItem(candidate, config) {
  const row = record(candidate)
  if (!row) return null
  const id = displayText(ownData(row, 'id'))
  const title = displayText(ownData(row, 'title'))
  if (!id || !title) return null
  const publishedAt = validTimestamp(ownData(row, 'published_at'))
  const item = { id, title, _publishedAt: publishedAt }

  if (ownData(config, 'show_summary') === true) {
    const summary = displayText(ownData(row, 'summary'))
    if (summary) item.summary = summary
  }
  if (ownData(config, 'show_source') === true) {
    const source = displayText(ownData(row, 'source'))
    const attribution = record(ownData(row, 'attribution'))
    const attributionLabel = displayText(ownData(attribution, 'label'))
    if (source || attributionLabel) item.source = source ?? attributionLabel
  }
  if (ownData(config, 'show_time') === true && publishedAt !== null) item.publishedAt = publishedAt
  return item
}

/**
 * Total read-path normalizer. Required row corruption invalidates the snapshot; optional corruption
 * removes only that field. Stable timestamp/id sorting makes display independent of append order.
 */
export function normalizeNews(value, config) {
  const safeConfig = record(config) ?? {}
  const rows = arrayValues(value, CONTRACT_ITEM_LIMIT)
  const scale = normalizedScale(safeConfig)
  if (!rows || rows.length === 0) return { available: false, items: [], scale }

  const normalized = []
  const ids = new Set()
  for (const row of rows) {
    const item = normalizeItem(row, safeConfig)
    if (!item || ids.has(item.id)) return { available: false, items: [], scale }
    ids.add(item.id)
    normalized.push(item)
  }
  normalized.sort((left, right) => {
    const leftTime = left._publishedAt ?? -Infinity
    const rightTime = right._publishedAt ?? -Infinity
    return rightTime - leftTime || compareText(left.id, right.id)
  })

  const items = normalized.slice(0, requestedItems(safeConfig)).map(({ _publishedAt, ...item }) => item)
  return { available: items.length > 0, items, scale }
}

export function formatNewsTime(publishedAt, now) {
  if (validTimestamp(publishedAt) === null || !finite(now)) return null
  const elapsed = Math.max(0, now - publishedAt)
  if (elapsed < 60_000) return 'Now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function fitted(g, value, start, floor, maxWidth, weight) {
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

function paintText(g, value, x, y, options) {
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

function planHeight(plan, visible) {
  const lines = [plan.titlePx]
  if (visible.summary) lines.push(plan.optionalPx)
  if (visible.source) lines.push(plan.optionalPx)
  if (visible.time) lines.push(plan.optionalPx)
  return lines.reduce((sum, px) => sum + px, 0) + Math.max(0, lines.length - 1) * LINE_GAP
}

function fitPlan(preferred, rowHeight, visible) {
  const at = (fit) => ({
    titlePx: TITLE_FLOOR + Math.floor((preferred.titlePx - TITLE_FLOOR) * fit),
    optionalPx: OPTIONAL_FLOOR + Math.floor((preferred.optionalPx - OPTIONAL_FLOOR) * fit),
  })
  let low = 0
  let high = 1
  for (let step = 0; step < 16; step++) {
    const candidate = (low + high) / 2
    if (planHeight(at(candidate), visible) <= rowHeight + 0.001) low = candidate
    else high = candidate
  }
  return at(low)
}

function rowPlan(box, rowHeight, scale, items) {
  const visible = {
    summary: items.some((item) => item.summary),
    source: items.some((item) => item.source),
    time: items.some((item) => item.publishedAt !== undefined),
  }
  const floorPlan = { titlePx: TITLE_FLOOR, optionalPx: OPTIONAL_FLOOR }
  for (const field of ['summary', 'source', 'time']) {
    if (planHeight(floorPlan, visible) <= rowHeight + 0.001) break
    visible[field] = false
  }
  const preferred = {
    titlePx: Math.max(TITLE_FLOOR, Math.round(Math.min(22, box.w * 0.032, rowHeight * 0.28) * scale)),
    optionalPx: Math.max(OPTIONAL_FLOOR, Math.round(Math.min(16, box.w * 0.022, rowHeight * 0.2) * scale)),
  }
  return { visible, ...fitPlan(preferred, rowHeight, visible) }
}

function drawUnavailable(g, normalized, box, tokens, pad) {
  const usableHeight = Math.max(0, box.h - pad * 2)
  const headlinePx = Math.max(12, Math.round(Math.min(24, box.w * 0.055, usableHeight * 0.24) * normalized.scale))
  const bodyPx = Math.max(10, Math.round(Math.min(16, box.w * 0.032, usableHeight * 0.15) * normalized.scale))
  const preferredTotal = headlinePx + bodyPx + 8
  const fit = preferredTotal > usableHeight && preferredTotal > 0 ? usableHeight / preferredTotal : 1
  const fittedHeadline = Math.max(12, Math.floor(12 + (headlinePx - 12) * fit))
  const fittedBody = Math.max(10, Math.floor(10 + (bodyPx - 10) * fit))
  const total = fittedHeadline + fittedBody + 8
  const top = pad + Math.max(0, (usableHeight - total) / 2)
  paintText(g, 'News unavailable', box.w / 2, top, {
    px: fittedHeadline, floor: 12, maxWidth: box.w - pad * 2,
    color: tokens.ink, align: 'center', weight: 600,
  })
  paintText(g, 'Headlines will appear here', box.w / 2, top + fittedHeadline + 8, {
    px: fittedBody, floor: 10, maxWidth: box.w - pad * 2,
    color: tokens.dim, align: 'center', weight: 400,
  })
}

function draw(g, ctx) {
  const { box, tokens, data, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const normalized = normalizeNews(data, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))
  if (!normalized.available) {
    drawUnavailable(g, normalized, box, tokens, pad)
    return
  }

  const bodyWidth = Math.max(0, box.w - pad * 2)
  const bodyHeight = Math.max(0, box.h - pad * 2)
  const rowHeight = bodyHeight / normalized.items.length
  const plan = rowPlan(box, rowHeight, normalized.scale, normalized.items)

  normalized.items.forEach((item, index) => {
    let y = pad + index * rowHeight
    paintText(g, item.title, pad, y, {
      px: plan.titlePx, floor: TITLE_FLOOR, maxWidth: bodyWidth,
      color: tokens.ink, weight: 600,
    })
    y += plan.titlePx
    if (plan.visible.summary && item.summary) {
      y += LINE_GAP
      paintText(g, item.summary, pad, y, {
        px: plan.optionalPx, floor: OPTIONAL_FLOOR, maxWidth: bodyWidth,
        color: tokens.dim, weight: 400,
      })
      y += plan.optionalPx
    }
    if (plan.visible.source && item.source) {
      y += LINE_GAP
      paintText(g, item.source, pad, y, {
        px: plan.optionalPx, floor: OPTIONAL_FLOOR, maxWidth: bodyWidth,
        color: tokens.dim, weight: 400,
      })
      y += plan.optionalPx
    }
    const time = plan.visible.time && item.publishedAt !== undefined
      ? formatNewsTime(item.publishedAt, now) : null
    if (time) {
      y += LINE_GAP
      paintText(g, time, pad, y, {
        px: plan.optionalPx, floor: OPTIONAL_FLOOR, maxWidth: bodyWidth,
        color: tokens.dim, weight: 400,
      })
    }
  })
}

export default { meta, draw }
