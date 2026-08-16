import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import {
  createPairingCode, findDeviceByToken, listDevices, redeemPairingCode,
  renameDevice, revokeDevice, deviceExists, updateDeviceHealth,
  assignScreen, setDeviceTabs, listDeviceTabs,
} from '../src/db/devices.js'
import { createScreen } from '../src/db/screens.js'

describe('pairing and devices', () => {
  it('pairing code round-trip', () => {
    const db = openDb(':memory:')
    const { code } = createPairingCode(db, 'bedside', 1000)
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    const res = redeemPairingCode(db, code, 2000)
    expect(res).not.toBeNull()
    expect(res!.device.name).toBe('bedside')
    expect(res!.token).toMatch(/^dbz_c_/)
    expect(findDeviceByToken(db, res!.token)?.id).toBe(res!.device.id)
    expect(redeemPairingCode(db, code, 3000)).toBeNull() // one-time
  })
  it('expired code is rejected', () => {
    const db = openDb(':memory:')
    const { code } = createPairingCode(db, 'x', 1000)
    expect(redeemPairingCode(db, code, 1000 + 600_001)).toBeNull()
  })
  it('rename, health, revoke', () => {
    const db = openDb(':memory:')
    const { code } = createPairingCode(db, 'x', 0)
    const { device, token } = redeemPairingCode(db, code, 1)!
    expect(renameDevice(db, device.id, 'hall')).toBe(true)
    updateDeviceHealth(db, device.id, 84, true, 50)
    const row = listDevices(db)[0]
    expect(row.name).toBe('hall')
    expect(row.battery).toBe(84)
    expect(row.last_seen_at).toBe(50)
    expect(deviceExists(db, device.id)).toBe(true)
    expect(revokeDevice(db, device.id)).toBe(true)
    expect(findDeviceByToken(db, token)).toBeUndefined()
  })
  /**
   * device_screens.device_id has an FK to devices with no cascade (foreign_keys = ON) — revoking
   * a device that has an assigned tab must delete its device_screens rows too, or the DELETE FROM
   * devices throws instead of revoking.
   */
  it('revokes a device with an assigned screen, removing its tab rows', () => {
    const db = openDb(':memory:')
    const { code } = createPairingCode(db, 'x', 0)
    const { device } = redeemPairingCode(db, code, 1)!
    const screen = createScreen(db, { name: 's', orientation: 'landscape', grid: { cells: [] } }, 0)
    expect(assignScreen(db, device.id, screen.id)).toBe(true)
    expect(listDeviceTabs(db, device.id)).toHaveLength(1)
    expect(revokeDevice(db, device.id)).toBe(true)
    expect(deviceExists(db, device.id)).toBe(false)
    expect(listDeviceTabs(db, device.id)).toEqual([])
  })

  it('revokes a device with multiple tabs set via setDeviceTabs', () => {
    const db = openDb(':memory:')
    const { code } = createPairingCode(db, 'y', 0)
    const { device } = redeemPairingCode(db, code, 1)!
    const s1 = createScreen(db, { name: 's1', orientation: 'landscape', grid: { cells: [] } }, 0)
    const s2 = createScreen(db, { name: 's2', orientation: 'landscape', grid: { cells: [] } }, 0)
    setDeviceTabs(db, device.id, [{ screen_id: s1.id }, { screen_id: s2.id }])
    expect(revokeDevice(db, device.id)).toBe(true)
    expect(deviceExists(db, device.id)).toBe(false)
  })

  it('prunes dead pairing codes', () => {
    const db = openDb(':memory:')
    // Create a code at now=0, expires at 600000
    createPairingCode(db, 'old', 0)
    // At now=700000 (after expiry), create a new code; old row should be pruned
    createPairingCode(db, 'new', 700000)
    const count = db.prepare('SELECT COUNT(*) as cnt FROM pairing_codes').get() as { cnt: number }
    expect(count.cnt).toBe(1)
  })
  it('throws on collision exhaustion', () => {
    const db = openDb(':memory:')
    // Create a code with single-char alphabet, creates 'AAAAAA'
    const { code: code1 } = createPairingCode(db, 'first', 0, { alphabet: 'A' })
    expect(code1).toBe('AAAAAA')
    // Try to create another code at same time; first is still live (not expired/used)
    // Only 'AAAAAA' can be generated from 'A' alphabet
    expect(() => {
      createPairingCode(db, 'second', 0, { alphabet: 'A' })
    }).toThrow('could not generate a unique pairing code')
  })
})
