import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { buildState } from '../src/ws/stateBuilder.js'
import { setDeviceTabs, getDevice } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'

describe('buildState tabs', () => {
  it('STATE carries screens[] in order with labels, and screen = tab 0', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_1','d','h',0)").run()
    const a = createScreen(db, { name: 'cc', orientation: 'portrait', grid: { cells: [] } }, 0)
    const b = createScreen(db, { name: 'io', orientation: 'portrait', grid: { cells: [] } }, 0)
    setDeviceTabs(db, 'dev_1', [{ screen_id: a.id }, { screen_id: b.id, label: 'env io' }])
    const state = buildState(db, getDevice(db, 'dev_1')!, 0, 1)
    expect(state.screens!.map((s) => s.id)).toEqual([a.id, b.id])
    expect(state.screens![1].label).toBe('env io')
    expect(state.screen!.id).toBe(a.id)
    expect(state.device.orientation).toBe('portrait')
  })

  it('a tab with an unreadable grid degrades that tab only', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_1','d','h',0)").run()
    const a = createScreen(db, { name: 'good', orientation: 'landscape', grid: { cells: [] } }, 0)
    const b = createScreen(db, { name: 'bad', orientation: 'landscape', grid: { cells: [] } }, 0)
    db.prepare('UPDATE screens SET grid = ? WHERE id = ?').run('{not json', b.id)
    setDeviceTabs(db, 'dev_1', [{ screen_id: b.id }, { screen_id: a.id }])
    const state = buildState(db, getDevice(db, 'dev_1')!, 0, 1)
    expect(state.screens!.map((s) => s.id)).toEqual([a.id])   // bad tab omitted
    expect(state.screen!.id).toBe(a.id)                        // screen = first RENDERABLE tab
  })
})
