import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/migrate.js'
import { createPairingCode, redeemPairingCode, getDevice, updateDeviceViewport } from '../src/db/devices.js'

/**
 * A screen is authored FOR a device, and a device has a size.
 *
 * Until the hub knew this, the editor could only guess: it offered a target-shape dropdown, an
 * operator picked 16:10 for a 20:9 handset, and every cell came out ~28% shorter in pixels than
 * the preview showed. It is also what makes WIDGET_MIN_PX enforceable at design time rather than
 * discovered on the wall.
 */
const freshDevice = () => {
  const db = new Database(':memory:')
  migrate(db)
  const { code } = createPairingCode(db, 'panel', Date.now() + 60_000)
  const redeemed = redeemPairingCode(db, code, Date.now())!
  return { db, id: redeemed.device.id }
}

describe('device viewport reporting', () => {
  it('is UNKNOWN until the device says otherwise, never zero', () => {
    const { db, id } = freshDevice()
    const d = getDevice(db, id)!
    expect(d.viewport_w).toBe(null)
    expect(d.viewport_h).toBe(null)
    expect(d.viewport_dpr).toBe(null)
    expect(d.viewport_at).toBe(null)
  })

  it('records what the device reported', () => {
    const { db, id } = freshDevice()
    expect(updateDeviceViewport(db, id, 853, 384, 1.875, 1000)).toBe(true)
    const d = getDevice(db, id)!
    expect([d.viewport_w, d.viewport_h, d.viewport_dpr]).toEqual([853, 384, 1.875])
    expect(d.viewport_at).toBe(1000)
  })

  /**
   * Last-known, not a fixed property: a browser window resizes freely and a handset rotates, so
   * every HELLO overwrites. A device that turns end-for-end must not leave the editor designing
   * against the shape it had an hour ago.
   */
  it('overwrites on each report rather than keeping the first', () => {
    const { db, id } = freshDevice()
    updateDeviceViewport(db, id, 853, 384, 1.875, 1000)
    updateDeviceViewport(db, id, 384, 853, 1.875, 2000)
    const d = getDevice(db, id)!
    expect([d.viewport_w, d.viewport_h]).toEqual([384, 853])
  })

  /**
   * A malformed payload must leave the previous good value in place. Blanking it would send the
   * editor straight back to guessing — worse than the stale-but-plausible value it replaced.
   */
  it('refuses junk and keeps the last good value', () => {
    const { db, id } = freshDevice()
    updateDeviceViewport(db, id, 853, 384, 1.875, 1000)
    for (const bad of [[0, 384], [-5, 384], [853, 0], ['853', 384], [NaN, 384], [null, null], [undefined, 1]]) {
      expect(updateDeviceViewport(db, id, bad[0], bad[1], 2, 9999)).toBe(false)
    }
    const d = getDevice(db, id)!
    expect([d.viewport_w, d.viewport_h, d.viewport_at]).toEqual([853, 384, 1000])
  })

  /** A missing dpr is tolerable — the box is what layout needs; the ratio is only ever advisory. */
  it('accepts a report with no usable dpr', () => {
    const { db, id } = freshDevice()
    expect(updateDeviceViewport(db, id, 800, 600, 'x', 1000)).toBe(true)
    expect(getDevice(db, id)!.viewport_dpr).toBe(null)
  })

  it('rounds fractional pixels rather than storing them', () => {
    const { db, id } = freshDevice()
    updateDeviceViewport(db, id, 853.4, 383.6, 1.875, 1000)
    const d = getDevice(db, id)!
    expect([d.viewport_w, d.viewport_h]).toEqual([853, 384])
  })
})

/**
 * A device that rotates, resizes, or has its system bars toggled is a DIFFERENT box — and the
 * editor now designs against exactly that box. Reporting only at HELLO would leave an operator
 * laying out cards against whatever shape the device happened to be in when it last connected.
 */
describe('viewport changes after connection', () => {
  it('a later report replaces the one from HELLO', () => {
    const { db, id } = freshDevice()
    updateDeviceViewport(db, id, 853, 384, 1.875, 1000)   // HELLO, landscape
    updateDeviceViewport(db, id, 384, 853, 1.875, 2000)   // rotated, over HEALTH
    const d = getDevice(db, id)!
    expect([d.viewport_w, d.viewport_h, d.viewport_at]).toEqual([384, 853, 2000])
  })

  /**
   * Hiding the system bars makes the board taller. The stored box must follow, or every
   * minimum-size check in the editor is computed against space the board no longer has.
   */
  it('follows a height change from system bars appearing or hiding', () => {
    const { db, id } = freshDevice()
    updateDeviceViewport(db, id, 853, 384, 1.875, 1000)
    updateDeviceViewport(db, id, 853, 411, 1.875, 2000)
    expect(getDevice(db, id)!.viewport_h).toBe(411)
  })
})
