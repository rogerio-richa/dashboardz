# Theme packs

[`hub/packs/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/packs) checks a theme pack (a theme plus its own
widget designs) against the hub's own rules. It is plain ESM with no
dependencies, so the command-line checker runs with bare `node`, and the hub's
tests call the same functions for the built-in themes and designs. The
format and the authoring guide are in [Make a theme pack](../theme-packs.md).

## Start here

1. [`packs/index.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/index.mjs): `checkPack({ manifest, designs })`,
   the entry point, plus `catalogueIds()`. Takes a pack already in memory;
   reading files and importing modules is the caller's job.
2. [`packs/theme.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/theme.mjs): `checkManifest`, `checkTheme` and
   `checkContrast` (the WCAG floors the built-in themes are held to;
   `builtinThemes.test.ts` calls it).
3. [`packs/design.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/design.mjs): `checkDesign`, `unpaintedTokens`
   (driven through the widget's sample contexts; `portable-subset.test.ts`
   calls it) and `drawFailures`.
4. [`hub/scripts/check-pack.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/scripts/check-pack.mjs): the command-line checker.
   Reads a pack folder, scans each design before importing it, prints
   findings, and with `--previews` draws PNGs through
   [`packs/preview.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/preview.mjs) (headless Chrome over CDP with Node's
   built-in `WebSocket`).
5. Installing from the admin: [`hub/src/routes/admin/packs.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/packs.ts) (check, install, list, remove; owner only, off with `PACKS_ENABLED=false`), [`hub/src/packStore.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/packStore.ts) (files under `<DATA_DIR>/packs/`), [`hub/src/db/packs.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/packs.ts) (the v30 `packs` table), [`hub/src/routes/packs.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/packs.ts) (serves `/packs/index.json` and the designs, `no-store`), [`hub/static/device/widgets/packs.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/packs.mjs) (loads installed designs before the board or the admin renders) and [`hub/admin/src/pages/Packs.tsx`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/admin/src/pages/Packs.tsx) (the install card on the Themes tab).

## The other files

| File | What it owns |
| --- | --- |
| [`packs/scan.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/scan.mjs) | `scannableSource`, `ALLOWED_G_OPS`, `BROWSER_API`, `scanSource` (drawing calls, browser APIs, imports). `test/source-scan.ts` re-exports `scannableSource`. |
| [`packs/findings.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/findings.mjs) | The `Finding` shape: `{ level, where, rule, message }`. |
| [`packs/rules.generated.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/packs/rules.generated.mjs) | Generated from the hub's TypeScript by [`hub/scripts/gen-pack-rules.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/scripts/gen-pack-rules.ts): each widget's settings, the theme limits, the sound events. |
| [`examples/theme-packs/vintage`](https://github.com/rogerio-richa/dashboardz/tree/main/examples/theme-packs/vintage) | The worked example pack; `test/example-pack.test.ts` keeps it passing with no findings. |

## Things that trip people up

- **Regenerate the rules after a schema change.** Changing a widget's cell
  schema, the theme schema or the sound events makes
  `packs-rules-mirror.test.ts` fail until you run
  `npx tsx scripts/gen-pack-rules.ts` in `hub/`.
- **Messages are for newcomers.** Each says what is wrong and what to do, in
  plain words; `rule` is the stable id tests assert on.
- **Pack-only rules.** No imports, the `designs/<widget>/<id>.mjs` path and the
  id prefix apply to pack designs only; built-in designs import shared helpers
  and keep their folders.
- **`design_options`** is accepted on every widget by
  [`cellSchema.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/cellSchema.ts), with its 2 KB total enforced in
  [`save.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/save.ts). A design's own settings must live there.

## Tests

`packs-rules-mirror.test.ts`, `packs-theme.test.ts`, `packs-design.test.ts`
(including every built-in design passing the shared rules),
`check-pack-cli.test.ts` (previews skip without Chrome) and
`example-pack.test.ts`. See [Hub tests](hub-tests.md).
