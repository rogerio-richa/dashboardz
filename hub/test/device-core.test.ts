import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { reduce, sortAlerts, viewModel, yieldTakeoverToHost } from '../static/device/device-core.mjs'

const alert = (id: string, severity: string, updated_at: number) =>
  ({ id, title: id, body: null, severity, sender: { id: 's', name: 'S' }, sound: false,
     created_at: updated_at, updated_at, update_count: 0, expires_at: null })

describe('reduce', () => {
  it('STATE replaces, ALERT_ADD upserts, ALERT_REMOVE deletes', () => {
    let s = reduce([], { type: 'STATE', device: { id: 'x', name: 'x' }, server_time: 0, alerts: [alert('a', 'info', 1)] })
    expect(s).toHaveLength(1)
    s = reduce(s, { type: 'ALERT_ADD', alert: alert('b', 'warn', 2) })
    s = reduce(s, { type: 'ALERT_ADD', alert: { ...alert('a', 'critical', 3), title: 'updated' } })
    expect(s).toHaveLength(2)
    expect(s.find((x: any) => x.id === 'a').title).toBe('updated')
    s = reduce(s, { type: 'ALERT_REMOVE', id: 'b', reason: 'dismissed' })
    expect(s.map((x: any) => x.id)).toEqual(['a'])
  })
})

describe('sortAlerts', () => {
  it('sorts severity first then recency', () => {
    const sorted = sortAlerts([alert('i', 'info', 9), alert('c', 'critical', 1), alert('w', 'warn', 5)])
    expect(sorted.map((a: any) => a.id)).toEqual(['c', 'w', 'i'])
  })
})

describe('viewModel', () => {
  it('splits cards vs chips by capacity and surfaces unsilenced critical takeover', () => {
    const alerts = [alert('c1', 'critical', 10), alert('c2', 'critical', 20), alert('w', 'warn', 5), alert('i', 'info', 1)]
    const vm = viewModel(alerts, 2, new Set(['c2']))
    expect(vm.takeover.id).toBe('c1')          // newest unsilenced critical
    expect(vm.extraCriticalCount).toBe(1)
    expect(vm.cards.map((a: any) => a.id)).toEqual(['c2', 'c1'])
    expect(vm.chips.map((a: any) => a.id)).toEqual(['w', 'i'])
    const quiet = viewModel([alert('i', 'info', 1)], 2, new Set())
    expect(quiet.takeover).toBeNull()
    expect(quiet.chips).toEqual([])
  })
})

describe('yieldTakeoverToHost', () => {
  it('yields only when driven AND the host explicitly owns takeover', () => {
    expect(yieldTakeoverToHost(true, true)).toBe(true)
  })

  it('does not yield to an old shell that hosts but declares no ownership', () => {
    expect(yieldTakeoverToHost(true, false)).toBe(false)
  })

  it('does not yield when undriven, even if hostOwns is somehow true', () => {
    expect(yieldTakeoverToHost(false, true)).toBe(false)
  })

  it('does not yield when neither condition holds', () => {
    expect(yieldTakeoverToHost(false, false)).toBe(false)
  })
})
