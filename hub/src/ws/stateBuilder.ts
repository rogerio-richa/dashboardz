import type { DB } from '../db/index.js'
import { activeWireAlertsForDevice } from '../db/alerts.js'
import { getScreen, type ScreenRow } from '../db/screens.js'
import { getTheme } from '../db/themes.js'
import { listDeviceTabs, type DeviceRow } from '../db/devices.js'
import { computeTabStatus } from './tabStatus.js'
import { getSoundManifest, parseSounds, resolveSounds } from '../sounds.js'
import type { StateMsg, WireScreen, WireTabScreen } from './protocol.js'

/**
 * AJV guarantees stored grids are valid, but bad data already in the database must never crash a
 * read path (house rule) — an unparseable grid returns null (and warns) rather than throwing, so
 * the caller can degrade just that one screen/tab instead of the whole STATE.
 */
function toWire(db: DB, screen: ScreenRow): WireScreen | null {
  try {
    const wire: WireScreen = {
      id: screen.id, name: screen.name, orientation: screen.orientation,
      grid: JSON.parse(screen.grid),
    }
    // NULL theme_id means the built-in default (not an error) and a dangling theme_id is bad
    // data already in the DB (theme deleted out from under a screen via a path that skipped
    // the cascade, or a raw admin edit) — both omit `theme` entirely rather than emit a
    // half-populated reference. Never `null`: an app that predates theming must be able to
    // ignore this key under ignoreUnknownKeys and render exactly as it does today.
    const theme = screen.theme_id ? getTheme(db, screen.theme_id) : undefined
    if (theme) wire.theme = { id: theme.id, rev: theme.rev }
    // Sounds resolve off the same lookup regardless of whether `theme` made it onto the wire —
    // a dangling theme_id still resolves (with the theme's suggestion collapsed to `{}`), same
    // as a screen that was never themed at all.
    const manifest = getSoundManifest()
    wire.sounds = resolveSounds(parseSounds(theme?.sounds), parseSounds(screen.sounds), manifest)
    wire.sounds_rev = manifest.rev
    return wire
  } catch {
    console.warn(`screen ${screen.id} has unreadable grid; serving default layout`)
    return null
  }
}

export function buildState(
  db: DB,
  device: Pick<DeviceRow, 'id' | 'name' | 'nav_bars'>,
  now: number,
  rev: number,
): StateMsg {
  // Tabs are the single truth since v25 — there is no legacy column left to read.
  const tabs = listDeviceTabs(db, device.id)
  const wires: WireTabScreen[] = []
  for (const t of tabs) {
    const screen = getScreen(db, t.screen_id)
    if (!screen) continue
    const wire = toWire(db, screen)
    if (wire) wires.push(t.label ? { ...wire, label: t.label } : wire)
  }
  /**
   * DERIVED from tab 0 since v15 (single-screen), extended to "the first renderable tab" here. A
   * layout is authored FOR a shape and the device shows whatever layout it is pointed at, so the
   * screen owns the shape.
   *
   * Still sent as `device.orientation`, deliberately: every shipped Android build and every loaded
   * board locks its rotation from this field, and changing the wire would have made a data-model
   * tidy-up into a client migration. A device with no renderable tab falls back to landscape, which
   * is what the default layout has always been drawn for.
   */
  const orientation = wires.length > 0 ? wires[0].orientation : 'landscape'
  const state: StateMsg = {
    type: 'STATE',
    device: { id: device.id, name: device.name, orientation, nav_bars: device.nav_bars },
    rev,
    server_time: now,
    alerts: activeWireAlertsForDevice(db, device.id, now),
  }
  // `screen` keeps being populated exactly as today (compat: old clients render it forever) —
  // `screens` is purely additive, present only when there's at least one renderable tab.
  if (wires.length > 0) {
    state.screen = wires[0]
    state.screens = wires
    state.tab_status = computeTabStatus(db, wires.map((w) => w.id))
  }
  return state
}
