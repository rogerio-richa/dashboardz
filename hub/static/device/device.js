import { reduce, viewModel, tabsFromState, resolveActiveTab, tabBarModel, tabsWithStreamRows, yieldTakeoverToHost, tabScrollState, pageOffset, offsetToShow, tabBarSignature } from './device-core.mjs'
import {
  stateAck,
  // Free layout: each card carries its own {x,y,w,h} rect
  // and its own continuous size scalar `t` — there is no more board-wide template/fraction.
  rectToPx, safeRect, sizeT, belowMinimum, WIDGET_MIN_PX,
} from './layout-core.mjs'
import { bitmapDeps, canvasHtml, cardContentInset, designFor, designsNeedingReload, loadCellBitmaps, noteReloadAttempts, unknownDesigns, unknownWidgetTypes, paintWidgets, stopAllWidgets } from './widgets/index.mjs'
import { WIDGET_DEFINITIONS } from './widgets/definitions.mjs'
import { designMinimum } from './widgets/catalogue.mjs'
import { onAssetReady } from './widgets/assets.mjs'
import { onBitmapReady } from './widgets/bitmaps.mjs'
import { boardRepaintPeriod, repaintPlan } from './widgets/repaint.mjs'
import { applyBoardToCss, applyChromeToCss, backdropCss, currentBackdrop, currentBg, currentThemeId, currentBoard, currentChrome, currentWidgets, derivedChrome, noteThemeRef } from './theme.mjs'
import { applyRotation, tryNativeLock } from './orientation.mjs'

const $ = (id) => document.getElementById(id)
let alerts = []
let silenced = new Set()
let serverOffset = 0
let ws = null
let backoff = 1000
let alarm = null
let audioCtx = null
let displayedAckId = null
let screenDef = null
// Tab state (tabs). `tabScreens` is the full ordered list from the last STATE (`tabsFromState`
// — `[]` on a pre-tabs or no-screen device); `activeTabId` is which one is on screen right now,
// either from the last STATE's resolution or a client-local switch (below); `tabStatus` is the
// per-screen severity dot map, refreshed independently by TAB_STATUS so a dot lighting up never
// waits for a full STATE round trip. `screenDef` (above) is always `tabScreens.find(id===activeTabId)`
// — the single source renderGrid/render already read before tabs existed.
let tabScreens = []
let tabStatus = {}
let activeTabId = null
// Background tabs with stream rows the operator hasn't looked at yet — pulses those tabs' dots
// (tabBarModel's `blink`). Client-local and deliberately forgotten on reload: it is an attention
// cue, not an inbox. Populated on live DATA pushes, cleared by switchTab, pruned on STATE.
let unseenActivity = new Set()
// The orientation the hub configured for THIS device (STATE's device.orientation). Held at module
// scope because `resize` has to re-decide without waiting for another STATE.
let wantedOrientation = null
// Link state as reported by a host shell (__dashboardzLink). Only consulted in driven mode.
let hostOnline = true
// Feed wire-form map (DATA delivery). Memory-only, never cleared on socket close — a
// reconnect snapshot replaces entries; keeping the map avoids a blank flash (never blank a board).
let feeds = {}
// The image widget's four module-level caches (object URLs keyed `feedId:image_rev`, the current
// key per feed, the in-flight set, and the failure/backoff map) lived here until `image` became a
// canvas design. Every rule they carried survives in `widgets/bitmaps.mjs` — one live bitmap per
// feed, revoke the previous on a new rev, keep the last good one when a fetch fails, a flat 30s
// per-FEED backoff (so a new rev retries immediately), and never fetch at `image_rev` 0 — where it
// is driven by injected deps and therefore actually testable with no DOM. This page's remaining
// share of that work is the two lines that name the real primitives (`bitmapDeps`, below) and kick
// the load per board (`loadCellBitmaps`, in renderGrid).

/**
 * What this client draws into, right now.
 *
 * Last-known rather than a fixed property: a browser window resizes freely and a handset rotates,
 * so the hub stores whatever the most recent HELLO reported. innerWidth/innerHeight, not `screen`:
 * the board lives in the viewport, and the browser chrome is not ours to draw in.
 */
const viewport = () => ({
  w: Math.round(globalThis.innerWidth || 0),
  h: Math.round(globalThis.innerHeight || 0),
  dpr: globalThis.devicePixelRatio || 1,
})

// --- transport seam (fit model) ---
/**
 * On its own the page owns its socket. Inside the Android shell it is DRIVEN: the native side owns
 * the connection and this page must never dial out.
 *
 * That is not a preference, it is a hard constraint (native takeover boundary). `registry.ts` closes the existing socket
 * whenever a second arrives for the same device id — `close(4000, 'replaced')` — so two sockets
 * under one device token ping-pong forever. A real storm was measured at 40 connect/disconnect
 * pairs a minute, each socket alive 16-20ms.
 *
 * The shell installs `__dashboardzHost` BEFORE this module runs, then feeds messages in through
 * `__dashboardzDeliver` and reports link state through `__dashboardzLink`.
 */
const host = () => globalThis.__dashboardzHost
const driven = () => !!host()

/** Paired enough to render a board: a token of our own, or a shell that has one on our behalf. */
const paired = () => driven() || !!token()

/**
 * Whether the current host explicitly claims the takeover/alarm surface. `typeof ... ===
 * 'function'` before calling it, same defensive shape as `token()`
 * above: an older shell's bridge simply has no `ownsTakeover` at all, and that absence must read
 * as false, not throw. try/catch for the same reason every other bridge call on this page is
 * guarded — a page is talking across a JS-to-Kotlin boundary it does not control.
 */
const hostOwnsTakeover = () => {
  const h = host()
  if (!h) return false
  try { return typeof h.ownsTakeover === 'function' && h.ownsTakeover() } catch { return false }
}

/**
 * One way out for every message. Guarded on readyState, which the raw `ws.send` calls it replaces
 * were not: sending on a socket closed mid-reconnect throws, and a TAP is exactly the thing an
 * operator does while the link is flapping.
 */
function send(obj) {
  const h = host()
  if (h) {
    try { h.send(JSON.stringify(obj)) } catch (err) { console.error('bridge send failed', err) }
    return
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

// --- pairing ---
/**
 * Null-safe on purpose. A hosted board has no token of its own — the shell pairs on its behalf —
 * and a WebView has no localStorage at all unless the host turns DOM storage on. Reading it
 * unguarded threw once per render tick inside the Android shell, which is a loud failure for a
 * value a driven page never needed.
 */
const token = () => {
  try {
    // A DRIVEN page holds no token — the shell paired on its behalf and owns the socket. It still
    // needs one for its own authenticated GETs (the theme document, image feeds), so it asks the
    // host. Without this every such fetch sent `Bearer null` and 401'd: a WebView board could
    // never be themed and never showed an image, silently, because both paths degrade quietly by
    // design.
    const host = globalThis.__dashboardzHost
    if (host && typeof host.token === 'function') return host.token() || null
    return globalThis.localStorage?.getItem('device_token') ?? null
  } catch { return null }
}

// --- tab persistence ---
// Same null-safety as `token()` above and for the same reason: a driven WebView may have DOM
// storage off, and "which tab was last active" degrading to "the first tab" is a fine outcome —
// throwing on every STATE is not.
const readActiveTab = () => {
  try { return globalThis.localStorage?.getItem('active_tab') ?? null } catch { return null }
}
const writeActiveTab = (id) => {
  try { globalThis.localStorage?.setItem('active_tab', id) } catch { /* storage disabled */ }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const res = await fetch('/api/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: $('pair-code').value.toUpperCase() }),
  })
  if (!res.ok) { $('pair-error').textContent = 'Invalid or expired code'; return }
  const body = await res.json()
  localStorage.setItem('device_token', body.device_token)
  location.reload()
})

