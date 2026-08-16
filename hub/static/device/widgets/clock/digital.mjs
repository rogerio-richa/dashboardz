import { clockTimePx, clockDatePx, fitSteps } from '../../layout-core.mjs'

/**
 * Today's clock, ported to the draw contract. Same clockTimePx/clockDatePx ramp, same
 * toLocaleTimeString formatting, same shrink-to-fit as the DOM original it replaces.
 *
 * It DOES centre its content vertically in the cell box (`top = (box.h - totalH) / 2`), where the
 * DOM original sat top-aligned. That top alignment was an artefact of `.cell`'s flex-start
 * default rather than a decision, and centring here is deliberate and ruled — do not "restore"
 * top alignment.
 *
 * It is the DEFAULT design, which makes it the target of degradation contract — every unknown
 * design id on a clock cell lands here. That is why it carries no exotic tokens: the fallback
 * must render acceptably under any theme.
 */
const meta = {
  id: 'digital',
  widget: 'clock',
  label: 'Digital',
  default: true,
  suggested_ratio: 2.0,
  // The clock centres and shrinks rather than stretching, so the off-ratio marker must not fire
  // on it — the exact miscalibration lane 1 left open.
  tokens: {
    time: { type: 'color', default: '@ink' },
    date: { type: 'color', default: '@dim' },
  },
  animations: { transition: [], persistent: [] },
}

function fitted(g, text, startPx, maxWidth) {
  for (const px of fitSteps(startPx, 16)) {
    g.font = `200 ${px}px system-ui`
    if (g.measureText(text).width <= maxWidth) return px
  }
  return 16
}

function draw(g, ctx) {
  const { box, tokens, now, config } = ctx
  const d = new Date(now)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  // `scale` is existing cell config and must keep reaching the renderer — it is one of the two
  // knobs whose death the dead-knob guard was built after, and the clock's was caught only by an
  // on-device screenshot while every suite passed.
  const scale = typeof config?.scale === 'number' ? config.scale : 1
  const timePx = fitted(g, time, clockTimePx(box.t, scale), box.w - 8)
  const datePx = clockDatePx(box.t, scale)
  const totalH = timePx + datePx + 4
  const top = (box.h - totalH) / 2

  g.textAlign = 'center'
  g.textBaseline = 'top'
  g.fillStyle = tokens.time
  g.font = `200 ${timePx}px system-ui`
  g.fillText(time, box.w / 2, top)
  g.fillStyle = tokens.date
  g.font = `400 ${datePx}px system-ui`
  g.fillText(date, box.w / 2, top + timePx + 4)
}

export default { meta, draw }
