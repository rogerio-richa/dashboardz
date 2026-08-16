import { describe, expect, it, beforeEach, vi } from 'vitest'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createPairingCode, redeemPairingCode, assignScreen, getDevice } from '../src/db/devices.js'
import { buildState } from '../src/ws/stateBuilder.js'
import { createFeed, pushStreamRow, pushValue, type FeedRow } from '../src/db/feeds.js'
import type { FastifyInstance } from 'fastify'
// @ts-expect-error plain JS module without types
import { rectsOverlap, rectValid, RECT_MIN, chartConfig } from '../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { normalizeGauge } from '../static/device/widgets/gauge/shared.mjs'

/** rect helper (layout model) — screen fractions, exact multiples of 0.001. */
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })
const FULL = rect(0, 0, 1, 1)

const GRID = { cells: [
  { rect: rect(0, 0, 0.5, 1), widget: 'clock', config: {} },
  { rect: rect(0.5, 0, 0.5, 1), widget: 'alert_feed', config: { min_severity: 'warn', clamp: { title_lines: 1, body_lines: 2 }, overflow: { counter: true } } },
] }

describe('/admin/api/screens', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string
  let valueFeed: FeedRow
  let streamFeed: FeedRow
  let streamFeed2: FeedRow
  let imageFeed: FeedRow

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
    valueFeed = createFeed(db, { name: 'value feed', mode: 'value' }, Date.now())
    streamFeed = createFeed(db, { name: 'stream feed', mode: 'stream' }, Date.now())
    streamFeed2 = createFeed(db, { name: 'stream feed 2', mode: 'stream' }, Date.now())
    imageFeed = createFeed(db, { name: 'image feed', mode: 'image' }, Date.now())
  })

  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/admin/api/screens', headers: { cookie }, payload })

  it('creates, lists (parsed grid + assigned_count), patches, deletes', async () => {
    const created = await post({ name: 'Kitchen', orientation: 'landscape', grid: GRID })
    expect(created.statusCode).toBe(200)
    // `warnings` is a property of the SAVE, not of the screen: it says what was advisory about
    // this write, and re-reading a screen later must not resurface a judgement about data that has
    // been pushed many times since. So it is stripped before comparing against the stored row.
    const { warnings, ...row } = created.json()
    expect(warnings).toEqual([])
    expect(row.id).toMatch(/^lay_/)
    expect(row.grid).toEqual(GRID)

    const list = await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })
    expect(list.json()).toEqual([{ ...row, assigned_count: 0 }])

    const patch = await app.inject({ method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie }, payload: { name: 'Kitchen 2' } })
    expect(patch.statusCode).toBe(204)

    const del = await app.inject({ method: 'DELETE', url: `/admin/api/screens/${row.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })).json()).toEqual([])
  })

  it('accepts the editor’s scale options for clock and alert_feed', async () => {
    const ok = await post({ name: 'scaled originals', orientation: 'portrait', grid: {
      cells: [
        { rect: rect(0, 0, 0.5, 1), widget: 'clock', config: { scale: 1.5 } },
        { rect: rect(0.5, 0, 0.5, 1), widget: 'alert_feed', config: { min_severity: 'warn', scale: 0.75 } },
      ],
    } })
    expect(ok.statusCode).toBe(200)
  })

  it('rejects scale outside 0.5..2 on clock and alert_feed like every other widget', async () => {
    for (const cell of [
      { widget: 'clock', config: { scale: 3 } },
      { widget: 'alert_feed', config: { scale: 0.1 } },
    ]) {
      const res = await post({ name: `bad-${cell.widget}`, orientation: 'portrait', grid: { cells: [{ rect: FULL, ...cell }] } })
      expect(res.statusCode, cell.widget).toBe(400)
    }
  })

  it('reports an unknown config key readably instead of an AJV oneOf wall', async () => {
    const res = await post({ name: 'bad key', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: { nonsense: 1 } }],
    } })
    expect(res.statusCode).toBe(400)
    const msg = res.json().error as string
    // The old message repeated "must be equal to constant" once per oneOf arm (8x) and never
    // named the offending cell or widget. Readable means: names the cell, names the widget,
    // and is not a wall.
    expect(msg).toMatch(/cell 1/i)
    expect(msg).toMatch(/clock/i)
    expect(msg.match(/must be equal to constant/g) ?? []).toHaveLength(0)
    expect(msg.length).toBeLessThan(200)
  })

  it('rejects every malformed grid shape before it reaches a device', async () => {
    const bad = async (grid: unknown, why: string) => {
      const res = await post({ name: `x-${why}`, orientation: 'landscape', grid })
      expect(res.statusCode, why).toBe(400)
    }
    await bad({ cells: [] }, 'empty cells array')
    await bad({ cells: [{ widget: 'clock', config: {} }] }, 'cell missing rect')
    await bad({ cells: [{ rect: FULL, widget: 'sparkline', config: {} }] }, 'widget not in registry')
    await bad({ cells: [{ rect: FULL, widget: 'clock', config: { extra: 1 } }] }, 'clock config must be empty')
    await bad({ cells: [{ rect: FULL, widget: 'alert_feed', config: { min_severity: 'loud' } }] }, 'bad severity')
    await bad({ cells: [{ rect: FULL, widget: 'alert_feed', config: { clamp: { title_lines: 0 } } }] }, 'clamp below 1')
    await bad({ cells: [{ rect: FULL, widget: 'alert_feed', config: { clamp: { title_lines: 11 } } }] }, 'clamp above 10')
    await bad({ cells: [{ rect: FULL, widget: 'alert_feed', config: { overflow: { counter: 'yes' } } }] }, 'counter not boolean')
    await bad({ cells: [{ rect: FULL, widget: 'alert_feed', config: { unknown: true } }] }, 'unknown config key')
    // chime_activity (stream-activity contract) is declared only on stream_list/table — a clock cell rejects it exactly
    // like any other unknown config key.
    await bad({ cells: [{ rect: FULL, widget: 'clock', config: { chime_activity: true } }] }, 'chime_activity not accepted on clock')
  })

  it('rejects duplicate names and unknown orientation', async () => {
    await post({ name: 'A', orientation: 'landscape', grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] } })
    const dup = await post({ name: 'A', orientation: 'landscape', grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] } })
    expect(dup.statusCode).toBe(400)
    expect(dup.json().error).toBe('name already exists')
    const badO = await post({ name: 'B', orientation: 'diagonal', grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] } })
    expect(badO.statusCode).toBe(400)
  })

  it('bounds screen IDs before route lookup', async () => {
    const oversized = `lay_${'a'.repeat(81)}`
    const patch = await app.inject({
      method: 'PATCH', url: `/admin/api/screens/${oversized}`, headers: { cookie }, payload: { name: 'x' },
    })
    const remove = await app.inject({ method: 'DELETE', url: `/admin/api/screens/${oversized}`, headers: { cookie } })
    expect(patch.statusCode).toBe(400)
    expect(remove.statusCode).toBe(400)
  })

  it('audits screen_created / screen_updated / screen_deleted', async () => {
    const row = (await post({ name: 'A', orientation: 'portrait', grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] } })).json()
    await app.inject({ method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie }, payload: { orientation: 'landscape' } })
    await app.inject({ method: 'DELETE', url: `/admin/api/screens/${row.id}`, headers: { cookie } })
    const events = (db.prepare("SELECT event FROM audit_log WHERE event LIKE 'screen_%' ORDER BY id").all() as any[]).map((r) => r.event)
    expect(events).toEqual(['screen_created', 'screen_updated', 'screen_deleted'])
  })

  it('with assigned devices: flips freely, shows assigned_count, pushes STATE on PATCH/DELETE', async () => {
    // Create screen
    const screen = (await post({ name: 'Lobby', orientation: 'landscape', grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] } })).json()

    // Create and assign a device
    const now = Date.now()
    const { code } = createPairingCode(db, 'TestDevice', now)
    const { device } = redeemPairingCode(db, code, now)!
    assignScreen(db, device.id, screen.id)

    // GET shows assigned_count: 1
    const list = await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })
    const screens = list.json() as any[]
    expect(screens[0].assigned_count).toBe(1)

    // v15: a screen owns its shape, so flipping it with devices attached is the ordinary case —
    // the device follows on the next STATE rather than having to be unassigned first.
    const flip = await app.inject({
      method: 'PATCH',
      url: `/admin/api/screens/${screen.id}`,
      headers: { cookie },
      payload: { orientation: 'portrait' },
    })
    expect(flip.statusCode).toBe(204)
    expect(buildState(db, getDevice(db, device.id)!, Date.now(), 1).device.orientation).toBe('portrait')

    // PATCH grid change pushes STATE to assigned device. `rev` is mandatory on a grid save (v14)
    // — see screenLostUpdate.test.ts for why.
    const pushSpy = vi.spyOn(app.statePusher, 'push')
    const patchGrid = await app.inject({
      method: 'PATCH',
      url: `/admin/api/screens/${screen.id}`,
      headers: { cookie },
      payload: { grid: { cells: [{ rect: FULL, widget: 'alert_feed', config: {} }] }, rev: 2 },
    })
    expect(patchGrid.statusCode).toBe(200)
    expect(patchGrid.json()).toMatchObject({ id: screen.id, rev: 3, grid: { cells: [{ widget: 'alert_feed' }] } })
    expect(pushSpy).toHaveBeenCalledWith(device.id)

    // DELETE pushes STATE to reset device
    pushSpy.mockClear()
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/screens/${screen.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    expect(pushSpy).toHaveBeenCalledWith(device.id)
  })

  it('a corrupt stored grid does not 500 the list: the row stays present with a fallback grid so it can still be deleted', async () => {
    const row = (await post({ name: 'Corrupt', orientation: 'landscape', grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] } })).json()
    db.prepare('UPDATE screens SET grid = ? WHERE id = ?').run('{not json', row.id)

    const list = await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })
    expect(list.statusCode).toBe(200)
    const found = (list.json() as any[]).find((r) => r.id === row.id)
    expect(found).toBeDefined()
    // screenOut's fallback: no `template` to fall back to under v6 — just
    // an empty cell list, still present and deletable.
    expect(found.grid).toEqual({ cells: [] })

    // Still deletable from the admin UI — a hidden corrupt row would be undeletable.
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/screens/${row.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
  })

  it('accepts a full data-widget grid when feeds exist and modes fit', async () => {
    const res = await post({ name: 'data board', orientation: 'landscape', grid: {
      cells: [
        { rect: rect(0, 0, 0.5, 0.5), widget: 'value_tile', config: { feed: valueFeed.id, path: 'cpu.load', label: 'CPU', unit: '%', format: 'abbrev', scale: 1.5 } },
        { rect: rect(0.5, 0, 0.5, 0.5), widget: 'gauge', config: { feed: valueFeed.id, path: 'mem', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } } },
        { rect: rect(0, 0.5, 0.5, 0.5), widget: 'stream_list', config: { feed: streamFeed.id, title_path: 'msg' } },
        { rect: rect(0.5, 0.5, 0.5, 0.5), widget: 'table', config: { feed: streamFeed.id, columns: [{ header: 'N', path: 'n' }] } },
      ],
    } })
    expect(res.statusCode).toBe(200)
  })

  /**
   * `chime_activity` (stream-activity contract) is stream_list/table's opt-in for the `activity` sound event — the
   * exact sibling of alert_feed's `sound_info`: device-read (Android's `Chime.kt`), hand-built in
   * the admin, no renderer ever consumes it. This pins that the schema takes it on both widgets
   * that declare it and that a save round-trips it unchanged, the same way every other accepted
   * key already does (see 'accepts a full data-widget grid...' above).
   */
  it('accepts chime_activity on stream_list and table cells, round-tripped', async () => {
    const res = await post({ name: 'chiming board', orientation: 'landscape', grid: {
      cells: [
        { rect: rect(0, 0, 0.5, 1), widget: 'stream_list', config: { feed: streamFeed.id, chime_activity: true } },
        { rect: rect(0.5, 0, 0.5, 1), widget: 'table', config: { feed: streamFeed.id, columns: [{ header: 'N', path: 'n' }], chime_activity: true } },
      ],
    } })
    expect(res.statusCode).toBe(200)
    const cells = res.json().grid.cells as { widget: string; config: Record<string, unknown> }[]
    expect(cells.find((c) => c.widget === 'stream_list')!.config.chime_activity).toBe(true)
    expect(cells.find((c) => c.widget === 'table')!.config.chime_activity).toBe(true)
  })

  it('rejects a binding to a nonexistent feed', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'value_tile', config: { feed: 'feed_nope', path: 'x' } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown feed "feed_nope"')
  })

  it('rejects stream_list on a value feed', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'stream_list', config: { feed: valueFeed.id } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('stream_list needs a stream feed')
  })

  it('rejects table on a value feed without path', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'table', config: { feed: valueFeed.id, columns: [{ header: 'N', path: 'n' }] } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('table on a value feed needs a path to an array')
  })

  it('accepts table on a value feed WITH path', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'table', config: { feed: valueFeed.id, path: 'items', columns: [{ header: 'N', path: 'n' }] } }],
    } })
    expect(res.statusCode).toBe(200)
  })

  /**
   * Three keys are optional because the renderer supplies defaults. A hand-authored cell that
   * omits one therefore avoids a 400 for a value it was going to get anyway —
   * which matters now that `docs/architecture/screens.md` invites cells to be written by hand.
   *
   * Both halves are asserted together on purpose: the save is what regressed, and the renderer
   * fallback is what makes dropping the requirement safe. Pinning only the 200 would leave "saves,
   * then draws a blank cell" looking like a pass.
   */
  describe('a cell may omit a key the renderer already defaults', () => {
    it('gauge saves with no min or max, and normalizeGauge supplies 0..100', async () => {
      const res = await post({ name: 'bare-gauge', orientation: 'landscape', grid: {
        cells: [{ rect: FULL, widget: 'gauge', config: { feed: valueFeed.id, path: 'mem' } }],
      } })
      expect(res.statusCode).toBe(200)
      expect(res.json().grid.cells[0].config).toEqual({ feed: valueFeed.id, path: 'mem' })
      // 50 sits halfway through the range the renderer falls back to — which is only true of 0..100.
      expect(normalizeGauge({ mem: 50 }, { path: 'mem' }).fraction).toBe(0.5)
      expect(normalizeGauge({ mem: 0 }, { path: 'mem' }).fraction).toBe(0)
      expect(normalizeGauge({ mem: 100 }, { path: 'mem' }).fraction).toBe(1)
    })

    it('chart saves with no style, and chartConfig supplies line', async () => {
      const res = await post({ name: 'bare-chart', orientation: 'landscape', grid: {
        cells: [{ rect: FULL, widget: 'chart', config: {
          series: [{ feed: streamFeed.id, y_path: 'v', icon: 'circle' }],
        } }],
      } })
      expect(res.statusCode).toBe(200)
      expect(res.json().grid.cells[0].config.style).toBeUndefined()
      expect(chartConfig({ series: [{ feed: 'a', y_path: 'v', icon: 'circle' }] }).style).toBe('line')
    })

    it('still refuses a HALF-specified gauge range, checked against the fallback it would render with', async () => {
      const res = await post({ name: 'half-gauge', orientation: 'landscape', grid: {
        cells: [{ rect: FULL, widget: 'gauge', config: { feed: valueFeed.id, path: 'mem', min: 200 } }],
      } })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('gauge min must be < max')
    })

    it('still requires the keys that have no defensible default', async () => {
      const noPath = await post({ name: 'no-path', orientation: 'landscape', grid: {
        cells: [{ rect: FULL, widget: 'gauge', config: { feed: valueFeed.id } }],
      } })
      expect(noPath.statusCode).toBe(400)
      const noSeries = await post({ name: 'no-series', orientation: 'landscape', grid: {
        cells: [{ rect: FULL, widget: 'chart', config: {} }],
      } })
      expect(noSeries.statusCode).toBe(400)
    })
  })

  it('rejects gauge with min >= max', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'gauge', config: { feed: valueFeed.id, path: 'mem', min: 5, max: 5 } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('gauge min must be < max')
  })

  it('rejects any binding to an image feed', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'value_tile', config: { feed: imageFeed.id, path: 'x' } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('image feeds are not bindable')
  })

  it('rejects text_block with both text and feed', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'text_block', config: { text: 'hi', feed: valueFeed.id, path: 'x' } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects text_block with neither', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'text_block', config: {} }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects scale outside 0.5..2', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'value_tile', config: { feed: valueFeed.id, path: 'x', scale: 3 } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a 5th table column', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'table', config: { feed: streamFeed.id, columns: [
        { header: 'a', path: 'a' }, { header: 'b', path: 'b' }, { header: 'c', path: 'c' },
        { header: 'd', path: 'd' }, { header: 'e', path: 'e' },
      ] } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  // ── chart + image (chart behavior) ─────────────────────────────────────────────────────────────
  it('accepts a chart with two series on two distinct stream feeds and distinct icons', async () => {
    const res = await post({ name: 'chart board', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'chart', config: {
        series: [
          { feed: streamFeed.id, y_path: 'cpu', icon: 'circle', label: 'CPU' },
          { feed: streamFeed2.id, y_path: 'ram', icon: 'square', label: 'RAM' },
        ],
        style: 'line', window_s: 300,
      } }],
    } })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a chart series bound to a value feed (chart needs stream feeds)', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'chart', config: {
        series: [{ feed: valueFeed.id, y_path: 'cpu', icon: 'circle' }], style: 'line',
      } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('chart needs stream feeds')
  })

  it('rejects a chart series bound to an unknown feed', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'chart', config: {
        series: [{ feed: 'feed_nope', y_path: 'cpu', icon: 'circle' }], style: 'line',
      } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown feed "feed_nope"')
  })

  it('rejects duplicate icons within one chart', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'chart', config: {
        series: [
          { feed: streamFeed.id, y_path: 'cpu', icon: 'circle' },
          { feed: streamFeed2.id, y_path: 'ram', icon: 'circle' },
        ],
        style: 'line',
      } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('chart series icons must be unique')
  })

  it('rejects a chart with a 5th series (AJV maxItems 4)', async () => {
    const feeds = [streamFeed.id, streamFeed2.id, streamFeed.id, streamFeed2.id, streamFeed.id]
    const icons = ['circle', 'square', 'triangle', 'diamond', 'star']
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'chart', config: {
        series: feeds.map((feed, i) => ({ feed, y_path: 'v', icon: icons[i] })), style: 'line',
      } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a chart with an unknown icon name', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'chart', config: {
        series: [{ feed: streamFeed.id, y_path: 'cpu', icon: 'sparkles' }], style: 'line',
      } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('accepts an image widget on an image feed', async () => {
    const res = await post({ name: 'image board', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'image', config: { feed: imageFeed.id, fit: 'cover' } }],
    } })
    expect(res.statusCode).toBe(200)
  })

  it('rejects an image widget on a value feed (image widget needs an image feed)', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'image', config: { feed: valueFeed.id, fit: 'contain' } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('image widget needs an image feed')
  })

  it('rejects an image widget on a stream feed too', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'image', config: { feed: streamFeed.id, fit: 'contain' } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('image widget needs an image feed')
  })

  it('rejects an image widget on an unknown feed', async () => {
    const res = await post({ name: 'x', orientation: 'landscape', grid: {
      cells: [{ rect: FULL, widget: 'image', config: { feed: 'feed_nope', fit: 'contain' } }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown feed "feed_nope"')
  })

  // ── rect geometry (layout model) ─────────────────────────────────────────────────────────
  const clockCell = (r: ReturnType<typeof rect>) => ({ rect: r, widget: 'clock', config: {} })

  it('accepts two cards that touch exactly at an edge', async () => {
    const res = await post({
      name: 'touching', orientation: 'portrait',
      grid: { cells: [clockCell(rect(0, 0, 0.5, 1)), clockCell(rect(0.5, 0, 0.5, 1))] },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects overlapping cards and names both', async () => {
    const res = await post({
      name: 'overlap', orientation: 'portrait',
      grid: { cells: [clockCell(rect(0, 0, 0.5, 1)), clockCell(rect(0.499, 0, 0.5, 1))] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('cards 1 and 2 overlap')
  })

  it('rejects a rect that is not quantized to 0.001', async () => {
    const res = await post({
      name: 'unquantized', orientation: 'portrait', grid: { cells: [clockCell(rect(0.3333, 0, 0.5, 1))] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('multiple of 0.001')
  })

  it('rejects a card extending past the right edge', async () => {
    const res = await post({
      name: 'past', orientation: 'portrait', grid: { cells: [clockCell(rect(0.6, 0, 0.5, 1))] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('card 1 extends past the right edge')
  })

  it('rejects a card below the minimum size', async () => {
    const res = await post({
      name: 'tiny', orientation: 'portrait', grid: { cells: [clockCell(rect(0, 0, RECT_MIN - 0.01, 1))] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a board with gaps', async () => {
    const res = await post({
      name: 'gappy', orientation: 'portrait',
      grid: { cells: [clockCell(rect(0, 0, 1, 0.17)), clockCell(rect(0, 0.5, 0.5, 0.25))] },
    })
    expect(res.statusCode).toBe(200)
  })

  // ── design (screen editor behavior) ────────────────────────────────────────────────────────────────────
  it('accepts a design on a clock cell', async () => {
    const res = await post({ name: 'themed', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: { design: 'segment' } }],
    } })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a design that is not a string', async () => {
    // Fastify's AJV runs with coerceTypes: 'array' (the @fastify/ajv-compiler default), which
    // coerces scalars like a number or boolean into a string ({design: 7} -> {design: "7"}, which
    // then satisfies minLength/maxLength and would wrongly 200). An object is never coerced to a
    // string under any AJV coercion mode, so it is the genuine probe for "design must be a string".
    const res = await post({ name: 'bad', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: { design: {} } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty-string design (minLength 1) — this is what makes deleting the key, not sending "", mandatory for the admin picker', async () => {
    const res = await post({ name: 'bad-empty', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: { design: '' } }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a design on a non-clock widget too, so no migration is needed later', async () => {
    const res = await post({ name: 'gauge', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'gauge', config: { feed: valueFeed.id, path: 'a', min: 0, max: 1, design: 'smooth' } }],
    } })
    expect(res.statusCode).toBe(200)
  })

  it('accepts a design on both text_block variants (literal text and feed+path)', async () => {
    const literal = await post({ name: 'text-literal', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'text_block', config: { text: 'hi', design: 'x' } }],
    } })
    expect(literal.statusCode).toBe(200)

    const bound = await post({ name: 'text-bound', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'text_block', config: { feed: valueFeed.id, path: 'a', design: 'x' } }],
    } })
    expect(bound.statusCode).toBe(200)
  })

  it('accepts a design on the image widget too, even though it has no scale', async () => {
    const res = await post({ name: 'image-designed', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'image', config: { feed: imageFeed.id, design: 'x' } }],
    } })
    expect(res.statusCode).toBe(200)
  })

  // ── theme assignment ───────────────────────────────────────────────────────────────────────────
  it('accepts theme_id on a screen', async () => {
    const res = await post({ name: 'themed screen', orientation: 'portrait', theme_id: 'thm_cypherpunk', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: {} }],
    } })
    expect(res.statusCode).toBe(200)
    expect(res.json().theme_id).toBe('thm_cypherpunk')
  })

  it('accepts null theme_id, meaning the built-in default', async () => {
    const res = await post({ name: 'default themed screen', orientation: 'portrait', theme_id: null, grid: {
      cells: [{ rect: FULL, widget: 'clock', config: {} }],
    } })
    expect(res.statusCode).toBe(200)
    expect(res.json().theme_id).toBeNull()
  })

  it('rejects a non-string theme_id', async () => {
    // Fastify's AJV runs with coerceTypes: 'array', which silently coerces a number like 7 into
    // "7" and would wrongly 200 — see the design-field reject test above for the same trap. An
    // object is never coerced to a string under any AJV coercion mode, so it is the genuine probe.
    const res = await post({ name: 'bad theme', orientation: 'portrait', theme_id: {}, grid: {
      cells: [{ rect: FULL, widget: 'clock', config: {} }],
    } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown theme_id with a readable error, not the FK constraint mislabeled as "name already exists"', async () => {
    // theme_id carries a live FK to themes(id), and better-sqlite3's FK
    // violation code is SQLITE_CONSTRAINT_FOREIGNKEY — which also startsWith('SQLITE_CONSTRAINT'),
    // the same prefix the UNIQUE-name-violation catch below checks. Without an explicit existence
    // check (mirroring feedCheck's "unknown feed" pattern), a typo'd theme_id would 400 with the
    // wrong, misleading message instead of a clear one.
    const res = await post({ name: 'x', orientation: 'portrait', theme_id: 'thm_nope', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: {} }],
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown theme "thm_nope"')
  })

  it('rejects an unknown theme_id on PATCH too', async () => {
    const row = (await post({ name: 'y', orientation: 'portrait', grid: {
      cells: [{ rect: FULL, widget: 'clock', config: {} }],
    } })).json()
    const res = await app.inject({
      method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
      payload: { theme_id: 'thm_nope' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown theme "thm_nope"')
  })

  /**
   * `screen_theme_assigned` was emitted from exactly ONE place —
   * deleteTheme's cascade, always with `theme_id: null` — so the event named for assignment
   * recorded only un-assignments, and "when did this screen get the cypherpunk theme, and who did
   * it" was unanswerable from the audit log. `screen_updated` records only that `theme_id` was
   * among the changed fields, never WHICH theme.
   */
  describe('screen_theme_assigned covers the assign path too (edge case)', () => {
    const assignments = () =>
      (db.prepare("SELECT details FROM audit_log WHERE event = 'screen_theme_assigned' ORDER BY id").all() as { details: string }[])
        .map((r) => JSON.parse(r.details))

    it('audits an assignment made at create time', async () => {
      const row = (await post({ name: 'themed-at-create', orientation: 'portrait', theme_id: 'thm_cypherpunk', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      expect(assignments()).toEqual([
        { screen_id: row.id, theme_id: 'thm_cypherpunk', reason: 'screen_created' },
      ])
    })

    it('records WHICH theme on assign, and null on unassign, via PATCH', async () => {
      const row = (await post({ name: 'themed-later', orientation: 'portrait', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      const patch = (payload: object) =>
        app.inject({ method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie }, payload })

      await patch({ theme_id: 'thm_cypherpunk' })
      await patch({ theme_id: null })
      expect(assignments()).toEqual([
        { screen_id: row.id, theme_id: 'thm_cypherpunk', reason: 'screen_edited' },
        { screen_id: row.id, theme_id: null, reason: 'screen_edited' },
      ])
    })

    it('does not log a non-change: a themeless create, or a PATCH re-sending the same theme', async () => {
      const row = (await post({ name: 'plain', orientation: 'portrait', theme_id: 'thm_cypherpunk', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { theme_id: 'thm_cypherpunk', name: 'plain2' },
      })
      // Only the create's own assignment — the no-op PATCH added nothing.
      expect(assignments()).toHaveLength(1)
    })
  })

  /**
   * screen state (alert-sound contract): a screen carries its own sparse event->family override map, layered over its
   * theme's suggestion by `resolveSounds` (hub/src/sounds.ts) at render time — none of that
   * resolution happens here, this is just the CRUD surface. Unlike a theme's sounds (tab state,
   * which stores a loose, pattern-checked string for forward-compat with a family a future client
   * ships), a SCREEN override is what a device actually plays, so PATCH validates it against
   * `getSoundManifest().families` right now and 400s on anything the running hub cannot resolve.
   */
  describe('sounds (alert-sound contract)', () => {
    it('accepts a sparse sounds override on create and returns the parsed map', async () => {
      const res = await post({
        name: 'sound screen', orientation: 'portrait', sounds: { critical: 'bells' },
        grid: { cells: [{ rect: FULL, widget: 'clock', config: {} }] },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().sounds).toEqual({ critical: 'bells' })
    })

    it('creates a screen with sounds omitted (defaults to {})', async () => {
      const res = await post({ name: 'plain sound screen', orientation: 'portrait', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })
      expect(res.statusCode).toBe(200)
      expect(res.json().sounds).toEqual({})
    })

    it('PATCH stores a sparse sounds override and {} clears it', async () => {
      const row = (await post({ name: 'y2', orientation: 'portrait', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()

      const r1 = await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { sounds: { critical: 'bells' } },
      })
      expect(r1.statusCode).toBe(204)
      const listed1 = (await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })).json() as any[]
      expect(listed1.find((s) => s.id === row.id).sounds).toEqual({ critical: 'bells' })

      const r2 = await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { sounds: {} },
      })
      expect(r2.statusCode).toBe(204)
      const listed2 = (await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })).json() as any[]
      expect(listed2.find((s) => s.id === row.id).sounds).toEqual({})
    })

    it('PATCH rejects an unknown family', async () => {
      const row = (await post({ name: 'y3', orientation: 'portrait', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      const res = await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { sounds: { critical: 'nope' } },
      })
      expect(res.statusCode).toBe(400)
    })

    it('rejects a sounds key that is not an event', async () => {
      const row = (await post({ name: 'y4', orientation: 'portrait', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      const res = await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { sounds: { bogus: 'bells' } },
      })
      expect(res.statusCode).toBe(400)
    })

    it('rejects a non-string sounds value and an out-of-pattern family name', async () => {
      const row = (await post({ name: 'y5', orientation: 'portrait', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      expect((await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { sounds: { critical: {} } },
      })).statusCode).toBe(400)
      expect((await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${row.id}`, headers: { cookie },
        payload: { sounds: { critical: 'Not Valid!' } },
      })).statusCode).toBe(400)
    })

    it('a sounds-only PATCH still pushes STATE to assigned devices and audits screen_updated', async () => {
      const screen = (await post({ name: 'sound push', orientation: 'landscape', grid: {
        cells: [{ rect: FULL, widget: 'clock', config: {} }],
      } })).json()
      const now = Date.now()
      const { code } = createPairingCode(db, 'SoundDevice', now)
      const { device } = redeemPairingCode(db, code, now)!
      assignScreen(db, device.id, screen.id)

      const pushSpy = vi.spyOn(app.statePusher, 'push')
      const res = await app.inject({
        method: 'PATCH', url: `/admin/api/screens/${screen.id}`, headers: { cookie },
        payload: { sounds: { critical: 'bells' } },
      })
      expect(res.statusCode).toBe(204)
      expect(pushSpy).toHaveBeenCalledWith(device.id)

      const events = (db.prepare("SELECT details FROM audit_log WHERE event = 'screen_updated' ORDER BY id DESC LIMIT 1").all() as { details: string }[])
        .map((r) => JSON.parse(r.details))
      expect(events[0]).toEqual({ screen_id: screen.id, fields: ['sounds'] })
    })
  })

  // layout-core.test.ts has no live Fastify server / route helper, so this agreement test lives
  // here to exercise the admin predicates through a real route round-trip. It covers BOTH halves of the
  // admin.ts duplication: overlapCheck against rectsOverlap, AND rectCheck against rectValid
  // (RECT_MIN imported, never hardcoded, so admin.ts's own RECT_MIN drifting from layout-core.mjs's
  // fails this test instead of silently passing — e.g. raising one to 0.08 while leaving the other
  // at 0.05 would previously go undetected).
  it('admin.ts rect predicates agree with the layout-core twins', async () => {
    // admin.ts cannot import layout-core.mjs (no build step); this pins the duplicate.
    const overlapCases = [
      { a: rect(0, 0, 0.5, 1), b: rect(0.5, 0, 0.5, 1), overlap: false },
      { a: rect(0, 0, 0.5, 1), b: rect(0.499, 0, 0.5, 1), overlap: true },
      { a: rect(0, 0, 1, 0.5), b: rect(0, 0.5, 1, 0.5), overlap: false },
    ]
    for (const [i, c] of overlapCases.entries()) {
      expect(rectsOverlap(c.a, c.b)).toBe(c.overlap)
      // and the same cases must round-trip through the live admin route
      const res = await post({
        name: `agree-overlap-${i}`, orientation: 'portrait',
        grid: { cells: [{ rect: c.a, widget: 'clock', config: {} }, { rect: c.b, widget: 'clock', config: {} }] },
      })
      expect(res.statusCode).toBe(c.overlap ? 400 : 200)
      // A 400 for an unrelated reason would satisfy the statusCode check alone; naming the
      // overlap in the message is what actually pins this case to overlapCheck.
      if (c.overlap) expect(res.json().error).toMatch(/overlap/)
    }

    const validCases = [
      { r: rect(0, 0, RECT_MIN, 1), valid: true },
      { r: rect(0, 0, RECT_MIN - 0.001, 1), valid: false },  // below the shared minimum
      { r: rect(0.3333, 0, 0.5, 1), valid: false },          // not quantized to 0.001
      { r: rect(0.6, 0, 0.5, 1), valid: false },             // x + w > 1
    ]
    for (const [i, c] of validCases.entries()) {
      expect(rectValid(c.r)).toBe(c.valid)
      const res = await post({
        name: `agree-valid-${i}`, orientation: 'portrait',
        grid: { cells: [{ rect: c.r, widget: 'clock', config: {} }] },
      })
      expect(res.statusCode).toBe(c.valid ? 200 : 400)
    }
  })

  /**
   * A LIVE feed whose data does not carry what the cell needs WARNS, it never blocks.
   *
   * Nothing has ever been declared for these widgets, so every board built before this contract
   * existed was built without one. Hard-rejecting would turn "your gauge is bound to a hostname"
   * — which renders an em-dash and has always been allowed — into a screen the operator can no
   * longer save at all, including to fix it. The warning is advisory precisely because the
   * evidence is inferred after the fact rather than promised in the moment, which is the line
   * between this and a pending binding.
   */
  describe('warns when a bound feed does not carry what the cell needs', () => {
    const gauge = (feed: string, path: string) => ({
      name: `gauge ${path} ${feed}`, orientation: 'landscape' as const,
      grid: { cells: [{ rect: FULL, widget: 'gauge', config: { feed, path, min: 0, max: 100 } }] },
    })

    it('saves a mismatched binding anyway, and names the cell and the path', async () => {
      pushValue(db, valueFeed.id, { host: 'web-01', cpu: { percent: 91 } }, 'test', Date.now())

      const res = await post(gauge(valueFeed.id, 'host'))

      expect(res.statusCode).toBe(200)
      expect(res.json().warnings).toEqual([
        expect.stringContaining('card 1'),
      ])
      expect(res.json().warnings[0]).toContain('host')
    })

    it('says nothing when the feed does carry it', async () => {
      pushValue(db, valueFeed.id, { host: 'web-01', cpu: { percent: 91 } }, 'test', Date.now())

      const res = await post(gauge(valueFeed.id, 'cpu.percent'))

      expect(res.statusCode).toBe(200)
      expect(res.json().warnings).toEqual([])
    })

    it('says nothing about a feed that has never been pushed — inconclusive is not incompatible', () => {
      // The whole reason `compatibleGeneric` treats an empty capability list as ok. A feed created
      // in the editor before its sender is wired up must not warn on every save until it is.
      return post(gauge(valueFeed.id, 'anything')).then((res) => {
        expect(res.statusCode).toBe(200)
        expect(res.json().warnings).toEqual([])
      })
    })

    it('infers a stream feed from its rows, so a stream-bound cell is checked too', async () => {
      pushStreamRow(db, streamFeed.id, { title: 'Deploy', latency_ms: 42 }, 'test', Date.now())

      const bad = await post({
        name: 'stream bad', orientation: 'landscape',
        grid: { cells: [{ rect: FULL, widget: 'chart', config: {
          series: [{ feed: streamFeed.id, y_path: 'title', icon: 'circle' }],
        } }] },
      })
      expect(bad.statusCode).toBe(200)
      expect(bad.json().warnings[0]).toContain('title')

      const good = await post({
        name: 'stream good', orientation: 'landscape',
        grid: { cells: [{ rect: FULL, widget: 'chart', config: {
          series: [{ feed: streamFeed.id, y_path: 'latency_ms', icon: 'circle' }],
        } }] },
      })
      expect(good.statusCode).toBe(200)
      expect(good.json().warnings).toEqual([])
    })

    /**
     * The mode-conditioned needs, reaching the live path. A stream-bound table has no array at
     * `config.path` and its columns resolve per row; warning about `data.array@…` here would fire
     * on every stream-bound table in existence.
     */
    const streamTable = (name: string, columns: Array<{ header: string; path: string }>) => post({
      name, orientation: 'landscape',
      grid: { cells: [{ rect: FULL, widget: 'table', config: {
        // `path` is set on purpose even though a stream-bound table ignores it. If the live check
        // ever stopped conditioning on the feed's mode, the value-feed need would demand
        // `data.array@leftover` of this stream and warn — so its presence is what makes this test
        // able to tell the two apart at all.
        feed: streamFeed.id, path: 'leftover', columns,
      } }] },
    })

    it('does not warn about a stream-bound table having no array at config.path', async () => {
      pushStreamRow(db, streamFeed.id, { title: 'Deploy', who: 'ana' }, 'test', Date.now())

      const res = await streamTable('stream table', [
        { header: 'What', path: 'title' }, { header: 'Who', path: 'who' },
      ])
      expect(res.statusCode).toBe(200)
      expect(res.json().warnings).toEqual([])
    })

    it('does check a stream-bound table\'s columns, against a row', async () => {
      pushStreamRow(db, streamFeed.id, { title: 'Deploy', who: 'ana' }, 'test', Date.now())

      const res = await streamTable('stream table bad', [
        { header: 'What', path: 'title' }, { header: 'When', path: 'absent' },
      ])
      expect(res.statusCode).toBe(200)
      expect(res.json().warnings[0]).toContain('absent')
    })

    it('still saves an existing board with several mismatches, warning once per cell', async () => {
      pushValue(db, valueFeed.id, { host: 'web-01' }, 'test', Date.now())
      pushStreamRow(db, streamFeed.id, { title: 'Deploy' }, 'test', Date.now())

      const res = await post({
        name: 'legacy board', orientation: 'landscape',
        grid: { cells: [
          { rect: rect(0, 0, 0.5, 1), widget: 'gauge', config: { feed: valueFeed.id, path: 'host', min: 0, max: 100 } },
          { rect: rect(0.5, 0, 0.5, 1), widget: 'chart', config: {
            series: [{ feed: streamFeed.id, y_path: 'title', icon: 'circle' }],
          } },
        ] },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().warnings).toHaveLength(2)
      expect(res.json().warnings[0]).toContain('card 1')
      expect(res.json().warnings[1]).toContain('card 2')
    })
  })
})
