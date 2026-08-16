# Admin UI

[`hub/admin`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/admin) is the React and TypeScript control panel the hub
serves at `/admin`. It is a separate npm package built with Vite into the
ignored `hub/static/admin/`. It holds no business rules: every decision
(validation, pairing, alert state) is made by the hub's
[`/admin/api/*` routes](hub-routes.md). Its own
[README](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/README.md) covers the commands and the dev proxy.

## Start here

1. [`src/main.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/main.tsx) mounts
   [`src/App.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/App.tsx): the login gate, the relay badge
   and ten tabs (Devices, Alerts, Screens, Widgets, Feeds, Themes, Senders,
   Agents, Activity, Storage). The selected tab is remembered in
   `localStorage`.
2. [`src/api.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/api.ts): the single `fetch` wrapper. Sends
   the session cookie, throws the hub's `{error}` text, and a 401 returns the
   app to the login screen.
3. [`src/pages/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/admin/src/pages): one component per tab, each with a
   colocated `*.test.tsx`.

## The screen editor

The largest part of the panel, spread over several files:

| File | Role |
| --- | --- |
| [`pages/Screens.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Screens.tsx) | Screen list, editor state, save (sends `rev`, shows `warnings`), sounds, tab bar position. |
| [`pages/LayoutCanvas.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/LayoutCanvas.tsx) | Drag and resize cards on the target device's real aspect. |
| [`layout-edit.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/layout-edit.ts) | Editor-only geometry: pointer gestures to rects. Shared rules come from `layout-core.mjs`. |
| [`pages/CellConfig.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/CellConfig.tsx) | Per-cell settings form, built from the design's `meta.options` through [`widget-options.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/widget-options.ts). Its design list puts the screen theme's suggested designs first ("Suggested by …", then "All designs"), named by `designLabel` in `design-registry.ts`. |
| [`pages/DataSourcePicker.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/DataSourcePicker.tsx) | Feed picker for generic widgets, filtered by `GET /admin/api/feed-fit`. |
| [`pages/SourceSetupDialog.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/SourceSetupDialog.tsx) | Weather, news and calendar setup: tests a source draft and binds it as a pending binding. |
| [`pages/WidgetPreview.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/WidgetPreview.tsx) | Live preview that paints the real device designs on a canvas. |
| [`pages/WidgetGallery.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/WidgetGallery.tsx), [`pages/Widgets.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Widgets.tsx) | Widget picker and the catalogue tab. |
| [`design-registry.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/design-registry.ts) | Registers the device catalogue and resolves the design a cell will render with. |

## Other pages and helpers

[`pages/Feeds.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Feeds.tsx) is labelled **Data
sources** in the UI (persistent sources plus raw push feeds; its tests are
`DataSources.test.tsx` and `Feeds.test.tsx`). A pushed feed's row flags a
current rejected push from `last_rejected`, and its **Inspect** panel shows the
last accepted and last rejected push and refreshes with the 5 second poll.
[`pages/Devices.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Devices.tsx) mints pairing codes;
[`pages/ConnectDevice.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/ConnectDevice.tsx) shows the code, the QR and the hub address to type,
picked by [`hubAddress.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/hubAddress.ts) (`PUBLIC_URL`, else the browser's own address, else the
hub's detected LAN address; the QR carries the same answer). [`pages/Login.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Login.tsx)
is the sign-in page, styled like the device pair screen rather than the workbench. [`pages/Themes.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Themes.tsx),
[`pages/Alerts.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Alerts.tsx),
[`pages/Agents.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Agents.tsx),
[`pages/Senders.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Senders.tsx),
[`pages/Activity.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Activity.tsx) (audit log) and
[`pages/Storage.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Storage.tsx) map one to one onto
their routes. Shared pieces: [`RelayBadge.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/RelayBadge.tsx)
(relay status and config), [`SoundMixer.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/SoundMixer.tsx)
with [`sounds.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/sounds.ts),
[`confirm.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/confirm.tsx) (in-app destructive confirm),
[`MultiSelect.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/MultiSelect.tsx) (a button that opens a filterable list of checkboxes; the feed form's allowed senders),
[`docs.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/docs.ts) (the docs base URL).

## How it connects

The admin imports browser modules from
[`hub/static/device`](device-runtime.md) directly: `layout-core.mjs` for rect
rules, `widgets/catalogue.mjs`, `registry.mjs`, `definitions.mjs`,
`bindings.mjs`, `tokens.mjs` and `surface.mjs` for previews. What the operator
sees in the preview is drawn by the same code as the board.

## Things that trip people up

- **Build before running hub tests.** `hub/test/server.test.ts` serves the
  built bundle; a fresh checkout has none until
  `npm --prefix hub/admin run build`.
- **The admin cannot import `widgets/index.mjs`.** It pulls in `assets.mjs`,
  whose `new URL(..., import.meta.url)` sprite globbing Vite refuses outside
  the project. That is why `catalogue.mjs` is a separate module, and why
  `vite.config.ts` externalises `assets.mjs` for tests only.
- **Plain `.mjs` imports need `// @ts-expect-error`**, since the device
  modules have no type declarations.
- **The admin keeps its own copy of the sound event list** in `sounds.ts`,
  mirroring `hub/src/sounds.ts`.
- **Docs links are pinned.** `Agents.test.tsx` pins `docs.ts` to
  `mkdocs.yml`'s `site_url`, and `hub/test/remote-access-doc.test.ts` pins the
  relay badge's link.

## Tests

Vitest with jsdom and Testing Library, colocated as `src/**/*.test.ts(x)`; run
with `npm --prefix hub/admin test`. Lint is Oxlint
([`.oxlintrc.json`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/.oxlintrc.json)); typecheck is `tsc -b`.
