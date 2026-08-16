import { describe, expect, it, beforeEach, vi } from 'vitest'
import { buildServer } from '../src/server.js'
import { openDb, type DB } from '../src/db/index.js'
import { createPairingCode, redeemPairingCode, assignScreen, getDevice } from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'
import { buildState } from '../src/ws/stateBuilder.js'
import type { FastifyInstance } from 'fastify'
import { BUILTIN_BOARD } from '../src/themeDefaults.js'

/**
 * Admin CRUD for themes (colorsets are no longer stored). Same session-cookie idiom as screensApi.test.ts:
 * log in via POST /admin/api/login and pass `headers: { cookie }` on every subsequent request —
 * there is no `authHeaders` helper in this codebase.
 */
describe('admin theme API', () => {
  let app: FastifyInstance
  let db: DB
  let cookie: string

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any, db })
    const login = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } })
    cookie = login.headers['set-cookie'] as string
  })

  /** Wires a device to a screen assigned to `themeId`, returning the device id. */
  const deviceOnThemedScreen = (themeId: string | null): string => {
    const screen = createScreen(db, { name: `S-${Math.random()}`, orientation: 'landscape', grid: { cells: [] }, theme_id: themeId }, Date.now())
    const now = Date.now()
    const { code } = createPairingCode(db, 'Dev', now)
    const { device } = redeemPairingCode(db, code, now)!
    assignScreen(db, device.id, screen.id)
    return device.id
  }

  /**
   * The exact `{id, rev} | undefined` this device's NEXT STATE message would carry for its
   * screen's theme (buildState, ws/stateBuilder.ts) — precisely the compound key theme.mjs's
   * noteThemeRef gates its `/api/themes/:id` refetch on. `statePusher.push` being CALLED proves
   * nothing on its own: a push whose STATE carries the same `{id, rev}` the device already cached
   * is indistinguishable, from the device's point of view, from no push at all. A theme write
   * was doing exactly this. Every push-path test below reads this
   * before and after the write and asserts it actually changed, not just that `push` was called.
   */
  const themeRefFor = (deviceId: string): { id: string; rev: number } | undefined => {
    const device = getDevice(db, deviceId)!
    return buildState(db, device, Date.now(), 1).screen?.theme
  }

  it('401s without a session cookie (same requireAdmin guard as every other admin route)', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/api/themes' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/admin/api/themes', payload: { name: 'x', board: {} } })).statusCode).toBe(401)
  })

  it('lists the seeded themes', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/themes', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((t: any) => t.id)).toEqual(expect.arrayContaining(['thm_default', 'thm_cypherpunk']))
  })



  it('creates a theme, accepting a chrome map, and returns it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/api/themes', headers: { cookie },
      payload: { name: 'T', board: BUILTIN_BOARD, chrome: { hairline: '#ff0000' }, widgets: {} },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id.startsWith('thm_')).toBe(true)
    expect(body.rev).toBe(1)
    expect(body.chrome).toEqual({ hairline: '#ff0000' })
  })

  it('creates a theme with chrome omitted (defaults to {})', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/api/themes', headers: { cookie },
      payload: { name: 'T', board: BUILTIN_BOARD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().chrome).toEqual({})
  })

  it('rejects a non-object chrome on theme create', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/api/themes', headers: { cookie },
      payload: { name: 'T', board: BUILTIN_BOARD, chrome: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an array chrome on theme update', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie },
      payload: { chrome: ['not', 'an', 'object'] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a chrome update and reflects it in the response', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie },
      payload: { chrome: { muted: '#123456' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().chrome).toEqual({ muted: '#123456' })
  })

  /**
   * Every colour property here was a bare `{ type: 'string' }`, so the
   * shipped API happily stored `ink: "not-a-colour"` — which the device then wrote onto `--text`,
   * where it is invalid at computed-value time and drops the whole property to its initial value.
   * The device degrades per key now regardless (theme.mjs), but a value that can never render
   * should not be storable, and rejecting it at save time beats discovering it on a kiosk
   * three weeks in. Same `#rgb`/`#rrggbb`/`#rrggbbaa` shape both renderer halves validate against.
   */
  describe('colour validation at the door', () => {
    const post = (payload: object) => app.inject({ method: 'POST', url: '/admin/api/themes', headers: { cookie }, payload })
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie }, payload })

    it('rejects a non-colour board value on create and on update', async () => {
      expect((await post({ name: 'T', board: { ...BUILTIN_BOARD, ink: 'not-a-colour' } })).statusCode).toBe(400)
      expect((await patch({ board: { ink: 'rgb(0 0 0' } })).statusCode).toBe(400)
      expect((await patch({ board: { bg: 'rebeccapurple' } })).statusCode).toBe(400)
      expect((await patch({ board: { bg: '#12345' } })).statusCode).toBe(400)
    })

    it('rejects a non-colour inside the series ramp', async () => {
      expect((await patch({ board: { series: ['#ff0000', 'nope'] } })).statusCode).toBe(400)
    })

    it('rejects a non-colour chrome value', async () => {
      expect((await patch({ chrome: { on_critical: 'white' } })).statusCode).toBe(400)
    })

    it('accepts all three colour literal shapes, and the seeded boards still round-trip', async () => {
      expect((await patch({ board: { bg: '#fff', ink: '#010203', dim: '#01020304' } })).statusCode).toBe(200)
      expect((await post({ name: 'Seeded', board: BUILTIN_BOARD })).statusCode).toBe(200)
      // The seeded cypherpunk board+chrome (migrate.ts) must survive its own API round-trip —
      // an 8-digit hairline (#ff2b2b33) included.
      const cypher = (await app.inject({ method: 'GET', url: '/admin/api/themes', headers: { cookie } })).json()
        .find((t: { id: string }) => t.id === 'thm_cypherpunk')
      expect((await post({ name: 'Clone', board: cypher.board, chrome: cypher.chrome })).statusCode).toBe(200)
    })

    it('leaves `scrim` a number, not a colour', async () => {
      expect((await patch({ board: { scrim: 0.75 } })).statusCode).toBe(200)
      expect((await patch({ board: { scrim: '#ffffff' } })).statusCode).toBe(400)
    })
  })

  /**
   * The columns and theme document accept `bg_kind`/`bg_color`, and `themeBody` must include them under
   * `additionalProperties: false` — so a flat-colour background is writable, and an uploaded image
   * can be REMOVED (the
   * only writer of `bg_kind`, the bg upload, only ever moved it to 'image').
   */
  describe('bg_kind / bg_color are writable', () => {
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie }, payload })

    it('sets a flat-colour background', async () => {
      const res = await patch({ bg_kind: 'flat', bg_color: '#102030' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ bg_kind: 'flat', bg_color: '#102030' })
    })

    it('accepts them on create', async () => {
      const res = await app.inject({
        method: 'POST', url: '/admin/api/themes', headers: { cookie },
        payload: { name: 'Flat', board: BUILTIN_BOARD, bg_kind: 'flat', bg_color: '#abcdef' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ bg_kind: 'flat', bg_color: '#abcdef' })
    })

    it('removes a background: an image theme can be set back to none, clearing the colour', async () => {
      await patch({ bg_kind: 'flat', bg_color: '#102030' })
      const res = await patch({ bg_kind: 'none', bg_color: null })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ bg_kind: 'none', bg_color: null })
    })

    it('rejects an unknown bg_kind and a non-colour bg_color', async () => {
      expect((await patch({ bg_kind: 'gradient' })).statusCode).toBe(400)
      expect((await patch({ bg_color: 'blue' })).statusCode).toBe(400)
    })

    it('pushes STATE like any other theme write', async () => {
      const deviceId = deviceOnThemedScreen('thm_cypherpunk')
      const before = themeRefFor(deviceId)
      const pushSpy = vi.spyOn(app.statePusher, 'push')
      expect((await patch({ bg_kind: 'flat', bg_color: '#102030' })).statusCode).toBe(200)
      expect(pushSpy).toHaveBeenCalledWith(deviceId)
      expect(themeRefFor(deviceId)!.rev).toBeGreaterThan(before!.rev)
    })
  })

  it('bumps rev on a theme update', async () => {
    // Relative to whatever the migrations left it on, not a literal — v13 converted this theme to
    // the palette-only model and bumped its rev doing so, and the next migration to touch it will
    // too. What this test is about is the +1, not the starting point.
    const before = (app.db.prepare("SELECT rev FROM themes WHERE id = 'thm_cypherpunk'").get() as { rev: number }).rev
    const res = await app.inject({
      method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie },
      payload: { name: 'Cypherpunk 2' },
    })
    expect(res.json().rev).toBe(before + 1)
  })

  it('404s a patch to an unknown theme', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/admin/api/themes/thm_nope', headers: { cookie },
      payload: { name: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses to delete a builtin theme', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/themes/thm_default', headers: { cookie } })
    expect(res.statusCode).toBe(400)
  })

  it('404s deleting an unknown theme', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/admin/api/themes/thm_nope', headers: { cookie } })
    expect(res.statusCode).toBe(404)
  })

  it('deletes a non-builtin theme, resetting referencing screens to the default', async () => {
    const t = (await app.inject({
      method: 'POST', url: '/admin/api/themes', headers: { cookie },
      payload: { name: 'T', board: BUILTIN_BOARD },
    })).json()
    const screen = createScreen(db, { name: 'S', orientation: 'landscape', grid: { cells: [] }, theme_id: t.id }, Date.now())

    const res = await app.inject({ method: 'DELETE', url: `/admin/api/themes/${t.id}`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().resetScreenIds).toEqual([screen.id])
  })




  it('rejects a non-coercible bad field', async () => {
    // NOT a number: Fastify's AJV runs coerceTypes:'array', so 7 becomes "7" and passes.
    const res = await app.inject({
      method: 'POST', url: '/admin/api/themes', headers: { cookie },
      payload: { name: {}, board: BUILTIN_BOARD },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects unknown properties on a theme create (additionalProperties discipline)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/api/themes', headers: { cookie },
      payload: { name: 'T', board: BUILTIN_BOARD, bogus: 1 },
    })
    expect(res.statusCode).toBe(400)
  })

  /** tab state (alert-sound contract): themes carry a suggested sounds map through create/PATCH/GET. */
  describe('sounds (alert-sound contract)', () => {
    it('accepts sounds on create and returns the parsed map', async () => {
      const res = await app.inject({
        method: 'POST', url: '/admin/api/themes', headers: { cookie },
        payload: { name: 'T', board: BUILTIN_BOARD, widgets: {}, sounds: { critical: 'bells' } },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().sounds).toEqual({ critical: 'bells' })
    })

    it('creates a theme with sounds omitted (defaults to {})', async () => {
      const res = await app.inject({
        method: 'POST', url: '/admin/api/themes', headers: { cookie },
        payload: { name: 'T', board: BUILTIN_BOARD },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().sounds).toEqual({})
    })

    it('PATCH stores sounds, bumps rev, and GET returns the parsed map', async () => {
      const created = await app.inject({
        method: 'POST', url: '/admin/api/themes', headers: { cookie },
        payload: { name: 's', board: BUILTIN_BOARD, widgets: {}, sounds: { critical: 'bells' } },
      })
      expect(created.statusCode).toBe(200)
      const id = created.json().id
      const patched = await app.inject({
        method: 'PATCH', url: `/admin/api/themes/${id}`, headers: { cookie },
        payload: { sounds: { critical: '8bit', warn: 'bells' } },
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().sounds).toEqual({ critical: '8bit', warn: 'bells' })
      expect(patched.json().rev).toBe(2)

      const list = await app.inject({ method: 'GET', url: '/admin/api/themes', headers: { cookie } })
      const found = list.json().find((t: any) => t.id === id)
      expect(found.sounds).toEqual({ critical: '8bit', warn: 'bells' })
    })

    it('rejects a sounds key that is not an event', async () => {
      const res = await app.inject({
        method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie },
        payload: { sounds: { bogus: 'bells' } },
      })
      expect(res.statusCode).toBe(400)
    })

    it('rejects a non-string sounds value and an out-of-pattern family name', async () => {
      // Not a number: Fastify's AJV runs coerceTypes:'array', so 7 becomes "7" and passes (same
      // reason the "rejects a non-coercible bad field" test above uses an object, not a number).
      expect((await app.inject({
        method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie },
        payload: { sounds: { critical: {} } },
      })).statusCode).toBe(400)
      expect((await app.inject({
        method: 'PATCH', url: '/admin/api/themes/thm_cypherpunk', headers: { cookie },
        payload: { sounds: { critical: 'Not Valid!' } },
      })).statusCode).toBe(400)
    })
  })

})