// --- websocket ---
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws/device`)
  ws.onopen = () => {
    backoff = 1000
    ws.send(JSON.stringify({
      type: 'HELLO', token: token(),
      // The box the board is actually drawn into. A screen is authored FOR a device, and
      // until the hub knows this the editor can only guess at the shape it is designing against.
      // CSS pixels, because layout, minimum sizes and type are all in CSS pixels.
      caps: { kind: 'browser', app_version: '0.1', viewport: viewport() },
    }))
  }
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data))
  ws.onclose = (ev) => {
    $('offline').style.display = 'block'
    if (ev.code === 4001) { localStorage.removeItem('device_token'); location.reload(); return }
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 60_000)
  }
}

/**
 * Everything the hub can say, whether it arrived over our own socket or was handed to us by the
 * shell. Deliberately identical either way — a driven page must render from the same code path,
 * or the two modes drift exactly the way the two RENDERERS did.
 */
function handleMessage(msg) {
    if (msg.type === 'STATE') {
      serverOffset = msg.server_time - Date.now()
      silenced = new Set(msg.alerts.filter((a) => a.silenced).map((a) => a.id))
      displayedAckId = null
      // Tabs: `tabsFromState` degrades to `[msg.screen]` (or `[]`) for a legacy single-screen
      // push, so a single-screen device keeps the same rendering path.
      // `resolveActiveTab` prefers the tab restored from localStorage when it is still one of
      // this STATE's tabs, else the first — same rule a fresh pairing (no stored id) resolves by.
      tabScreens = tabsFromState(msg)
      activeTabId = resolveActiveTab(tabScreens.map((s) => s.id), readActiveTab())
      screenDef = tabScreens.find((s) => s.id === activeTabId) ?? null
      // Unseen-activity ids for tabs that no longer exist (or that resolution just made active)
      // must not linger — same prune-don't-remember rule the chime id-set follows.
      unseenActivity = new Set([...unseenActivity].filter((id) =>
        id !== activeTabId && tabScreens.some((s) => s.id === id)))
      // A fresh connect (or reconnect) gets exactly one STATE, not a STATE followed by a
      // TAB_STATUS — `msg.tab_status` (present alongside `screens`) is the
      // ONLY source for dots already lit by an alert that was active before this socket opened.
      // The dedicated TAB_STATUS handler below only ever fires for a CHANGE after that.
      tabStatus = msg.tab_status ?? {}
      // Prefetch: decode every non-classic family/event across ALL tabs now, not lazily when the
      // alarm first ticks or a tab switch lands — a tab switch is "client-local"
      // precisely so it never waits on the network, and the alarm's own first beep must not
      // stall on a fetch either.
      prefetchSounds(tabScreens)
      alerts = reduce(alerts, msg)
      // Orientation before render: applyRotation resizes the grid, and every canvas cell measures
      // itself during render — doing this after would paint once at the wrong size.
      wantedOrientation = msg.device?.orientation ?? null
      applyOrientation()
      render()
      // STATE_ACK after applying (STATE acknowledgment). screen_id key is omitted for the
      // default layout — absent ⇔ null on the hub side, matching the Android encoder. screen_ids
      // is the full tab set this client is now holding (screen state's set-based ack) — always present,
      // even `[]`, so the hub can tell a tab-aware ack from a legacy single-screen one.
      // screen_id itself is tab 0, NOT the active tab (screenDef) — same rule the Kotlin shell's
      // `msg.screens?.firstOrNull()?.id` follows. A modern hub only reads screen_id when
      // screen_ids is absent (legacy compare), which only happens when an intermediary (an APK
      // shell re-encoding this message and stripping unknown keys)
      // drops screen_ids — and a legacy compare is always against tab 0, never the active tab.
      send(stateAck(msg.rev ?? 0, tabScreens[0]?.id ?? null, tabScreens.map((s) => s.id)))
      // Re-report the active tab on every STATE: the hub drops its
      // in-memory StatePusher entry — including activeScreenId — on socket close, but this board
      // only sends a TAB message on a tap. Without this, a reconnect (network blip, hub restart)
      // restores the tab from localStorage locally and keeps rendering it correctly, but the admin
      // silently loses track of which tab is active until the operator happens to tap again.
      // Guarded on tabScreens.length > 1: a single-tab (or zero-tab) device has no TAB concept —
      // the hub already knows "the" tab from screens[0], same as the ack above.
      if (tabScreens.length > 1 && activeTabId) send({ type: 'TAB', screen_id: activeTabId })
      // Theme fetch, fire-and-forget (same shape as the image-feed load renderGrid kicks off):
      // render() above already painted with whatever theme.mjs has cached (built-in defaults on
      // first load, or the last good theme), so the board is never blank while this is in flight. `themeFetchFn` is the device
      // auth seam theme.mjs deliberately does not attach itself — re-render once
      // it settles so a newly-fetched (or newly-failed-back-to-built-in) board actually paints.
      // `.catch`: noteThemeRef itself cannot reject (its own try/catch
      // covers the one await), but `render` is called here as a promise callback, so if IT throws
      // the exception becomes an unhandled promise rejection instead of the plain, immediately
      // visible synchronous throw every other `render()` call site in this file would produce —
      // logged and swallowed here rather than left silent, same as paintWidgets' own per-cell
      // catch (widgets/index.mjs) already does for the identical "one bad render must not take
      // anything else down with it" reason.
      noteThemeRef(screenDef?.theme ?? null, { fetchFn: themeFetchFn, now: () => Date.now() })
        .then(render)
        .catch((err) => console.error('theme-triggered render failed', err))
      return
    }
    if (msg.type === 'DATA') {
      serverOffset = msg.server_time - Date.now()
      // `snapshot: true` marks a full reference-set resend (connect/layout-change/feed-delete) —
      // replace the whole map so a deleted feed actually drops out (delete ⇒ "feed
      // missing", not silence). A single-feed push merges instead, keeping the rest of the map.
      if (msg.snapshot) feeds = { ...msg.feeds }
      else Object.assign(feeds, msg.feeds)
      // Activity tick (stream-activity contract): only a live push can ever ring one — a snapshot is a reconnect
      // resync, not new activity (alert sounds' identical "silence on reconnect" rule).
      // The tab-dot blink follows the same live-only rule but a BROADER scope: every stream on a
      // background tab blinks (silent, cheap); only opted-in cells tick (audible, opt-in).
      if (!msg.snapshot) {
        const pushedIds = Object.keys(msg.feeds)
        maybePlayActivityTick(pushedIds)
        const fresh = tabsWithStreamRows(tabScreens, pushedIds, activeTabId)
        if (fresh.some((id) => !unseenActivity.has(id))) {
          fresh.forEach((id) => unseenActivity.add(id))
          renderTabBar()
        }
      }
      render()
      return
    }
    if (msg.type === 'TAB_STATUS') {
      // Dots only (tabs) — a sender's alert lighting a background tab must not
      // wait for, or trigger, a full STATE round trip or a grid repaint of the tab already on
      // screen. `renderTabBar()` alone updates the dot; the grid path is untouched.
      tabStatus = msg.tab_status ?? {}
      renderTabBar()
      return
    }
    if (msg.type === 'PLAY_SOUND') {
      // Same native-ownership gate render()'s takeover/alarm block uses below: once the
      // shell explicitly owns the audio surface, this page must not ALSO play an audition sound —
      // it is the identical double-beep this gate already exists to prevent, just for a one-shot
      // push instead of the alarm loop.
      if (!yieldTakeoverToHost(driven(), hostOwnsTakeover())) {
        if (msg.family === 'classic') {
          beep(1, 880)
        } else {
          const url = soundUrl(msg.family, msg.event, screenDef?.sounds_rev ?? 0)
          loadSound(url).then(() => {
            const buf = soundBuffers.get(url)
            if (buf && buf !== 'failed') playBuffer(buf, 0.4)
            else beep(1, 880) // fetch/decode failed (or this device predates the family) — never silent
          })
        }
      }
      return
    }
    if (msg.type === 'RELOAD') {
      // Remote unstick (protocol.ts ReloadMsg): the hub asked this page to load itself fresh —
      // the escape hatch for a board whose catalogue-staleness ladder is spent. Works the same
      // driven or not: a driven WebView reloads the same hub URL the shell loaded, and every
      // static file is served `no-cache`, so the reload IS the update.
      location.reload()
      return
    }
    if (msg.type === 'ALERT_ADD') send({ type: 'ACK', id: msg.alert.id, stage: 'delivered' })
    if (msg.type === 'ALERT_REMOVE') silenced.delete(msg.id)
    alerts = reduce(alerts, msg)
    render()
}

// --- sounds (WebAudio beeps; no assets) ---
// Browsers suspend AudioContexts created without a user gesture (autoplay policy) and never
// auto-resume them, so a single shared context is created lazily and unlocked on the first
// pointerdown/keydown anywhere in the page. A context created fresh per beep() call would also
// leak — one context is reused for the lifetime of the page.
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return audioCtx
}
function unlockAudio() {
  const ctx = getAudioCtx()
  if (ctx.state === 'suspended') ctx.resume().then(updateSoundHint).catch(() => {})
}
document.addEventListener('pointerdown', unlockAudio, { once: false })
document.addEventListener('keydown', unlockAudio, { once: false })

function beep(times, freq, gainValue = 0.4) {
  const ctx = getAudioCtx()
  for (let i = 0; i < times; i++) {
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.frequency.value = freq; gain.gain.value = gainValue
    osc.start(ctx.currentTime + i * 0.5); osc.stop(ctx.currentTime + i * 0.5 + 0.25)
  }
}

// --- sound families (WireScreen.sounds — resolved theme ⊕ screen ⊕ classic, alert sounds) ---
// 'classic' carries no file — it IS the oscillator path above, so it is never looked up here.
// Every other family name is a static `/sounds/<family>/<event>.wav`, cached decoded so an alarm
// tick or a PLAY_SOUND never re-fetches/re-decodes on every play.
const soundBuffers = new Map() // url -> AudioBuffer | 'failed'
// In-flight/settled load promise per URL — a SEPARATE map from soundBuffers itself (not just a
// `soundBuffers.has(url)` dedup check) because prefetchSounds and a PLAY_SOUND for the exact same
// URL land back to back: prefetch claims the slot first, and without sharing the promise a second
// caller would see the 'failed' placeholder mid-fetch and resolve immediately — beeping even
// though the very same file finishes decoding a moment later. Every caller of loadSound for a
// given URL now awaits the one real fetch+decode.
const soundLoads = new Map() // url -> Promise<void>
function soundUrl(family, event, rev) { return `/sounds/${family}/${event}.wav?rev=${rev}` }
/**
 * Fetch+decode one family/event file, memoised by URL (which already embeds `rev`, so a manifest
 * bump naturally busts the cache instead of needing an explicit evict). `soundBuffers` is marked
 * 'failed' BEFORE the fetch even starts, not after: a decode that never resolves (or throws
 * mid-flight) must still leave the entry in a state `soundFor`/PLAY_SOUND read as "no buffer, use
 * the oscillator" rather than leaving it unset (which would look identical to "never requested"
 * and could get fetched over and over). A bad network or a corrupt file therefore degrades to the
 * fallback beep, never to silence and never to an uncaught rejection — and only a SUCCESS is
 * memoised for the life of the page; a failure clears itself from `soundLoads` so a transient
 * blip (network hiccup, hub restart mid-fetch) doesn't strand a kiosk on the oscillator forever.
 */
function loadSound(url) {
  if (soundLoads.has(url)) return soundLoads.get(url)
  soundBuffers.set(url, 'failed')
  const p = (async () => {
    try {
      const res = await fetch(url)
      if (res.ok) {
        soundBuffers.set(url, await getAudioCtx().decodeAudioData(await res.arrayBuffer()))
        return
      }
    } catch { /* falls through to the retry reset below */ }
    // Failure (non-OK status, network error, or a decode throw): soundBuffers stays 'failed' so
    // the caller falls back to beep() right now, but the settled promise is dropped from
    // soundLoads so the NEXT prefetchSounds/soundFor-triggering STATE tries the fetch again
    // instead of memoising the failure for the life of the page. Retry frequency is naturally
    // bounded by how often STATE pushes, not by a timer here.
    soundLoads.delete(url)
  })()
  soundLoads.set(url, p)
  return p
}
function playBuffer(buf, gain = 0.4) {
  const ctx = getAudioCtx()
  const src = ctx.createBufferSource(); const g = ctx.createGain()
  src.buffer = buf; g.gain.value = gain; src.connect(g); g.connect(ctx.destination); src.start()
}
/**
 * Kicks off (fire-and-forget — `loadSound` never rejects) a decode for every non-classic
 * family/event this device's tabs might need. Called on every STATE so a tab switch mid-alarm, or
 * an audition PLAY_SOUND for a family the active tab doesn't even use, plays instantly instead of
 * stalling on a first-time fetch.
 */
function prefetchSounds(screens) {
  for (const s of screens) {
    if (!s.sounds || s.sounds_rev == null) continue
    for (const event of Object.keys(s.sounds)) {
      const family = s.sounds[event]
      if (family !== 'classic') loadSound(soundUrl(family, event, s.sounds_rev))
    }
  }
}
/**
 * The active tab's (`screenDef` — the same module state the tab bar and TAB sends already track)
 * resolved pick for an event. 'classic', a screen with no sounds at all, or a buffer
 * that hasn't finished decoding (still 'failed' or never prefetched) all return null — the caller's
 * cue to fall back to the oscillator, exactly like a fetch/decode failure does.
 */
function soundFor(event) {
  const s = screenDef
  if (!s || !s.sounds || s.sounds[event] === 'classic' || s.sounds_rev == null) return null
  const buf = soundBuffers.get(soundUrl(s.sounds[event], event, s.sounds_rev))
  return buf && buf !== 'failed' ? buf : null
}

// --- activity tick (stream-activity contract: a soft tick on a watched stream's new entries, sound only) ---
let lastActivityTickAt = 0
const ACTIVITY_COOLDOWN_MS = 2500
/**
 * stream-activity contract (deliberate any-tab extension of alert-sound contract's visible-tab-only chime rule): the carrying screen —
 * ANY of this device's tabs whose grid has a `stream_list`/`table` cell opted into
 * `chime_activity` for one of `pushedIds` — voices the tick, whether or not it is on screen right
 * now. The opted-in cell belongs to a specific screen, so ownership is unambiguous; unlike an
 * alert there is no routing problem to resolve. Prefers the visible tab (`screenDef`) when it is
 * itself a carrier, else the first carrying tab in tab order. Returns null when nothing carries
 * the push (nothing opted in, or the push touches no opted-in feed) — the caller's cue to stay
 * silent.
 */
function activityVoice(pushedIds) {
  const carriers = tabScreens.filter((s) => {
    const cells = Array.isArray(s.grid?.cells) ? s.grid.cells : []
    return cells.some((c) => c && (c.widget === 'stream_list' || c.widget === 'table')
      && c.config?.chime_activity === true && pushedIds.includes(c.config?.feed))
  })
  if (!carriers.length) return null
  const s = carriers.find((x) => x.id === screenDef?.id) ?? carriers[0]
  return { family: s.sounds?.activity ?? 'classic', rev: s.sounds_rev ?? 0 }
}
/**
 * Called for every non-snapshot DATA push (`snapshot: true` — a reconnect resync — never
 * ticks; the caller only invokes this on the non-snapshot branch). Collapses to at most one tick
 * per push regardless of how many feeds/rows it carries, same batch discipline as an alert chime,
 * plus a device-side minimum gap between ticks so a chatty stream cannot machine-gun — a push
 * landing inside the gap is DROPPED, not deferred (activity is ambient awareness, not a queue).
 * Suppressed while the critical alarm is sounding (same rule chimes follow) or while a driven
 * host explicitly owns the takeover/alarm surface (the identical expression
 * PLAY_SOUND and the takeover block above both use). Only a push that actually results in a
 * played tick stamps `lastActivityTickAt`: a push nothing carries, or one suppressed outright,
 * must not arm the cooldown against the NEXT genuinely qualifying push.
 *
 * Wrapped in its own try/catch (same reasoning as render()'s idle-body guard above, whose own
 * comment records the real bug this mirrors: a malformed cell throwing mid-handler, on a screen
 * that keeps recurring in every future DATA push, silently breaking more than the tick itself). A
 * bad grid/sounds shape must degrade this one feature, not take the DATA branch's `render()` call
 * down with it.
 */
function maybePlayActivityTick(pushedIds) {
  try {
    const voice = activityVoice(pushedIds)
    if (!voice) return
    if (yieldTakeoverToHost(driven(), hostOwnsTakeover())) return
    if (alarm) return
    const now = Date.now()
    if (now - lastActivityTickAt < ACTIVITY_COOLDOWN_MS) return
    lastActivityTickAt = now
    if (voice.family !== 'classic') {
      const buf = soundBuffers.get(soundUrl(voice.family, 'activity', voice.rev))
      if (buf && buf !== 'failed') { playBuffer(buf, 0.25); return }
    }
    // classic, missing, or not-yet-decoded (prefetch hasn't landed) all degrade here — a single
    // short, low-gain blip, never silence. Distinct pitch from the alarm/PLAY_SOUND beep (880Hz)
    // so a tick reads as a tick, not a muted alarm.
    beep(1, 1047, 0.2)
  } catch (err) {
    console.error('activity tick failed', err)
  }
}

function startAlarm() {
  stopAlarm()
  const ctx = getAudioCtx()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  // Cadence frozen exactly as before (1.5s interval, immediate first tick): only the SOURCE of
  // each tick's sound changed — a resolved family's decoded buffer in place of the oscillator,
  // same 0.4 gain either way (playBuffer's default), `beep(2, 880)` as the untouched fallback.
  const tick = () => { const buf = soundFor('critical'); buf ? playBuffer(buf) : beep(2, 880) }
  alarm = setInterval(tick, 1500)
  tick()
}
function stopAlarm() { if (alarm) { clearInterval(alarm); alarm = null } }
// A context that has never received a user gesture (e.g. a freshly rebooted, never-touched
// kiosk browser) cannot be force-unmuted from script — this hint is the honest mitigation: it
// tells whoever is standing at the screen to tap once, which both silences the current alert
// and (via the document-level listener above) unlocks audio for every alert after it.
function updateSoundHint() {
  const locked = audioCtx && audioCtx.state === 'suspended'
  $('silence-hint').textContent = locked ? '🔇 Tap anywhere to enable sound' : '🔇 Tap anywhere to silence'
}

// --- rendering ---
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() + serverOffset - ts) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}
const atTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
// Device clock base (staleness) — same server_time + monotonic-since-receipt formula STATE
// already uses for `ago`/the idle clock; DATA receipt keeps serverOffset current too (see above).
const hubNow = () => Date.now() + serverOffset
// `feedMissingHtml` lived here — the loud, dashed "feed missing" div every data widget's DOM branch
// returned for an unresolvable binding. `chart` was its last caller; the notice is
// painted by the designs now (`centredNotice`, widgets/text-fit.mjs), so both the helper and its
// `.feed-missing` CSS rule are gone rather than kept warm for a caller that no longer exists.
/**
 * A cell too small for its widget (WIDGET_MIN_PX). Loud and dashed like `feed missing`, and for
 * the same reason: it is an authoring mistake the operator has to see and fix, not a state to
 * degrade through. Naming the size it needs is what makes it actionable rather than a scold.
 */
const tooSmallHtml = (widget, designMin) => {
  // Name the floor that actually applied, not the widget's: a ticker band refused at 120×28 and
  // told it "needs 160×110" sends the operator to resize for a rule that was never the one.
  const min = designMin ?? WIDGET_MIN_PX[widget]
  return `<div class="placeholder too-small">${escapeHtml(widget)} needs ${min.w}\u00d7${min.h}</div>`
}
// Authed theme fetch (theming: device-token theme endpoint, tab state transfer). `/api/themes/:id`
// is device-token gated exactly like `/api/feeds/:id/image`, and theme.mjs's noteThemeRef
// deliberately takes `fetchFn` as an injected dependency rather than attaching auth itself — this
// is that seam. Same Bearer-header shape `bitmapDeps` uses for an image feed, just without the
// blob()/object-URL handling theme.mjs's own JSON parsing (`res.json()`) already covers.
const themeFetchFn = (url) => fetch(url, { headers: { authorization: `Bearer ${token()}` } })

// The image feeds' fetch/decode/revoke/clock, bound to THIS page's token (widgets/index.mjs holds
// the primitives; only this file has the credential, which is why they take `token` rather than
// reaching for it). Built once — the deps are stateless and `token` is re-read per call, so a page
// that pairs after load still authenticates.
const imageDeps = bitmapDeps(token)

function cardHtml(a) {
  // Answer buttons on the card itself: since the board went WebView (web-renderer boundary), the native shell only
  // renders options on the critical takeover — without this row, a warn/info question is a card
  // the wall can see but never answer. Order and count (≤4) are the hub's; render what arrives.
  const opts = Array.isArray(a.options) && a.options.length > 0
    ? `<div class="opts">${a.options.map((o) =>
      `<button data-answer="${escapeHtml(a.id)}" data-option="${escapeHtml(o.id)}">${escapeHtml(o.label)}</button>`).join('')}</div>`
    : ''
  return `<div class="card ${a.severity}">
    <div class="meta"><span>${a.severity === 'critical' ? '🔴' : a.severity === 'warn' ? '⚠' : 'ℹ'}
      ${escapeHtml(a.sender.name.toUpperCase())} · ${a.severity.toUpperCase()}</span><span>${ago(a.updated_at)}</span></div>
    <div class="title">${escapeHtml(a.title)}</div>
    ${a.body ? `<div class="body">${escapeHtml(a.body)}</div>` : ''}
    ${opts}
    <div class="foot">
      <span>${atTime(a.created_at)}${a.update_count ? ` · updated ${a.update_count}×` : ''}</span>
      <button data-dismiss="${escapeHtml(a.id)}">Dismiss</button>
    </div>
  </div>`
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function widgetHtml(cell, cellHeightPx, idx, cellWidthPx) {
  // Before anything else, including the canvas branch: a design cannot rescue a box too small to
  // hold the widget, and painting one anyway is what produced four unlabelled rings.
  const designMin = designMinimum(cell.widget, cell.config?.design)
  if (belowMinimum(cell.widget, cellWidthPx, cellHeightPx, designMin)) return tooSmallHtml(cell.widget, designMin)
  // designFor IS the canvas/DOM decision point, and it has to be asked FIRST. This prevents the
  // host from assuming that only the clock can be a canvas design; the moment any other widget
  // registered a design, designFor would return it, paintWidgets would resolve it and try to paint
  // a canvas that was never emitted — the design silently ignored, nothing logged, nothing failing.
  // Canvas designs own the clock now (web-renderer boundary); the DOM branch is gone rather than kept as a fallback,
  // because two clock code paths would drift and `digital` already IS the fallback.
  if (designFor(cell, currentWidgets())) return canvasHtml(idx)
  // `chart` was the last widget-specific branch here. It emitted its own
  // `<canvas class="chart">` and decided the all-series-missing placeholder itself; both moved into
  // `widgets/chart/plot.mjs`, which draws the notice on its own canvas like every other design. What
  // is left below is not a widget branch at all — it is the fallback for a widget type this build
  // has never heard of, and there is deliberately nothing between it and the canvas line above.
  // Unknown-widget rule: loud placeholder, never a silent drop, never a crash.
  return `<div class="placeholder" style="flex:1">Unsupported widget "${escapeHtml(String(cell.widget))}" — update this page</div>`
}

/**
 * Reload the page when the board asks for a design or widget type this build does not have.
 *
 * `widgets/index.mjs` registers designs and `definitions.mjs` describes widget types once, at page
 * load. A panel opened before either catalogue entry shipped cannot use it until the page reloads.
 * Unknown designs still degrade to the widget default; an unknown widget keeps the existing DOM
 * fallback. Both stay bounded by the same attempt ladder below.
 *
 * `sessionStorage`, not a module variable, precisely because the reload is the point: the record
 * of what we have already reloaded for has to survive it, or a design id that is simply WRONG (an
 * operator typo, a design that was removed) reloads the panel forever. It is also per-tab and
 * dies with the session, so a genuinely stale panel that is power-cycled gets a fresh attempt.
 *
 * That record is a per-id ATTEMPT LADDER rather than a bare list of ids (see RELOAD_BACKOFF_MS in
 * widgets/index.mjs for why, and for the choice of rungs): "one reload per id, ever" could not tell
 * a wrong id from an id the hub did not have YET, and gave up on a deploy race permanently.
 *
 * Storage can throw or be absent (a WebView with storage disabled, a privacy mode), and a board
 * that will not paint because it could not read a reload marker would be a far worse bug than the
 * one this fixes — so every failure path here degrades to "do not reload".
 */
const CATALOGUE_TRIED_KEY = 'dashboardz.catalogueReloads'

function catchUpCatalogue(cells) {
  // Cheapest check first, and deliberately so: renderGrid runs on every 1s render tick for weeks
  // on end, and on all but a handful of those ticks there is nothing unknown. Only once something
  // IS unknown is it worth touching storage or reading a clock.
  if (!unknownDesigns(cells, currentWidgets()).length &&
      !unknownWidgetTypes(cells, WIDGET_DEFINITIONS).length) return

  let store
  try {
    store = globalThis.sessionStorage
    if (!store) return
  } catch { return }

  let raw
  try {
    raw = store.getItem(CATALOGUE_TRIED_KEY)
  } catch {
    // The store itself cannot be read, so there is no way to tell an id already reloaded for from
    // one never tried — and reloading blind is exactly the unbounded loop this marker exists to
    // prevent. Do not reload. (Distinct from the corrupt-VALUE case below, which IS recoverable.)
    return
  }

  let stored = null
  try {
    stored = raw ? JSON.parse(raw) : null
  } catch { /* corrupt value: start a fresh ladder — the setItem below replaces it in this same tick */ }

  // Date.now(), never hubNow(): this is a local elapsed-time timer and must not jump when the
  // server offset re-syncs. This matches bitmaps.mjs's failure backoff so reloads are paced locally.
  const now = Date.now()
  const needed = designsNeedingReload(cells, currentWidgets(), stored, now, WIDGET_DEFINITIONS)
  if (!needed.length) return

  try {
    store.setItem(CATALOGUE_TRIED_KEY, JSON.stringify(noteReloadAttempts(stored, needed, now)))
  } catch {
    // Could not record the attempt, so reloading would loop. Staying on the default design is the
    // documented degradation; an unbreakable reload cycle is not.
    return
  }
  console.info(`catalogue is newer than this page (${needed.join(', ')}); reloading`)
  globalThis.location?.reload()
}

/**
 * The persistent bottom tab bar (tabs, tab-bar behavior). Pure DOM from `tabBarModel`; this
 * function does no deciding of its own, just builds/hides the bar and wires the tap handler.
 *
 * Called from `render()` on every pass (so a STATE, a resize, an orientation change all keep it in
 * sync) AND directly from the `TAB_STATUS` handler above, which intentionally does NOT go through
 * `render()` — a dot lighting up on a background tab must not repaint the grid that IS on screen.
 */
// What the strip looked like last time it was built, and which tab it was scrolled to. Both exist
// to keep `renderTabBar` from doing work: it runs on EVERY render — every data push included — and
// rebuilding innerHTML throws the scroll position away. A 5s feed made that a teardown twelve times
// a minute, each snapping the bar to the start and then dragging it back: unreadable.
let lastTabSignature = null
let lastShownTabId = null

function renderTabBar() {
  const model = tabBarModel(tabScreens, tabStatus, activeTabId, unseenActivity)
  const bar = $('tabbar')
  const signature = tabBarSignature(model)
  if (signature === lastTabSignature && bar.querySelector('#tabscroll')) {
    // Nothing the markup reads has changed. Leave the DOM — and the scroll offset — alone. The
    // arrows still get a sync because a resize can change what fits without changing the model.
    syncTabArrows()
    return
  }
  lastTabSignature = signature
  if (!model.visible) {
    // Same rule renderGrid's `display:none` follows on the no-screen path: hidden means hidden,
    // and an empty innerHTML means a device that drops from two tabs to one leaves no dead click
    // targets or leftover dots behind.
    bar.style.display = 'none'
    bar.innerHTML = ''
    return
  }
  bar.style.display = 'flex'
  const keptOffset = scrollerMetrics($('tabscroll')).offset
  const vertical = tabBarVertical()
  bar.innerHTML =
    `<button class="tab-arrow" data-scroll="-1" aria-label="Previous tabs">${vertical ? '\u25B2' : '\u25C0'}</button>` +
    `<div class="tab-scroller" id="tabscroll">` +
    model.tabs.map((tab) =>
      `<button class="tab-btn${tab.active ? ' active' : ''}" data-tab="${escapeHtml(tab.id)}">` +
      `<span class="tab-label">${escapeHtml(tab.text)}</span>` +
      // Blink pulses the dot the tab already has (severity colour kept); a tab with nothing to
      // report gets a neutral one to pulse — unseen activity must be visible even on a quiet tab.
      (tab.dot || tab.blink
        ? `<span class="tab-dot tab-dot--${escapeHtml(tab.dot ?? 'unseen')}${tab.blink ? ' tab-dot--blink' : ''}"></span>`
        : '') +
      `</button>`).join('') +
    `</div>` +
    `<button class="tab-arrow" data-scroll="1" aria-label="More tabs">${vertical ? '\u25BC' : '\u25B6'}</button>`

  bar.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)))
  const scroller = $('tabscroll')
  bar.querySelectorAll('[data-scroll]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = scrollerMetrics(scroller)
      applyScrollOffset(scroller, pageOffset(m.offset, m.viewport, Number(b.dataset.scroll), m.scrollSize))
      // The offset the browser lands on is what the arrows must reflect, and `scroll-behavior:
      // smooth` means that is not this tick — the scroll handler below is what settles them.
      syncTabArrows()
    }))
  // Also on scroll, because a strip can be scrolled by touch as well as by the arrows, and on
  // resize/orientation change, where the same tabs can stop overflowing entirely.
  scroller.addEventListener('scroll', syncTabArrows)
  // Restore where the strip was before this rebuild, instantly — the operator may have scrolled it
  // somewhere deliberately, and a status dot lighting up is no reason to move it. `scroll-behavior:
  // smooth` applies to programmatic scrolls too, so it is suspended for the restore: animating back
  // to where you already were is the jitter this whole path exists to remove.
  if (keptOffset > 0) {
    const behavior = scroller.style.scrollBehavior
    scroller.style.scrollBehavior = 'auto'
    applyScrollOffset(scroller, keptOffset)
    scroller.style.scrollBehavior = behavior
  }
  // Auto-scroll only when the ACTIVE tab changed (or on the first build). Doing it on every render
  // is what fought the operator for the scrollbar.
  const justSwitched = activeTabId !== lastShownTabId
  if (justSwitched) {
    lastShownTabId = activeTabId
    showActiveTab()
  }
  syncTabArrows()
  // ...and again after layout. The first pass runs in the same tick the scroller was inserted,
  // where clientWidth/scrollWidth are still whatever the browser had before it laid the new
  // buttons out — so the offset comes out short and the active tab stays half off the edge (this
  // is exactly what a 12-tab panel showed: scrolled, but not to Finance). One frame later the
  // measurements are real.
  globalThis.requestAnimationFrame?.(() => { if (justSwitched) showActiveTab(); syncTabArrows() })
  // ...and once more when the FONT has settled. Tab widths depend on the face that finally loads,
  // so a strip measured before then is measured short — the scroll lands mid-list instead of on
  // the active tab. `document.fonts.ready` resolves immediately when there is nothing to wait for,
  // so this is one extra measure, not a delay.
  globalThis.document?.fonts?.ready?.then?.(() => { if (justSwitched) showActiveTab(); syncTabArrows() })
}

