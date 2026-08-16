import { CONTRACTS } from '../data/contracts.js'

/**
 * The cell/grid JSON-schema constants: ONE home, reachable by AJV (`admin.ts`'s route schemas),
 * the served widget-contract endpoint, and the tests. Before this module existed these were a
 * route-local const inside `adminRoutes` (`hub/src/routes/admin.ts`), never exported — which
 * forced `screens-doc.test.ts` and `option-bounds.test.ts` to regex `admin.ts`'s SOURCE TEXT to
 * see the schema at all. That broke the moment the `boundOrPending` reshape moved config
 * properties across a source region a regex was keyed to, and it can break again the same way
 * for any future reshape — a text reader has no way to know it stopped matching. Importing this
 * module as a plain object removes that whole failure mode: a reader here walks the real schema,
 * not a guess about where its properties sit in a file.
 */

/**
 * The shared CHART_ICONS enum both renderers draw glyphs for (shared data-widget contract,
 * chart behavior). Duplicated here as a plain array — not imported — because this file is TS/Node and
 * `hub/static/device/layout-core.mjs` is browser-loaded plain ESM with no build step, so there is
 * no shared module the two sides can both import. `layout-core.test.ts`'s
 * "admin.ts CHART_ICONS is byte-identical to layout-core.mjs CHART_ICONS" test cross-checks this
 * EXACT export against `layout-core.mjs`'s `CHART_ICONS` (imports both, asserts equality) — that
 * test is what keeps the two lists honest, not this comment; if it ever fails, the two lists have
 * drifted and the fix is to update whichever one is wrong. (The neighbouring "chart constants"
 * test only pins layout-core's own copy; it never reads this file.)
 */
export const CHART_ICONS = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'heart', 'bolt', 'drop', 'sun', 'moon', 'flag']

/**
 * Widget config binding contract (data widgets design — widget registry + shared
 * binding contract). Every bindable widget's config carries `feed` (a feed id, existence and
 * mode checked by the save service — AJV can't see the DB) and an optional `path` into
 * that feed's payload; `scale` (0.5..2) is the shared resize knob. Per-widget mode rules:
 * stream_list/table read naturally off a stream feed's rows, a value feed needs an explicit
 * `path` to the array a table should render, gauge needs a numeric `min` < `max`, and no
 * widget may bind to an image feed (image feeds render, they aren't queried). text_block is
 * the one config-level XOR: literal `text` OR a `feed`+`path` binding, never both, never
 * neither.
 */
const bindProps = { feed: { type: 'string', minLength: 1, maxLength: 84 }, path: { type: 'string', maxLength: 200 } }
const scaleProp = { scale: { type: 'number', minimum: 0.5, maximum: 2 } }
/**
 * `text_block`/`led`'s own knobs, nested under one key the way `clamp`/`overflow`/`ticker` are.
 * Spread onto BOTH text_block branches: a sign is a sign whether its words are literal or arrive
 * off a feed, and a design must not be reachable from only one half of a widget's XOR.
 *
 * `color`/`colors` are hex STRINGS, deliberately: they override the theme tokens for a panel
 * someone picked a colour for on purpose. The design validates the shape before it can ever become
 * a `fillStyle` — this schema only bounds the length.
 */
const ledProp = { led: { type: 'object', additionalProperties: false, properties: {
  lines: { type: 'integer', minimum: 1, maximum: 6 },
  color: { type: 'string', maxLength: 7 },
  colors: { type: 'string', maxLength: 64 },
  effect: { enum: ['none', 'scroll', 'blink', 'rainbow', 'wipe', 'snow'] },
  speed: { type: 'number', minimum: 0, maximum: 400 },
  off_dots: { type: 'boolean' },
  glow: { type: 'boolean' },
  // The marquee ring: a sign's border lamps are separate hardware from its matrix, so they get
  // their own pattern and their own colour.
  border: { enum: ['none', 'chase', 'blink', 'alternate'] },
  border_color: { type: 'string', maxLength: 7 },
} } }
/**
 * Whether this cell is drawn as a card when the theme's backdrop is `cards` (device-web
 * paintWidgets — the pipeline paints the card, not any design). `false` opts a cell OUT of the
 * card chrome (a title strip sitting directly on the board, e.g.); unset/`true` means "card when
 * the theme says cards". Accepted on EVERY widget for the same reason `design` is: cell chrome is
 * not a per-widget feature, and a widget gaining it later must not need a migration. NOT a
 * `meta.options` knob — it is read by the pipeline, not by a design (same rule as `sound_info`).
 */
