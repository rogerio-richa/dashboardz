import type { DB } from '../db/index.js'
import { createScreen } from '../db/screens.js'
import { setDeviceTabs } from '../db/devices.js'

/**
 * The screen a device is born with: first run must not end at an
 * unexplained clock). One full-bleed clock cell — deliberately nothing that needs data,
 * because at pair time no source exists to bind: weather wants a location and a calendar
 * wants an ICS URL, and inventing either would be worse than asking. The admin editor
 * recognises this exact shape and offers to add both, through the same widget-first flow
 * every other cell goes through.
 *
 * A real, editable screen rather than the client's built-in default layout: the operator's
 * admin opens on something they can change, and the Devices tab never shows a dead end.
 */
export const STARTER_GRID = { cells: [{ widget: 'clock', config: {}, rect: { x: 0, y: 0, w: 1, h: 1 } }] }

export function seedStarterScreen(db: DB, deviceId: string, deviceName: string, now: number): void {
  const screen = createScreen(db, { name: deviceName, orientation: 'landscape', grid: STARTER_GRID }, now)
  setDeviceTabs(db, deviceId, [{ screen_id: screen.id }])
}
