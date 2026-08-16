# Screens and widget contracts

Three small folders decide what a screen may contain and which data can feed
which widget, on the server side:

- [`hub/src/screens`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/screens): the grid schema, the save service,
  the starter screen and the machine-readable widget contract.
- [`hub/src/widgets`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/widgets): which feeds and source outputs are
  compatible with which widget.
- [`hub/src/data`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/data): data contracts (canonical payload shapes)
  and the capability vocabulary used to compare a feed with a widget.

The rendering side of widgets lives in the browser; see
[Widget designs](widgets.md). The author-facing rules are in
[How to build a screen](../architecture/screens.md), the
[widget design contract](../architecture/widgets.md) and
[Data sources](../architecture/data.md).

## Start here

1. [`screens/cellSchema.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/cellSchema.ts): the JSON
   Schema for a grid and each cell (`rectSchema`, `cellSchema`, `gridSchema`,
   `RECT_MIN`, `RECT_QUANTUM`). AJV in
   [`routes/admin/screens.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/screens.ts) validates
   every save against it.
2. [`screens/save.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/save.ts): `saveScreenWithSources`,
   the one way a screen is written. It also owns `WIDGET_FEED_MODES` (which
   feed modes each generic widget accepts).
3. [`widgets/requirements.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/widgets/requirements.ts): the three
   semantic widgets (`weather_forecast`, `news_list`, `calendar_events`) and
   the contract and capabilities each requires; `compatibleOutput` and
   `compatibleGeneric`.

## A screen save

1. AJV checks the body against `gridSchema` (shape, known widgets, known
   config keys).
2. `saveScreenWithSources` validates the whole grid against the database:
   bound feeds exist and fit, rects do not overlap, and any *pending* binding
   (`source_draft_id` plus `output_contract`, a source that has only been
   previewed) still points at a live draft.
3. In one transaction it promotes each referenced draft into a real source
   and feed ([`sources/drafts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/drafts.ts)
   `materializeSourceDraft`), rewrites the pending bindings to the new feed
   ids, re-validates, and creates or updates the row with a revision check
   (`expected_rev`; a mismatch is a 409).
4. The route then pushes `STATE` to every device carrying the screen and
   announces any feeds the promotion filled.
5. The response carries `warnings[]`: advisory compatibility notes. A save
   with warnings has been written.

## The other files

| File | What it owns |
| --- | --- |
| [`screens/widgetContract.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/widgetContract.ts) | Builds `GET /admin/api/widget-contract` from `cellSchema` itself, with a content-hash `revision`. The MCP server reads it at startup. |
| [`screens/starter.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/starter.ts) | The one-cell clock screen a newly paired device gets. |
| [`data/contracts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/data/contracts.ts) | Contract ids (`dashboardz.weather.daily-forecast/v1`, `dashboardz.news.items/v1`, `dashboardz.calendar.events/v1`, the legacy value/stream/image contracts) and `validateContractOutput`, used by the source runtime. |
| [`data/needs.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/data/needs.ts) | What a generic widget needs at its bound `path`: four types (`number`, `scalar`, `array<object>`, `binary`) and three scopes. |
| [`data/feedCapabilities.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/data/feedCapabilities.ts) | What a feed, or a draft's preview, demonstrably produces, computed from its payload. |

## How it connects

Used by [`routes/admin/screens.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/screens.ts)
(saves), [`routes/admin/feeds.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/feeds.ts)
(`feed-fit`, the widget contract) and
[`routes/sourceAdmin.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/sourceAdmin.ts) (source choices
for a widget). The source runtime validates every output against
`data/contracts.ts` before writing it.

## Things that trip people up

- **Hub TypeScript cannot import the browser modules.** `hub/tsconfig.json`
  sets `rootDir: src`, so rules shared with `hub/static/device` are
  duplicated and pinned by tests: `WIDGET_FEED_MODES` against
  `widgets/bindings.mjs` (`widget-bindings.test.ts`), `CHART_ICONS` against
  `layout-core.mjs` (`layout-core.test.ts`), the rect rules against
  `layout-core.mjs`.
- **A grid PATCH replaces the whole grid.** There is no cell-level diff.
- **Two compatibility vocabularies.** Semantic widgets compare contract ids
  and capability names; generic widgets compare feed mode plus the type found
  at `config.path`. `compatibleGeneric` is the second.
- **Adding a widget or config key** means editing `cellSchema.ts`, the
  browser definitions and designs, and the screens doc; `screens-doc.test.ts`
  and `widget-contract.test.ts` fail until all agree.

## Tests

`screensApi.test.ts`, `screenLostUpdate.test.ts` (409 handling),
`screenSourcePromotion.test.ts`, `screens-doc.test.ts`,
`widget-contract.test.ts`, `widgetRequirements.test.ts`,
`generic-compatibility.test.ts`, `feed-fit-semantic.test.ts`,
`data-needs.test.ts`, `dataContracts.test.ts`, `option-bounds.test.ts`,
`pairStarter.test.ts` in [`hub/test`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test).
