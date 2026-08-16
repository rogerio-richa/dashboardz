import { randomInt } from 'node:crypto'
import type { DB } from './index.js'
import type { Orientation } from './screens.js'
import { newId } from '../ids.js'
import { generateToken, hashToken } from '../auth/tokens.js'

/**
 * What this device does with its system bars (v17, superseding v16's screen property).
 *
 * A property of the GLASS, not of the layout: the same board is correct on a wall panel with no
 * bars and on a handheld that still needs its back gesture, so two devices sharing a screen have
 * no reason to agree about this.
 */
export type NavBars = 'hidden' | 'respected' | 'on_tap'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 600_000

export interface DeviceRow {
  id: string
  name: string
  nav_bars: NavBars
  created_at: number
  last_seen_at: number | null
  battery: number | null
  charging: number | null
  // The box this device draws into, in CSS pixels, as of viewport_at (schema v8). NULL for a
  // device that has never reported — treat as UNKNOWN, never as zero.
  viewport_w: number | null
  viewport_h: number | null
  viewport_dpr: number | null
  viewport_at: number | null
}

const DEVICE_COLS = 'id, name, nav_bars, created_at, last_seen_at, battery, charging, viewport_w, viewport_h, viewport_dpr, viewport_at'

export function createPairingCode(
  db: DB,
  deviceName: string,
  now: number,
  opts?: { alphabet?: string },
): { code: string; expires_at: number } {
  const alphabet = opts?.alphabet ?? CODE_ALPHABET

  // Prune dead rows
  db.prepare('DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at < ?')
    .run(now)

  const expires_at = now + CODE_TTL_MS
  const insert = db.prepare('INSERT INTO pairing_codes (code, device_name, expires_at) VALUES (?, ?, ?)')

  // Retry up to 10 times on collision
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = ''
    for (let i = 0; i < 6; i++) code += alphabet[randomInt(alphabet.length)]

    try {
      insert.run(code, deviceName, expires_at)
      return { code, expires_at }
    } catch (err) {
      const error = err as { code?: string }
      if (error.code && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
        // Collision; retry
        continue
      }
      throw err
    }
  }

  throw new Error('could not generate a unique pairing code')
}

export function redeemPairingCode(db: DB, code: string, now: number): { device: DeviceRow; token: string } | null {
  const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at >= ?')
    .get(code, now) as { device_name: string } | undefined
  if (!row) return null
  db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?').run(now, code)
  const token = generateToken('device')
  const device: DeviceRow = {
    id: newId('dev'), name: row.device_name, created_at: now,
    last_seen_at: null, battery: null, charging: null,
    nav_bars: 'respected',
    // Unknown until the device connects and tells us — never assumed.
    viewport_w: null, viewport_h: null, viewport_dpr: null, viewport_at: null,
  }
  db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(device.id, device.name, hashToken(token), device.created_at)
  return { device, token }
}

export function findDeviceByToken(db: DB, token: string): DeviceRow | undefined {
  return db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE token_hash = ?`)
    .get(hashToken(token)) as DeviceRow | undefined
}

export function listDevices(db: DB): DeviceRow[] {
  return db.prepare(`SELECT ${DEVICE_COLS} FROM devices ORDER BY created_at`).all() as DeviceRow[]
}

export function deviceExists(db: DB, id: string): boolean {
  return db.prepare('SELECT 1 FROM devices WHERE id = ?').get(id) !== undefined
}

/** The one write the operator makes against the glass rather than against a layout. */
export function setDeviceNavBars(db: DB, id: string, navBars: NavBars): boolean {
  return db.prepare('UPDATE devices SET nav_bars = ? WHERE id = ?').run(navBars, id).changes > 0
}

export function renameDevice(db: DB, id: string, name: string): boolean {
  return db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id).changes > 0
}

export function getDevice(db: DB, id: string): DeviceRow | undefined {
  return db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined
}

export interface DeviceTab { screen_id: string; position: number; label: string | null }

export function listDeviceTabs(db: DB, deviceId: string): DeviceTab[] {
  return db.prepare(
    'SELECT screen_id, position, label FROM device_screens WHERE device_id = ? ORDER BY position',
  ).all(deviceId) as DeviceTab[]
}

/** Replace-all semantics, one transaction — same convention as a grid PATCH replacing cells. */
export function setDeviceTabs(
  db: DB, deviceId: string, tabs: { screen_id: string; label?: string | null }[],
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM device_screens WHERE device_id = ?').run(deviceId)
    const insert = db.prepare(
      'INSERT INTO device_screens (device_id, screen_id, position, label) VALUES (?, ?, ?, ?)')
    tabs.forEach((t, i) => insert.run(deviceId, t.screen_id, i, t.label ?? null))
  })()
}

/**
 * Single-screen sugar (since v24; pure since v25). `devices.screen_id` is gone — this is now
 * nothing but a single-tab-shaped call into `setDeviceTabs`, kept as its own function because
 * `PATCH {screen_id}` and MCP's `assign_screen` are compat surfaces that still speak one screen at
 * a time, not zero or many.
 */
export function assignScreen(db: DB, deviceId: string, screenId: string | null): boolean {
  if (!deviceExists(db, deviceId)) return false
  setDeviceTabs(db, deviceId, screenId ? [{ screen_id: screenId }] : [])
  return true
}

/**
 * `device_screens.device_id` has an FK to devices (no cascade, foreign_keys = ON) — a device with
 * any assigned tab must have its device_screens rows cleared before the devices row, or the
 * DELETE throws instead of revoking. One transaction so a mid-way failure never leaves deliveries
 * or tabs gone but the device row still there (or vice versa).
 */
export function revokeDevice(db: DB, id: string): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM deliveries WHERE device_id = ?').run(id)
    db.prepare('DELETE FROM device_screens WHERE device_id = ?').run(id)
    return db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0
  })()
}

/**
 * Record the box this device actually draws into (schema v8).
 *
 * Last-known, not a fixed property: a browser window resizes freely and a handset rotates, so this
 * is refreshed on every HELLO rather than written once at enrollment. Rejects anything not a
 * positive, finite number so a malformed caps payload leaves the previous good value in place
 * instead of blanking it — a device that lies about its size must not make the editor guess again.
 */
export function updateDeviceViewport(
  db: DB,
  id: string,
  w: unknown,
  h: unknown,
  dpr: unknown,
  now: number,
): boolean {
  const px = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null
  const ratio = typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : null
  const width = px(w)
  const height = px(h)
  if (width === null || height === null) return false
  const res = db
    .prepare('UPDATE devices SET viewport_w = ?, viewport_h = ?, viewport_dpr = ?, viewport_at = ? WHERE id = ?')
    .run(width, height, ratio, now, id)
  return res.changes > 0
}

export function updateDeviceHealth(db: DB, id: string, battery: number | null, charging: boolean | null, now: number): void {
  db.prepare('UPDATE devices SET battery = COALESCE(?, battery), charging = COALESCE(?, charging), last_seen_at = ? WHERE id = ?')
    .run(battery, charging === null ? null : charging ? 1 : 0, now, id)
}
