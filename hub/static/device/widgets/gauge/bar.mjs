/**
 * `gauge`/`bar` — a value plotted onto a filled rectangle, coloured by threshold. Gauge's DEFAULT
 * design (first in catalogue order) — `ring` (`./ring.mjs`) is the second. `bar` defaults because
 * `layout-core.mjs`'s `gaugeConfig` has always read `style: c.style === 'ring' ? 'ring' : 'bar'`,
 * i.e. bar unless a cell explicitly opted into ring. This default preserves the appearance of
 * saved gauge cells that do not name a design.
 * Both share `normalizeGauge` (`./shared.mjs`) for every read-path/threshold decision; this file
 * only turns that into pixels, following `text/block.mjs`/`value/tile.mjs`'s structure (a `draw`
 * that only paints what normalize decided). `fitted`/`paintText`/`formatAge` come from
 * `../text-fit.mjs`; `normalizeGauge` from `./shared.mjs`. Both are pure helper modules, which the
 * contract permits — see `docs/architecture/widgets.md`.
 *
 * Drawn with `rect`/`fill` (component contract) — a track rectangle in `tokens.dim`,
 * then a fill rectangle sized to `fraction` on top of it, the direct canvas equivalent of the old
 * DOM's `.gauge-track`/`.gauge-fill` pair (`width:auto` background + `width:${frac*100}%` fill).
 *
 * `ctx.stale`/`ctx.age_ms` and severity-through-tokens (colour-token contract): identical contract to `./ring.mjs` —
 * see that file's docstring for the full reasoning, restated here only where the bar's own shape
 * differs.
 */
import { FLOOR_VALUE, FLOOR_LABEL } from '../../layout-core.mjs'
import { normalizeGauge } from './shared.mjs'
import { fitted, formatAge, paintText } from '../text-fit.mjs'

const meta = {
  id: 'bar',
  widget: 'gauge',
  label: 'Bar',
  // Matches definitions.mjs's own `gauge` entry (suggested_ratio: 2) — a design must not silently
  // disagree with the widget's own declared shape.
  suggested_ratio: 2,
  tokens: {
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
    // No `default` — same reasoning as `./ring.mjs`'s own `decimals` (and value_tile's,
    // `gaugeConfig`'s own default (`decimals: null`) has always meant "no
    // forced rounding", which is not a value `decimals` could ever legitimately hold.
    // `max: 3` matches the grid PATCH schema's `gauge` branch (`hub/src/routes/admin.ts`), which
    // has long accepted `decimals` only as `integer, minimum 0, maximum 3` — see `../value/tile.mjs`
    // for the full note; `hub/test/option-bounds.test.ts` pins the two together.
    decimals: { type: 'number', label: 'Decimals', min: 0, max: 3 },
    // `path`, same declaration as `./ring.mjs`'s — both gauge designs read the same
    // `normalizeGauge`, so both must offer the same knobs or which design a cell picks would
    // change which thresholds an operator can set. `config.thresholds.warn`/`.crit` is the shape
    // `hub/src/routes/admin.ts`'s `gauge` branch accepts; no `default`, because `gaugeConfig`'s own
    // `null` ("no threshold at all") is not a number.
    warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' },
    crit: { type: 'number', label: 'Crit', path: 'thresholds.crit' },
  },
  animations: { transition: [], persistent: [] },
}

/**
 * The severity colour, and only the one that applies (colour-token contract).
 *
 * The fill uses only the token for the resolved severity. The portable-subset guard exercises warn
 * and critical branches with real thresholds, so every declared token is read without throwaway
 * writes.
 */
