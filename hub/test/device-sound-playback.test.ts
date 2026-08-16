import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { resolve } from 'node:path'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'

/**
 * Device-web sound-family playback: a critical alarm and an audition PLAY_SOUND use a decoded
 * family file (`/sounds/<family>/<event>.wav`) instead of always beeping, but the oscillator
 * (`beep`) MUST remain the fallback for every way a file can fail to
 * reach the speaker — a family with no file on disk (a hand-edited/bogus DB row), a device that
 * predates the family, or a shell that owns the audio surface and must suppress the page entirely.
 *
 * Real files, real fetch, real decode: this uses the same headless-Chrome harness
 * device-alarm-guard.test.ts introduced (jsdom cannot run WebAudio at all), pointed at the hub's
 * actual `hub/static/sounds/**` fixtures rather than mocks, so a change to the file layout or a
 * broken `soundUrl()` would fail this test the same way it would fail on real hardware.
 */

const STATIC_ROOT = resolve('static')
const maybe = hasBrowser() ? describe : describe.skip
const deliver = (msg: object) => `__dashboardzDeliver(${JSON.stringify(JSON.stringify(msg))})`
const now = () => Date.now()

// Wraps both node types device.js can start: createOscillator (the `beep()` fallback path) and
// createBufferSource (the decoded-file path, `playBuffer`) — two independent counters make "which
// path actually fired" an assertion instead of a guess from timing alone.
const INIT = `
window.__oscStarts = 0
window.__bufStarts = 0
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
  const realCreateBuf = ctx.createBufferSource.bind(ctx)
  ctx.createBufferSource = () => {
    const src = realCreateBuf()
    const realStart = src.start.bind(src)
    src.start = (...a) => { window.__bufStarts++; return realStart(...a) }
    return src
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
// `sounds` carries all four events (resolveSounds always resolves the full set) even though
// only `critical` is exercised here — matches the real WireScreen shape a hub STATE would send.
const screenWithFamily = (id: string, family: string) => ({
  id, name: id, orientation: 'landscape', theme: null, grid: { tab_bar: 'bottom', cells: [] },
  sounds: { critical: family, warn: family, info: family, offline: family }, sounds_rev: 1,
})

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

maybe('device-web sound-family playback and oscillator fallback', () => {
  let server: { url: string; close: () => void }
  beforeAll(async () => { server = await serveStatic(STATIC_ROOT) })
  afterAll(() => server?.close())

  it('a resolved family (bells) plays the decoded file, not the oscillator', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // Warm the prefetch with an alert-free STATE first, and wait for the real localhost
      // fetch+decode to land — exactly the "screen assigned well before an alert fires" case
      // prefetch exists for (comment above `prefetchSounds`: a tab switch or the alarm's own
      // first beep must not stall on the network). This isolates the assertion from the OTHER,
      // also-real case (a critical arriving before the prefetch settles) covered by its own
      // timing note below.
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [])))
      await settle(page, 500)
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [critical('a1')])))
      await settle(page, 200) // just past the alarm's immediate first tick
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBeGreaterThan(0)
      expect(oscStarts).toBe(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('a bogus family (no file on disk) degrades to the oscillator, never silence', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // 'nope' resolves to a 404 (hand-edited DB row bypassing the API's family validation) —
      // loadSound must leave the cache entry 'failed' and the alarm must still beep. Warmed the
      // same way as the healthy-family case above, so this isolates "the fetch failed" from "the
      // fetch hadn't finished yet".
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'nope')], [])))
      await settle(page, 500)
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'nope')], [critical('a1')])))
      await settle(page, 200)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(0)
      expect(oscStarts).toBeGreaterThan(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('a failed fetch is retried by the next prefetch, not memoised forever', async () => {
    let page: Page | undefined
    let server2: { url: string; close: () => void } | undefined
    try {
      // A dedicated server for this test: the route below must 500 exactly once (the family's
      // first-ever fetch) and then serve the real fixture for every request after — proving
      // `loadSound` drops its failure from `soundLoads` rather than memoising a
      // 'failed' placeholder for the life of the page.
      let hits = 0
      const { readFileSync } = await import('node:fs')
      const fixture = readFileSync(resolve('static/sounds/bells/critical.wav'))
      server2 = await serveStatic(STATIC_ROOT, {
        '/sounds/bells/critical.wav': (_req, res) => {
          hits++
          if (hits === 1) { res.writeHead(500).end(); return }
          res.writeHead(200, { 'content-type': 'audio/wav' }).end(fixture)
        },
      })
      page = await openPage(`${server2.url}/device/`, 853, 384, INIT)
      // First STATE: prefetch's fetch 500s, so the alarm's first tick (started by the SAME
      // STATE's critical alert) must still beep — same contract as the "bogus family" case above.
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [critical('a1')])))
      await settle(page, 300)
      const oscAfterFailure = await page.evaluate<number>('window.__oscStarts')
      expect(oscAfterFailure).toBeGreaterThan(0)
      const bufAfterFailure = await page.evaluate<number>('window.__bufStarts')
      expect(bufAfterFailure).toBe(0)
      // Second STATE (same family/event/rev): prefetchSounds runs again. If the failed fetch were
      // still memoised in soundLoads this would early-return through the same settled promise and
      // never hit the server again — `hits` staying at 1 would prove the bug. It must retry, this
      // time succeeding, so the alarm's next tick plays the decoded buffer instead of beeping.
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [critical('a1')])))
      await settle(page, 2000) // clears the 1.5s alarm cadence, past the retried fetch+decode
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      expect(bufStarts).toBeGreaterThan(0)
      expect(hits).toBeGreaterThanOrEqual(2)
    } finally {
      await page?.close()
      server2?.close()
    }
  }, 60_000)

  it('a critical alert racing an unfinished prefetch still beeps its first tick, never silence', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // No warm-up: STATE and the critical alert land together, so the alarm's immediate first
      // tick is synchronous with `startAlarm()` while `loadSound`'s fetch is still in flight —
      // `soundFor` must see the placeholder 'failed' entry and fall back, exactly like a real
      // failure, rather than throwing or leaving the tick silent.
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [critical('a1')])))
      await settle(page, 50) // before any real fetch could possibly resolve
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(oscStarts).toBeGreaterThan(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('PLAY_SOUND plays a decoded family file once, quietly, no alarm/takeover involved', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // No alert at all — PLAY_SOUND (alert-sound contract audition) is independent of the takeover/alarm path.
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [])))
      await page.evaluate(deliver({ type: 'PLAY_SOUND', family: 'bells', event: 'critical' }))
      await settle(page, 500)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(1)
      expect(oscStarts).toBe(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('PLAY_SOUND with family "classic" beeps once (no file lookup)', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [])))
      await page.evaluate(deliver({ type: 'PLAY_SOUND', family: 'classic', event: 'critical' }))
      await settle(page, 300)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(0)
      expect(oscStarts).toBe(1)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('PLAY_SOUND is silent (neither path) once a driven host claims audio ownership', async () => {
    let page: Page | undefined
    try {
      // The gate is `driven() && hostOwnsTakeover()`. A hosted page under an Android shell that
      // has explicitly claimed the takeover/alarm surface must not also sound an audition push —
      // the same double-beep the takeover overlay's own suppression exists to prevent.
      page = await openPage(`${server.url}/device/`, 853, 384,
        `${INIT}\nwindow.__dashboardzHost.ownsTakeover = () => true`)
      await page.evaluate(deliver(stateMsg([screenWithFamily('tab1', 'bells')], [])))
      await page.evaluate(deliver({ type: 'PLAY_SOUND', family: 'bells', event: 'critical' }))
      await settle(page, 500)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(0)
      expect(oscStarts).toBe(0)
    } finally {
      await page?.close()
    }
  }, 60_000)
})

/**
 * screen state (activity tick, stream-activity contract): a DATA push whose feeds hit an opted-in `chime_activity` cell on
 * ANY tab (stream-activity contract's deliberate any-tab extension of alert-sound contract's visible-tab-only chime rule) plays a soft
 * tick — the carrying screen's resolved `sounds.activity` family, buffer or oscillator-blip
 * fallback exactly like every other event. `snapshot: true` (reconnect resync) never ticks, a
 * push that touches no opted-in feed never ticks, a device-side 2.5s cooldown drops (not defers)
 * a second qualifying push, and the same native-ownership gate PLAY_SOUND/the takeover use
 * suppresses it under a driven host that owns the audio surface.
 */
maybe('device-web activity tick (screen state)', () => {
  let server: { url: string; close: () => void }
  beforeAll(async () => { server = await serveStatic(STATIC_ROOT) })
  afterAll(() => server?.close())

  // A screen with a `stream_list` cell opted into `chime_activity` for `feedId`, and a full
  // five-event resolved `sounds` map (resolveSounds always resolves the full set, now
  // including `activity` — stream-activity contract). `chimeActivity` defaults true so callers only override it for
  // the "not opted in" case.
  const screenWithActivity = (
    id: string, family: string, feedId: string, chimeActivity = true,
  ) => ({
    id, name: id, orientation: 'landscape', theme: null,
    grid: {
      tab_bar: 'bottom',
      cells: [{ widget: 'stream_list', config: { feed: feedId, chime_activity: chimeActivity } }],
    },
    sounds: { critical: family, warn: family, info: family, offline: family, activity: family },
    sounds_rev: 1,
  })
  // A plain screen with no cells at all — stands in for an unrelated tab in the "any tab" cases.
  const plainScreen = (id: string, family: string) => ({
    id, name: id, orientation: 'landscape', theme: null, grid: { tab_bar: 'bottom', cells: [] },
    sounds: { critical: family, warn: family, info: family, offline: family, activity: family },
    sounds_rev: 1,
  })
  const dataMsg = (feedIds: string[], snapshot = false) => ({
    type: 'DATA', server_time: now(),
    feeds: Object.fromEntries(feedIds.map((id) => [id, {
      mode: 'stream', rows: [], pushed_at: now(), stale_after_s: null,
    }])),
    ...(snapshot ? { snapshot: true } : {}),
  })

  it('a qualifying non-snapshot push on a BACKGROUND (non-active) tab still ticks — any tab subscribes (stream-activity contract)', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // Two tabs: 'tab1' (resolves active, per resolveActiveTab's "first tab" default — no stored
      // active_tab yet) carries nothing, 'tab2' carries the opted-in cell. The push must still
      // tick even though the carrying screen is never the one on screen.
      await page.evaluate(deliver(stateMsg(
        [plainScreen('tab1', 'bells'), screenWithActivity('tab2', 'bells', 'feed1')], [])))
      await settle(page, 500) // let prefetch decode activity.wav for both tabs
      await page.evaluate(deliver(dataMsg(['feed1'])))
      await settle(page, 300)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      // Either path proves it ticked; the prefetch warm-up above makes the buffer path the
      // expected one, but the blip fallback is an equally valid pass (never silence).
      expect(bufStarts + oscStarts).toBeGreaterThan(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('snapshot: true stays silent even though the feed is opted in', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      await page.evaluate(deliver(stateMsg([screenWithActivity('tab1', 'bells', 'feed1')], [])))
      await settle(page, 500)
      await page.evaluate(deliver(dataMsg(['feed1'], true)))
      await settle(page, 300)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(0)
      expect(oscStarts).toBe(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('a second qualifying push inside the 2.5s cooldown is dropped, not deferred', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      await page.evaluate(deliver(stateMsg([screenWithActivity('tab1', 'bells', 'feed1')], [])))
      await settle(page, 500)
      await page.evaluate(deliver(dataMsg(['feed1'])))
      await settle(page, 200)
      const afterFirst = await page.evaluate<number>('window.__bufStarts + window.__oscStarts')
      expect(afterFirst).toBe(1)
      // Back-to-back (real page clock, well inside 2.5s) — must NOT add a second tick.
      await page.evaluate(deliver(dataMsg(['feed1'])))
      await settle(page, 200)
      const afterSecond = await page.evaluate<number>('window.__bufStarts + window.__oscStarts')
      expect(afterSecond).toBe(1)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('the hosted-ownership gate suppresses the tick, same as PLAY_SOUND/the takeover', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384,
        `${INIT}\nwindow.__dashboardzHost.ownsTakeover = () => true`)
      await page.evaluate(deliver(stateMsg([screenWithActivity('tab1', 'bells', 'feed1')], [])))
      await settle(page, 500)
      await page.evaluate(deliver(dataMsg(['feed1'])))
      await settle(page, 300)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(0)
      expect(oscStarts).toBe(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('a push touching no opted-in feed stays silent', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // 'feed1' is NOT opted in (chime_activity: false) — the same feed id a carrying cell could
      // reference, proving the opt-in flag itself gates the tick, not just feed presence.
      await page.evaluate(deliver(stateMsg(
        [screenWithActivity('tab1', 'bells', 'feed1', false)], [])))
      await settle(page, 500)
      await page.evaluate(deliver(dataMsg(['feed1'])))
      await settle(page, 300)
      const bufStarts = await page.evaluate<number>('window.__bufStarts')
      const oscStarts = await page.evaluate<number>('window.__oscStarts')
      expect(bufStarts).toBe(0)
      expect(oscStarts).toBe(0)
    } finally {
      await page?.close()
    }
  }, 60_000)

  it('a qualifying push while the critical alarm is sounding stays silent (same suppression as a chime)', async () => {
    let page: Page | undefined
    try {
      page = await openPage(`${server.url}/device/`, 853, 384, INIT)
      // A critical alert on the SAME STATE starts the alarm (startAlarm's own immediate first
      // tick fires synchronously) — settle just past that immediate tick but well inside its
      // 1.5s critical-alarm cadence, so any further buf/osc start in the narrow window that follows
      // can only be the activity push, not the alarm's own next beat.
      await page.evaluate(deliver(stateMsg(
        [screenWithActivity('tab1', 'bells', 'feed1')], [critical('a1')])))
      await settle(page, 200)
      const before = await page.evaluate<number>('window.__bufStarts + window.__oscStarts')
      await page.evaluate(deliver(dataMsg(['feed1'])))
      await settle(page, 300) // still short of the alarm's next 1.5s beat
      const after = await page.evaluate<number>('window.__bufStarts + window.__oscStarts')
      expect(after).toBe(before)
    } finally {
      await page?.close()
    }
  }, 60_000)
})
