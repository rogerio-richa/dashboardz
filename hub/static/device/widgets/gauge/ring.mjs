/**
 * `gauge`/`ring` — a value plotted onto a stroked arc, coloured by threshold. The SECOND design in
 * catalogue order — `bar` (`./bar.mjs`) sorts first and is gauge's default, matching
 * `layout-core.mjs`'s `gaugeConfig`'s own unbroken-since-inception `style` default (`c.style ===
 * 'ring' ? 'ring' : 'bar'`, i.e. bar unless a cell explicitly opted into ring). Ring is fully
 * available as the second design, just not the one a cell gets when it names none.
 * Both share `normalizeGauge` (`./shared.mjs`) for every read-path/threshold decision; this file
 * only turns that into pixels, following `text/block.mjs`/`value/tile.mjs`'s structure (a `draw`
 * that only paints what normalize decided). `fitted`/`paintText`/`formatAge` come from
 * `../text-fit.mjs`; `normalizeGauge` from `./shared.mjs`. Both are pure helper modules, which the
 * contract permits — see `docs/architecture/widgets.md`.
 *
 * The old DOM branch drew a ring with a CSS `conic-gradient` plus a punched-out inner circle to
 * fake a stroke — a canvas has a real one. `arc`/`stroke`/`lineWidth`/`lineCap` draw a TRUE ring
 * directly, so there is no hole to PUNCH. The hole is still PAINTED, though, and deliberately: the
 * DOM version let a theme colour it through the `--gauge-hole` chrome key, and a canvas design
 * cannot read chrome at all. That capability returns here as the declared `hole` token, defaulting
 * to `@bg` so an unthemed board looks exactly as it did. The `--gauge-hole` chrome key itself was
 * retired: it had gone unread by anything since the DOM branch
 * died, and a migration now strips it out of every stored theme's chrome.
 *
 * `ctx.stale`/`ctx.age_ms` (widget contract, shared with text_block/value_tile):
 * `stale` drives ONLY the dimmed treatment of the value text (component contract); the
 * age caption renders whenever the bound feed has actually been PUSHED to (`age_ms !== null`),
 * fresh or stale alike — the old DOM branch's `ageChipHtml` showed an age chip on every push
 * (device.js's own "never-pushed is quiet, not stale" rule), preserved exactly here. The ring's
 * OWN colouring (track background, severity fill) does not dim when stale — matching screen state's
 * own choice to dim only the primary reading, not the whole widget, even though the old DOM's
 * `.tile.stale{opacity:.5}` rule visually faded everything.
 *
 * Severity colour resolves through the design's own declared `tokens` (colour-token contract) —
 * `info`/`warn`/`critical`, each defaulting to the board's own `@info`/`@warn`/`@critical` — never
 * a CSS variable, which does not exist inside a canvas design.
 */
import { FLOOR_VALUE, FLOOR_LABEL } from '../../layout-core.mjs'
import { normalizeGauge } from './shared.mjs'
import { fitted, formatAge, paintText } from '../text-fit.mjs'

const meta = {
  id: 'ring',
  widget: 'gauge',
  label: 'Ring',
  // Matches definitions.mjs's own `gauge` entry (suggested_ratio: 2) — a design must not silently
  // disagree with the widget's own declared shape.
  suggested_ratio: 2,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    info: { type: 'color', default: '@info' },
    warn: { type: 'color', default: '@warn' },
    critical: { type: 'color', default: '@critical' },
    // The ring's centre. `@bg` reproduces the untouched board showing through, which is what an
    // unpainted hole looked like — see the note at the fill in `draw`.
    hole: { type: 'color', default: '@bg' },
  },
  options: {
    label: { type: 'text', label: 'Label', default: '' },
    unit: { type: 'text', label: 'Unit', default: '' },
    min: { type: 'number', label: 'Min', default: 0 },
    max: { type: 'number', label: 'Max', default: 100 },
    // No `default` (same reasoning as value_tile's own `decimals`):
    // `gaugeConfig`'s own default (`decimals: null`) has always meant "no forced rounding", which
    // is not a value `decimals` could ever legitimately hold.
    // `max: 3` matches the grid PATCH schema's `gauge` branch (`hub/src/routes/admin.ts`), which
    // has long accepted `decimals` only as `integer, minimum 0, maximum 3` — see `../value/tile.mjs`
    // for the full note; `hub/test/option-bounds.test.ts` pins the two together.
    decimals: { type: 'number', label: 'Decimals', min: 0, max: 3 },
    // Nested knobs, declarable through `meta.options`'s `path`. They live at
    // `config.thresholds.warn`/`.crit` — the shape `hub/src/routes/admin.ts`'s `gauge` branch has
    // always required (`thresholds`, `additionalProperties: false`) and `normalizeGauge` reads —
    // so the generated field writes exactly what save accepts, and CellConfig.tsx's hand-built
    // `renderGaugeThresholds` is gone. No `default`: `gaugeConfig` defaults both to `null`, which
    // means "no threshold, severity can only ever be info" — not a number either could hold.
    warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' },
    crit: { type: 'number', label: 'Crit', path: 'thresholds.crit' },
  },
  animations: { transition: [], persistent: [] },
}

