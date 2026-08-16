import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createScreen } from '../src/db/screens.js'
import { pushValue, bumpImageRev } from '../src/db/feeds.js'
import { imagePath } from '../src/feedImage.js'
import type { FastifyInstance } from 'fastify'

describe('/admin/api/feeds', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string
  let dataDir: string

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dbz-feedsapi-'))
    db = openDb(':memory:')
    app = await buildServer({ config: { port: 0, dataDir, adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/admin/api/feeds', headers: { cookie }, payload })

  it('rejects unauthenticated access', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/feeds' })
    expect(res.statusCode).toBe(401)
  })

  it('creates a value feed with defaults and lists it', async () => {
    const created = await post({ name: 'cpu', mode: 'value' })
    expect(created.statusCode).toBe(200)
    const row = created.json()
    expect(row.id).toMatch(/^feed_/)
    expect(row.name).toBe('cpu')
    expect(row.mode).toBe('value')
    expect(row.cap).toBe(50)
    expect(row.stale_after_s).toBeNull()
    expect(row.alert_on_stale).toBe(false)
    expect(row.allowed_senders).toBeNull()
    expect(row.pushed_at).toBeNull()
    expect(row.pushed_by).toBeNull()
    expect(row.image_rev).toBe(0)

    const list = await app.inject({ method: 'GET', url: '/admin/api/feeds', headers: { cookie } })
    expect(list.json()).toEqual([row])
  })

  // Image-feed behavior: the current API blocks mode 'image' at creation (asserted 400 here); image-feed behavior
  // unlocked the server-side image path (sniffing, storage, device endpoint), so creation now
  // succeeds. Image feeds remain unbindable by the current widget set — feedCheck still enforces
  // that separately (see admin.ts).
  it('accepts mode image at creation (image-feed behavior unlocked it)', async () => {
    const res = await post({ name: 'pic', mode: 'image' })
    expect(res.statusCode).toBe(200)
    const row = res.json()
    expect(row.mode).toBe('image')
    expect(row.image_rev).toBe(0)
  })

  it('rejects cap out of bounds', async () => {
    const res = await post({ name: 'x', mode: 'stream', cap: 501 })
    expect(res.statusCode).toBe(400)
  })

  it('rejects duplicate names', async () => {
    await post({ name: 'cpu', mode: 'value' })
    const dup = await post({ name: 'cpu', mode: 'stream' })
    expect(dup.statusCode).toBe(400)
    expect(dup.json().error).toBe('name already exists')
  })

  it('GET one returns payload, rows, references; unknown id is 404', async () => {
    const row = (await post({ name: 'cpu', mode: 'value' })).json()
    pushValue(db, row.id, { load: 1.5 }, 'snd_hub', 2000)
    const screen = createScreen(db, { name: 'board', orientation: 'landscape', grid: {
      cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'value_tile', config: { feed: row.id, path: 'load' } }],
    } }, 1000)

    const get = await app.inject({ method: 'GET', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    expect(get.statusCode).toBe(200)
    const body = get.json()
    expect(body.payload).toEqual({ load: 1.5 })
    expect(body.rows).toEqual([])
    expect(body.references).toEqual([{ id: screen.id, name: 'board' }])

    const missing = await app.inject({ method: 'GET', url: '/admin/api/feeds/feed_nope', headers: { cookie } })
    expect(missing.statusCode).toBe(404)
  })

  it('PATCH updates fields but never mode', async () => {
    const row = (await post({ name: 'cpu', mode: 'value' })).json()
    const patch = await app.inject({
      method: 'PATCH', url: `/admin/api/feeds/${row.id}`, headers: { cookie },
      payload: { name: 'cpu2', stale_after_s: 60, alert_on_stale: true, allowed_senders: ['snd_a'] },
    })
    expect(patch.statusCode).toBe(204)

    const get = await app.inject({ method: 'GET', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    const body = get.json()
    expect(body.name).toBe('cpu2')
    expect(body.stale_after_s).toBe(60)
    expect(body.alert_on_stale).toBe(true)
    expect(body.allowed_senders).toEqual(['snd_a'])

    const badPatch = await app.inject({
      method: 'PATCH', url: `/admin/api/feeds/${row.id}`, headers: { cookie }, payload: { mode: 'stream' },
    })
    expect(badPatch.statusCode).toBe(400)
  })

  it('DELETE removes feed and its rows', async () => {
    const row = (await post({ name: 'log', mode: 'stream' })).json()
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)

    const get = await app.inject({ method: 'GET', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    expect(get.statusCode).toBe(404)

    const missing = await app.inject({ method: 'DELETE', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    expect(missing.statusCode).toBe(404)
  })

  it('DELETE on an image feed unlinks its bytes; a never-pushed image feed deletes cleanly', async () => {
    const row = (await post({ name: 'pic', mode: 'image' })).json()
    const path = imagePath(dataDir, row.id)
    // Stand-in for a real push (the route layer owns the actual atomic write): the invariant a
    // real push guarantees is bytes-on-disk together with image_rev > 0, so reproduce both.
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from([1, 2, 3]))
    bumpImageRev(db, row.id, 'snd_test', 2000)
    expect(existsSync(path)).toBe(true)

    const del = await app.inject({ method: 'DELETE', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    expect(existsSync(path)).toBe(false)

    const neverPushed = (await post({ name: 'pic2', mode: 'image' })).json()
    const del2 = await app.inject({ method: 'DELETE', url: `/admin/api/feeds/${neverPushed.id}`, headers: { cookie } })
    expect(del2.statusCode).toBe(204)
  })

  it('DELETE still succeeds on a non-ENOENT unlink failure, but logs it (stale bytes must not go unnoticed)', async () => {
    const row = (await post({ name: 'pic3', mode: 'image' })).json()
    const path = imagePath(dataDir, row.id)
    // A directory at the image path makes unlinkSync fail with EPERM/EISDIR, not ENOENT — a
    // deterministic stand-in for a real permission/IO failure without needing actual chmod games.
    mkdirSync(path, { recursive: true })
    bumpImageRev(db, row.id, 'snd_test', 2000)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const del = await app.inject({ method: 'DELETE', url: `/admin/api/feeds/${row.id}`, headers: { cookie } })
    expect(del.statusCode).toBe(204)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(row.id)
    warn.mockRestore()
  })

  /**
   * "Which of my feeds actually fit this cell?" answered by the HUB, not by the picker.
   *
   * The admin cannot import `compatibleGeneric`: `hub/tsconfig.json` sets `rootDir: src`, so admin
   * code only ever reaches into `hub/static/**`. The two options were to move the matcher into a
   * pure `.mjs` and let the hub keep an unguardable duplicate of the LOGIC, or to ask the hub. A
   * duplicated data table has a test that can compare both copies; two copies of a function body
   * have nothing of the kind, and this codebase treats a second home for a rule as a defect. So
   * the rule stays in `src/widgets/requirements.ts` and the picker holds none of it.
   *
   * It reports the UNFIT set rather than the fit one so that a caller who cannot reach this
   * endpoint, or does not ask, shows every feed. Failing open is the same instinct as the
   * inconclusive rule: never hide a feed on the strength of a check that did not happen.
   */
  describe('GET /admin/api/feed-fit', () => {
    const fit = (widget: string, config: object) => app.inject({
      method: 'GET', headers: { cookie },
      url: `/admin/api/feed-fit?widget=${widget}&config=${encodeURIComponent(JSON.stringify(config))}`,
    })

    it('names the feeds that cannot satisfy the cell, and why', async () => {
      const numeric = (await post({ name: 'cpu', mode: 'value' })).json()
      const textual = (await post({ name: 'host', mode: 'value' })).json()
      pushValue(db, numeric.id, { cpu: { percent: 91 } }, 'test', Date.now())
      pushValue(db, textual.id, { cpu: { percent: 'hot' } }, 'test', Date.now())

      const res = await fit('gauge', { path: 'cpu.percent' })

      expect(res.statusCode).toBe(200)
      expect(res.json().unfit).toEqual([
        { id: textual.id, why: expect.stringContaining('cpu.percent') },
      ])
    })

    it('does not report a feed that has never been pushed — inconclusive is not incompatible', async () => {
      const empty = (await post({ name: 'later', mode: 'value' })).json()
      const res = await fit('gauge', { path: 'cpu.percent' })
      expect(res.json().unfit.map((u: { id: string }) => u.id)).not.toContain(empty.id)
    })

    it('answers per mode, so a stream-bound table is judged on its columns', async () => {
      const stream = (await post({ name: 'events', mode: 'stream' })).json()
      db.prepare('INSERT INTO feed_rows (feed_id, payload, pushed_at, pushed_by) VALUES (?, ?, ?, ?)')
        .run(stream.id, JSON.stringify({ title: 'Deploy' }), Date.now(), 'test')

      const good = await fit('table', { columns: [{ header: 'What', path: 'title' }] })
      expect(good.json().unfit.map((u: { id: string }) => u.id)).not.toContain(stream.id)

      const bad = await fit('table', { columns: [{ header: 'When', path: 'absent' }] })
      expect(bad.json().unfit.map((u: { id: string }) => u.id)).toContain(stream.id)
    })

    it('refuses a config that is not an object, rather than guessing', async () => {
      const res = await app.inject({
        method: 'GET', headers: { cookie },
        url: '/admin/api/feed-fit?widget=gauge&config=not-json',
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
