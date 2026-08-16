import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createPairingCode, redeemPairingCode, assignScreen, getDevice } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'
import { buildState } from '../src/ws/stateBuilder.js'
import { getTheme } from '../src/db/themes.js'

// A 1x1 PNG — the smallest valid input sniffImage accepts (same fixture feedImage.test.ts uses).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('theme background', () => {
  let app: FastifyInstance, token: string, cookie: string, dataDir: string

  // App-building mirrors feedsPush.test.ts (mkdtempSync dataDir, openDb(':memory:'), which
  // migrates and seeds thm_default/thm_cypherpunk); the admin session cookie is minted the same
  // way feedsApi.test.ts does — POST /admin/api/login, then reuse the set-cookie header. The
  // device token comes from the same pairing-code redemption themesApi.test.ts uses.
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dbz-themebg-'))
    const config = { port: 0, dataDir, adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null }
    const db = openDb(':memory:')
    app = await buildServer({ config: config as any, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
    const code = createPairingCode(app.db, 'dev', Date.now())
    token = redeemPairingCode(app.db, code.code, Date.now())!.token
  })

  afterEach(async () => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const put = (url: string, payload: Buffer, contentType = 'image/png') =>
    app.inject({ method: 'PUT', url, headers: { cookie, 'content-type': contentType }, payload })
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers })

  it('uploads a PNG, bumping bg_rev and the theme rev', async () => {
    const before = getTheme(app.db, 'thm_cypherpunk')!
    const res = await put('/admin/api/themes/thm_cypherpunk/bg', PNG)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ bg_rev: 1 })

    // bumpBgRev must bump the theme's own rev too, not just bg_rev — the theme document's ETag
    // is `rev`, so a background change devices haven't seen yet must also invalidate that cache.
    const after = getTheme(app.db, 'thm_cypherpunk')!
    expect(after.bg_rev).toBe(1)
    expect(after.bg_kind).toBe('image')
    expect(after.rev).toBe(before.rev + 1)
  })

  it('rejects a non-image', async () => {
    const res = await put('/admin/api/themes/thm_cypherpunk/bg', Buffer.from('not an image'))
    expect(res.statusCode).toBe(400)
  })

  it('rejects anything over MAX_IMAGE_BYTES', async () => {
    const res = await put('/admin/api/themes/thm_cypherpunk/bg', Buffer.alloc(524_289))
    expect(res.statusCode).toBe(413)
  })

  it('401s (unauthorized) an admin-session-less upload', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/admin/api/themes/thm_cypherpunk/bg',
      headers: { 'content-type': 'image/png' }, payload: PNG,
    })
    expect(res.statusCode).toBe(401)
  })

  /**
   * The admin guard is now a PLUGIN-WIDE `addHook` on this file's admin
   * child instance (one shared `requireAdmin`, imported from admin.ts) rather than a per-route
   * `preHandler` on a locally-redeclared copy — so an admin route added inside that scope later is
   * guarded by construction. The scoping is the risky half: the two DEVICE-token routes in this
   * same file sit outside that child and must NOT pick up the hook, or every device on the wall
   * loses its theme.
   */
  it('the admin hook guards the admin route without touching either device route', async () => {
    // Admin-authed: no session cookie -> 401 (guarded by the plugin-wide hook).
    expect((await app.inject({
      method: 'PUT', url: '/admin/api/themes/thm_cypherpunk/bg',
      headers: { 'content-type': 'image/png' }, payload: PNG,
    })).statusCode).toBe(401)

    // Device-authed: a Bearer token and NO admin cookie still works, on both device routes.
    await put('/admin/api/themes/thm_cypherpunk/bg', PNG)
    expect((await get('/api/themes/thm_cypherpunk', { authorization: `Bearer ${token}` })).statusCode).toBe(200)
    expect((await get('/api/themes/thm_cypherpunk/bg', { authorization: `Bearer ${token}` })).statusCode).toBe(200)

    // ...and an admin cookie is NOT an accepted substitute for a device token on those routes.
    expect((await app.inject({ method: 'GET', url: '/api/themes/thm_cypherpunk', headers: { cookie } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/themes/thm_cypherpunk/bg', headers: { cookie } })).statusCode).toBe(401)
  })

  it('404s an upload for an unknown theme id', async () => {
    const res = await put('/admin/api/themes/thm_nope/bg', PNG)
    expect(res.statusCode).toBe(404)
  })

  it('serves the bytes to a device with bg_rev as the ETag', async () => {
    await put('/admin/api/themes/thm_cypherpunk/bg', PNG)
    const res = await get('/api/themes/thm_cypherpunk/bg', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('1') // unquoted, per the image route
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload).toEqual(PNG)
  })

  it('304s when the ETag matches', async () => {
    await put('/admin/api/themes/thm_cypherpunk/bg', PNG)
    const res = await get('/api/themes/thm_cypherpunk/bg', {
      authorization: `Bearer ${token}`, 'if-none-match': '1',
    })
    expect(res.statusCode).toBe(304)
    expect(res.headers.etag).toBe('1')
  })

  it('404s the bg route for a theme that has no image', async () => {
    const res = await get('/api/themes/thm_default/bg', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(404)
  })

  it('404s the bg route for an unknown theme', async () => {
    const res = await get('/api/themes/thm_nope/bg', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(404)
  })

  /**
   * The upload audited, bumped `rev` and returned — but never pushed
   * STATE, so an operator uploading a background saw nothing happen on the wall until a reconnect
   * or an unrelated screen edit. Exactly the shape of the colorset-PATCH bug already fixed on this
   * branch, and a contradiction of admin.ts's own "a theme/colorset write must reach devices
   * already rendering it" comment block.
   *
   * `push` being called proves nothing on its own (the colorset bug called it too) — what matters
   * is that the `{id, rev}` on the device's NEXT STATE differs from what it had cached, since
   * that compound key is the sole gate on theme.mjs's refetch. Both are asserted, same as
   * themesAdminApi.test.ts's push-path tests.
   */
  describe('STATE push on background upload', () => {
    /** Wires a device to a screen assigned to `themeId`, returning the device id. */
    const deviceOnThemedScreen = (themeId: string | null): string => {
      const screen = createScreen(app.db, { name: `S-${Math.random()}`, orientation: 'landscape', grid: { cells: [] }, theme_id: themeId }, Date.now())
      const now = Date.now()
      const { code } = createPairingCode(app.db, 'Dev', now)
      const { device } = redeemPairingCode(app.db, code, now)!
      assignScreen(app.db, device.id, screen.id)
      return device.id
    }
    const themeRefFor = (deviceId: string) =>
      buildState(app.db, getDevice(app.db, deviceId)!, Date.now(), 1).screen?.theme

    it('pushes to devices whose screen references the theme, carrying a new rev', async () => {
      const deviceId = deviceOnThemedScreen('thm_cypherpunk')
      const before = themeRefFor(deviceId)

      const pushSpy = vi.spyOn(app.statePusher, 'push')
      expect((await put('/admin/api/themes/thm_cypherpunk/bg', PNG)).statusCode).toBe(200)

      expect(pushSpy).toHaveBeenCalledWith(deviceId)
      const after = themeRefFor(deviceId)
      expect(after).not.toEqual(before)
      expect(after!.rev).toBeGreaterThan(before!.rev)
    })

    it('does not push to a device on an unrelated theme', async () => {
      const other = deviceOnThemedScreen('thm_default')
      const pushSpy = vi.spyOn(app.statePusher, 'push')
      await put('/admin/api/themes/thm_cypherpunk/bg', PNG)
      expect(pushSpy).not.toHaveBeenCalledWith(other)
    })

    it('does not push when the upload is rejected', async () => {
      const deviceId = deviceOnThemedScreen('thm_cypherpunk')
      const pushSpy = vi.spyOn(app.statePusher, 'push')
      expect((await put('/admin/api/themes/thm_cypherpunk/bg', Buffer.from('not an image'))).statusCode).toBe(400)
      expect(pushSpy).not.toHaveBeenCalledWith(deviceId)
    })
  })

  it('401s a device-less request for the bytes, and audits the rejection', async () => {
    const res = await get('/api/themes/thm_cypherpunk/bg')
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid token' })
    const row = app.db.prepare(
      "SELECT * FROM audit_log WHERE event = 'auth_rejected' AND details LIKE '%/api/themes/:id/bg%'",
    ).get()
    expect(row).toBeDefined()
  })
})
