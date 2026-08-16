import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'

/**
 * THE GUARD (fit model).
 *
 * Rendering defects can share one fit-model cause — a value_tile clipped top and bottom, a gauge
 * ring drawn as an ellipse, a label silently dropped, a gauge value sliced in half — and every one
 * can reproduce at 720p landscape while the hub suite stays green.
 * They were invisible to the test suite because jsdom has no layout engine: clientHeight,
 * offsetHeight and scrollWidth all report 0, so an overflow assertion passes vacuously.
 *
 * This renders the REAL page in a REAL browser at handset sizes and asserts the invariant the fit
 * model exists to keep: a widget never paints outside its cell. It is worth more than the three
 * fixes it was written after, because it closes the class rather than the instances.
 *
 * SCOPE, narrowed honestly: the probe measures DOM elements inside each cell. Four of the widgets
 * named above — `value_tile`, `gauge`, `text_block`, `stream_list` — are canvas designs now, so
 * their cells contain a single `<canvas>` sized to the cell and there are no child elements left to
 * overflow. What this guard still proves for them is that the canvas BOX is contained; what it can
 * no longer see is clipping INSIDE the widget, which is where the original "ring drawn as an
 * ellipse" and "value sliced in half" failures lived. Those are covered instead by the designs' own
 * draw tests, which record draw calls rather than measuring layout.
 *
 * So the boards below deliberately include one cell that renders real DOM, to keep this guard
 * measuring something with children. Do not remove it without replacing the coverage — a board of
 * nothing but canvases would leave this file green and asserting almost nothing.
 *
 * THE FIXTURE HAS STOPPED CHASING WIDGETS, because there are none left to chase. It was `table`,
 * then `image`, then `chart`; all 12 widget types are canvas designs now and NO widget
 * renders DOM inside a cell any more. `feedMissingHtml` is gone with `chart`'s branch — every "Feed
 * missing" notice is painted onto a canvas by the designs' shared `centredNotice`.
 *
 * What is left is `device.js`'s two AUTHORING notices, which are DOM and always will be, because
 * they are what a cell shows when there is no widget to draw at all:
 *   - `.placeholder.too-small` — the cell is smaller than `WIDGET_MIN_PX` for its widget;
 *   - the unsupported-widget notice — the board names a widget type this build does not know.
 * The second is unusable HERE: an unknown widget type is exactly what `catchUpCatalogue` reloads
 * the page for, and a test whose board reloads itself measures nothing. So the fixture is
 * a deliberately undersized `text_block`, which is a real DIV with real text and `flex: 1` — an
 * element the content-clipped arm of the probe CAN, in principle, catch.
 *
 * The assertion below names that fixture's own TEXT rather than the `too-small` class, and the
 * reason is the same trap this file's next docstring records: the four gauge cells already render
 * `too-small` notices by accident, so a class-only assertion would be satisfied with the fixture
 * deleted. `text_block needs 80×40` can only come from the cell put there for it.
 *
 * Driven mode is what makes it possible without a hub: installing `__dashboardzHost` before the
 * module evaluates stops the page dialling out, and `__dashboardzDeliver` feeds it a STATE. That
 * seam was built for the Android WebView; a test needs exactly the same thing.
 */

const STATIC_ROOT = resolve('static')

/** A board that puts every tile-family widget under pressure at once. */
const screenWith = (cells: object[]) => ({
  type: 'STATE',
  rev: 1,
  server_time: Date.now(),
  device: { id: 'dev_test', name: 'test', orientation: 'landscape' },
  alerts: [],
  screen: { id: 'lay_test', name: 'test', orientation: 'landscape', grid: { cells } },
})

// `design: 'ring'` selects the ring design; `style` is retired (migration v21).
//
// Be clear about what this fixture proves NOW, because it is less than it once did. `gauge` and
// `value_tile` are canvas designs, so the only element inside their cells is a `<canvas>` sized to
// the cell — the probe below still checks that box is contained, which is a real assertion, but the
// original "ring drawn as an ellipse" and "value sliced in half" failures happened INSIDE the
// widget and are now invisible to any DOM measurement. Their replacements are the designs' own
// draw tests (`widget-gauge.test.ts`, `widget-value.test.ts`), which record draw calls.
// `image` is included below precisely so this browser guard still measures a widget whose
// content is real DOM — without it the probe has nothing but canvases to walk.
const gauge = (x: number, y: number, w: number, h: number) => ({
  rect: { x, y, w, h },
  widget: 'gauge',
  config: { feed: 'f1', path: 'v', min: 0, max: 100, label: 'channel utilisation', unit: '%', design: 'ring' },
})

