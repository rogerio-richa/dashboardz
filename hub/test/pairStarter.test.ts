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
  it('creates a full-bleed clock screen named after the device, assigned as the first tab', async () => {
    const res = await pair('bedside')
    expect(res.statusCode).toBe(200)
    const deviceId = res.json().device_id as string

    const screens = (await get('/admin/api/screens')).json() as Array<{ id: string; name: string; grid: { cells: unknown[] } }>
    expect(screens).toHaveLength(1)
    expect(screens[0].name).toBe('bedside')
    expect(screens[0].grid.cells).toEqual([
      { widget: 'clock', config: {}, rect: { x: 0, y: 0, w: 1, h: 1 } },
    ])

    const tabs = app.db.prepare('SELECT screen_id, position FROM device_screens WHERE device_id = ?')
      .all(deviceId) as Array<{ screen_id: string; position: number }>
    expect(tabs).toEqual([{ screen_id: screens[0].id, position: 0 }])
  })

  it('the seeded grid is valid under the live cell schema, so the operator can edit and re-save it', async () => {
    await pair('kitchen')
    const [screen] = (await get('/admin/api/screens')).json() as Array<{ grid: object }>
    const validate = new Ajv().compile(gridSchema)
    expect(validate(screen.grid), JSON.stringify(validate.errors)).toBe(true)
  })

  it('a rejected code seeds nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pair', payload: { code: 'ZZZZZZ' } })
    expect(res.statusCode).toBe(400)
    expect((await get('/admin/api/screens')).json()).toEqual([])
  })
})
