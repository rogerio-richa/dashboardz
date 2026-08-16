/**
 * `value_tile`/`statusbar` — a slim full-width header strip: the cell's label as a board title on
 * the left, `Connected: <node> (Battery: NN%)` plus a status dot on the right, and (when the strip
 * is tall enough) a second line `Mesh <Active|Quiet|Offline> | Nodes seen: N`. Built for the
 * Meshtastic telemetry payload (integrations/meshtastic/monitor.py); on any other value payload it
 * degrades to title + `Connected: —` + the dot, which still tells the truth the dot exists for.
 *
 * The dot is FRESHNESS, not payload data — the one liveness signal the platform already carries
 * per cell (`ctx.stale`/`ctx.age_ms`, the same channel every migrated design reads):
 *   - `active`  → `info` (green): payload present, pushed within QUIET_AFTER_MS.
 *   - `quiet`   → `dim` (gray): payload present but the last push is older than QUIET_AFTER_MS
 *     (90s = three missed pushes at monitor.py's 30s TELEMETRY_EVERY_S default).
 *   - `down`    → `critical` (red): `ctx.stale` (the hub's own per-feed verdict) or no payload
 *     at all — including unbound/missing-feed, which for a HEADER is better said as the red dot
 *     and "Mesh Offline" than as value_tile's centred loud notice; a wall panel's header should
 *     degrade to "the mesh is not okay", not to configuration prose.
 *
 * Gray, not yellow, for `quiet` — two reasons, recorded because the mock says yellow: dimming is
 * the codebase's established staleness idiom (every design dims its reading), and the
 * portable-token guard (portable-subset.test.ts) drives designs only with `age_ms: null`/
 * `stale: false`, so a `warn` token reachable only on an age branch would be declared-but-never-
 * painted and fail the catalogue-wide dead-slot check. See the widget contract.
 *
 * `node.name`/`battery_pct`/`nodes_seen` are read by fixed name off the payload (siblings of
 * whatever `config.path` would resolve), NOT `meta.options` knobs — same reasoning as
 * `gauge/battery.mjs`: options must name keys the save schema already accepts, and the value_tile
 * branch has no business growing Meshtastic field-name knobs.
 */
import { resolvePath } from '../../layout-core.mjs'
import { FLOOR_LABEL } from '../../layout-core.mjs'
import { fitted, paintText } from '../text-fit.mjs'

const QUIET_AFTER_MS = 90_000