const cardProp = { card: { type: 'boolean' } }
/**
 * Which library design draws this widget (web-renderer boundary). Accepted on EVERY widget from the start —
 * one field and a default — so a widget gaining designs later needs no migration. The value
 * is not enumerated here on purpose: the catalogue lives in the renderer and grows without a
 * hub release, and an unknown id degrades to the widget's default design at render time
 * rather than being rejected at save time.
 */
const designProp = { design: { type: 'string', minLength: 1, maxLength: 40 } }
const pendingBindingProps = {
  source_draft_id: { type: 'string', pattern: '^drf_[A-Za-z0-9_-]{1,80}$', maxLength: 84 },
  output_contract: { enum: Object.keys(CONTRACTS) },
}
/**
 * ONE definition of "a binding is a feed id, or a promise about a source that does not exist
 * yet". Every widget that binds a feed uses it, so the pending half cannot be added to one
 * branch and forgotten on another — which is how the mode tables drifted.
 *
 * `visual` is everything that is not the binding; `alsoRequired` names which of those the
 * widget insists on, and is applied to BOTH branches so a pending cell is held to the same
 * completeness as a stored one. A gauge still needs its `path` whether the feed exists or not.
 */
const boundOrPending = (visual: Record<string, unknown>, alsoRequired: string[] = []) => ({ oneOf: [
  {
    type: 'object', additionalProperties: false, required: ['feed', ...alsoRequired],
    properties: { ...visual, feed: bindProps.feed },
  },
  {
    type: 'object', additionalProperties: false,
    required: ['source_draft_id', 'output_contract', ...alsoRequired],
    properties: { ...visual, ...pendingBindingProps },
  },
] })
const semanticConfig = (visual: Record<string, unknown>) => boundOrPending(visual)
/**
 * Grid contract. `template` is gone; every cell carries a rect in
 * screen fractions. AJV covers shape and bounds; quantization, the x+w<=1 sums and overlap are the
 * parts AJV cannot express, so the save service checks them. `rect` nests so the eleven
 * per-widget oneOf branches keep validating `config` unchanged.
 */
export const RECT_MIN = 0.05
/**
 * The grid's position quantum. AJV cannot express "multiple of 0.001 within float noise"
 * (multipleOf trips on binary representation), so save.ts checks it — against THIS constant,
 * which the widget-contract endpoint also serves, so an agent learns the same number the save
 * path enforces.
 */
