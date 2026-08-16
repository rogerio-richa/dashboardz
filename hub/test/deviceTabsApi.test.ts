import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
let app: FastifyInstance, db: any, cookie: string

beforeEach(async () => {
  db = openDb(':memory:')
  app = await buildServer({ config, db })
  const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'sekret' } })
  cookie = login.headers['set-cookie'] as string
})

const mkScreen = async (orientation: 'landscape' | 'portrait') => {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/api/screens',
    headers: { cookie },
    payload: {
      name: `screen-${Math.random()}`,
      orientation,
      grid: { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] },
    },
  })
  return res.json()
}

const mkDevice = async () => {
  const pairingRes = await app.inject({
    method: 'POST',
    url: '/admin/api/devices/pairing-codes',
    headers: { cookie },
    payload: { name: `device-${Math.random()}` },
  })
  const { code } = pairingRes.json()
  const pairRes = await app.inject({ method: 'POST', url: '/api/pair', payload: { code } })
  const { device_id } = pairRes.json()
  return { id: device_id }
}

const patchDevice = async (deviceId: string, patch: object) => {
  return app.inject({
    method: 'PATCH',
    url: `/admin/api/devices/${deviceId}`,
    headers: { cookie },
    payload: patch,
  })
}

describe('PATCH tabs', () => {
  it('assigns an ordered list and lists it back', async () => {
    const d = await mkDevice(); const a = await mkScreen('landscape'); const b = await mkScreen('landscape')
    const res = await patchDevice(d.id, { tabs: [{ screen_id: a.id }, { screen_id: b.id, label: 'io' }] })
    expect(res.statusCode).toBe(204)
    const list = (await app.inject({ method: 'GET', url: '/admin/api/devices', headers: { cookie } })).json()
    const row = list.find((x: any) => x.id === d.id)
    expect(row.tabs.map((t: any) => [t.screen_id, t.label])).toEqual([[a.id, null], [b.id, 'io']])
    expect(row.screen_id).toBe(a.id)  // GET compat: first tab
  })
  it('rejects mixed orientations', async () => {
    const d = await mkDevice(); const a = await mkScreen('landscape'); const b = await mkScreen('portrait')
    const res = await patchDevice(d.id, { tabs: [{ screen_id: a.id }, { screen_id: b.id }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/orientation/)
  })
  it('rejects duplicates, unknown screens, and tabs+screen_id together', async () => {
    const d = await mkDevice(); const a = await mkScreen('landscape')
    expect((await patchDevice(d.id, { tabs: [{ screen_id: a.id }, { screen_id: a.id }] })).statusCode).toBe(400)
    expect((await patchDevice(d.id, { tabs: [{ screen_id: 'lay_nope' }] })).statusCode).toBe(400)
    expect((await patchDevice(d.id, { tabs: [{ screen_id: a.id }], screen_id: a.id })).statusCode).toBe(400)
  })
  it('screen_id sugar still works and shows up as one tab', async () => {
    const d = await mkDevice(); const a = await mkScreen('landscape')
    expect((await patchDevice(d.id, { screen_id: a.id })).statusCode).toBe(204)
    const row = (await app.inject({ method: 'GET', url: '/admin/api/devices', headers: { cookie } })).json()
      .find((x: any) => x.id === d.id)
    expect(row.tabs).toHaveLength(1)
  })
  /**
   * A multi-tab device with tabs [A, B] and PATCH {screen_id: A} must
   * still converge to exactly [A] — the single-tab-sugar invariant is "the result is one tab",
   * not "tab 0 already names this screen". The old change-detection compared only tab 0 and
   * silently no-opped, leaving B in place.
   */
  it('screen_id sugar converges a multi-tab device to one tab, even when tab 0 already matches', async () => {
    const d = await mkDevice(); const a = await mkScreen('landscape'); const b = await mkScreen('landscape')
    await patchDevice(d.id, { tabs: [{ screen_id: a.id }, { screen_id: b.id }] })
    const res = await patchDevice(d.id, { screen_id: a.id })
    expect(res.statusCode).toBe(204)
    const row = (await app.inject({ method: 'GET', url: '/admin/api/devices', headers: { cookie } })).json()
      .find((x: any) => x.id === d.id)
    expect(row.tabs.map((t: any) => t.screen_id)).toEqual([a.id])
  })
  it('does not mutate name/nav_bars if tabs validation fails', async () => {
    const d = await mkDevice(); const a = await mkScreen('landscape')
    // Initial state
    await patchDevice(d.id, { name: 'original-name' })
    // PATCH with valid name but invalid tabs (duplicates) — should be rejected atomically
    const res = await patchDevice(d.id, { name: 'new-name', tabs: [{ screen_id: a.id }, { screen_id: a.id }] })
    expect(res.statusCode).toBe(400)
    // Verify name was NOT changed
    const row = (await app.inject({ method: 'GET', url: '/admin/api/devices', headers: { cookie } })).json()
      .find((x: any) => x.id === d.id)
    expect(row.name).toBe('original-name')
  })
})

describe('tab bar agreement (per-screen declaration)', () => {
  const mkScreenWithBar = async (tabBar?: string) => {
    const res = await app.inject({
      method: 'POST', url: '/admin/api/screens', headers: { cookie },
      payload: {
        name: `screen-${Math.random()}`, orientation: 'landscape',
        grid: {
          cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }],
          ...(tabBar === undefined ? {} : { tab_bar: tabBar }),
        },
      },
    })
    return res.json()
  }

  it('persists tab_bar through save and echoes it in the stored grid', async () => {
    const s = await mkScreenWithBar('top')
    expect(s.grid.tab_bar).toBe('top')
    const listed = (await app.inject({ method: 'GET', url: '/admin/api/screens', headers: { cookie } })).json()
      .find((x: any) => x.id === s.id)
    expect(listed.grid.tab_bar).toBe('top')
  })

  it('rejects a multi-tab list mixing bar positions; undeclared means bottom', async () => {
    const d = await mkDevice()
    const top = await mkScreenWithBar('top'); const legacy = await mkScreenWithBar(undefined)
    const res = await patchDevice(d.id, { tabs: [{ screen_id: top.id }, { screen_id: legacy.id }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/tab bar position/)
    const bottom = await mkScreenWithBar('bottom')
    expect((await patchDevice(d.id, { tabs: [{ screen_id: bottom.id }, { screen_id: legacy.id }] })).statusCode).toBe(204)
  })

  it('rejects a hidden-bar screen in a multi-tab list but allows it alone', async () => {
    const d = await mkDevice()
    const hidden = await mkScreenWithBar('hidden'); const other = await mkScreenWithBar('bottom')
    const res = await patchDevice(d.id, { tabs: [{ screen_id: hidden.id }, { screen_id: other.id }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/hide/)
    expect((await patchDevice(d.id, { tabs: [{ screen_id: hidden.id }] })).statusCode).toBe(204)
  })

  it('rejects editing a tabbed screen to hide or move its bar, allows the agreeing edit', async () => {
    const d = await mkDevice()
    const a = await mkScreenWithBar('bottom'); const b = await mkScreenWithBar('bottom')
    await patchDevice(d.id, { tabs: [{ screen_id: a.id }, { screen_id: b.id }] })
    const edit = async (tabBar: string) => app.inject({
      method: 'PATCH', url: `/admin/api/screens/${a.id}`, headers: { cookie },
      payload: { grid: { ...a.grid, tab_bar: tabBar }, rev: a.rev },
    })
    expect((await edit('hidden')).statusCode).toBe(400)
    expect((await edit('left')).statusCode).toBe(400)
    expect((await edit('bottom')).statusCode).toBe(200)
  })
})