/** A side bar runs down the screen; a top/bottom bar runs across it. Decides which axis scrolls. */
function tabBarVertical() {
  const cls = $('idle').className
  return cls === 'tabbar-left' || cls === 'tabbar-right'
}

/** The three sizes `device-core`'s scroll arithmetic wants, off whichever axis this bar uses. */
function scrollerMetrics(el) {
  if (!el) return { scrollSize: 0, viewport: 0, offset: 0 }
  return tabBarVertical()
    ? { scrollSize: el.scrollHeight, viewport: el.clientHeight, offset: el.scrollTop }
    : { scrollSize: el.scrollWidth, viewport: el.clientWidth, offset: el.scrollLeft }
}

function applyScrollOffset(el, offset) {
  if (!el) return
  if (tabBarVertical()) el.scrollTop = offset
  else el.scrollLeft = offset
}

/**
 * Arrows appear only while the strip overflows, and each disables itself at its own end. Called
 * after every render, on scroll, and after a switch — the three ways the answer can change.
 */
function syncTabArrows() {
  const scroller = $('tabscroll')
  if (!scroller) return
  const state = tabScrollState(scrollerMetrics(scroller))
  const bar = $('tabbar')
  bar.querySelectorAll('[data-scroll]').forEach((arrow) => {
    arrow.classList.toggle('shown', state.overflowing)
    const back = Number(arrow.dataset.scroll) < 0
    arrow.disabled = back ? state.atStart : state.atEnd
  })
}

