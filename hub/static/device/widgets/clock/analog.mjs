import { handAngles } from '../clock-geometry.mjs'

/**
 * Flat analog face: circular face, heavy rim, numerals at 12/3/6/9, tick marks at the other eight
 * hour positions, hour and minute hands, no second hand. The design reference describes a
 * rounded-square face; this implementation draws a circle instead, and which shape ships is
 * deferred until the device reports its actual viewport.
 *
 * suggested_ratio is 1.0, which is what stops lane 1's off-ratio marker from firing wrongly: the
 * design genuinely wants a square, and it centres-and-shrinks in anything else rather than
 * stretching into an ellipse — because the draw code does that, not because any meta field says so.
 *
 * Every rotated draw — each hand AND each tick — is wrapped in save/restore. Without that, a
 * rotation would leak into whatever drew next — and since one canvas is reused per cell across
 * frames, it would compound.
 */
const meta = {
  id: 'analog',
  widget: 'clock',
  label: 'Analog face',
  suggested_ratio: 1.0,
  tokens: {
    face: { type: 'color', default: '@surface' },
    rim: { type: 'color', default: '@ink' },
    tick: { type: 'color', default: '@ink' },
    numeral: { type: 'color', default: '@ink' },
    hand_hour: { type: 'color', default: '@ink' },
    hand_minute: { type: 'color', default: '@ink' },
  },
  animations: { transition: [], persistent: [] },
}

function hand(g, angleDeg, length, width, color) {
  g.save()
  g.rotate(angleDeg * Math.PI / 180)
  g.strokeStyle = color
  g.lineWidth = width
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(0, 0)
  g.lineTo(0, -length)
  g.stroke()
  g.restore()
}

/** One radial tick mark, drawn the same save/rotate/restore way as a hand so a leaked rotation
 * from either shares the same guard. `angleDeg` is degrees clockwise from 12, matching
 * handAngles' convention (0 = 12 o'clock). */
function tick(g, angleDeg, rOuter, rInner, width, color) {
  g.save()
  g.rotate(angleDeg * Math.PI / 180)
  g.strokeStyle = color
  g.lineWidth = width
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(0, -rOuter)
  g.lineTo(0, -rInner)
  g.stroke()
  g.restore()
}

/** The eight hour positions that don't carry a numeral (12/3/6/9 do). */
const TICK_HOURS = [1, 2, 4, 5, 7, 8, 10, 11]

function draw(g, ctx) {
  const { box, tokens, now } = ctx
  const size = Math.min(box.w, box.h)
  const r = size / 2

  g.save()
  g.translate(box.w / 2, box.h / 2)

  const rim = r * 0.06
  const inner = r - rim / 2

  g.fillStyle = tokens.face
  g.beginPath()
  g.arc(0, 0, inner, 0, Math.PI * 2)
  g.fill()

  g.strokeStyle = tokens.rim
  g.lineWidth = rim
  g.beginPath()
  g.arc(0, 0, inner, 0, Math.PI * 2)
  g.stroke()

  g.fillStyle = tokens.numeral
  g.font = `600 ${Math.round(r * 0.26)}px system-ui`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const nr = inner * 0.74
  g.fillText('12', 0, -nr)
  g.fillText('3', nr, 0)
  g.fillText('6', 0, nr)
  g.fillText('9', -nr, 0)

  for (const h of TICK_HOURS) {
    tick(g, h * 30, inner * 0.94, inner * 0.82, r * 0.03, tokens.tick)
  }

  const d = new Date(now)
  const { hour, minute } = handAngles(d.getHours(), d.getMinutes())
  hand(g, minute, inner * 0.82, r * 0.055, tokens.hand_minute)
  hand(g, hour, inner * 0.55, r * 0.075, tokens.hand_hour)

  g.fillStyle = tokens.hand_hour
  g.beginPath()
  g.arc(0, 0, r * 0.06, 0, Math.PI * 2)
  g.fill()

  g.restore()
}

export default { meta, draw }