function resolveSeverityColor(g, tokens, severity) {
  const color = severity === 'critical' ? tokens.critical : severity === 'warn' ? tokens.warn : tokens.info
  g.fillStyle = color
  return color
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeGauge(data, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))
  const usableWidth = Math.max(0, box.w - pad * 2)
  const usableHeight = Math.max(0, box.h - pad * 2)

  const stale = ctx.stale === true
  const ageMs = typeof ctx.age_ms === 'number' ? ctx.age_ms : null
  const showAge = ageMs !== null
  const showLabel = n.label !== ''
  // The old DOM branch's own rule: the unit renders only alongside a real number
  // (`cfg.unit && numeric` — device.js), never next to the em-dash placeholder.
  const showUnit = n.available && n.unit !== ''
  const valueColor = stale ? tokens.dim : tokens.ink

  const labelPx = Math.max(FLOOR_LABEL, Math.round(Math.min(usableHeight * 0.11, usableWidth * 0.08) * n.scale))
  const valuePx = Math.max(FLOOR_VALUE, Math.round(Math.min(usableHeight * 0.24, usableWidth * 0.2) * n.scale))
  const unitPx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.32))
  const agePx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.24))
  const gap = Math.max(2, Math.round(valuePx * 0.16))
  const barW = Math.max(20, Math.round(usableWidth * 0.8))
  const barH = Math.max(6, Math.round(Math.min(usableHeight * 0.14, usableWidth * 0.08) * n.scale))

  const labelBlock = showLabel ? labelPx + gap : 0
  const ageBlock = showAge ? gap + agePx : 0
  const totalHeight = labelBlock + barH + gap + valuePx + ageBlock
  let y = box.h / 2 - totalHeight / 2

  if (showLabel) {
    paintText(g, n.label, box.w / 2, y, {
      px: labelPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 500,
    })
    y += labelPx + gap
  }

  const barX = box.w / 2 - barW / 2
  g.fillStyle = tokens.dim
  g.beginPath()
  g.rect(barX, y, barW, barH)
  g.fill()

  const color = resolveSeverityColor(g, tokens, n.severity)
  if (n.fraction > 0) {
    g.fillStyle = color
    g.beginPath()
    g.rect(barX, y, barW * n.fraction, barH)
    g.fill()
  }
  y += barH + gap

  // Value + unit paint as one horizontally-centred group, unit trailing at its own smaller size —
  // the canvas equivalent of the DOM's `<span class="tile-unit">` sitting right after `.tile-
  // value`'s text (same technique `value/tile.mjs`/`./ring.mjs` use).
  const unitGap = showUnit ? Math.max(2, Math.round(unitPx * 0.2)) : 0
  g.font = `400 ${unitPx}px system-ui`
  const unitWidth = showUnit ? g.measureText(n.unit).width : 0
  const valueMaxWidth = Math.max(0, usableWidth - unitWidth - unitGap)
  const valueFit = fitted(g, n.value, valuePx, FLOOR_VALUE, valueMaxWidth > 0 ? valueMaxWidth : usableWidth, 700)
  g.font = `700 ${valueFit.px}px system-ui`
  const valueWidth = valueFit.text ? g.measureText(valueFit.text).width : 0
  const groupWidth = valueWidth + (showUnit && valueFit.text ? unitGap + unitWidth : 0)
  const groupX = box.w / 2 - groupWidth / 2

  paintText(g, valueFit.text, groupX, y, {
    px: valueFit.px, floor: FLOOR_VALUE, maxWidth: valueMaxWidth > 0 ? valueMaxWidth : usableWidth,
    color: valueColor, align: 'left', baseline: 'top', weight: 700,
  })
  if (showUnit && valueFit.text) {
    paintText(g, n.unit, groupX + valueWidth + unitGap, y + Math.max(0, valueFit.px - unitPx),
      { px: unitPx, floor: FLOOR_LABEL, maxWidth: usableWidth, color: tokens.dim, align: 'left', baseline: 'top', weight: 400 })
  }
  y += valuePx

  if (showAge) {
    y += gap
    paintText(g, formatAge(ageMs), box.w / 2, y, {
      px: agePx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 400,
    })
  }
}

export default { meta, draw }