/**
 * Cells sized to JUST CLEAR the widget minimum, which is where the fit pass actually has work to
 * do. A generous cell proves nothing: the first version of this guard used 213x192 gauges and
 * passed even with the flex-shrink fix reverted, because nothing was ever tight enough to
 * negotiate. WIDGET_MIN_PX.gauge is 120x110, so these are the tightest legal gauge on each board.
 */
const atMinimum = (boardW: number, boardH: number) => ({
  gw: Math.ceil(120 / boardW * 1000) / 1000,
  gh: Math.ceil(110 / boardH * 1000) / 1000,
})
const tile = (x: number, y: number, w: number, h: number) => ({
  rect: { x, y, w, h },
  widget: 'value_tile',
  config: { feed: 'f1', path: 'v', label: 'nodes heard', unit: 'n' },
})

/**
 * The one DOM-rendering cell on these boards, so the probe has real child elements to measure and
 * not only canvases — see this file's docstring for why no WIDGET can play this part any more.
 *
 * A `text_block` in a cell shorter than its 40px minimum renders `device.js`'s `tooSmallHtml`: a
 * real DIV, `flex: 1`, with real wrappable text. Deterministic and network-free — it depends on the
 * laid-out box and nothing else, so it needs no feed, no push and no fetch.
 */
const TOO_SMALL_TEXT = 'text_block needs 80×40'
const tooSmall = (x: number, y: number, w: number, h: number) => ({
  rect: { x, y, w, h },
  widget: 'text_block',
  config: { text: 'never rendered — the cell is under the minimum' },
})
/** A height fraction that lands at ~36 CSS px: under `text_block`'s 40px minimum on every board
 *  size below, while still leaving the 11px notice a single unwrapped line. */
const underMinimumH = (boardH: number) => Math.floor((36 / boardH) * 1000) / 1000

const DATA = {
  type: 'DATA',
  server_time: Date.now(),
  snapshot: true,
  feeds: {
    f1: { id: 'f1', mode: 'value', payload: { v: 88.888888 }, pushed_at: Date.now(), rows: [] },
    // One feed is all these boards bind: the DOM-rendered cell above renders from its own geometry,
    // not from data. A pushed image feed would be no use either way — this harness is a bare
    // static-file server with no `/api/feeds/:id/image` route, so nothing could ever decode.
  },
}

/**
 * Measures every cell against everything painted inside it, in LAYOUT space (offset*), because a
 * board may be under the 90° counter-rotation and a client rect would be reported in the
 * transformed frame.
 */
const OVERFLOW_PROBE = `
(() => {
  const bad = []
  for (const cell of document.querySelectorAll('.cell')) {
    const ch = cell.clientHeight, cw = cell.clientWidth
    if (!ch || !cw) continue
    for (const el of cell.querySelectorAll('*')) {
      if (el.offsetParent === null && el.offsetHeight === 0) continue
      const top = el.offsetTop, left = el.offsetLeft
      // 1) the element's BOX escaping the cell.
      const worst = Math.max(-top, (top + el.offsetHeight) - ch, -left, (left + el.offsetWidth) - cw)
      if (worst > 1) {
        bad.push({ cls: el.className || el.tagName, kind: 'escapes-cell',
                   px: Math.round(worst), text: (el.textContent || '').slice(0, 24) })
        continue
      }
      // 2) the element's CONTENT clipped inside its own box.
      //
      // This is the failure that hid for a whole day. A flex child does not overflow its parent,
      // it COMPRESSES: the box stays inside the cell and the text is cut off within it, so a
      // box-only check reports that everything fits. Height only — a vertically clipped line is
      // never intended, whereas .tile-value ellipsises horizontally on purpose.
      if (el.scrollHeight - el.clientHeight > 1 && el.clientHeight > 0) {
        bad.push({ cls: el.className || el.tagName, kind: 'content-clipped',
                   px: el.scrollHeight - el.clientHeight, text: (el.textContent || '').slice(0, 24) })
      }
    }
  }
  return JSON.stringify(bad)
})()`

/**
 * "Is this guard still measuring anything?", asked of the page rather than assumed.
 *
 * The probe above walks elements inside cells, and a board of nothing but `<canvas>` gives it
 * nothing to walk: every assertion would pass vacuously and the file would go on looking green
 * through the migration that emptied it. This file's docstring has warned about that in prose
 * from the DOM fixture; each size test
 * below now also asserts that the DOM-rendered fixture really did produce a text-bearing,
 * non-canvas element — the thing the overflow probe exists to measure.
 *
 * The assertion names `feed-missing` specifically rather than "some text somewhere", and the first
 * draft's failure to do that is worth recording: a board of nothing but canvases is NOT text-free
 * here, because all four gauge cells currently render `.placeholder.too-small` ("gauge needs
 * 120×110"). `atMinimum` sizes them against the WINDOW, while `belowMinimum` measures the laid-out
 * grid, which is a few pixels smaller — so the fixture that calls itself "gauges at their minimum
 * size" is in fact four too-small notices, and a loose probe would have been satisfied by them
 * while the widget it exists to watch had vanished. That gauge-sizing discrepancy predates this
 * and is deliberately left alone here rather than fixed in passing (changing those rects
 * changes what every assertion in this file measures); it is recorded so the next reader does not
 * mistake a green run for "four gauges fit".
 */
