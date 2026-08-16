# Board runtime

[`hub/static/device`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/static/device) is the board: the page every
device renders, served by the hub at `/device`. It is plain ES modules with no
build step. A browser opens it directly; the Android app hosts the same page in
a WebView. Widget drawing lives one folder down, in
[`widgets/`](widgets.md). Behaviour is specified in
[Devices](../architecture/devices.md) and [Theming](../theming.md).

## Start here

1. [`index.html`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/index.html): the DOM skeleton (splash,
   pairing form, idle clock, alert cards, grid, tab bar, takeover, offline
   banner) and the built-in `:root` colour variables. Loads `device.js`.
2. [`device.js`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/device.js): the entry module and the only
   file that touches the DOM, the socket and audio. `connect()` opens
   `/ws/device` and sends `HELLO`; `handleMessage()` is the switch over every
   server message; `render()` and `renderGrid()` draw.
3. [`device-core.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/device-core.mjs): the pure logic
   `device.js` delegates to: the alert reducer, sorting and view model, tab
   resolution, the tab bar model, and whether to yield the takeover to a
   native host.

## The pure modules

| File | What it owns |
| --- | --- |
| [`layout-core.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/layout-core.mjs) | Fit and overflow rules: rect helpers (`rectValid`, `rectsOverlap`, `quantize`, `RECT_MIN`), size ramps, `resolvePath`, value formatting, per-widget config normalisers, staleness. Shared with the admin editor. |
| [`theme.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/theme.mjs) | Theme cache keyed by `id:rev`, built-in board and chrome, chrome derived from the palette, backdrops, CSS variable application. |
| [`orientation.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/orientation.mjs) | Makes a portrait or landscape board read correctly by counter-rotating with CSS when the hardware will not lock. |

[`hub/static/sounds`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/static/sounds) holds the sample families
(`bells`, `8bit`; `classic` is synthesised) and
[`manifest.json`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/sounds/manifest.json), which the hub reads to
resolve sounds. `hub/scripts/gen-sounds.mjs` regenerates the WAV files.

## How it connects

- **Standalone browser.** The pairing form posts to `/api/pair` and stores
  `device_token` in `localStorage`; `connect()` reconnects with backoff, and
  close code 4001 wipes the token and reloads into pairing.
- **Hosted by Android.** The shell installs `globalThis.__dashboardzHost`
  before the page loads. `device.js` then never opens a socket: the shell
  feeds raw hub frames in through `__dashboardzDeliver(json)`, reports link
  state through `__dashboardzLink(online)`, and hands over its token for the
  page's own authenticated GETs (theme documents, image feeds). See
  [Android app](android.md).
- **Data.** `STATE` sets tabs, theme and alerts; `DATA` updates feed payloads;
  each canvas cell is painted by `paintWidgets` from
  [`widgets/index.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/index.mjs).

## Things that trip people up

- **Two sockets per device fight forever.** The hub closes the older socket
  with 4000, so a hosted page that dialled out would ping-pong with the shell.
  `driven()` is the guard; keep any new network code behind it.
- **The board must never go blank.** Theme fetch failures keep the last good
  theme and render built-in defaults until the first success; bad config
  degrades a single cell, never the page.
- **A stale page can outlive a hub upgrade.** Scripts are served `no-store`
  for that reason, and `RELOAD` from the admin forces a reload. The page also
  reloads itself (with backoff) when it meets a design id it cannot draw; see
  `designsNeedingReload` in `widgets/index.mjs`.
- **The built-in palette exists in three places**: `index.html` `:root`,
  `theme.mjs` `BUILTIN_BOARD` and `hub/src/themeDefaults.ts`. Tests pin them
  together (`migrateV7.test.ts`, `deviceTheme.test.ts`).
- **The layout rules had a Kotlin twin, now retired.** `layout-core.mjs` is
  the only implementation; its contract is the vectors in
  [`hub/test/fixtures/data-widget-vectors.json`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/fixtures/data-widget-vectors.json).

## Tests

Pure modules are unit-tested from the hub suite: `device-core.test.ts`,
`layout-core.test.ts`, `tabs-core.test.ts`, `deviceTheme.test.ts`,
`themeApply.test.ts`, `chromeDerivation.test.ts`, `backdrop.test.ts`,
`device-orientation.test.ts`, `deviceViewport.test.ts`. Tests that need real
layout or audio (`board-overflow.test.ts`, `splash.test.ts`,
`tab-blink.test.ts`, `device-alarm-guard.test.ts`,
`device-sound-playback.test.ts`) drive a real Chrome through
[`hub/test/support/browser.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/support/browser.ts) and skip when
no Chrome is installed.
