import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { resolve } from 'node:path'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'

/**
 * Regression guard for a real bug: a critical alert's alarm (device.js's `beep(2,880)` on a 1.5s
 * `setInterval`) kept beeping forever after the operator HOLD-dismissed the takeover, stopping only
 * once they switched to a different board tab.
 *
 * Root cause: render()'s own comment already promises "the takeover block below runs
 * unconditionally" — independent of whether the idle body (renderGrid, or the default cards/chips
 * layout) succeeds. It didn't: an exception ANYWHERE in that idle-body rendering (a malformed cell,
 * any bug in widgetHtml/renderGrid) propagated straight out of render(), skipping the takeover/alarm
 * block that decides `startAlarm()`/`stopAlarm()`. Once a screen's idle body starts throwing, EVERY
 * render on it keeps throwing the same way — including the render that processes the dismiss's
 * ALERT_REMOVE, which had already correctly removed the alert from `alerts` before calling render(),
 * but never got to act on that. The takeover stayed stuck showing whatever it last painted and the
 * alarm — started by an earlier, successful render — never reached a code path that could stop it
 * again. Switching to a different tab (a different, working screenDef) is the only thing that let a
 * render() reach the takeover block again, which matches the exact "switching tabs stops it" symptom
 * this bug was reported with.
 *
 * The fix wraps the idle-body branch in render() (device.js) in a try/catch, the same way
 * paintWidgets (widgets/index.mjs) already guards its own per-cell paint call for the identical
 * reason ("a design bug in one clock cell must not be able to hide a critical alert") — this closes
 * the sibling gap around renderGrid/widgetHtml/the default layout that guard never covered.
 *
 * Driven mode (the same seam board-overflow.test.ts uses) stands in for the hub: `__dashboardzHost`
 * plus `__dashboardzDeliver` let this feed STATE/ALERT_REMOVE messages directly, and an AudioContext
 * wrapper counts real oscillator `.start()` calls as a faithful, hardware-free proxy for "is the
 * alarm still audible".
 */

const STATIC_ROOT = resolve('static')
const maybe = hasBrowser() ? describe : describe.skip
const deliver = (msg: object) => `__dashboardzDeliver(${JSON.stringify(JSON.stringify(msg))})`
const now = () => Date.now()

const INIT = `
window.__oscStarts = 0
const RealCtx = window.AudioContext || window.webkitAudioContext
function Wrapped(...args) {
  const ctx = new RealCtx(...args)
  const realCreateOsc = ctx.createOscillator.bind(ctx)
  ctx.createOscillator = () => {
    const osc = realCreateOsc()
    const realStart = osc.start.bind(osc)
    osc.start = (...a) => { window.__oscStarts++; return realStart(...a) }
    return osc
  }
  return ctx
}
window.AudioContext = Wrapped
window.webkitAudioContext = Wrapped
window.__dashboardzHost = { send() {}, ready() {} }
`

function critical(id: string, updated_at = now()) {
  return {
    id, title: `Critical ${id}`, body: 'x', severity: 'critical',
    sender: { id: 'sender1', name: 'Sender' }, sound: true,
    created_at: updated_at, updated_at, update_count: 0, expires_at: null,
    silenced: false, options: null,
  }
}
const goodScreen = (id: string) =>
  ({ id, name: id, orientation: 'landscape', theme: null, grid: { tab_bar: 'bottom', cells: [] } })
// A `null` cell entry makes widgetHtml's `boxes.map(c => safeRect(c.rect))` throw inside renderGrid
// — a stand-in for any malformed-cell/renderGrid bug, chosen because it is the smallest input that
// reaches the unguarded path.
const brokenScreen = (id: string) =>
  ({ id, name: id, orientation: 'landscape', theme: null, grid: { tab_bar: 'bottom', cells: [null] } })

function stateMsg(screens: object[], alerts: object[]) {
  return {
    type: 'STATE', rev: 1, server_time: now(),
    device: { id: 'dev_test', name: 'test', orientation: 'landscape' },
    alerts, screens, tab_status: {},
  }
}
async function settle(page: Page, ms: number) {
  await page.evaluate(`new Promise(r => setTimeout(r, ${ms}))`)
}

maybe('alarm stops on dismiss even when the idle body throws', () => {
  let server: { url: string; close: () => void }
  beforeAll(async () => { server = await serveStatic(STATIC_ROOT) })
  afterAll(() => server?.close())

  it('a broken screen must not trap the takeover/alarm block behind renderGrid', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)

      // A critical arrives on a working screen: takeover shows, alarm starts normally.
      await page.evaluate(deliver(stateMsg([goodScreen('tab1'), goodScreen('tab2')], [critical('a1')])))
      await settle(page, 1700) // > one 1.5s beep interval
      const startedCount = await page.evaluate<number>('window.__oscStarts')
      expect(startedCount).toBeGreaterThan(0)

      // The active screen's grid becomes malformed (still the same active alert) — every render on
      // this tab now throws inside renderGrid.
      await page.evaluate(deliver(stateMsg([brokenScreen('tab1'), goodScreen('tab2')], [critical('a1')])))

      // Dismiss the alert. `alerts` is updated before render() runs regardless of what render()
      // then does, so this must be enough on its own — no tab switch, no further messages.
      await page.evaluate(deliver({ type: 'ALERT_REMOVE', id: 'a1', reason: 'dismissed' }))
      await settle(page, 3200) // > two more beep intervals if the alarm were still running

      const finalCount = await page.evaluate<number>('window.__oscStarts')
      const takeoverDisplay = await page.evaluate<string>(`document.getElementById('takeover').style.display`)

      expect(takeoverDisplay).toBe('none')
      expect(finalCount).toBe(startedCount)
    } finally {
      await page?.close()
    }
  }, 60_000)
})
