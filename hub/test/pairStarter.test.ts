import { beforeEach, describe, expect, it } from 'vitest'
import { Ajv } from 'ajv'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { gridSchema } from '../src/screens/cellSchema.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, cookie: string

beforeEach(async () => {
  app = await buildServer({ config, db: openDb(':memory:') })
  const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  cookie = login.headers['set-cookie'] as string
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload })

const pair = async (name: string) => {
  const { code } = (await post('/admin/api/devices/pairing-codes', { name })).json()
  return app.inject({ method: 'POST', url: '/api/pair', payload: { code } })
}

describe('pairing seeds a starter screen', () => {
  it('creates a clock screen with a "where to edit this" line, named after the device, assigned as the first tab', async () => {
    const res = await pair('bedside')
    expect(res.statusCode).toBe(200)
    const deviceId = res.json().device_id as string

    const screens = (await get('/admin/api/screens')).json() as Array<{ id: string; name: string; grid: { cells: unknown[] } }>
    expect(screens).toHaveLength(1)
    expect(screens[0].name).toBe('bedside')
    // A first-time user looking at the panel must learn where screens are edited: a bare
    // clock reads as "this app is a clock" (adoption review B3).
    expect(screens[0].grid.cells).toEqual([
      { widget: 'clock', config: {}, rect: { x: 0, y: 0, w: 1, h: 0.8 } },
      { widget: 'text_block', config: { text: 'Edit this screen at pi:8484/admin, under Screens' }, rect: { x: 0, y: 0.8, w: 1, h: 0.2 } },
    ])

    const tabs = app.db.prepare('SELECT screen_id, position FROM device_screens WHERE device_id = ?')
      .all(deviceId) as Array<{ screen_id: string; position: number }>
    expect(tabs).toEqual([{ screen_id: screens[0].id, position: 0 }])
  })

  it('the seeded grid is valid under the live cell schema, so the operator can edit and re-save it', async () => {
    await pair('kitchen')
    const [screen] = (await get('/admin/api/screens')).json() as Array<{ grid: object }>
    // Same option the hub sets (server.ts): design_options uses a union type list on purpose.
    const validate = new Ajv({ allowUnionTypes: true }).compile(gridSchema)
    expect(validate(screen.grid), JSON.stringify(validate.errors)).toBe(true)
  })

  it('does not print a localhost admin address the panel could never open', async () => {
    const local = await buildServer({ config: { ...config, publicUrl: 'http://localhost:8484' }, db: openDb(':memory:') })
    const login = await local.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
    const c = login.headers['set-cookie'] as string
    const { code } = (await local.inject({ method: 'POST', url: '/admin/api/devices/pairing-codes', headers: { cookie: c }, payload: { name: 'desk' } })).json()
    await local.inject({ method: 'POST', url: '/api/pair', payload: { code } })
    const [screen] = (await local.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie: c } })).json() as Array<{ grid: { cells: Array<{ config: { text?: string } }> } }>
    expect(screen.grid.cells[1].config.text).toBe("Edit this screen on the hub's admin page, under Screens")
  })

  it('pairing again with a name a screen already has still works (re-pairing "kitchen")', async () => {
    // Screen names are unique, and the starter screen is named after the device: before this,
    // the second pair threw a UNIQUE violation and answered HTTP 500 every time.
    expect((await pair('kitchen')).statusCode).toBe(200)
    const again = await pair('kitchen')
    expect(again.statusCode).toBe(200)
    const names = ((await get('/admin/api/screens')).json() as Array<{ name: string }>).map((s) => s.name).sort()
    expect(names).toEqual(['kitchen', 'kitchen 2'])
  })

  it('a rejected code seeds nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pair', payload: { code: 'ZZZZZZ' } })
    expect(res.statusCode).toBe(400)
    expect((await get('/admin/api/screens')).json()).toEqual([])
  })
})