/**
 * Bring the active tab into view. The case this exists for is not the arrows at all: a device
 * restores its active tab from localStorage, and in a long strip that tab can restore anywhere —
 * including off the edge, which is how a live Finance tab ended up invisible in its own bar.
 */
function showActiveTab() {
  const scroller = $('tabscroll')
  const active = scroller?.querySelector('.tab-btn.active')
  if (!scroller || !active) return
  const vertical = tabBarVertical()
  const m = scrollerMetrics(scroller)
  // Measured off rects, NOT offsetTop/offsetLeft: those are relative to the nearest POSITIONED
  // ancestor, and the scroller is static, so a button's offsetLeft is not its position in the
  // scrolled content — it silently included the ◀ arrow's width and ignored the current scroll.
  // rect-delta + current offset is the same number regardless of what is positioned where.
  const box = scroller.getBoundingClientRect()
  const item = active.getBoundingClientRect()
  applyScrollOffset(scroller, offsetToShow({
    itemStart: (vertical ? item.top - box.top : item.left - box.left) + m.offset,
    itemSize: vertical ? item.height : item.width,
    offset: m.offset,
    viewport: m.viewport,
    scrollSize: m.scrollSize,
  }))
}

/**
 * Client-local tab switch (tabs — "switching is client-local"). No STATE round trip: the
 * hub already pushed every tab's layout up front (fat push), so the switch is just picking which
 * one of the already-held `tabScreens` is `screenDef` right now.
 *
 * Goes through the full `render()`, not a bare `renderGrid()`: a tab can carry its OWN theme
 * (`WireTabScreen.theme`), and `render()` is what reapplies the board/chrome CSS custom properties
 * from `theme.mjs`'s cache AND keeps the tab bar's own active-state highlight in sync — a
 * `renderGrid()`-only switch would leave the previous tab's colours on screen until the next STATE.
 * `noteThemeRef` + the `.then(render)` re-render mirror the STATE handler's own theme-fetch shape
 * above exactly, for the same reason: paint immediately with whatever theme.mjs already has
 * cached, then correct it once the new tab's theme document (if different) has actually loaded.
 */
