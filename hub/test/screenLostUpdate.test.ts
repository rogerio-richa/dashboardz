import { describe, expect, it, beforeEach } from 'vitest'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import type { FastifyInstance } from 'fastify'

/**
 * Lost updates on screen saves.
 *
 * The editor PATCHes the WHOLE grid — it is a read-modify-write over a blob, not a field update —
 * and nothing checked that the row had not moved underneath it. So two editors open the same
 * screen, both save, and the second silently discards everything the first did. The version guard
 * rejects the stale write, so the operator can reload instead of losing the other editor's work.
 *
 * `rev` is the row's version. A grid PATCH must carry the rev it was built from; if the row has
 * moved on, the save is refused rather than applied, and the operator reloads. Refusing is the
 * whole point — the failure mode being fixed is a write that SUCCEEDS and destroys work, so
 * anything short of a rejection just moves the silence somewhere else.
 */
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

// `design: 'ring'`: `style` is retired from the gauge save
// schema — `design` is the current field, the same one every other multi-design widget uses.
const gridWith = (label: string) => ({ cells: [
  { rect: rect(0, 0, 1, 1), widget: 'gauge', config: { feed: 'f', path: 'v', min: 0, max: 100, label, unit: '%', design: 'ring' } },
] })

describe('screen saves are guarded against lost updates', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
    db.prepare("INSERT INTO feeds (id, name, mode, cap, alert_on_stale, image_rev, created_at) VALUES ('f', 'f', 'value', 50, 0, 0, 0)").run()
  })

  const create = async (name: string) =>
    (await app.inject({
      method: 'POST', url: '/admin/api/screens', headers: { cookie },
      payload: { name, orientation: 'landscape', grid: gridWith('original') },
    })).json()

  const patch = (id: string, payload: object) =>
    app.inject({ method: 'PATCH', url: `/admin/api/screens/${id}`, headers: { cookie }, payload })

  const storedLabel = (id: string) =>
    JSON.parse((db.prepare('SELECT grid FROM screens WHERE id = ?').get(id) as { grid: string }).grid)
      .cells[0].config.label

  const revOf = (id: string) =>
    (db.prepare('SELECT rev FROM screens WHERE id = ?').get(id) as { rev: number }).rev

  it('starts a new screen at rev 1', async () => {
    const row = await create('fresh')
    expect(row.rev).toBe(1)
  })

  it('reports rev on the list, so an editor can save what it loaded', async () => {
    const row = await create('listed')
    const listed = (await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })).json()
    expect(listed.find((s: { id: string }) => s.id === row.id).rev).toBe(1)
  })

  it('accepts a grid save carrying the current rev, and bumps it', async () => {
    const row = await create('current')
    const res = await patch(row.id, { grid: gridWith('edited'), rev: row.rev })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: row.id, rev: 2, grid: gridWith('edited') })
    expect(storedLabel(row.id)).toBe('edited')
    expect(revOf(row.id)).toBe(2)
  })

  /**
   * THE BUG, exactly as it happened: two editors load the same screen, the first saves, the second
   * saves what it loaded before that. The second must not win.
   */
  it('refuses a grid save built from a rev that has since moved, and keeps the first write', async () => {
    const row = await create('contested')

    const first = await patch(row.id, { grid: gridWith('first editor'), rev: row.rev })
    expect(first.statusCode).toBe(200)

    const second = await patch(row.id, { grid: gridWith('second editor'), rev: row.rev })
    expect(second.statusCode).toBe(409)
    expect(storedLabel(row.id)).toBe('first editor')
  })

  /** The 409 carries the current rev, so the client can tell how far behind it is without a refetch. */
  it('reports the current rev on a conflict', async () => {
    const row = await create('conflict-body')
    await patch(row.id, { grid: gridWith('a'), rev: row.rev })
    const res = await patch(row.id, { grid: gridWith('b'), rev: row.rev })
    expect(res.json()).toEqual({ error: 'screen changed elsewhere', rev: 2 })
  })

  /**
   * A grid PATCH with no rev at all is the pre-fix client, and it is exactly the write that
   * destroyed work. Accepting it "for compatibility" would leave the bug reachable from any caller
   * that simply omits the field — which is what every caller did until now.
   */
  it('refuses a grid save that carries no rev', async () => {
    const row = await create('revless')
    const res = await patch(row.id, { grid: gridWith('sneaky') })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/rev/)
    expect(storedLabel(row.id)).toBe('original')
  })

  /**
   * Assigning a theme is a single-field write from a different control, not a read-modify-write of
   * a blob, so it needs no rev — requiring one there would be friction with no lost update to
   * prevent. It still bumps the row's version, because the row did change.
   */
  it('lets a field-level PATCH through without a rev, and still bumps it', async () => {
    const row = await create('field-level')
    const res = await patch(row.id, { name: 'renamed' })
    expect(res.statusCode).toBe(204)
    expect(revOf(row.id)).toBe(2)
  })

  /** A stale editor must not be told "conflict" about a screen that no longer exists. */
  it('404s an unknown screen rather than 409ing it', async () => {
    const res = await patch('lay_gone', { grid: gridWith('x'), rev: 1 })
    expect(res.statusCode).toBe(404)
  })

  /** A rev from the future is as wrong as one from the past — both mean "not what I read". */
  it('refuses a rev that does not match, in either direction', async () => {
    const row = await create('future')
    const res = await patch(row.id, { grid: gridWith('x'), rev: row.rev + 5 })
    expect(res.statusCode).toBe(409)
    expect(storedLabel(row.id)).toBe('original')
  })

  /**
   * A refused save must not have any of the side effects a successful one has — no audit entry, no
   * STATE push to the assigned devices telling them to re-render a layout that did not change.
   */
  it('has no side effects when it refuses', async () => {
    const row = await create('quiet')
    await patch(row.id, { grid: gridWith('a'), rev: row.rev })
    const before = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'screen_updated'").get() as { n: number }).n
    await patch(row.id, { grid: gridWith('b'), rev: row.rev })
    const after = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'screen_updated'").get() as { n: number }).n
    expect(after).toBe(before)
  })
})
