import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/migrate.js'
import { listDeviceTabs, setDeviceTabs, assignScreen } from '../src/db/devices.js'
import { createScreen, deleteScreen, assignedDeviceIds } from '../src/db/screens.js'

const grid = { cells: [] }

describe('migration v24', () => {
  it('copies an existing assignment to position 0', () => {
    const db = new Database(':memory:')
    migrate(db, { targetVersion: 23 })
    db.prepare("INSERT INTO screens (id, name, orientation, grid, rev, created_at) VALUES ('lay_1','s','landscape','{}',1,0)").run()
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at, screen_id) VALUES ('dev_1','d','h',0,'lay_1')").run()
    migrate(db, { targetVersion: 24 })
    expect(listDeviceTabs(db, 'dev_1')).toEqual([{ screen_id: 'lay_1', position: 0, label: null }])
  })

  /**
   * A devices.screen_id naming a screen that was since deleted (no FK
   * enforced it pre-tabs) must not abort the whole migration — foreign_keys = ON means the naive
   * INSERT throws and the hub never boots. The dangling row is skipped; every other device's
   * assignment still migrates.
   */
  it('skips a dangling screen_id instead of aborting the whole migration', () => {
    const db = new Database(':memory:')
    migrate(db, { targetVersion: 23 })
    db.prepare("INSERT INTO screens (id, name, orientation, grid, rev, created_at) VALUES ('lay_1','s','landscape','{}',1,0)").run()
    // dev_1 names a screen that no longer exists. better-sqlite3 enforces foreign_keys by
    // default, same as openDb — so producing this row at all means going around that (a hub
    // build that predates FK enforcement, or a hand-edited file); toggle it off just for this
    // one insert to reproduce that history, same as production's actual dangling row would have
    // gotten there, then restore it before migrating — openDb always has it ON by the time v24
    // runs for real.
    db.pragma('foreign_keys = OFF')
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at, screen_id) VALUES ('dev_1','d','h',0,'lay_gone')").run()
    db.pragma('foreign_keys = ON')
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at, screen_id) VALUES ('dev_2','d2','h2',0,'lay_1')").run()
    expect(() => migrate(db, { targetVersion: 24 })).not.toThrow()
    expect(listDeviceTabs(db, 'dev_1')).toEqual([])
    expect(listDeviceTabs(db, 'dev_2')).toEqual([{ screen_id: 'lay_1', position: 0, label: null }])
  })
})

describe('migration v25', () => {
  it('drops devices.screen_id while device_screens (copied by v24) keeps answering', () => {
    const db = new Database(':memory:')
    migrate(db, { targetVersion: 23 })
    db.prepare("INSERT INTO screens (id, name, orientation, grid, rev, created_at) VALUES ('lay_1','s','landscape','{}',1,0)").run()
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at, screen_id) VALUES ('dev_1','d','h',0,'lay_1')").run()
    // Runs v24 (copies the populated column into device_screens) then v25 (drops the column) in
    // the same call — proving DROP COLUMN on an FK child column leaves the join-table copy intact.
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(devices)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('screen_id')
    expect(listDeviceTabs(db, 'dev_1')).toEqual([{ screen_id: 'lay_1', position: 0, label: null }])
  })
})

describe('setDeviceTabs / listDeviceTabs', () => {
  let db: any, s1: any, s2: any
  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_1','d','h',0)").run()
    s1 = createScreen(db, { name: 'a', orientation: 'landscape', grid }, 0)
    s2 = createScreen(db, { name: 'b', orientation: 'landscape', grid }, 0)
  })
  it('replaces the whole ordered list and preserves labels', () => {
    setDeviceTabs(db, 'dev_1', [{ screen_id: s1.id }, { screen_id: s2.id, label: 'io' }])
    setDeviceTabs(db, 'dev_1', [{ screen_id: s2.id, label: 'io' }, { screen_id: s1.id }])
    expect(listDeviceTabs(db, 'dev_1')).toEqual([
      { screen_id: s2.id, position: 0, label: 'io' },
      { screen_id: s1.id, position: 1, label: null },
    ])
  })
  it('assignScreen is pure single-tab sugar over setDeviceTabs (v25: no legacy column left to dual-write)', () => {
    expect(assignScreen(db, 'dev_1', s1.id)).toBe(true)
    expect(listDeviceTabs(db, 'dev_1')).toEqual([{ screen_id: s1.id, position: 0, label: null }])
    expect(assignScreen(db, 'dev_1', null)).toBe(true)
    expect(listDeviceTabs(db, 'dev_1')).toEqual([])
  })
  it('assignScreen returns false for an unknown device', () => {
    expect(assignScreen(db, 'dev_nope', s1.id)).toBe(false)
  })
  it('deleteScreen removes the tab and compacts positions', () => {
    setDeviceTabs(db, 'dev_1', [{ screen_id: s1.id }, { screen_id: s2.id }])
    deleteScreen(db, s1.id)
    expect(listDeviceTabs(db, 'dev_1')).toEqual([{ screen_id: s2.id, position: 0, label: null }])
  })
  it('deleteScreen returns every device whose tabs referenced the deleted screen', () => {
    setDeviceTabs(db, 'dev_1', [{ screen_id: s1.id }])
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_2','d2','h2',0)").run()
    assignScreen(db, 'dev_2', s1.id)
    expect(listDeviceTabs(db, 'dev_1')).toHaveLength(1)
    expect(listDeviceTabs(db, 'dev_2')).toEqual([{ screen_id: s1.id, position: 0, label: null }])
    const result = deleteScreen(db, s1.id)
    expect(result.deleted).toBe(true)
    expect(result.resetDeviceIds).toHaveLength(2)
    expect(result.resetDeviceIds).toContain('dev_1')
    expect(result.resetDeviceIds).toContain('dev_2')
  })
})

describe('assignedDeviceIds', () => {
  it('finds devices via device_screens tabs (single truth since v25)', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_1','d','h',0)").run()
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_2','d2','h2',0)").run()
    const s1 = createScreen(db, { name: 'a', orientation: 'landscape', grid }, 0)
    setDeviceTabs(db, 'dev_1', [{ screen_id: s1.id }])
    assignScreen(db, 'dev_2', s1.id)
    expect(assignedDeviceIds(db, s1.id).sort()).toEqual(['dev_1', 'dev_2'])
  })
  it('a device with no tab on the screen is not returned', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_1','d','h',0)").run()
    const s1 = createScreen(db, { name: 'a', orientation: 'landscape', grid }, 0)
    const s2 = createScreen(db, { name: 'b', orientation: 'landscape', grid }, 0)
    setDeviceTabs(db, 'dev_1', [{ screen_id: s2.id }])
    expect(assignedDeviceIds(db, s1.id)).toEqual([])
  })
})