// A resize or rotation changes both what fits and where the active tab sits; the arrows and the
// scroll offset are stale until something re-measures, and nothing else would.
globalThis.addEventListener?.('resize', () => { showActiveTab(); syncTabArrows() })

function switchTab(id) {
  if (!id || id === activeTabId) return
  activeTabId = id
  // Opening the tab is what "seeing" means — the blink stops here, not on a timer. render()
  // below repaints the bar via renderTabBar, so no extra call is needed.
  unseenActivity.delete(id)
  writeActiveTab(id)
  screenDef = tabScreens.find((s) => s.id === id) ?? null
  render()
  send({ type: 'TAB', screen_id: id })
  noteThemeRef(screenDef?.theme ?? null, { fetchFn: themeFetchFn, now: () => Date.now() })
    .then(render)
    .catch((err) => console.error('theme-triggered render failed', err))
}

function renderGrid() {
  const grid = $('grid')
  // Absolute positioning: every card owns its own {x,y,w,h} rect, so the grid is a plain positioned
  // container; each cell places itself inside via left/top/width/height computed from rectToPx.
  grid.style.display = 'block'
  grid.style.position = 'relative'
  // Hide the default-layout chrome; the grid IS the idle view now. #idle's own flex-direction/
  // className must not leak from a prior default-layout render (landscape-active reflows #idle
  // as a row, which would squeeze the grid), and #alerts (parent of cards/chips) is an empty
  // flex:1 sibling of #grid that would otherwise still claim half the screen.
  // Bar placement comes from the ACTIVE screen's own layout document (tabs, per-screen
  // declaration) — the hub enforces that every tab in a list agrees, so this never changes
  // mid-switch. 'bottom' (and the impossible-in-a-list 'hidden') keep the classless default;
  // set BEFORE the clientWidth/clientHeight reads below so the measured box already excludes
  // whichever edge the bar owns.
  const barPosition = screenDef.grid && typeof screenDef.grid.tab_bar === 'string' ? screenDef.grid.tab_bar : 'bottom'
  $('idle').className = ['top', 'left', 'right'].includes(barPosition) ? `tabbar-${barPosition}` : ''
  $('clockpane').style.display = 'none'
  $('alerts').style.display = 'none'
  $('cards').style.display = 'none'
  $('chips').style.display = 'none'
  const screenW = grid.clientWidth
  const screenH = grid.clientHeight
  const cells = Array.isArray(screenDef.grid.cells) ? screenDef.grid.cells : []
  // If this board names a design this build cannot draw, the page is older than the
  // catalogue and reloading is what fixes it. Checked here rather than on the STATE path because
  // the theme arrives separately and asynchronously — a theme naming `flip` lands after the STATE
  // that referenced it, and this is the one place both are already in scope.
  catchUpCatalogue(cells)
  // Each card owns its own box and its own size scalar now — there is no board-wide fraction.
  // safeRect coerces a missing/garbage rect (e.g. a hand-edited DB row) rather than throwing, so
  // a bad rect renders a real (if oddly placed) card instead of blanking the board.
  const boxes = cells.map((c) => {
    const rect = safeRect(c.rect)
    return { rect, px: rectToPx(rect, screenW, screenH), t: sizeT(rect.w, rect.h) }
  })
  // Ask for the bitmaps this board needs, once per full render, off the same `feeds` map the cells
  // are drawn from. Fire-and-forget — nothing here can wait for a decode, so the first paint below
  // draws `loading image…` and `onBitmapReady` (bottom of this file) repaints the cell the moment
  // the picture lands. `boxes` rides along so a too-small cell never fetches: the deleted
  // `ensureImageLoaded` was called from INSIDE `widgetHtml`, AFTER its own `belowMinimum` check
  // below, so a below-minimum image cell never spent a round trip on a bitmap it was about to
  // cover with `tooSmallHtml`'s notice. This call sits ahead of `widgetHtml` now (it has to run
  // once for the whole board, not per cell), so it has to make that same size check itself rather
  // than inherit it for free — `loadCellBitmaps`'s own docstring has the gate-by-gate detail.
  loadCellBitmaps(cells, feeds, imageDeps, boxes)
  grid.innerHTML = cells.map((c, idx) => {
    const b = boxes[idx]
    return `<div class="cell" style="position:absolute;left:${b.px.left}px;top:${b.px.top}px;` +
      `width:${b.px.width}px;height:${b.px.height}px">${widgetHtml(c, b.px.height, idx, b.px.width)}</div>`
  }).join('')
  // THE post-insert paint pass (interface contract) — canvas can't be painted from an HTML string,
  // so every cell gets a real <canvas> placeholder above and is painted here once it exists in the
  // DOM (and therefore has real clientWidth/clientHeight to size the backing store to). There were
  // two of these; `paintCharts` went with `charts.mjs`, and its board argument
  // — a chart resolves its series ramp from `board.series` — is now `ctx.ramp`, built inside this
  // one from the very same `currentBoard()`.
  // `alerts` (module-level, above) is passed here and at repaintCells' call below — the same array
  // at both, so a design sees identical alerts whichever path painted it.
  paintWidgets(cells, boxes, currentBoard(), hubNow, currentWidgets(), feeds, undefined, alerts, cardChrome())
  // Everything the per-cell tick needs to repaint one cell without going near the DOM again. The
  // boxes are safe to keep because the only thing that invalidates them is the grid's box changing,
  // and every path that can do that (resize, rotation, a new screen) comes back through here.
  gridBoxes = boxes
  const paintedAt = Date.now()
  cellPaintedAt = {}
  for (let idx = 0; idx < cells.length; idx++) cellPaintedAt[idx] = paintedAt
}

