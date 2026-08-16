import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The device page must know installed pack designs BEFORE it renders or connects: its unknown-design
 * check would otherwise see a pack design as unknown and reload itself, again and again.
 */
describe('device page boot', () => {
  it('awaits the installed-pack loader before the first connect', () => {
    const src = readFileSync(new URL('../static/device/device.js', import.meta.url), 'utf8')
    // A promise, not top-level await: TLA needs WebView 89, and the Android app supports 80+.
    expect(src).not.toMatch(/^await /m)
    const load = src.indexOf('loadInstalledPacks({ register }).finally(')
    const connect = src.lastIndexOf('connect()')
    expect(load).toBeGreaterThan(-1)
    expect(load).toBeLessThan(connect)
    expect(src).toMatch(/import \{ loadInstalledPacks \} from '\.\/widgets\/packs\.mjs'/)
  })
})
