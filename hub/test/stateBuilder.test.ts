import { describe, expect, it, beforeEach } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { buildState } from '../src/ws/stateBuilder.js'
import { createScreen, updateScreen } from '../src/db/screens.js'
import { assignScreen, createPairingCode, redeemPairingCode, getDevice } from '../src/db/devices.js'
import { createTheme, getTheme } from '../src/db/themes.js'
import { getSoundManifest } from '../src/sounds.js'

const GRID = { cells: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config: {} }] }
const CLASSIC_SOUNDS = { critical: 'classic', warn: 'classic', info: 'classic', offline: 'classic', activity: 'classic' }

describe('buildState', () => {
  let db: DB
  beforeEach(() => { db = openDb(':memory:') })

  const device = () => {
    const { code } = createPairingCode(db, 'kitchen', 1000)
    return redeemPairingCode(db, code, 1000)!.device
  }

  /**
   * v15: the wire still carries `device.orientation` — every shipped board locks its rotation from
   * it — but the value is DERIVED from the assigned screen. An unassigned device falls back to
   * landscape, which is the shape the default layout has always been drawn for.
   */
  it('falls back to landscape and omits the screen when nothing is assigned', () => {
    const state = buildState(db, device(), 2000, 1)
    expect(state.device.orientation).toBe('landscape')
    expect(state.rev).toBe(1)
    // Absent, not null: the wire contract says absent/null ⇒ default layout, and we never
    // send a key we don't need (Android tolerates both, but absent is the canonical form).
    expect('screen' in state).toBe(false)
  })

  it('embeds the assigned screen with parsed grid, and takes its orientation from it', () => {
    const d = device()
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID }, 1000)
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 3)
    expect(state.screen).toEqual({
      id: s.id, name: 'Board', orientation: 'portrait', grid: GRID,
      sounds: CLASSIC_SOUNDS, sounds_rev: getSoundManifest().rev,
    })
    expect(state.device.orientation).toBe('portrait')
  })

  /** The device follows the screen it is pointed at — that is the whole of v15. */
  it('changes the device orientation when the screen it shows is flipped', () => {
    const d = device()
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID }, 1000)
    assignScreen(db, d.id, s.id)
    expect(buildState(db, getDevice(db, d.id)!, 2000, 1).device.orientation).toBe('portrait')
    db.prepare("UPDATE screens SET orientation = 'landscape' WHERE id = ?").run(s.id)
    expect(buildState(db, getDevice(db, d.id)!, 2000, 2).device.orientation).toBe('landscape')
  })

  it('unreadable stored grid degrades to no screen, never throws (bad data never crashes a read)', () => {
    const d = device()
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID }, 1000)
    db.prepare('UPDATE screens SET grid = ? WHERE id = ?').run('{not json', s.id)
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 1)
    expect('screen' in state).toBe(false)
  })

  it('omits theme entirely when the screen has none', () => {
    const d = device()
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID }, 1000)
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 1)
    expect('theme' in state.screen!).toBe(false)
  })

  it('carries {id, rev} when the screen has a theme', () => {
    const d = device()
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID, theme_id: 'thm_cypherpunk' }, 1000)
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 1)
    expect(state.screen!.theme).toEqual({ id: 'thm_cypherpunk', rev: getTheme(db, 'thm_cypherpunk')!.rev })
  })

  it('omits theme rather than throwing when theme_id dangles', () => {
    const d = device()
    const themeId = createTheme(db, { name: 'Temp', board: {}, widgets: {} }).id
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID, theme_id: themeId }, 1000)
    // Delete the theme row directly, bypassing deleteTheme's cascade (which would null this
    // out) and the FK constraint, to simulate bad data already in the database.
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM themes WHERE id = ?').run(themeId)
    db.pragma('foreign_keys = ON')
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 1)
    expect('theme' in state.screen!).toBe(false)
    // The theme lookup failed, so its suggestion is `{}` — sounds still resolve (to classic,
    // absent any screen override), same as no theme at all.
    expect(state.screen!.sounds).toEqual(CLASSIC_SOUNDS)
  })

  it('resolves theme ⊕ screen ⊕ classic onto each wire screen', () => {
    const d = device()
    const theme = createTheme(db, { name: 't', board: {}, widgets: {}, sounds: { critical: '8bit', warn: '8bit' } })
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID, theme_id: theme.id }, 1000)
    // screen assigned to the theme, with a partial override:
    updateScreen(db, s.id, { sounds: { critical: 'bells' } })
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 1)
    expect(state.screen?.sounds).toEqual({ critical: 'bells', warn: '8bit', info: 'classic', offline: 'classic', activity: 'classic' })
    expect(state.screen?.sounds_rev).toBeGreaterThanOrEqual(1)
  })

  it('no theme, no override → all classic (and the field is still present)', () => {
    const d = device()
    const s = createScreen(db, { name: 'Board', orientation: 'portrait', grid: GRID }, 1000)
    assignScreen(db, d.id, s.id)
    const state = buildState(db, getDevice(db, d.id)!, 2000, 1)
    expect(state.screen?.sounds).toEqual(CLASSIC_SOUNDS)
  })
})