// Background-image object URL, keyed by `themeId:bg_rev` — the same one-live-URL-per-source shape
// the image widget uses, and for the same reason: these panels run for weeks, so an unrevoked URL
// per revision is a real leak.
let bgUrl = null
let bgKey = null
let bgPending = null

/**
 * Fetch the theme's background bytes and keep ONE object URL for them.
 *
 * Authed, so it cannot be an `<img src>` — same constraint as the image widget. Fire-and-forget:
 * the board already painted with the procedural backdrop, and this re-renders once the bytes land,
 * so a slow or failed image never blanks a board.
 */
function ensureBgLoaded(themeId, rev) {
  const key = `${themeId}:${rev}`
  if (bgKey === key || bgPending === key) return
  bgPending = key
  fetch(`/api/themes/${themeId}/bg`, { headers: { authorization: `Bearer ${token()}` } })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
    .then((blob) => {
      if (bgPending !== key) return          // a newer revision won while this was in flight
      if (bgUrl) URL.revokeObjectURL(bgUrl)  // exactly one live URL at a time
      bgUrl = URL.createObjectURL(blob)
      bgKey = key
      bgPending = null
      render()
    })
    .catch(() => {
      // Keep whatever is already showing (contract: a failed fetch never blanks the board) and
      // stop retrying this key — the 1s render tick would otherwise hammer a 404 forever.
      if (bgPending === key) bgPending = null
    })
}

/**
 * The board's full `background` shorthand: scrim over image over procedural backdrop over colour.
 *
 * CSS paints the FIRST layer on top, which is why the scrim leads. This is where `scrim` finally
 * gets a consumer — it exists to keep cards readable over an arbitrary photo, and applies only
 * when there IS a photo: a procedural backdrop is derived from the palette and legible by
 * construction, so dimming it would just make the board muddy.
 */
/**
 * The per-cell card chrome the `cards` backdrop asks for — `{surface, border, gap}` — or null for
 * every other backdrop kind. Computed here (page code, where the theme lives) and handed INTO
 * paintWidgets, so the widget pipeline stays free of theme-module state and a test can drive card
 * painting by passing the object directly. `gap` is the theme's `board.card_gap` (px, default 2).
 */
function cardChrome() {
  if (currentBackdrop() !== 'cards') return null
  const board = currentBoard()
  const finite = (v) => typeof v === 'number' && Number.isFinite(v)
  return {
    surface: typeof board?.surface === 'string' ? board.surface : '#ffffff',
    border: derivedChrome(board, currentChrome()).border,
    gap: finite(board?.card_gap) ? board.card_gap : 2,
    // Interior padding between the border and the design's content (`board.card_padding`);
    // unset means the pipeline default (CARD_PADDING).
    padding: finite(board?.card_padding) ? board.card_padding : undefined,
  }
}

function boardBackground() {
  const board = currentBoard()
  const procedural = backdropCss(board, currentBackdrop())
  const bg = currentBg()
  const themeId = currentThemeId()
  if (!bg || bg.kind !== 'image' || !themeId) return procedural
  ensureBgLoaded(themeId, bg.rev)
  if (!bgUrl) return procedural            // not arrived yet — the backdrop carries the board
  const scrim = Math.min(1, Math.max(0, Number(board?.scrim ?? 0)))
  const layers = []
  if (scrim > 0) layers.push(`linear-gradient(rgba(0,0,0,${scrim}), rgba(0,0,0,${scrim}))`)
  layers.push(`url("${bgUrl}") center / cover no-repeat`)
  layers.push(procedural)
  return layers.join(', ')
}

/**
 * When the board was last painted, by any path — a STATE, a DATA push, an asset landing, or the
 * tick below. Stamped here rather than at the tick's call site so a board that has just repainted
 * for real data does not immediately repaint again for the clock.
 */
let lastRenderAt = 0

/**
 * The last full render's boxes, and when each cell was last drawn — the state a per-cell repaint
 * needs. Both are owned by renderGrid and read only by the tick below; a board with no screen
 * assigned has neither, which is why that path still renders in full.
 */
let gridBoxes = []
let cellPaintedAt = {}

/**
 * Repaint just these cells, without rebuilding the grid's DOM.
 *
 * This is the whole saving. A full render re-serializes every cell into `grid.innerHTML`, re-runs
 * shrink-to-fit and repaints every canvas and chart on the board; on the A05 that measured 32-46ms
 * with nothing on screen actually changing. A clock needs one canvas redrawn.
 */
function repaintCells(indices, at) {
  const cells = Array.isArray(screenDef?.grid?.cells) ? screenDef.grid.cells : []
  paintWidgets(cells, gridBoxes, currentBoard(), hubNow, currentWidgets(), feeds, indices, alerts, cardChrome())
  for (const idx of indices) cellPaintedAt[idx] = at
}

