# Hub tests

[`hub/test`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test) is one flat Vitest suite for the server, the board
runtime and the widget designs. Files are named after what they test, so the
quickest way in is to search for the module name. Run it with
`npm --prefix hub test`, or one file with `npx vitest run test/notify.test.ts`
from inside `hub/`.

## Setup facts

- [`vitest.config.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/vitest.config.ts) includes
  `test/**/*.test.ts`. Tests run with `hub/` as the working directory, and
  several read files by paths relative to it (`../docs/...`).
- Most tests build a real server in process:
  `buildServer({ config, db: openDb(':memory:') })` and drive it with
  `app.inject`. [`support/inject.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/support/inject.ts) keeps
  those calls type-safe.
- No test touches the network. Providers get a canned `fetch`; fixtures live
  in [`fixtures/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test/fixtures).
- Test files are typechecked: `npm --prefix hub run typecheck` uses
  `tsconfig.check.json`, and
  [`scripts/check-typecheck-scope.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/check-typecheck-scope.mjs)
  first fails if any test file is missing from the compiler's program.
- The server test serves the built admin bundle, so run
  `npm --prefix hub/admin run build` once on a fresh checkout.

## Kinds of test

| Kind | Examples | Notes |
| --- | --- | --- |
| Module unit tests | `alerts.test.ts`, `ttl.test.ts`, `sourceRun.test.ts` | Named after the `src` module. |
| HTTP API tests | `screensApi.test.ts`, `feedsPush.test.ts`, `notify.test.ts` | `app.inject` against a real server. |
| Migration tests | `migrate.test.ts`, `migrateV19.test.ts` | Build an old schema with `migrate(db, { targetVersion })`, then upgrade. |
| Design tests | `widget-gauge.test.ts`, `clock-nixie.test.ts`, `widget-paint.test.ts` | Call `draw` against a recording surface and assert what was drawn. |
| Shared vectors | `layout-core.test.ts` with [`fixtures/data-widget-vectors.json`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/fixtures/data-widget-vectors.json) | The contract for the layout rules. |
| Real-browser tests | `board-overflow.test.ts`, `splash.test.ts`, `widget-chart.test.ts` | [`support/browser.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/support/browser.ts) drives a local Chrome over CDP; skipped when none is found. |
| Journeys | `e2e.test.ts`, `widgetFirstJourney.test.ts` | Real listening server, real WebSocket, in-memory SQLite. |

## Tests that pin documents

These read a doc and the code that enforces it, and fail when either moves
alone. When one fails, fix whichever side is wrong; never weaken the check.

| Test | Pins |
| --- | --- |
| `screens-doc.test.ts` | [How to build a screen](../architecture/screens.md) against `cellSchema.ts` and the catalogue: every widget and config key. |
| `contract-doc.test.ts` | [The widget design contract](../architecture/widgets.md): its worked example quotes `text/block.mjs` byte for byte, and its coverage count, list knobs and widget needs match the code. |
| `remote-access-doc.test.ts` | [Remote access](../remote-access.md): exists, in the nav, linked from the README and the relay badge. |
| `skill-doc.test.ts` | `clients/mcp/SKILL.md`, `clients/openclaw/SKILL.md`, `integrations/claude/SKILL.md` against the MCP tool table and the answer route. |
| [`code-docs.test.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/code-docs.test.ts) | These docs/code pages, through [`scripts/check-code-docs.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/check-code-docs.mjs). |

## Tests that read source as text

Guards that grep code rather than run it, built on
[`source-scan.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/source-scan.ts) (blanks comments so prose
cannot satisfy them) and
[`reachable-config-reads.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/reachable-config-reads.ts):

- `knob-coverage.test.ts`: every config key the schema accepts is read by
  reachable renderer code.
- `portable-subset.test.ts`: designs use no browser API beyond `g` and `ctx`.
- `sourceArchitecture.test.ts`: one scheduler, every provider has a widget.
- `themeCoverage.test.ts`: no bare hex colours outside `:root`.

## Tests that pin duplicated code

Some rules exist twice because the two sides cannot import each other:

| Pair | Test |
| --- | --- |
| `hub/src/relay/envelope.ts` and `clients/sender/src/envelope.ts` | `envelope.test.ts` here and in `clients/sender/test` share one vector |
| `WIDGET_FEED_MODES` (`screens/save.ts`) and `WIDGET_BINDINGS` (`widgets/bindings.mjs`) | `widget-bindings.test.ts` |
| `CHART_ICONS` in `cellSchema.ts` and `layout-core.mjs` | `layout-core.test.ts` |
| Built-in palette in `themeDefaults.ts`, `theme.mjs` and `index.html` | `migrateV7.test.ts`, `deviceTheme.test.ts` |
| Editor widget list in `hub/admin/src/layout-edit.ts` | `widget-definitions.test.ts` |

## Elsewhere

Other packages keep their own suites: `hub/admin/src/**/*.test.tsx`,
`relay/test`, `clients/*/test`, `integrations/claude/assistant/test`,
`integrations/meshtastic/test_*.py`, `apps/android/app/src/test`. Two of them
import hub source directly: [`relay/test/e2e.test.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/test/e2e.test.ts)
and [`clients/mcp/test/hub-pin.test.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/test/hub-pin.test.ts),
so they need `hub/node_modules` installed.
