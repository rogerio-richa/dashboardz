# Widget designs

[`hub/static/device/widgets`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/static/device/widgets) holds every
widget design and the plumbing that paints them. A **widget** is a type a cell
can hold (`clock`, `gauge`, `chart`, ...); a **design** is one way of drawing
it (`clock/segment`, `gauge/ring`, ...). Designs are canvas-only ES modules
shared by the board and the admin preview. The author-facing contract (meta
shape, the portable drawing subset, the draw context, degradation) is
[The widget design contract](../architecture/widgets.md); this page is about
where things are.

## Start here

1. [`catalogue.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/catalogue.mjs): `CATALOGUE`,
   the list of every shipped design. Adding a design means adding one import
   and one entry here.
2. One small design, for example
   [`clock/digital.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/clock/digital.mjs): a
   default export of `{ meta, draw(g, ctx) }`. `meta` declares id, widget,
   label, tokens, options and animations; `draw` paints into `ctx.box` using
   only `g` (a canvas-like surface) and `ctx`.
3. [`index.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/index.mjs): what `device.js`
   calls. `paintWidgets` builds each cell's `ctx` (data, rows, series, feed
   freshness, tokens, assets, bitmap) and calls the design's `draw`;
   `designFor` picks the design (cell, then theme, then default).

## Designs by folder

`clock/` (digital, segment, analog, flip, nixie), `gauge/` (bar, ring,
battery, plus `shared.mjs`), `value/` (tile, statusbar), `text/` (block, led),
`stream/` (list, scroll, chat, ticker, plus `scroll-core.mjs`), `chart/`
(plot, candles), `table/grid`, `image/frame`, `alert/feed`, `weather/forecast`,
`news/list`, `calendar/agenda`. A folder may carry its own `assets/` (the nixie
glyph sheet).

## The plumbing

| File | What it owns |
| --- | --- |
| [`registry.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/registry.mjs) | `register`, `lookup`, `defaultDesignFor`, and `validateOptions` for `meta.options`. An unknown design id resolves to the widget's default. |
| [`definitions.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/definitions.mjs) | `WIDGET_DEFINITIONS`: widget *types*, data only, with samples for previews. |
| [`bindings.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/bindings.mjs) | `WIDGET_BINDINGS`: which feed modes each generic widget accepts, and its needs at the bound path. |
| [`tokens.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/tokens.mjs) | Colour token resolution: theme widget token, then palette, then the design's default. |
| [`surface.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/surface.mjs) | The canvas placeholder HTML and DPR-correct `prepare`. |
| [`loop.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/loop.mjs) | The single `requestAnimationFrame` loop; idles to zero frames. |
| [`repaint.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/repaint.mjs) | Timer repaints for output that changes with the clock (clocks, relative ages). |
| [`assets.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/assets.mjs), [`bitmaps.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/bitmaps.mjs) | Async loading of design artwork (`ctx.assets`) and image-feed bitmaps (`ctx.bitmap`); each announces when ready so the host repaints. |
| [`text-fit.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/text-fit.mjs), [`clock-geometry.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/static/device/widgets/clock-geometry.mjs) | Shared shrink-to-fit text and clock geometry helpers. |

## How it connects

`device.js` imports `index.mjs`; the admin imports `catalogue.mjs`,
`registry.mjs`, `definitions.mjs`, `bindings.mjs`, `tokens.mjs` and
`surface.mjs` (never `index.mjs`, see [Admin UI](hub-admin.md)). On the server,
the cell schema in
[`hub/src/screens/cellSchema.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/cellSchema.ts) must know
every widget and config key, and
[`hub/src/screens/save.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/save.ts) mirrors
`WIDGET_BINDINGS` as `WIDGET_FEED_MODES`.

## Things that trip people up

- **Catalogue order is load-bearing.** With no design marked default, the
  first registered design for a widget is the default; reordering changes how
  existing saved cells draw.
- **Designs may not touch the DOM.** No `document`, no `new Image()`, no
  timers: `g` must be swappable for a recording surface.
  `portable-subset.test.ts` scans design source (comments blanked) to enforce
  it. The host loads assets; the design just draws.
- **One animation loop.** A design that animates exposes
  `isAnimating(ctx)`; it never starts its own timer.
- **A new widget is more than a design.** It needs a definition, bindings,
  the hub cell schema, the admin's knobs, and the screens doc. The
  `knob-coverage.test.ts`, `meta-options.test.ts`, `widget-definitions.test.ts`
  and `screens-doc.test.ts` guards fail until they agree.
- **New design, stale admin.** The admin gallery only shows a design after
  `npm --prefix hub/admin run build`.

## Tests

One `widget-*.test.ts` or `clock-*.test.ts` per design family in
[`hub/test`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test), mostly driving `draw` against a recording surface,
plus `widget-paint.test.ts`, `widget-registry.test.ts`,
`widget-definitions.test.ts`, `widget-bindings.test.ts`,
`widget-tokens.test.ts`, `widget-surface.test.ts`, `widget-loop.test.ts`,
`widget-repaint.test.ts`, `widget-minimum.test.ts`,
`catalogue-staleness.test.ts`, `text-fit.test.ts` and the guards named above.
