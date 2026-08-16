import type { DB } from '../db/index.js'
import { createScreen } from '../db/screens.js'
import { setDeviceTabs } from '../db/devices.js'

/**
 * The screen a device is born with: first run must not end at an unexplained clock. A clock
 * over one line of text saying where the screen is edited. Deliberately nothing that needs data,
 * because at pair time no source exists to bind: weather wants a location and a calendar wants an
 * ICS URL, and inventing either would be worse than asking. The admin editor recognises this
 * shape and offers to add both, through the same widget-first flow every other cell goes through.
 *
 * A real, editable screen rather than the client's built-in default layout: the operator's admin
 * opens on something they can change, the hint is an ordinary cell they delete when they're done
 * with it, and the Devices tab never shows a dead end.
 */
export function starterGrid(publicUrl: string | null) {
  return {
    cells: [
      { widget: 'clock', config: {}, rect: { x: 0, y: 0, w: 1, h: 0.8 } },
      { widget: 'text_block', config: { text: editHint(publicUrl) }, rect: { x: 0, y: 0.8, w: 1, h: 0.2 } },
    ],
  }
}

/** A hub without PUBLIC_URL defaults to localhost, which the panel itself can never open. */
function editHint(publicUrl: string | null): string {
  let host = ''
  try { host = publicUrl ? new URL(publicUrl).hostname : '' } catch { host = '' }
  const loopback = host === '' || host === 'localhost' || host.endsWith('.localhost') ||
    host.startsWith('127.') || host === '[::1]' || host === '0.0.0.0'
  if (loopback) return "Edit this screen on the hub's admin page, under Screens"
  // Written the way people type it into a browser: http:// is implied, https:// is kept.
  const address = publicUrl!.replace(/\/+$/, '').replace(/^http:\/\//, '')
  return `Edit this screen at ${address}/admin, under Screens`
}

/**
 * Screen names are unique, and re-pairing a device under the same name ("kitchen" again after an
 * unpair) is ordinary, so the starter takes the first free name: "kitchen", "kitchen 2", ...
 */
function freeScreenName(db: DB, base: string): string {
  const taken = db.prepare('SELECT 1 FROM screens WHERE name = ?')
  if (!taken.get(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.get(candidate)) return candidate
  }
}

export function seedStarterScreen(db: DB, deviceId: string, deviceName: string, now: number, publicUrl: string | null = null): void {
  const name = freeScreenName(db, deviceName)
  const screen = createScreen(db, { name, orientation: 'landscape', grid: starterGrid(publicUrl) }, now)
  setDeviceTabs(db, deviceId, [{ screen_id: screen.id }])
}
