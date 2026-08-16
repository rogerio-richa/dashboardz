import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import statusbar from '../static/device/widgets/value/statusbar.mjs'
// @ts-expect-error plain JS module without types
import { normalizeStatus } from '../static/device/widgets/value/statusbar.mjs'

type Call = { fillStyle: string; text: string }
type FillCall = { style: string; arc: { r: number } | null }

function recorder() {
  const calls: Call[] = []
  const fills: FillCall[] = []
  let lastArc: FillCall['arc'] = null
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string) => calls.push({ fillStyle: g.fillStyle, text }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => { lastArc = null }, closePath: () => {},
    moveTo: () => {}, lineTo: () => {},
    arc: (_cx: number, _cy: number, r: number) => { lastArc = { r } },
    rect: () => {}, stroke: () => {},
    fill: () => fills.push({ style: g.fillStyle, arc: lastArc }),
  }
  return { g, calls, fills }
}

const tokens = { ink: '#ink', dim: '#dim', info: '#info', critical: '#crit' }
const telemetry = {
  node: { name: 'Node-01', short: 'N01', hw: 'TBEAM' },
  battery_pct: 84, plugged_in: false, voltage: 4.12,
  channel_util_pct: 4.2, air_util_tx_pct: 1.1, uptime_s: 1000, nodes_seen: 7,
}
const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens,
  config: { path: '', label: 'Meshtastic Dashboard' },
  data: telemetry,
  box: { w: 800, h: 80, t: 1 },
  now: 0, state: {}, motion: 'full', stale: false, age_ms: 5_000,
  ...overrides,
})

const dot = (fills: FillCall[]) => fills.find((f) => f.arc !== null)

describe('value/statusbar normalize', () => {
  it('is active on fresh data, quiet past 90s, down when stale or empty', () => {
    expect(normalizeStatus(telemetry, {}, false, 5_000).state).toBe('active')
    expect(normalizeStatus(telemetry, {}, false, 91_000).state).toBe('quiet')
    expect(normalizeStatus(telemetry, {}, true, 5_000).state).toBe('down')
    expect(normalizeStatus(null, {}, false, null).state).toBe('down')
  })

  it('reads node name, battery and nodes_seen off the payload', () => {
    const n = normalizeStatus(telemetry, {}, false, 5_000)
    expect(n.node).toBe('Node-01')
    expect(n.battery).toBe(84)
    expect(n.nodes).toBe(7)
  })
})

describe('value/statusbar design', () => {
  it('registers as a value_tile design named statusbar', () => {
    expect(statusbar.meta.widget).toBe('value_tile')
    expect(statusbar.meta.id).toBe('statusbar')
  })

  it('paints a green dot and Mesh Active on fresh telemetry', () => {
    const { g, calls, fills } = recorder()
    statusbar.draw(g, baseCtx())
    expect(dot(fills)?.style).toBe('#info')
    expect(calls.some((c) => c.text.includes('Mesh Active'))).toBe(true)
  })

  it('paints a dim dot and Mesh Quiet when telemetry is aging', () => {
    const { g, calls, fills } = recorder()
    statusbar.draw(g, baseCtx({ age_ms: 120_000 }))
    expect(dot(fills)?.style).toBe('#dim')
    expect(calls.some((c) => c.text.includes('Mesh Quiet'))).toBe(true)
  })

  it('paints a red dot and Mesh Offline when stale, and when there is no data at all', () => {
    const staleRun = recorder()
    statusbar.draw(staleRun.g, baseCtx({ stale: true }))
    expect(dot(staleRun.fills)?.style).toBe('#crit')
    expect(staleRun.calls.some((c) => c.text.includes('Mesh Offline'))).toBe(true)

    const emptyRun = recorder()
    statusbar.draw(emptyRun.g, baseCtx({ data: null, age_ms: null }))
    expect(dot(emptyRun.fills)?.style).toBe('#crit')
    expect(emptyRun.calls.some((c) => c.text.includes('Mesh Offline'))).toBe(true)
  })

  it('paints the title and the connected fragment', () => {
    const { g, calls } = recorder()
    statusbar.draw(g, baseCtx())
    expect(calls.some((c) => c.text === 'Meshtastic Dashboard' && c.fillStyle === '#ink')).toBe(true)
    expect(calls.some((c) => c.text === 'Connected: Node-01 (Battery: 84%)')).toBe(true)
    expect(calls.some((c) => c.text === 'Mesh Active | Nodes seen: 7')).toBe(true)
  })

  it('degrades on payloads missing the meshtastic fields', () => {
    const { g, calls } = recorder()
    statusbar.draw(g, baseCtx({ data: { value: 23.4 }, config: { label: 'Temperature' } }))
    expect(calls.some((c) => c.text === 'Connected: —')).toBe(true)
  })

  it('drops the second line at strip heights', () => {
    const { g, calls } = recorder()
    statusbar.draw(g, baseCtx({ box: { w: 800, h: 34, t: 1 } }))
    expect(calls.some((c) => c.text.includes('Nodes seen'))).toBe(false)
    expect(calls.some((c) => c.text === 'Meshtastic Dashboard')).toBe(true)
  })
})
