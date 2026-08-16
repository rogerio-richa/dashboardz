import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'static')
const maybe = hasBrowser() ? describe : describe.skip

const deliver = (msg: object) => `__dashboardzDeliver(${JSON.stringify(JSON.stringify(msg))})`
const now = () => Date.now()

const INIT = `window.__dashboardzHost = { send() {}, ready() {} }`

const streamTab = (id: string, feed: string) => ({
  id, name: id, orientation: 'landscape',
  grid: { tab_bar: 'bottom', cells: [{ widget: 'stream_list', config: { feed }, rect: { x: 0, y: 0, w: 1, h: 1 } }] },
  sounds: { critical: 'classic', warn: 'classic', info: 'classic', offline: 'classic', activity: 'classic' },
  sounds_rev: 2,
})
const plainTab = (id: string) => ({
  id, name: id, orientation: 'landscape', grid: { tab_bar: 'bottom', cells: [] },
  sounds: { critical: 'classic', warn: 'classic', info: 'classic', offline: 'classic', activity: 'classic' },
  sounds_rev: 2,
})

function stateMsg(screens: object[]) {
  return {
    type: 'STATE', rev: 1, server_time: now(),
    device: { id: 'dev_test', name: 'test', orientation: 'landscape' },
    alerts: [], screens, tab_status: {},
  }
}
const dataMsg = (feedIds: string[], snapshot = false) => ({
  type: 'DATA', server_time: now(), snapshot,
  feeds: Object.fromEntries(feedIds.map((id) => [id, { mode: 'stream', rows: [{ payload: { text: 'x' }, pushed_at: now() }] }])),
})

maybe('tab-dot blink on unseen stream rows', () => {
  let server: { url: string; close: () => void }
  beforeAll(async () => { server = await serveStatic(STATIC_ROOT) })
  afterAll(() => server?.close())

  it('a live push to a background stream tab pulses its dot; opening the tab clears it', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      await page.evaluate(deliver(stateMsg([plainTab('active1'), streamTab('bg1', 'f1')])))
      // No blink before any push, and none for a snapshot resync.
      await page.evaluate(deliver(dataMsg(['f1'], true)))
      expect(await page.evaluate<number>(`document.querySelectorAll('.tab-dot--blink').length`)).toBe(0)
      // A live push blinks the background tab's dot.
      await page.evaluate(deliver(dataMsg(['f1'])))
      expect(await page.evaluate<number>(`document.querySelectorAll('.tab-dot--blink').length`)).toBe(1)
      // Opening the tab clears it.
      await page.evaluate(`document.querySelector('[data-tab="bg1"]').click()`)
      expect(await page.evaluate<number>(`document.querySelectorAll('.tab-dot--blink').length`)).toBe(0)
    } finally {
      await page?.close()
    }
  })

  it('a push for the ACTIVE tab does not blink', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      await page.evaluate(deliver(stateMsg([streamTab('active1', 'f1'), plainTab('bg1')])))
      await page.evaluate(deliver(dataMsg(['f1'])))
      expect(await page.evaluate<number>(`document.querySelectorAll('.tab-dot--blink').length`)).toBe(0)
    } finally {
      await page?.close()
    }
  })
})