function render() {
  lastRenderAt = Date.now()
  // Unpaired: the grid is not rendered at all, so paintWidgets' sweep never runs. Anything the
  // last paired render left animating would keep painting a detached canvas.
  if (!paired()) {
    stopAllWidgets()
    return
  }
  $('pairing').style.display = 'none'
  $('splash').style.display = 'none'
  $('idle').style.display = 'flex'
  // Board -> CSS custom properties (theming: the eight still-DOM widgets' substitution point).
  // Applied unconditionally here, not just inside renderGrid(), because index.html's :root vars
  // (--bg/--card/--text/--dim/--info/--warn/--critical) are read by BOTH the grid layout and the
  // default idle/takeover chrome (.card, #offline, body, ...) — driving only the grid path would
  // leave the no-screen-assigned view unthemed.
  applyBoardToCss(currentBoard(), (k, v) => document.documentElement.style.setProperty(k, v))
  // Chrome -> CSS custom properties (tab-bar chrome: the eleven tokenised colours the board block does
  // not drive — hairlines, muted text, chips, borders, warn/critical surface tints, the takeover
  // overlay's own palette, on-critical text). Same unconditional placement as applyBoardToCss
  // above and the same reason: these vars are read outside the grid too.
  // The board goes in alongside the chrome map because every chrome key derives from it when the
  // theme leaves that key unset — see applyChromeToCss/CHROME_FROM_BOARD.
  applyChromeToCss(currentChrome(), currentBoard(), (k, v) => document.documentElement.style.setProperty(k, v))
  // The procedural backdrop (v10). Set on <body>'s `background` shorthand rather than through a
  // custom property, because a backdrop may be several stacked gradients plus a colour and the
  // shorthand is what composes them. `--bg` stays whatever the palette says, so anything else
  // reading it is unaffected. A user-uploaded image, when that lands, paints over this.
  document.body.style.background = boardBackground()
  // Tab bar (tabs, tab-bar behavior) — computed once per render, same as `vm` below: whether it is
  // visible depends only on `tabScreens.length`, never on which idle body (grid vs. default
  // layout) happens to be showing beneath it.
  renderTabBar()
  // Takeover semantics (it overlays the idle layout exactly as today) are independent of
  // which idle body is showing, so vm is computed once up front and the takeover block below
  // runs unconditionally — only the idle-body rendering branches on screenDef.
  const landscape = window.innerWidth > window.innerHeight
  const vm = viewModel(alerts, landscape ? 2 : 3, silenced)

  // Guarded the same way paintWidgets guards its own per-cell paint (widgets/index.mjs's own
  // docstring: "an unguarded throw here would propagate out through renderGrid to render(),
  // skipping the takeover/critical-alert block that runs after renderGrid — a design bug in one
  // clock cell must not be able to hide a critical alert"). That guard only covers a design's
  // OWN draw call; it does not cover renderGrid's surrounding DOM work (widgetHtml's per-cell HTML,
  // catchUpCatalogue, the default-layout branch's own cardHtml/chip mapping) — an exception ANYWHERE
  // in the idle body still reached this exact same trap, THE ONE THIS FILE'S OWN COMMENT ABOVE
  // ALREADY PROMISES CANNOT HAPPEN ("the takeover block below runs unconditionally"). Confirmed live
  // (a malformed cell in the active screen's grid): render() threw here, every subsequent render on
  // that screen kept throwing the same way, and the alarm — started by an EARLIER, successful
  // render — never reached the code path that could ever call stopAlarm() again. The takeover
  // overlay was stuck showing whatever it last painted, silently out of step with `alerts` (which
  // update() already applies before render() is even called), until the operator switched to a
  // different tab, whose different screenDef renders without the offending cell and finally lets a
  // render() reach the block below. That is the exact "switching tabs stops it" behaviour this bug
  // was reported with. The fix is not a second alarm-stopping call bolted onto ALERT_REMOVE
  // (a blind double-stop would still leave the takeover itself stuck showing stale content, and
  // would not save a future idle-body bug from hiding the SAME block again) — it is making this
  // function's own already-stated guarantee true.
  try {
    if (screenDef) {
      renderGrid()
    } else {
      // No screen assigned: the grid and every canvas in it is gone from view, and paintWidgets —
      // whose sweep is the only other thing that stops an animation — is not reached on this path.
      // Stop them here or they paint a hidden, detached canvas until the page reloads.
      stopAllWidgets()
      // Restore the default-layout chrome in case a prior render left it hidden for a grid
      // (empty string reverts each property to its stylesheet value).
      $('grid').style.display = 'none'
      $('alerts').style.display = ''
      $('clockpane').style.display = ''
      $('cards').style.display = ''
      $('chips').style.display = ''
      $('idle').className = landscape && alerts.length > 0 ? 'landscape-active' : ''

      $('cards').innerHTML = vm.cards.map(cardHtml).join('')
      $('chips').innerHTML = vm.chips.map((a) =>
        `<div class="chip">● ${escapeHtml(a.title)} · ${ago(a.updated_at)}</div>`).join('')
      document.querySelectorAll('[data-dismiss]').forEach((b) =>
        b.addEventListener('click', () => sendTap(b.dataset.dismiss, 'dismiss')))
      // No optimistic local state on answer: the hub records it and replies ALERT_REMOVE, and the
      // next render drops the card — the same trust-the-hub shape dismiss has always had.
      document.querySelectorAll('[data-answer]').forEach((b) =>
        b.addEventListener('click', () =>
          send({ type: 'TAP', id: b.dataset.answer, action: 'answer', option_id: b.dataset.option })))
    }
  } catch (err) {
    console.error('idle body render failed', err)
  }

  // A hosted page must not show its own takeover/alarm once the native shell explicitly owns that
  // surface — otherwise both the native TakeoverScreen and this page's #takeover can be
  // on screen at once, each sounding its own alarm (page WebAudio + native ToneGenerator
  // double-beeping). An old shell (driven, but no ownsTakeover()) still gets the web takeover —
  // that fallback is exactly why yieldTakeoverToHost requires an explicit true, not just `driven`.
  if (vm.takeover && !yieldTakeoverToHost(driven(), hostOwnsTakeover())) {
    const t = vm.takeover
    $('takeover').style.display = 'flex'
    $('takeover-meta').textContent = `🔴 CRITICAL · ${t.sender.name.toUpperCase()} · ${atTime(t.updated_at)}` +
      (vm.extraCriticalCount ? ` · +${vm.extraCriticalCount} critical` : '')
    $('takeover-title').textContent = t.title
    $('takeover-body').textContent = t.body ?? ''
    $('takeover').dataset.alertId = t.id
    if (t.id !== displayedAckId) {
      send({ type: 'ACK', id: t.id, stage: 'displayed' })
      displayedAckId = t.id
    }
    if (!alarm) startAlarm()
    updateSoundHint()
  } else {
    // Reached both when there is genuinely no takeover AND when the host just took ownership of
    // one that exists — stopAlarm() must run either way, so a page that WAS alarming when
    // ownership switched over does not keep beeping alongside the native alarm.
    $('takeover').style.display = 'none'
    stopAlarm()
    displayedAckId = null
  }
}

function sendTap(id, action) {
  send({ type: 'TAP', id, action })
  if (action === 'silence') { silenced.add(id); stopAlarm(); render() }
}

// takeover interactions: tap anywhere silences; hold dismiss 1s dismisses
$('takeover').addEventListener('click', (e) => {
  if (e.target.id !== 'dismiss-btn') sendTap($('takeover').dataset.alertId, 'silence')
})
let holdTimer = null
$('dismiss-btn').addEventListener('pointerdown', (e) => {
  // Capture the pointer for the duration of the hold: a fingertip on glass micro-slides, and
  // without capture that fires `pointerleave` near the button's edge —
  // silently cancelling the hold, so "hold to dismiss" only worked dead-center on the label.
  // With capture the button owns the pointer until release; leave/cancel still end the hold for
  // the cases that mean it (system gesture steals the pointer, finger lifts elsewhere).
  try { e.target.setPointerCapture(e.pointerId) } catch { /* capture unsupported — old engine */ }
  holdTimer = setTimeout(() => sendTap($('takeover').dataset.alertId, 'dismiss'), 1000)
})
$('dismiss-btn').addEventListener('pointerup', () => clearTimeout(holdTimer))
$('dismiss-btn').addEventListener('pointerleave', () => clearTimeout(holdTimer))
$('dismiss-btn').addEventListener('pointercancel', () => clearTimeout(holdTimer))

// --- widget pointer routing (scrollable stream) ---
// The host half of the design `pointer` contract (docs/architecture/widgets.md, "Pointer input"):
// designs run on a recording surface with no DOM (portable drawing subset), so THIS is the only place gestures are
// listened for. Listeners sit on #grid — which outlives every `grid.innerHTML` rebuild — and hits
// resolve by COORDINATES against `gridBoxes`, never by event target, so a DATA push replacing the
// canvases mid-drag does not break the gesture. A handler returning true means "my state moved";
// the cell repaints through the same per-cell path the clock tick uses.
let cellGesture = null // { idx, cell, design, x, y, lastY, startX, startY, moved }
const DRAG_SLOP_PX = 8 // finger travel below this is a tap; above it, the gesture is a drag