export const RECT_QUANTUM = 0.001
export const rectSchema = {
  type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'],
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    w: { type: 'number', minimum: RECT_MIN, maximum: 1 },
    h: { type: 'number', minimum: RECT_MIN, maximum: 1 },
  },
}
// Adding a config property here? Also add its name to KNOBS in hub/test/knob-coverage.test.ts.
// That test pins "every property this schema accepts is consumed by a renderer" — the codebase
// has shipped a schema-accepted-but-never-rendered ("dead knob") bug twice (stream_list/table
// `scale`, then clock `scale`); the reachability guard keeps every accepted property tied to a renderer.
export const cellSchema = {
  type: 'object', additionalProperties: false, required: ['widget', 'config', 'rect'],
  properties: {
    widget: { enum: ['clock', 'alert_feed', 'calendar_events', 'value_tile', 'gauge', 'stream_list', 'table', 'text_block', 'chart', 'image', 'weather_forecast', 'news_list'] },
    config: { type: 'object' },
    rect: rectSchema,
  },
  oneOf: [
    { properties: { widget: { const: 'clock' }, config: { type: 'object', additionalProperties: false, properties: { ...scaleProp, ...designProp, ...cardProp } } } },
    { properties: { widget: { const: 'alert_feed' }, config: {
      type: 'object', additionalProperties: false,
      properties: {
        ...scaleProp,
        ...designProp, ...cardProp,
        min_severity: { enum: ['info', 'warn', 'critical'] },
        /**
         * Sender allowlist: only cards from these sender names render on this cell. Rendering
         * only — chimes and tab dots stay device-wide (Chime.kt never reads it). Hand-authored
         * (an array is not a shape meta.options can generate); empty means every sender.
         */
        senders: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 } },
        // Body text only — `scale` moves every size; this grows just the body run (≥ 1 so it can
        // only enlarge). Card heights absorb the growth in the design.
        body_scale: { type: 'number', minimum: 1, maximum: 3 },
        /**
         * Whether this screen's device chimes for info alerts. Off unless set, and the only
         * way an info alert makes any noise at all — a sender cannot ask for it (see
         * `resolveSound`). Audibility for routine traffic belongs to the room, not to whatever
         * happens to be integrated with the hub.
         */
        sound_info: { type: 'boolean' },
        clamp: { type: 'object', additionalProperties: false, properties: {
          title_lines: { type: 'integer', minimum: 1, maximum: 10 },
          body_lines: { type: 'integer', minimum: 1, maximum: 10 },
        } },
        overflow: { type: 'object', additionalProperties: false, properties: {
          counter: { type: 'boolean' },
        } },
      },
    } } },
    { properties: { widget: { const: 'value_tile' }, config: boundOrPending({
      path: bindProps.path, ...scaleProp, ...designProp, ...cardProp,
      label: { type: 'string', maxLength: 40 }, unit: { type: 'string', maxLength: 12 },
      format: { enum: ['raw', 'abbrev'] }, decimals: { type: 'integer', minimum: 0, maximum: 3 },
    }, ['path']) } },
    // `min`/`max` are deliberately NOT required. Both gauge designs declare `min: 0`/`max: 100`
    // as their `meta.options` default and `normalizeGauge` (widgets/gauge/shared.mjs) falls back
    // to exactly those, so a hand-authored cell that omits them renders correctly — requiring
    // them only 400'd an author for a value the renderer was going to supply anyway, which
    // matters now that docs/architecture/screens.md invites cells to be written by hand.
    // `feed` and `path` stay required: neither has a defensible default (an unbound gauge is a
    // mistake, not a shape). `screens/save.ts` still refuses `min >= max`, resolving each
    // through the same fallback so a half-specified range is caught rather than waved through.
    { properties: { widget: { const: 'gauge' }, config: boundOrPending({
      path: bindProps.path, ...scaleProp, ...designProp, ...cardProp,
      min: { type: 'number' }, max: { type: 'number' },
      label: { type: 'string', maxLength: 40 }, unit: { type: 'string', maxLength: 12 },
      decimals: { type: 'integer', minimum: 0, maximum: 3 },
        // `style` ('bar'|'ring') retired: design
        // selection is `config.design` now, the same field every other multi-design widget
        // uses — `...designProp, ...cardProp` above already covers it. migrateV21 (src/db/migrate.ts)
        // rewrote every stored `style` into `design` so no legacy alias needs to survive here.
      thresholds: { type: 'object', additionalProperties: false,
        properties: { warn: { type: 'number' }, crit: { type: 'number' } } },
    }, ['path']) } },
    { properties: { widget: { const: 'stream_list' }, config: boundOrPending({
      ...scaleProp, ...designProp, ...cardProp,
      title_path: { type: 'string', maxLength: 200 }, body_path: { type: 'string', maxLength: 200 },
      clamp: { type: 'object', additionalProperties: false, properties: {
        title_lines: { type: 'integer', minimum: 1, maximum: 10 },
        body_lines: { type: 'integer', minimum: 1, maximum: 10 } } },
      overflow: { type: 'object', additionalProperties: false,
        properties: { counter: { type: 'boolean' } } },
      // `stream_list`/`ticker`'s own knobs, nested rather than spread loose across the branch —
      // same shape `clamp` and `overflow` use, so one design's settings stay legible beside another's.
      ticker: { type: 'object', additionalProperties: false, properties: {
        speed: { type: 'number', minimum: 0, maximum: 400 },
        family: { enum: ['sans', 'mono', 'serif'] },
        text_px: { type: 'integer', minimum: 8, maximum: 96 },
        separator: { type: 'string', maxLength: 8 },
        direction: { enum: ['left', 'right'] } } },
      // stream-activity contract: device-read, hand-built in the admin (no renderer reads it — same rule as sound_info)
      chime_activity: { type: 'boolean' },
    }) } },
    { properties: { widget: { const: 'table' }, config: boundOrPending({
      path: bindProps.path, ...scaleProp, ...designProp, ...cardProp,
      columns: { type: 'array', minItems: 1, maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['header', 'path'],
        properties: { header: { type: 'string', maxLength: 24 }, path: { type: 'string', maxLength: 200 },
          align: { enum: ['left', 'right'] } } } },
      headers: { type: 'boolean' },
      overflow: { type: 'object', additionalProperties: false,
        properties: { counter: { type: 'boolean' } } },
      // stream-activity contract: device-read, hand-built in the admin (no renderer reads it — same rule as sound_info)
      chime_activity: { type: 'boolean' },
    }, ['columns']) } },
    // text_block's XOR is now three-way: literal `text`, a stored `feed`+`path`, or a pending
    // promise+`path`. The literal branch stays hand-written because it binds nothing at all —
    // `boundOrPending` covers the two that do.
    { properties: { widget: { const: 'text_block' }, config: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', maxLength: 2000 },
          align: { enum: ['left', 'center', 'right'] }, ...scaleProp, ...designProp, ...cardProp, ...ledProp } },
      ...boundOrPending({
        path: bindProps.path, align: { enum: ['left', 'center', 'right'] }, ...scaleProp, ...designProp, ...cardProp,
        ...ledProp,
      }, ['path']).oneOf,
    ] } } },
    // Chart (chart behavior, shared data-widget contract). series 1..4, each item required
    // feed+y_path+icon; icon enum is the shared CHART_ICONS glyph set both renderers draw.
    // Duplicate icons and non-stream series feeds are DB-dependent checks AJV can't express;
    // screens/save.ts enforces both.
    // `style` is deliberately NOT required, for the same reason as `gauge`'s `min`/`max`:
    // `chart/plot.mjs` declares it with `default: 'line'` and `chartConfig` (layout-core.mjs)
    // maps anything absent — or unknown — to `'line'`, so an omitted `style` has always
    // rendered as a line chart. `series` stays required: there is no defensible default for
    // "which feeds to plot".
    // Chart is the one widget whose binding is PER SERIES, so `boundOrPending` applies to the
    // series item rather than the config — and a chart may mix a series on a feed that exists
    // with one on a source that does not. Anything else would make the pending case strictly
    // less capable than the live one, on the widget an operator is most likely to be adding a
    // new source for.
    { properties: { widget: { const: 'chart' }, config: {
      type: 'object', additionalProperties: false, required: ['series'],
      properties: {
        series: { type: 'array', minItems: 1, maxItems: 4, items: boundOrPending({
          y_path: { type: 'string', maxLength: 200 },
          icon: { enum: CHART_ICONS }, label: { type: 'string', maxLength: 24 },
        }, ['y_path', 'icon']) },
        style: { enum: ['line', 'bar'] },
      // `chart`/`candles`' own knobs, nested like every other design's. `style` stays line|bar:
      // candles are a DESIGN, not a third style, so a client that does not know the design falls
      // back to drawing the same series as a line rather than to nothing.
        candles: { type: 'object', additionalProperties: false, properties: {
          // `ohlc` = each row IS a bar, pushed by whatever holds the real data. `ticks` derives bars
          // by bucketing a value feed and is an approximation — see screens.md.
          mode: { enum: ['ticks', 'ohlc'] },
          bucket_s: { type: 'integer', minimum: 1, maximum: 86400 },
          wick: { type: 'boolean' },
          // Whether the x axis is a frame ending NOW or the data's own span.
          rolling: { type: 'boolean' } } },
        window_s: { type: 'integer', minimum: 5 },
        y_min: { type: 'number' }, y_max: { type: 'number' },
        ...scaleProp,
        ...designProp, ...cardProp,
      },
    } } },
    // Image (chart behavior, image-feed behavior image feeds + shared data-widget contract). The ONE
    // widget that requires (not forbids) an image-mode feed — checked by screens/save.ts.
    // No scaleProp (image has no on-canvas resize knob), but design is still every widget's
    // Image gets designProp on its own, unpaired with scale, matching the screen editor behavior.
    { properties: { widget: { const: 'image' }, config: boundOrPending({
      fit: { enum: ['contain', 'cover'] }, ...designProp, ...cardProp,
    }) } },
    { properties: { widget: { const: 'weather_forecast' }, config: semanticConfig({
      days: { type: 'integer', minimum: 5, maximum: 7 },
      show_humidity: { type: 'boolean' },
      show_precipitation: { type: 'boolean' },
      show_wind: { type: 'boolean' },
      show_pollen: { type: 'boolean' },
      ...scaleProp,
      ...designProp, ...cardProp,
    }) } },
    { properties: { widget: { const: 'news_list' }, config: semanticConfig({
      items: { type: 'integer', minimum: 1, maximum: 10 },
      show_summary: { type: 'boolean' },
      show_source: { type: 'boolean' },
      show_time: { type: 'boolean' },
      ...scaleProp,
      ...designProp, ...cardProp,
    }) } },
    { properties: { widget: { const: 'calendar_events' }, config: semanticConfig({
      events: { type: 'integer', minimum: 1, maximum: 10 },
      show_location: { type: 'boolean' },
      ...scaleProp,
      ...designProp, ...cardProp,
    }) } },
  ],
}
export const gridSchema = {
  type: 'object', additionalProperties: false, required: ['cells'],
  properties: {
    cells: { type: 'array', minItems: 1, maxItems: 12, items: cellSchema },
    // Where this screen expects the device tab bar (tabs) — see ScreenGrid.tab_bar.
    // Absent = 'bottom'; 'hidden' screens cannot join multi-tab lists (validated at PATCH time).
    tab_bar: { enum: ['bottom', 'top', 'left', 'right', 'hidden'] },
  },
}
