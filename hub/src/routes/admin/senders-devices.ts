import type { FastifyInstance } from 'fastify'
import { createSender, deleteSender, listSenders } from '../../db/senders.js'
import {
  assignScreen, createPairingCode, getDevice, listDevices, listDeviceTabs, renameDevice,
  revokeDevice, setDeviceNavBars, setDeviceTabs, type NavBars,
} from '../../db/devices.js'
import { getScreen } from '../../db/screens.js'
import { getSoundManifest, SOUND_EVENTS } from '../../sounds.js'
import { audit } from '../../db/audit.js'
import { pushTabStatus } from '../../ws/tabStatus.js'
import { actorOf, screenTabBar } from './shared.js'

export function registerSendersDevicesRoutes(admin: FastifyInstance, app: FastifyInstance): void {
  admin.get('/admin/api/senders', async () => listSenders(app.db))
  admin.post<{ Body: { name: string; default_devices?: string[] } }>('/admin/api/senders', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      default_devices: { type: 'array', items: { type: 'string' } },
    } } },
  }, async (req) => {
    const res = createSender(app.db, req.body.name, req.body.default_devices ?? [])
    const actor = actorOf(req)
    audit(app.db, actor.type, actor.id, 'sender_created', { sender_id: res.sender.id, name: res.sender.name })
    return res
  })
  admin.delete<{ Params: { id: string } }>('/admin/api/senders/:id', async (req, reply) => {
    if (req.params.id === 'snd_hub') return reply.code(400).send({ error: 'cannot delete the hub sender' })
    const removed = deleteSender(app.db, req.params.id)
    if (!removed.deleted) return reply.code(404).send({ error: 'not found' })
    // A device holding one of this sender's alerts on screen has to be told, or it keeps
    // rendering — and sounding — an alert whose sender no longer exists.
    for (const alert of removed.retracted) {
      app.registry.sendMany(alert.target_devices, {
        type: 'ALERT_REMOVE', id: alert.id, reason: 'sender_deleted',
      })
    }
    if (removed.retracted.length > 0) pushTabStatus(app.db, app.registry)
    const actor = actorOf(req)
    audit(app.db, actor.type, actor.id, 'sender_deleted', {
      sender_id: req.params.id, retracted: removed.retracted.length,
    })
    return reply.code(204).send()
  })

  admin.get('/admin/api/devices', async () =>
    listDevices(app.db).map((d) => {
      const tabs = listDeviceTabs(app.db, d.id)
      return {
        ...d,
        // DERIVED, not stored (v25 dropped devices.screen_id): tab 0 or null. Honest compat for
        // MCP's assign_screen and any admin bookmark still reading this field off GET devices.
        screen_id: tabs[0]?.screen_id ?? null,
        online: app.registry.isOnline(d.id),
        rendering: app.statePusher.rendering(d.id),
        tabs: tabs.map((t) => ({ ...t, name: getScreen(app.db, t.screen_id)?.name ?? t.screen_id })),
      }
    }))
  admin.post<{ Body: { name: string } }>('/admin/api/devices/pairing-codes', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
    } } },
  }, async (req) => {
    const res = createPairingCode(app.db, req.body.name, Date.now())
    const actor = actorOf(req)
    audit(app.db, actor.type, actor.id, 'pairing_code_created', { name: req.body.name })
    return res
  })
  admin.patch<{ Params: { id: string }; Body: { name?: string; screen_id?: string | null; nav_bars?: NavBars; tabs?: { screen_id: string; label?: string | null }[] } }>(
    '/admin/api/devices/:id', {
      schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        screen_id: { type: ['string', 'null'] },
        nav_bars: { enum: ['hidden', 'respected', 'on_tap'] },
        tabs: { type: 'array', maxItems: 16, items: {
          type: 'object', additionalProperties: false, required: ['screen_id'], properties: {
            screen_id: { type: 'string' },
            label: { type: ['string', 'null'], maxLength: 40 },
          } } },
      } } },
    }, async (req, reply) => {
      const device = getDevice(app.db, req.params.id)
      if (!device) return reply.code(404).send({ error: 'not found' })

      // No orientation cross-check any more (v15). A screen owns its shape and a device shows
      // whatever screen it is pointed at, so a mismatch is not rejected — it is unrepresentable.
      if (typeof req.body.screen_id === 'string' && !getScreen(app.db, req.body.screen_id)) {
        return reply.code(400).send({ error: 'unknown screen' })
      }

      // Validate tabs upfront (before any mutations) to prevent partial writes: a request like
      // PATCH { name: 'X', tabs: [{dup}, {dup}] } must not rename the device if tabs validation fails.
      if (req.body.tabs !== undefined && req.body.screen_id !== undefined) {
        return reply.code(400).send({ error: 'send tabs or screen_id, not both' })
      }
      if (req.body.tabs !== undefined) {
        const ids = req.body.tabs.map((t) => t.screen_id)
        if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'duplicate screens in tabs' })
        const screens = ids.map((sid) => getScreen(app.db, sid))
        const missing = ids.filter((_, i) => !screens[i])
        if (missing.length > 0) return reply.code(400).send({ error: `unknown screens: ${missing.join(', ')}` })
        const orientations = new Set(screens.map((s) => s!.orientation))
        if (orientations.size > 1) {
          return reply.code(400).send({ error: 'all tab screens must share one orientation' })
        }
        // Tab-bar agreement (per-screen bar declaration). Same shape as the
        // orientation rule above: the bar must not teleport between tabs, and a bar-hiding
        // screen inside a multi-tab list would strand the viewer (switching is touch-only).
        // Single-tab lists are exempt — no bar is ever shown for them.
        if (ids.length > 1) {
          const positions = screens.map((s) => screenTabBar(s!))
          if (positions.includes('hidden')) {
            return reply.code(400).send({ error: 'screens that hide the tab bar cannot join a multi-tab list' })
          }
          if (new Set(positions).size > 1) {
            return reply.code(400).send({ error: 'all tab screens must agree on tab bar position' })
          }
        }
      }

      let changed = false
      const actor = actorOf(req)

      if (req.body.name !== undefined && req.body.name !== device.name) {
        renameDevice(app.db, req.params.id, req.body.name)
        audit(app.db, actor.type, actor.id, 'device_renamed', { device_id: req.params.id, name: req.body.name })
        changed = true
      }
      if (req.body.nav_bars !== undefined && req.body.nav_bars !== device.nav_bars) {
        setDeviceNavBars(app.db, req.params.id, req.body.nav_bars)
        audit(app.db, actor.type, actor.id, 'device_nav_bars_changed', { device_id: req.params.id, nav_bars: req.body.nav_bars })
        changed = true
      }
      if (req.body.tabs !== undefined) {
        const ids = req.body.tabs.map((t) => t.screen_id)
        setDeviceTabs(app.db, req.params.id, req.body.tabs)
        audit(app.db, actor.type, actor.id, 'device_tabs_assigned',
          { device_id: req.params.id, screen_ids: ids })
        changed = true
      }
      if (req.body.screen_id !== undefined) {
        // The single-tab-sugar invariant is "the result is exactly one tab" (or zero, for
        // null) — not "tab 0 names this screen". A multi-tab device with tabs [A, B] and
        // PATCH {screen_id: A} must still converge to [A] alone, even though tab 0 already
        // is A, so comparing tab 0 alone wrongly no-ops and leaves tab B in place.
        const tabs = listDeviceTabs(app.db, req.params.id)
        const alreadyThisShape = req.body.screen_id === null
          ? tabs.length === 0
          : tabs.length === 1 && tabs[0].screen_id === req.body.screen_id
        if (!alreadyThisShape) {
          assignScreen(app.db, req.params.id, req.body.screen_id)
          audit(app.db, actor.type, actor.id, 'device_screen_assigned', { device_id: req.params.id, screen_id: req.body.screen_id })
          changed = true
        }
      }
      if (changed) {
        app.statePusher.push(req.params.id)
        app.dataPusher.snapshot(req.params.id)
      }
      return reply.code(204).send()
    })

  admin.delete<{ Params: { id: string } }>('/admin/api/devices/:id', async (req, reply) => {
    app.registry.close(req.params.id, 4001, 'revoked')
    if (!revokeDevice(app.db, req.params.id)) return reply.code(404).send({ error: 'not found' })
    const actor = actorOf(req)
    audit(app.db, actor.type, actor.id, 'device_revoked', { device_id: req.params.id })
    return reply.code(204).send()
  })

  /**
   * Audition push (alert-sound contract): a one-shot PLAY_SOUND for an online device, no persistence — the
   * operator hears the family/event pair they are about to assign. Order: 404 unknown device,
   * 400 unknown family (event invalidity is caught by AJV's enum before the handler runs),
   * 409 offline, then send + audit + 204.
   */
  admin.post<{ Params: { id: string }; Body: { family: string; event: string } }>(
    '/admin/api/devices/:id/play-sound', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['family', 'event'], properties: {
        family: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9_]+$' },
        event: { type: 'string', enum: [...SOUND_EVENTS] },
      } } },
    }, async (req, reply) => {
      if (!getDevice(app.db, req.params.id)) return reply.code(404).send({ error: 'not found' })
      if (!getSoundManifest().families[req.body.family]) {
        return reply.code(400).send({ error: `unknown sound family: ${req.body.family}` })
      }
      if (!app.registry.isOnline(req.params.id)) return reply.code(409).send({ error: 'device offline' })
      app.registry.send(req.params.id, { type: 'PLAY_SOUND', family: req.body.family, event: req.body.event })
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'device_play_sound',
        { device_id: req.params.id, family: req.body.family, event: req.body.event })
      return reply.code(204).send()
    },
  )

  /**
   * Remote page reload (protocol.ts ReloadMsg — see its docstring for why this exists). Same
   * shape as play-sound above: 404 unknown device, 409 offline (a reload cannot be queued, and
   * an offline device loads fresh code on its next connect anyway), then send + audit + 204.
   */
  admin.post<{ Params: { id: string } }>('/admin/api/devices/:id/reload', async (req, reply) => {
    if (!getDevice(app.db, req.params.id)) return reply.code(404).send({ error: 'not found' })
    if (!app.registry.isOnline(req.params.id)) return reply.code(409).send({ error: 'device offline' })
    app.registry.send(req.params.id, { type: 'RELOAD' })
    const actor = actorOf(req)
    audit(app.db, actor.type, actor.id, 'device_reload', { device_id: req.params.id })
    return reply.code(204).send()
  })
}