/** The interactive cell under a viewport point, with cell-relative CSS coords — or null. */
function pointerCellAt(clientX, clientY) {
  if (!screenDef?.grid || gridBoxes.length === 0) return null
  const rect = $('grid').getBoundingClientRect()
  const x = clientX - rect.left
  const y = clientY - rect.top
  const cells = Array.isArray(screenDef.grid.cells) ? screenDef.grid.cells : []
  for (let idx = 0; idx < cells.length; idx++) {
    const b = gridBoxes[idx]?.px
    if (!b || x < b.left || x >= b.left + b.width || y < b.top || y >= b.top + b.height) continue
    const design = designFor(cells[idx], currentWidgets())
    if (!design?.pointer) return null // cells never overlap (save-service invariant): first hit is THE hit
    // Carded cells draw with a translated origin (paintWidgets' content inset) — a tap must land
    // in the same coordinate space the design laid out in, or the arrow rail shifts under the
    // finger. cardContentInset is the paint path's own function, so the two cannot disagree.
    const inset = cardContentInset(cardChrome(), cells[idx])
    return { idx, cell: cells[idx], design, x: x - b.left - inset, y: y - b.top - inset }
  }
  return null
}

$('grid').addEventListener('pointerdown', (e) => {
  const hit = pointerCellAt(e.clientX, e.clientY)
  if (!hit) return
  cellGesture = { ...hit, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false }
  // Same capture reasoning as dismiss-btn above: glass micro-slides must not hand the drag to
  // some other element mid-gesture.
  try { $('grid').setPointerCapture(e.pointerId) } catch { /* capture unsupported — old engine */ }
})
$('grid').addEventListener('pointermove', (e) => {
  if (!cellGesture) return
  const dy = e.clientY - cellGesture.lastY
  cellGesture.lastY = e.clientY
  if (Math.abs(e.clientX - cellGesture.startX) > DRAG_SLOP_PX ||
      Math.abs(e.clientY - cellGesture.startY) > DRAG_SLOP_PX) cellGesture.moved = true
  if (cellGesture.moved && cellGesture.design.pointer.move?.(cellGesture.cell, dy)) {
    repaintCells([cellGesture.idx], Date.now())
  }
})
// The actions channel: how an interactive design sends something back out (docs/architecture/
// widgets.md, Pointer input). The host owns the socket vocabulary — a design names an alert and
// an option, and these emit the SAME wire messages the idle card buttons send, so the hub cannot
// tell which surface answered.
const cellActions = {
  answer: (alertId, optionId) => send({ type: 'TAP', id: alertId, action: 'answer', option_id: optionId }),
  dismiss: (alertId) => sendTap(alertId, 'dismiss'),
}

function endCellGesture(cancelled) {
  const gesture = cellGesture
  cellGesture = null
  if (!gesture || cancelled || gesture.moved) return
  // Never moved past the slop: a tap, delivered at the DOWN's cell-relative coords.
  if (gesture.design.pointer.tap?.(gesture.cell, gesture.x, gesture.y, cellActions)) {
    repaintCells([gesture.idx], Date.now())
  }
}
$('grid').addEventListener('pointerup', () => endCellGesture(false))
$('grid').addEventListener('pointercancel', () => endCellGesture(true))
// Wheel support costs three lines and makes the design exercisable from a desktop browser —
// the same reasoning the admin preview gets hover states the wall never sees.
$('grid').addEventListener('wheel', (e) => {
  const hit = pointerCellAt(e.clientX, e.clientY)
  if (hit?.design.pointer.wheel?.(hit.cell, e.deltaY)) {
    e.preventDefault()
    repaintCells([hit.idx], Date.now())
  }
}, { passive: false })

// Artwork lands whenever it finishes decoding, which is not on anyone's schedule. Before this the
// 1s tick doubled as the "did an image arrive?" poll, which is what made the tick impossible to
// slow down without delaying every icon on the board.
onAssetReady(() => { if (paired()) render() })

// A feed's bitmap lands whenever its fetch and decode finish, which is nobody's schedule either —
// and `image` is not on the repaint timer (widgets/repaint.mjs: its output only changes when data
// arrives), so without this subscription a decoded picture would sit behind `draw`'s back and the
// cell would show `loading image…` until the next STATE or DATA push. This is the exact repaint the
// deleted `ensureImageLoaded`'s own `.then` did with `render()`.
onBitmapReady(() => { if (paired()) render() })

// clock + status
setInterval(() => {
  // Before pairing there is no socket at all, which is not the same as being offline — don't
  // show the OFFLINE banner over the pairing form.
  if (!token()) { $('offline').style.display = 'none'; return }
  const now = new Date(Date.now() + serverOffset)
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  $('date').textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  // A driven page has no socket of its own, so `ws.readyState` would report OFFLINE forever —
  // the shell owns the connection and tells us about it through __dashboardzLink.
  const online = driven() ? hostOnline : !!(ws && ws.readyState === 1)
  $('status').textContent = online ? '● hub connected' : '○ hub offline'
  $('offline').style.display = online ? 'none' : 'block'
  if ($('idle').style.display === 'none') return
  // No screen assigned: the default layout is HTML alert cards with no canvases at all, so there is
  // nothing to repaint per-cell and the board-level rule is the whole answer.
  if (!screenDef) {
    const period = boardRepaintPeriod(screenDef, alerts.length)
    if (period !== null && Date.now() - lastRenderAt >= period) render()
    return
  }
  const at = Date.now()
  // A cell can be repainted on its own when it draws into a canvas AND the last full render left a
  // box for it. The second half matters between a screen arriving and the render that lays it out:
  // there is no geometry to paint into yet, and a full render is what produces it.
  const plan = repaintPlan(screenDef, at, cellPaintedAt,
    (cell, idx) => !!designFor(cell, currentWidgets()) && !!gridBoxes[idx])
  if (plan.kind === 'none') return
  if (plan.kind === 'full') render()
  else repaintCells(plan.cells, at)
}, 1000)
/**
 * Re-decide the board's rotation for the current viewport. `render()` is only called when the
 * class actually CHANGED, because that is exactly when the grid's layout box resized and every
 * canvas backing store needs rebuilding; calling it unconditionally would double every render.
 *
 * The native lock is attempted first and its result deliberately ignored: when it works (Android
 * Chrome in fullscreen) the viewport itself changes and the next resize settles to no rotation,
 * and when it is refused — desktop, or not fullscreen — the counter-rotation already handled it.
 */
function applyOrientation() {
  if (!wantedOrientation) return
  tryNativeLock(wantedOrientation, globalThis.screen)
  const changed = applyRotation(wantedOrientation, {
    root: document.body,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
  })
  if (changed) render()
}

/**
 * Tell the hub when our box changes. The editor designs against this, so a rotation or a
 * resize that never reached the hub would leave an operator laying out cards against a shape the
 * device no longer has.
 *
 * Only on an actual CHANGE, and debounced: a drag-resize fires `resize` continuously, and a phone
 * rotating fires several as the animation settles. HEALTH is the existing channel for "facts about
 * this device right now", so this needs no new message type.
 */
let reportedViewport = ''
let viewportTimer = null
function reportViewportIfChanged() {
  const vp = viewport()
  const key = `${vp.w}x${vp.h}@${vp.dpr}`
  if (key === reportedViewport) return
  reportedViewport = key
  clearTimeout(viewportTimer)
  viewportTimer = setTimeout(() => send({ type: 'HEALTH', viewport: vp }), 400)
}

window.addEventListener('resize', () => { applyOrientation(); render(); reportViewportIfChanged() })
window.addEventListener('orientationchange', applyOrientation)

/**
 * The shell's inbound surface. Installed unconditionally so the native side can call it the moment
 * the page reports ready, without racing this module's evaluation. Both are total: a malformed
 * payload from the bridge must not take the board down, exactly as a malformed socket frame
 * must not.
 */
globalThis.__dashboardzDeliver = (json) => {
  try { handleMessage(typeof json === 'string' ? JSON.parse(json) : json) }
  catch (err) { console.error('bridge deliver failed', err) }
}
/**
 * Link state, reported by the host. A driven page owns no socket, so `ws.readyState` says nothing
 * about whether the board is connected — the 1s tick below reads `hostOnline` instead when driven.
 * Starts true so a board that has just loaded does not flash OFFLINE before the first report.
 */
globalThis.__dashboardzLink = (online) => {
  hostOnline = !!online
  $('offline').style.display = hostOnline ? 'none' : 'block'
}

// Driven pages never dial out (see the transport seam above); the shell connects for them.
if (!driven() && token()) connect()
if (driven()) { render(); try { host().ready() } catch { /* older shell without ready() */ } }
// Only now that this module has actually run does "unpaired" mean anything: swap the boot splash
// (the no-JavaScript default in index.html) for the pair form. A page that never gets here —
// module fetch killed by a flaky network mid-reload — keeps the splash, which is the honest
// state for a board that merely failed to boot.
if (!paired()) {
  $('splash').style.display = 'none'
  $('pairing').style.display = 'grid'
}