/**
 * The severity colour, and only the one that applies (colour-token contract).
 *
 * The stroke uses only the token for the resolved severity. The portable-subset guard exercises
 * warn and critical branches with real thresholds, so every declared token is read without
 * throwaway writes.
 */
function resolveSeverityColor(g, tokens, severity) {
  const color = severity === 'critical' ? tokens.critical : severity === 'warn' ? tokens.warn : tokens.info
  g.strokeStyle = color
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
  const valuePx = Math.max(FLOOR_VALUE, Math.round(Math.min(usableHeight * 0.22, usableWidth * 0.2) * n.scale))
  const unitPx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.32))
  const agePx = Math.max(FLOOR_LABEL, Math.round(valuePx * 0.24))
  const gap = Math.max(2, Math.round(valuePx * 0.16))
  const ringD = Math.max(28, Math.round(Math.min(usableHeight * 0.5, usableWidth * 0.8) * n.scale))

  const labelBlock = showLabel ? labelPx + gap : 0
  const ageBlock = showAge ? gap + agePx : 0
  const totalHeight = labelBlock + ringD + gap + valuePx + ageBlock
  let y = box.h / 2 - totalHeight / 2

  if (showLabel) {
    paintText(g, n.label, box.w / 2, y, {
      px: labelPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'center', baseline: 'top', weight: 500,
    })
    y += labelPx + gap
  }

  const cx = box.w / 2
  const cy = y + ringD / 2
  const lineWidth = Math.max(3, Math.round(ringD * 0.16))
  const r = Math.max(1, (ringD - lineWidth) / 2)

  /*
   * The hole, painted rather than left transparent.
   *
   * The DOM gauge coloured it through the `--gauge-hole` chrome key, read by a
   * `.gauge-ring-inner` CSS rule that died with the DOM branch, leaving that key unread until it
   * was retired outright. A canvas design cannot read chrome at all (`resolveTokens` resolves
   * against the BOARD palette), so the capability returns as a declared token instead, which is
   * the mechanism every other design colour already uses.
   *
   * `@bg` as the default reproduces an unpainted hole exactly — the board is what showed through
   * before — so no existing board changes appearance. Drawn first, at the ring's inner edge, so the
   * track and value arcs paint over its boundary rather than leaving a seam.
   */
  g.beginPath()
  g.fillStyle = tokens.hole
  g.arc(cx, cy, Math.max(0, r - lineWidth / 2), 0, Math.PI * 2)
  g.fill()

  g.beginPath()
  g.lineWidth = lineWidth
  g.lineCap = 'butt'
  g.strokeStyle = tokens.dim
  g.arc(cx, cy, r, 0, Math.PI * 2)
  g.stroke()

  const color = resolveSeverityColor(g, tokens, n.severity)
  if (n.fraction > 0) {
    const start = -Math.PI / 2
    g.beginPath()
    g.lineWidth = lineWidth
    g.lineCap = 'round'
    g.strokeStyle = color
    g.arc(cx, cy, r, start, start + n.fraction * Math.PI * 2)
    g.stroke()
  }
  y += ringD + gap

  // Value + unit paint as one horizontally-centred group, unit trailing at its own smaller size —
  // the canvas equivalent of the DOM's `<span class="tile-unit">` sitting right after `.tile-
  // value`'s text (same technique `value/tile.mjs` uses).
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
