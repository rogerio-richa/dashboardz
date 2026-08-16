import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createAgentToken } from '../src/db/agents.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { getTheme } from '../src/db/themes.js'

const EXAMPLE = fileURLToPath(new URL('../../examples/theme-packs/vintage/', import.meta.url))
/** The vintage example as the admin uploads it: pack.json plus every design's source. */
function examplePack(over: (m: any) => void = () => {}) {
  const manifest = JSON.parse(readFileSync(join(EXAMPLE, 'pack.json'), 'utf8'))
  over(manifest)
  const designs: { path: string; source: string }[] = []
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : designs.push({ path: relative(EXAMPLE, p).split(sep).join('/'), source: readFileSync(p, 'utf8') }) } }
  walk(join(EXAMPLE, 'designs'))
  return { manifest, designs }
}

describe('theme pack install API', () => {
  let app: FastifyInstance, db: DB, cookie: string, dataDir: string
  let tmpBase: string
  const created: string[] = []
  const boot = async (extra: Record<string, unknown> = {}, keepDataDir = false) => {
    // Inside the project: vitest only imports modules under its root, and the hub imports pack designs.
    if (!keepDataDir) { dataDir = mkdtempSync(join(fileURLToPath(new URL('../node_modules/', import.meta.url)), '.tmp-packsapi-')); created.push(dataDir) }
    tmpBase = join(dataDir, 'tmp-base')
    mkdirSync(tmpBase, { recursive: true })
    process.env.PACKS_TMP_DIR = tmpBase
    db = openDb(':memory:')
    app = await buildServer({ config: { port: 0, dataDir, adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, ...extra } as any, db })
    cookie = (await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })).headers['set-cookie'] as string
  }
  beforeEach(async () => { await boot() })
  afterEach(async () => {
    await app.close()
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.PACKS_TMP_DIR
  })
  const install = (body: object, headers: Record<string, string> = { cookie }) => app.inject({ method: 'POST', url: '/admin/api/packs', headers, payload: body })

  it('installs the example: files, theme, index and a no-store module', async () => {
    const res = await install(examplePack())
    expect(res.statusCode, res.body).toBe(200)
    expect(existsSync(join(dataDir, 'packs', 'vintage', 'designs', 'gauge', 'vintage-dial.mjs'))).toBe(true)
    const theme = getTheme(db, res.json().theme_id)!
    expect(JSON.parse(theme.board).bg).toBe('#f4ecd8')
    const index = (await app.inject({ method: 'GET', url: '/packs/index.json' })).json()
    expect(index).toEqual([{ id: 'vintage', version: '1.0.0', designs: [{ widget: 'gauge', id: 'vintage-dial', url: '/packs/vintage/designs/gauge/vintage-dial.mjs?v=1' }] }])
    const mod = await app.inject({ method: 'GET', url: '/packs/vintage/designs/gauge/vintage-dial.mjs?v=1' })
    expect(mod.statusCode).toBe(200)
    expect(mod.headers['content-type']).toMatch(/javascript/)
    expect(mod.headers['cache-control']).toBe('no-store')
  })

  it('an update bumps the version in the URL and replaces the pack theme settings', async () => {
    const first = (await install(examplePack())).json()
    const second = await install(examplePack((m) => { m.version = '1.0.1'; m.theme.backdrop = 'flat' }))
    expect(second.statusCode).toBe(200)
    expect(second.json().theme_id).toBe(first.theme_id)
    expect(getTheme(db, first.theme_id)!.backdrop).toBe('flat')
    const index = (await app.inject({ method: 'GET', url: '/packs/index.json' })).json()
    expect(index[0].designs[0].url).toMatch(/\?v=2$/)
  })

  it('refuses a pack with checker errors, storing nothing', async () => {
    const res = await install(examplePack((m) => { m.theme.board.ink = m.theme.board.bg }))
    expect(res.statusCode).toBe(400)
    expect(res.json().findings.some((f: any) => f.rule === 'theme.contrast.ink')).toBe(true)
    expect(existsSync(join(dataDir, 'packs', 'vintage'))).toBe(false)
  })

  it('/check reports findings without installing', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/packs/check', headers: { cookie }, payload: examplePack() })
    expect(res.statusCode).toBe(200)
    expect(res.json().findings).toEqual([])
    expect(existsSync(join(dataDir, 'packs', 'vintage'))).toBe(false)
  })

  /** Temporary folders never pile up: checks use the temp folder and clean up, installs leave only the pack. */
  it('leaves no temporary folders behind after checks and installs', async () => {
    await app.inject({ method: 'POST', url: '/admin/api/packs/check', headers: { cookie }, payload: examplePack() })
    await install(examplePack())
    await install(examplePack((m) => { m.version = '1.0.1' }))
    await install(examplePack((m) => { m.theme.board.ink = m.theme.board.bg }))
    expect(readdirSync(join(dataDir, 'packs'))).toEqual(['vintage'])
    expect(readdirSync(tmpBase)).toEqual([])
  })

  it('sweeps temporary folders left by a crash when the hub starts', async () => {
    await install(examplePack())
    for (const d of ['.new-vintage-abc', '.old-vintage-def', '.check-123']) mkdirSync(join(dataDir, 'packs', d, 'designs'), { recursive: true })
    await app.close()
    await boot({}, true)
    expect(readdirSync(join(dataDir, 'packs'))).toEqual(['vintage'])
  })

  it('only the signed-in owner can install; an agent token cannot', async () => {
    const { token } = createAgentToken(db, 'worker')
    expect((await install(examplePack(), { authorization: `Bearer ${token}` })).statusCode).toBe(401)
  })

  it('refuses a second pack reusing an installed design id', async () => {
    await install(examplePack())
    const clash = examplePack((m) => { m.id = 'other'; m.name = 'Other' })
    clash.designs[0].path = 'designs/gauge/vintage-dial.mjs'
    const res = await install(clash)
    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json())).toMatch(/vintage-dial/)
  })

  it('/check already reports a clash with an installed pack', async () => {
    await install(examplePack())
    const clash = examplePack((m) => { m.id = 'other'; m.name = 'Other' })
    const res = await app.inject({ method: 'POST', url: '/admin/api/packs/check', headers: { cookie }, payload: clash })
    expect(res.json().findings.some((f: any) => f.rule === 'pack.design-clash')).toBe(true)
  })

  it('serves nothing outside an installed pack', async () => {
    await install(examplePack())
    for (const url of ['/packs/..%2F..%2Fhub.db', '/packs/vintage/designs/gauge/..%2F..%2Fpack.json', '/packs/vintage/designs/gauge/nope.mjs', '/packs/vintage/pack.json']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404)
    }
  })

  it('remove deletes the files and the record, keeps the theme, and reloads online devices', async () => {
    const { theme_id } = (await install(examplePack())).json()
    const device = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device
    vi.spyOn(app.registry, 'isOnline').mockImplementation((id) => id === device.id)
    const send = vi.spyOn(app.registry, 'send')
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/packs/vintage', headers: { cookie } })
    expect(res.statusCode).toBe(204)
    expect(existsSync(join(dataDir, 'packs', 'vintage'))).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/packs/index.json' })).json()).toEqual([])
    expect(getTheme(db, theme_id)).toBeDefined()
    expect(send).toHaveBeenCalledWith(device.id, { type: 'RELOAD' })
  })

  it('refuses too many designs or a design that is too large', async () => {
    const big = examplePack()
    big.designs[0].source += '\n//' + 'x'.repeat(300 * 1024)
    expect((await install(big)).statusCode).toBe(400)
    const many = examplePack()
    many.designs = Array.from({ length: 65 }, (_, i) => ({ path: `designs/gauge/vintage-d${i}.mjs`, source: 'export default {}' }))
    expect((await install(many)).statusCode).toBe(400)
  })

  it('PACKS_ENABLED=false: routes 404, the index is empty, the admin config says so', async () => {
    await app.close()
    await boot({ packsEnabled: false })
    expect((await install(examplePack())).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/packs/index.json' })).json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/admin/api/config', headers: { cookie } })).json().packs_enabled).toBe(false)
  })
})