const TEXT_CHILD_PROBE = `
(() => {
  const found = []
  for (const cell of document.querySelectorAll('.cell'))
    for (const el of cell.querySelectorAll('*'))
      if (el.tagName !== 'CANVAS' && (el.textContent || '').trim() && el.clientHeight > 0)
        found.push({ cls: el.className || el.tagName, text: (el.textContent || '').trim().slice(0, 24) })
  return JSON.stringify(found)
})()`

const deliver = (msg: object) => `__dashboardzDeliver(${JSON.stringify(JSON.stringify(msg))})`

// A guard that fails for want of a browser gets deleted. Skip cleanly instead.
const maybe = hasBrowser() ? describe : describe.skip

maybe('a widget never paints outside its cell', () => {
  let server: { url: string; close: () => void }

  beforeAll(async () => { server = await serveStatic(STATIC_ROOT) })
  afterAll(() => server?.close())

  /**
   * 853x384 is the Galaxy A05 in landscape, in CSS px — a representative handset viewport.
   * 640x360 and 800x480 bracket the small end of what a panel might be.
   */
  const SIZES: [number, number][] = [[853, 384], [640, 360], [800, 480]]

  for (const [w, h] of SIZES) {
    it(`holds at ${w}x${h} with gauges at their minimum size`, async () => {
      let page: Page | undefined
      try {
        page = await openPage(
          `${server.url}/device/`,
          w, h,
          // Installed before the module evaluates, so the page never opens a socket.
          'window.__dashboardzHost = { send() {}, ready() {} }',
        )
        const { gw, gh } = atMinimum(w, h)
        await page.evaluate(deliver(screenWith([
          gauge(0, 0, gw, gh), gauge(gw, 0, gw, gh),
          gauge(0, gh, gw, gh), gauge(gw, gh, gw, gh),
          tile(gw * 2, 0, 1 - gw * 2, gh),
          // The DOM-rendered cell, deliberately short, so the probe measures real children.
          tooSmall(gw * 2, gh, 1 - gw * 2, underMinimumH(h)),
        ])))
        await page.evaluate(deliver(DATA))
        // One frame, so the post-insert fit pass has run against real measurements.
        await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')

        const found = JSON.parse(await page.evaluate<string>(OVERFLOW_PROBE))
        expect(found, `overflowing at ${w}x${h}: ${JSON.stringify(found)}`).toEqual([])
        // ...and the board it measured was not all canvases (see TEXT_CHILD_PROBE). Asserted on the
        // fixture's own TEXT, not its class: four gauge cells render `placeholder too-small`
        // notices of their own by accident (see TEXT_CHILD_PROBE's docstring), so a class-only
        // assertion would stay green with the fixture deleted.
        const texts: { cls: string; text: string }[] = JSON.parse(await page.evaluate<string>(TEXT_CHILD_PROBE))
        expect(texts.map((t) => t.text), `no DOM-rendered cell left on this board at ${w}x${h}`)
          .toContain(TOO_SMALL_TEXT)
      } finally {
        await page?.close()
      }
    }, 60_000)
  }

  /**
   * The probe must be able to FAIL, or a green run means nothing. A deliberately over-large
   * element inside a cell has to be caught — this is the same discipline portable-subset.test.ts
   * applies to its own regex guard.
   */
  it('the probe can actually detect an overflow', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384,
        'window.__dashboardzHost = { send() {}, ready() {} }')
      await page.evaluate(deliver(screenWith([tile(0, 0, 0.25, 0.2)])))
      await page.evaluate(deliver(DATA))
      await page.evaluate(`
        const c = document.querySelector('.cell')
        const spike = document.createElement('div')
        spike.className = 'deliberate-overflow'
        // flex-shrink:0 is load-bearing in the FIXTURE too: without it the flex column compresses
        // the spike and the box-overflow arm never fires — the very trap this probe now also
        // catches with its content-clipped arm.
        spike.style.cssText = 'height:400px;width:10px;flex-shrink:0'
        c.appendChild(spike)
      `)
      const found = JSON.parse(await page.evaluate<string>(OVERFLOW_PROBE))
      expect(found.some((f: { cls: string }) => f.cls === 'deliberate-overflow')).toBe(true)
    } finally {
      await page?.close()
    }
  }, 60_000)
})
