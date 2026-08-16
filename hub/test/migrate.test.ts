import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/db/index.js'
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5 } from '../src/db/schema.js'
import { migrate, LATEST_VERSION } from '../src/db/migrate.js'
import { gridToRects } from '../src/db/migrations/v6-rects.js'
// @ts-expect-error plain JS module without types
import { sizeT } from '../static/device/layout-core.mjs'

const cols = (db: any, table: string): string[] =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name)

describe('migrate', () => {
  it('brings a fresh database to the latest version', () => {
    const db = openDb(':memory:')
    // v24 (tabs): creates the device_screens table for per-device screen ordering; v25 drops
    // devices.screen_id now that device_screens is the only place an assignment lives; v26 adds
    // the generic settings table (storage & retention); v27 adds themes.sounds/screens.sounds
    // (alert sounds) — see SCHEMA_V24/V25/V26/V27's docstrings in src/db/schema.ts.
    expect(LATEST_VERSION).toBe(27)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(cols(db, 'settings')).toEqual(['key', 'value', 'updated_at'])
    // v20 drops the retired v18 connector table. A fresh database creates it at v18 and loses it
    // three steps later, which is a strange-looking round trip and the correct one: the migration
    // list is append-only, so the table has to be created before it can be dropped.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connectors'").get())
      .toBeUndefined()
    expect(cols(db, 'alerts')).toEqual(expect.arrayContaining(['options', 'reply_to']))
    expect(cols(db, 'deliveries')).toEqual(expect.arrayContaining(['answered_at', 'answer']))
    expect(cols(db, 'senders')).toEqual(expect.arrayContaining(['relay_key']))
    expect(cols(db, 'source_instances')).toEqual([
      'id', 'provider_id', 'package_id', 'package_version', 'name', 'config', 'strategy',
      'interval_s', 'enabled', 'state', 'next_run_at', 'failure_count', 'last_run_at',
      'last_success_at', 'last_status', 'legacy_connector_id', 'last_used_at', 'rev',
      'created_at', 'updated_at',
    ])
    expect(cols(db, 'source_outputs')).toContain('source_id')
  })

  it('upgrades an existing v1 database without losing data', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1)
    db.pragma('user_version = 1')
    db.prepare('INSERT INTO senders (id,name,token_hash,created_at) VALUES (?,?,?,?)')
      .run('snd_1', 'legacy', 'hash', 1000)
    db.prepare(`INSERT INTO alerts (id,sender_id,title,severity,sound,created_at,updated_at,update_count,status,target_screens)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('alr_1', 'snd_1', 'pre-existing', 'warn', 1, 1000, 1000, 0, 'active', '[]')

    migrate(db as any)

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get('alr_1') as any
    expect(row.title).toBe('pre-existing')   // data survived
    expect(row.options).toBeNull()           // new column, defaulted
    expect(row.reply_to).toBeNull()
    // The pre-existing sender keeps a NULL relay_key: its token was shown once and never stored,
    // so there is nothing to derive a key from. It simply cannot use the relay.
    const legacy = db.prepare('SELECT relay_key FROM senders WHERE id = ?').get('snd_1') as any
    expect(legacy.relay_key).toBeNull()
  })

  it('is idempotent — running twice changes nothing', () => {
    const db = openDb(':memory:')
    migrate(db)
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(cols(db, 'alerts').filter((c) => c === 'options')).toHaveLength(1)
  })

  it('migrates v2 → v3: renames screen tables/columns, preserves rows and ids', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1)
    db.exec(SCHEMA_V2)
    db.pragma('user_version = 2')

    db.prepare('INSERT INTO screens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('scr_1', 'bedside', 'hash', 1000)
    db.prepare('INSERT INTO senders (id, name, token_hash, default_screens, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('snd_1', 'sender', 'hash2', '["scr_1"]', 1000)
    db.prepare(`INSERT INTO alerts (id,sender_id,title,severity,sound,created_at,updated_at,update_count,status,target_screens)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('alr_1', 'snd_1', 'Disk 91%', 'warn', 1, 1000, 1000, 0, 'active', '["scr_1"]')
    db.prepare('INSERT INTO deliveries (alert_id, screen_id) VALUES (?, ?)')
      .run('alr_1', 'scr_1')
    db.prepare('INSERT INTO pairing_codes (code, screen_name, expires_at) VALUES (?, ?, ?)')
      .run('ABCDEF', 'bedside', 2000)

    migrate(db as any)

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    const dev = db.prepare('SELECT * FROM devices').get() as Record<string, unknown>
    expect(dev.id).toMatch(/^scr_/)   // grandfathered id, NOT rewritten
    expect(db.prepare('SELECT default_devices FROM senders').get()).toBeTruthy()
    expect(db.prepare('SELECT target_devices FROM alerts').get()).toBeTruthy()
    expect(db.prepare('SELECT device_name FROM pairing_codes').get()).toBeTruthy()
    expect(db.prepare('SELECT device_id FROM deliveries').get()).toBeTruthy()
  })

  it('migrates v3 → v4: screens table, device orientation/screen_id, pairing orientation, hub sender', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1); db.exec(SCHEMA_V2); db.exec(SCHEMA_V3)
    db.pragma('user_version = 3')
    db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('scr_old', 'bedside', 'hash', 1000)

    migrate(db as any)

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(cols(db, 'screens')).toEqual(['id', 'name', 'orientation', 'grid', 'created_at', 'theme_id', 'rev', 'sounds'])
    // devices.orientation and pairing_codes.orientation are dropped again by v15 — a screen owns
    // the shape now — so the end state of a full migrate has neither. devices.screen_id (added
    // here at v4) is dropped too, by v25 — device_screens is the only place an assignment lives.
    expect(cols(db, 'devices')).not.toContain('orientation')
    expect(cols(db, 'devices')).not.toContain('screen_id')
    expect(cols(db, 'pairing_codes')).not.toContain('orientation')
    // Existing devices survive with no assigned screen (data model).
    expect(db.prepare('SELECT COUNT(*) c FROM device_screens').get()).toEqual({ c: 0 })
    // The reserved hub sender exists for self-notifications and can never authenticate:
    // 'system-sender-no-token' is not a sha256 hex digest, so no real token hashes to it.
    const hub = db.prepare("SELECT * FROM senders WHERE id = 'snd_hub'").get() as any
    expect(hub.name).toBe('Hub')
    expect(hub.token_hash).toBe('system-sender-no-token')
  })

  it('a failing migration leaves the version unchanged (atomicity)', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1)
    db.pragma('user_version = 1')
    // Pre-create deliveries.answer — the FOURTH of v2's five ALTERs — so the first three
    // statements (alerts.options, alerts.reply_to, deliveries.answered_at) succeed and only
    // the fourth fails. This is deliberate: sabotaging the *first* statement would make the
    // migrator throw before it ever reaches the user_version write, so "version stayed at 1"
    // would hold true even with no transaction at all — that would prove nothing. Sabotaging
    // a later statement means the only thing that can stop the first three from sticking is
    // an actual transactional rollback.
    db.exec('ALTER TABLE deliveries ADD COLUMN answer TEXT')
    expect(() => migrate(db as any)).toThrow()
    // The half-applied migration must not have advanced the version — otherwise the next
    // boot skips the remaining DDL and the schema is permanently wrong.
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    // And the columns from the earlier, individually-successful statements must not have
    // stuck around either — this is the assertion that actually proves rollback happened,
    // rather than merely proving the throw beat the pragma write.
    expect(cols(db, 'alerts')).not.toEqual(expect.arrayContaining(['options', 'reply_to']))
    expect(cols(db, 'deliveries')).not.toEqual(expect.arrayContaining(['answered_at']))
    // The statement after the failing one must not have run at all.
    expect(cols(db, 'senders')).not.toEqual(expect.arrayContaining(['relay_key']))
  })

  it('migrates v4 → v5: feeds + feed_rows tables', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1); db.exec(SCHEMA_V2); db.exec(SCHEMA_V3); db.exec(SCHEMA_V4)
    db.pragma('user_version = 4')

    migrate(db as any)

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(cols(db, 'feeds')).toEqual([
      'id', 'name', 'mode', 'cap', 'stale_after_s', 'alert_on_stale',
      'allowed_senders', 'payload', 'pushed_at', 'pushed_by', 'image_rev', 'created_at',
    ])
    expect(cols(db, 'feed_rows')).toEqual(['id', 'feed_id', 'payload', 'pushed_at', 'pushed_by'])
    // mode is DB-permissive for all three modes from day one; the creation API currently allows
    // value|stream only, while 'image' is supported without another migration.
    db.prepare("INSERT INTO feeds (id, name, mode, created_at) VALUES ('feed_a', 'a', 'image', 1)").run()
    expect(() =>
      db.prepare("INSERT INTO feeds (id, name, mode, created_at) VALUES ('feed_b', 'b', 'bogus', 1)").run(),
    ).toThrow()
    // name is UNIQUE (editor dropdown identity, same rule as screens)
    expect(() =>
      db.prepare("INSERT INTO feeds (id, name, mode, created_at) VALUES ('feed_c', 'a', 'value', 1)").run(),
    ).toThrow()
  })

  it('migrates v5 → v6: rewrites every screen grid and lands on the latest version', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1); db.exec(SCHEMA_V2); db.exec(SCHEMA_V3); db.exec(SCHEMA_V4); db.exec(SCHEMA_V5)
    db.prepare('INSERT INTO screens (id, name, orientation, grid, created_at) VALUES (?,?,?,?,?)')
      .run('lay_test', 'n', 'portrait', JSON.stringify({
        template: '2x2',
        cells: [{ widget: 'clock', config: {} }, { widget: 'clock', config: {} },
                 { widget: 'clock', config: {} }, { widget: 'clock', config: {} }],
      }), 1)
    db.pragma('user_version = 5')

    migrate(db as any)

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    const grid = JSON.parse((db.prepare('SELECT grid FROM screens WHERE id = ?').get('lay_test') as { grid: string }).grid)
    expect(grid.template).toBeUndefined()
    expect(grid.cells).toHaveLength(4)
    expect(grid.cells[3].rect).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('a v6 migration that hits an unreadable stored grid warns and leaves that row untouched, rather than crashing the whole run', () => {
    const db = new Database(':memory:')
    db.exec(SCHEMA_V1); db.exec(SCHEMA_V2); db.exec(SCHEMA_V3); db.exec(SCHEMA_V4); db.exec(SCHEMA_V5)
    db.prepare('INSERT INTO screens (id, name, orientation, grid, created_at) VALUES (?,?,?,?,?)')
      .run('lay_bad', 'n', 'portrait', '{not json', 1)
    db.pragma('user_version = 5')

    const warn = (console as any).warn
    let warned = false
    ;(console as any).warn = (...args: unknown[]) => { warned = true; return warn.apply(console, args) }
    try {
      expect(() => migrate(db as any)).not.toThrow()
    } finally {
      (console as any).warn = warn
    }
    expect(warned).toBe(true)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    const row = db.prepare('SELECT grid FROM screens WHERE id = ?').get('lay_bad') as { grid: string }
    expect(row.grid).toBe('{not json')
  })
})

