import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { findDeviceByToken, updateDeviceHealth, updateDeviceViewport } from '../db/devices.js'
import { recordAck, recordAnswer, recordTap } from '../db/alerts.js'
import { audit } from '../db/audit.js'
import { emitRelayOutcome } from '../relay/handler.js'
import { pushTabStatus } from './tabStatus.js'
import type { ClientMsg } from './protocol.js'

const HELLO_TIMEOUT_MS = 5000

// JSON.parse only guarantees valid syntax, not the shape we expect. A client (or a bug in a
// client) can send `null`, an array, a number, or an object with the wrong field types — none of
// that may ever be allowed to throw inside the socket's 'message' handler.
function isClientMsg(value: unknown): value is ClientMsg {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

export function registerDeviceSocket(app: FastifyInstance, opts: { pingIntervalMs?: number } = {}): void {
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000
  const alive = new WeakMap<WebSocket, number>()

  const pinger = setInterval(() => {
    for (const [, socket] of app.registry.all()) {
      const misses = (alive.get(socket) ?? 0) + 1
      if (misses > 2) { socket.terminate(); continue }
      alive.set(socket, misses)
      socket.ping()
    }
  }, pingIntervalMs)
  pinger.unref()
  app.addHook('onClose', async () => clearInterval(pinger))

  app.get('/ws/device', { websocket: true }, (socket: WebSocket) => {
    let deviceId: string | null = null
    const helloTimer = setTimeout(() => socket.close(4002, 'hello timeout'), HELLO_TIMEOUT_MS)

    socket.on('pong', () => alive.set(socket, 0))
    socket.on('message', (raw) => {
      // Last-resort guarantee: no client payload — malformed JSON, unexpected shape, or a bug
      // below — may ever crash the process. Everything for this message is inside this try.
      try {
        const parsed: unknown = JSON.parse(raw.toString())
        if (!isClientMsg(parsed)) return
        const msg = parsed

        if (msg.type === 'HELLO') {
          if (deviceId) return // already authenticated on this socket; ignore repeat HELLO
          if (typeof msg.token !== 'string') return
          clearTimeout(helloTimer)
          const device = findDeviceByToken(app.db, msg.token)
          if (!device) {
            audit(app.db, 'system', null, 'ws_auth_rejected', {})
            socket.close(4001, 'invalid token')
            return
          }
          deviceId = device.id
          alive.set(socket, 0)
          app.registry.attach(device.id, socket)
          updateDeviceHealth(app.db, device.id, null, null, Date.now())
          // Last-known, refreshed on every HELLO: a browser window resizes and a handset rotates,
          // so this is never a fixed property of the device. A malformed or absent viewport leaves
          // the previous good value alone rather than blanking it.
          const vp = msg.caps?.viewport
          if (vp) updateDeviceViewport(app.db, device.id, vp.w, vp.h, vp.dpr, Date.now())
          audit(app.db, 'device', device.id, 'ws_connected', { caps: msg.caps ?? {} })
          app.statePusher.push(device.id)
          app.dataPusher.snapshot(device.id)
          return
        }

        if (!deviceId) return // everything else requires HELLO first

        if (msg.type === 'ACK') {
          if (typeof msg.id !== 'string' || (msg.stage !== 'delivered' && msg.stage !== 'displayed')) return
          recordAck(app.db, msg.id, deviceId, msg.stage, Date.now())
        } else if (msg.type === 'STATE_ACK') {
          if (typeof msg.rev !== 'number') return
          const legacy = !Array.isArray(msg.screen_ids)
          const screenIds = Array.isArray(msg.screen_ids)
            ? msg.screen_ids.filter((s): s is string => typeof s === 'string')
            : typeof msg.screen_id === 'string' ? [msg.screen_id] : []
          app.statePusher.onAck(deviceId, msg.rev, screenIds, legacy)
        } else if (msg.type === 'TAP') {
          if (typeof msg.id !== 'string') return
          if (msg.action === 'answer') {
            if (typeof msg.option_id !== 'string') return
            const answeredAt = Date.now()
            const res = recordAnswer(app.db, msg.id, deviceId, msg.option_id, answeredAt)
            if (!res.ok) return
            audit(app.db, 'device', deviceId, 'tap_answer', { alert_id: msg.id, option_id: msg.option_id })
            // If this alert arrived over the relay, the human's answer is what the sender has
            // been waiting for — route it home. A no-op for local alerts and for a hub with no
            // relay configured, so the LAN path is byte-for-byte what it was before.
            emitRelayOutcome(app.db, app.relayManager, msg.id, {
              event: 'answer', option_id: msg.option_id, device_id: deviceId, at: answeredAt,
            })
            // An answered alert is done on this device — same treatment as a dismissal.
            app.registry.send(deviceId, { type: 'ALERT_REMOVE', id: msg.id, reason: 'dismissed' })
            pushTabStatus(app.db, app.registry)
            return
          }
          if (msg.action !== 'silence' && msg.action !== 'dismiss') return
          recordTap(app.db, msg.id, deviceId, msg.action, Date.now())
          audit(app.db, 'device', deviceId, `tap_${msg.action}`, { alert_id: msg.id })
          if (msg.action === 'dismiss') {
            app.registry.send(deviceId, { type: 'ALERT_REMOVE', id: msg.id, reason: 'dismissed' })
            pushTabStatus(app.db, app.registry)
          }
        } else if (msg.type === 'TAB') {
          if (typeof msg.screen_id !== 'string') return
          app.statePusher.onTab(deviceId, msg.screen_id)
        } else if (msg.type === 'HEALTH') {
          const battery = typeof msg.battery === 'number' ? msg.battery : null
          const charging = typeof msg.charging === 'boolean' ? msg.charging : null
          updateDeviceHealth(app.db, deviceId, battery, charging, Date.now())
          // A device that rotates or has its system bars toggled is a DIFFERENT box, and the
          // editor now designs against exactly that box. Without this it would keep designing
          // against whatever shape the device happened to be in when it last connected.
          if (msg.viewport) {
            updateDeviceViewport(app.db, deviceId, msg.viewport.w, msg.viewport.h, msg.viewport.dpr, Date.now())
          }
        }
      } catch {
        // swallow: a malformed or unexpected client payload must never crash the process
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (deviceId) {
        app.registry.detach(deviceId, socket)
        // DeviceRegistry.attach replaces a stale socket on reconnect by closing it with 4000 —
        // that stale socket's own 'close' event fires after the new socket is already attached.
        // Dropping the pusher entry unconditionally here would wipe the NEW connection's
        // STATE_ACK tracking and disarm its timeout timer. Only drop once the device is
        // genuinely offline (no socket currently attached).
        if (!app.registry.isOnline(deviceId)) app.statePusher.drop(deviceId)
        updateDeviceHealth(app.db, deviceId, null, null, Date.now())
        audit(app.db, 'device', deviceId, 'ws_disconnected', {})
      }
    })
  })
}