const meta = {
  id: 'statusbar',
  widget: 'value_tile',
  label: 'Status bar',
  // Deliberately NOT value_tile's 3/2 (the discipline ring.mjs states is "don't silently
  // disagree" — this one is loud): a header strip is a wide band, and the admin preview should
  // suggest one. Nothing pins a design's ratio to its widget's (widget-definitions.test.ts pins
  // only the WIDGET table).
  suggested_ratio: 6,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    info: { type: 'color', default: '@info' },
    critical: { type: 'color', default: '@critical' },
  },
  options: {
    label: { type: 'text', label: 'Label', default: '' },
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

/** Same rule as every migrated design's scalarSource: stream-bound cells read the newest row. */
function scalarSource(data) {
  return isArray(data) ? data[0] : data
}

/**
 * Every display decision, none of the painting. `stale`/`ageMs` are `ctx.stale`/`ctx.age_ms`
 * verbatim; `data` is `dataForCell`'s output. Exported for the design's own suite.
 */
export function normalizeStatus(data, config, stale, ageMs) {
  const c = record(config) ?? {}
  const label = typeof c.label === 'string' ? c.label : ''
  const scale = typeof c.scale === 'number' && Number.isFinite(c.scale)
    ? Math.min(2, Math.max(0.5, c.scale)) : 1
  const src = record(scalarSource(data))

  const nodeVal = resolvePath(src, 'node.name')
  const node = typeof nodeVal === 'string' && nodeVal !== '' ? nodeVal : null
  const batteryVal = resolvePath(src, 'battery_pct')
  const battery = typeof batteryVal === 'number' && Number.isFinite(batteryVal) ? Math.round(batteryVal) : null
  const nodesVal = resolvePath(src, 'nodes_seen')
  const nodes = typeof nodesVal === 'number' && Number.isFinite(nodesVal) ? nodesVal : null

  const state = src === null || stale === true
    ? 'down'
    : (typeof ageMs === 'number' && ageMs > QUIET_AFTER_MS ? 'quiet' : 'active')

  return { state, label, scale, node, battery, nodes }
}

const STATUS_COPY = { active: 'Mesh Active', quiet: 'Mesh Quiet', down: 'Mesh Offline' }

function dotColor(tokens, state) {
  return state === 'down' ? tokens.critical : state === 'quiet' ? tokens.dim : tokens.info
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeStatus(data, config, ctx.stale === true,
    typeof ctx.age_ms === 'number' ? ctx.age_ms : null)

  const pad = Math.max(6, Math.min(20, box.h * 0.18))
  const usableWidth = Math.max(0, box.w - pad * 2)
  // Two lines need headroom; below ~48px the strip is a single line (title + connected + dot).
  const twoLines = box.h >= 48
  // Width cap 0.024: the reference mock's title runs ~2.4% of board width — the earlier 0.035
  // ballooned the title on wide boards into a banner rather than a header line.
  const titlePx = Math.max(FLOOR_LABEL, Math.round(Math.min(box.h * (twoLines ? 0.3 : 0.44), box.w * 0.024) * n.scale))
  const metaPx = Math.max(FLOOR_LABEL, Math.round(titlePx * 0.72))
  const lineY = twoLines ? box.h * 0.32 : box.h / 2

  // Right side first, so the title knows how much width remains: dot, then the connected
  // fragment to its left.
  const dotR = Math.max(4, Math.round(titlePx * 0.32))
  const dotCx = box.w - pad - dotR
  g.beginPath()
  g.fillStyle = dotColor(tokens, n.state)
  g.arc(dotCx, lineY, dotR, 0, Math.PI * 2)
  g.fill()

  const connected = n.node === null
    ? 'Connected: —'
    : `Connected: ${n.node}${n.battery === null ? '' : ` (Battery: ${n.battery}%)`}`
  const connMax = usableWidth * 0.55
  const connFit = fitted(g, connected, metaPx, FLOOR_LABEL, connMax, 500)
  g.font = `500 ${connFit.px}px system-ui`
  const connWidth = connFit.text ? g.measureText(connFit.text).width : 0
  const connX = dotCx - dotR - Math.round(metaPx * 0.6) - connWidth
  paintText(g, connFit.text, connX, lineY, {
    px: connFit.px, floor: FLOOR_LABEL, maxWidth: connMax,
    color: n.state === 'down' ? tokens.dim : tokens.ink, align: 'left', baseline: 'middle', weight: 500,
  })

  // Title, clipped to the width the right side left over.
  if (n.label !== '') {
    const titleMax = Math.max(0, connX - pad - Math.round(titlePx * 0.8))
    paintText(g, n.label, pad, lineY, {
      px: titlePx, floor: FLOOR_LABEL, maxWidth: titleMax > 0 ? titleMax : usableWidth * 0.4,
      color: tokens.ink, align: 'left', baseline: 'middle', weight: 700,
    })
  }

  // Below 48px the dot alone carries the state; the copy returns as soon as the strip can hold
  // two lines (the degrade order: second line drops first).
  if (twoLines) {
    const status = STATUS_COPY[n.state]
    const line = n.nodes === null ? status : `${status} | Nodes seen: ${n.nodes}`
    paintText(g, line, pad, box.h * 0.72, {
      px: metaPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'left', baseline: 'middle', weight: 400,
    })
  }
}

export default { meta, draw }