describe('v6 template -> rect migration (gridToRects, pure function)', () => {
  const cell = (w: string) => ({ widget: w, config: {} })

  it('1x1 becomes a single full-bleed rect', () => {
    expect(gridToRects({ template: '1x1', cells: [cell('clock')] })).toEqual({
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }],
    })
  })

  it('2x1 becomes left and right halves', () => {
    expect(gridToRects({ template: '2x1', cells: [cell('clock'), cell('gauge')] })).toEqual({
      cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'gauge', config: {} },
      ],
    })
  })

  it('1x2 becomes top and bottom halves', () => {
    expect(gridToRects({ template: '1x2', cells: [cell('clock'), cell('gauge')] })).toEqual({
      cells: [
        { rect: { x: 0, y: 0, w: 1, h: 0.5 }, widget: 'clock', config: {} },
        { rect: { x: 0, y: 0.5, w: 1, h: 0.5 }, widget: 'gauge', config: {} },
      ],
    })
  })

  it('2x2 becomes four quadrants in row-major order', () => {
    const cells = [cell('clock'), cell('gauge'), cell('table'), cell('chart')]
    expect(gridToRects({ template: '2x2', cells })).toEqual({
      cells: [
        { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, widget: 'clock', config: {} },
        { rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, widget: 'gauge', config: {} },
        { rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, widget: 'table', config: {} },
        { rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, widget: 'chart', config: {} },
      ],
    })
  })

  it('preserves each cell config verbatim', () => {
    const g = { template: '1x1', cells: [{ widget: 'gauge', config: { feed: 'f', path: 'p', min: 0, max: 9 } }] }
    expect(gridToRects(g).cells[0].config).toEqual({ feed: 'f', path: 'p', min: 0, max: 9 })
  })

  it('an unknown template degrades to full bleed rather than throwing', () => {
    expect(gridToRects({ template: '9x9', cells: [cell('clock')] })).toEqual({
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }],
    })
  })

  it('a cell count that disagrees with the template still migrates every cell it has', () => {
    const out = gridToRects({ template: '2x2', cells: [cell('clock')] })
    expect(out.cells).toHaveLength(1)
    expect(out.cells[0].rect).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
  })

  // Every rect comes from gridToRects and sizeT is the production function, so this checks the
  // complete migration path rather than restating either side's expected values by hand.
  it('every migrated rect lands on the sizeT anchor for its template', () => {
    const cellsPerTemplate: Record<string, number> = { '1x1': 1, '2x1': 2, '1x2': 2, '2x2': 4 }
    const anchorPerTemplate: Record<string, number> = { '1x1': 1, '2x1': 0.75, '1x2': 0.75, '2x2': 0.5 }
    for (const template of Object.keys(cellsPerTemplate)) {
      const cells = Array.from({ length: cellsPerTemplate[template] }, (_, i) => cell(`w${i}`))
      const out = gridToRects({ template, cells })
      expect(out.cells).toHaveLength(cellsPerTemplate[template])
      for (const c of out.cells) expect(sizeT(c.rect.w, c.rect.h)).toBe(anchorPerTemplate[template])
    }
  })
})
