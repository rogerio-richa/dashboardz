import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'static')
const maybe = hasBrowser() ? describe : describe.skip

const INIT = `window.__dashboardzHost = { send() {}, ready() {}, token() { return 'dbz_c_x' } }`
const display = (id: string) => `getComputedStyle(document.getElementById('${id}')).display`

/**
 * The mechanism that matters when the network is bad: device.js loads as a deferred module, and
 * when its fetch fails (for example, mDNS flaking on a .local hub address) the page stays on
 * whatever the HTML shows by default. The default must be the splash, and the pair form must need
 * JavaScript to appear.
 */
describe('device page HTML defaults (what shows if device.js never loads)', () => {
  const html = readFileSync(join(STATIC_ROOT, 'device', 'index.html'), 'utf8')

  it('ships a splash that is visible without JavaScript', () => {
    expect(html).toContain('id="splash"')
    expect(html).not.toMatch(/id="splash"[^>]*style="[^"]*display:\s*none/)
  })

  it('ships the pair form hidden until device.js decides it is genuinely unpaired', () => {
    expect(html).toMatch(/id="pairing"[^>]*style="[^"]*display:\s*none/)
  })
})

maybe('boot splash instead of the pair form', () => {
  let server: { url: string; close: () => void }
  beforeAll(async () => { server = await serveStatic(STATIC_ROOT) })
  afterAll(() => server?.close())

  it('a driven (app-hosted) page never shows the pair form — module init goes straight to the board', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      expect(await page.evaluate<string>(display('pairing'))).toBe('none')
      expect(await page.evaluate<string>(display('splash'))).toBe('none')
      expect(await page.evaluate<string>(display('idle'))).not.toBe('none')
    } finally {
      await page?.close()
    }
  })

  it('a genuinely unpaired browser swaps the splash for the pair form', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384)
      expect(await page.evaluate<string>(display('pairing'))).not.toBe('none')
      expect(await page.evaluate<string>(display('splash'))).toBe('none')
    } finally {
      await page?.close()
    }
  })
})
