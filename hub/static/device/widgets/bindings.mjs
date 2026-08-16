/**
 * What each generic/legacy widget consumes — the feed-mode half of its contract, as data.
 *
 * The same argument catalogue.mjs makes for designs. A widget's accepted feed modes were written
 * down in three places: CellConfig's `'any' | 'stream' | 'image'` filter arguments, Widgets.tsx's
 * hand-typed `binds:` strings, and feedCheck's per-widget branches in hub/src/routes/admin.ts. The
 * three had already drifted — the catalogue page said value_tile and gauge bind "a value feed",
 * and both have accepted stream feeds since the day they shipped. The catalogue page is precisely
 * where somebody goes to find that out, so the one copy a human reads was the one that was wrong.
 *
 * This module imports NOTHING, which is what lets the admin bundle it (see catalogue.mjs's note on
 * assets.mjs and the `new URL` sprite globbing). The hub cannot import it — `hub/tsconfig.json` has
 * `rootDir: src`, so reaching into `../static` breaks `npm run build` — so admin.ts carries a
 * duplicate of the mode sets alone, cross-checked against this file by
 * `hub/test/widget-bindings.test.ts`. That is the CHART_ICONS arrangement exactly, for the same
 * reason and with the same guard.
 *
 * Semantic widgets deliberately do NOT appear here. Their compatibility is contract id plus
 * required capabilities, declared in definitions.mjs and pinned against the hub requirement map.
 * Adding an empty or permissive mode entry here would create a second, incorrect compatibility
 * path.
 *
 * `needs` is the second enforceable field, beside `modes`. `modes` says which feed MODES may be
 * bound; `needs` says what TYPE must be found at the path this cell configures. Together they are
 * the generic half of the widget contract — the half semantic widgets got from their canonical
 * payload shape and these nine never had, which is why a screen could not be saved against a feed
 * that did not exist yet. Each entry names a CONFIG KEY (`path_from`), not a path: the path itself
 * belongs to the cell, and the widget only declares what must be at the end of it. The vocabulary
 * of four types and three scopes lives in `hub/src/data/needs.ts`, which restates this table for
 * the server (`rootDir: src` forbids importing it) under `widget-bindings.test.ts`'s guard — the
 * CHART_ICONS arrangement exactly, for the same reason.
 *
 * `payload` stays the one line a person needs to know what to push, and is what the picker shows
 * beside a data source. It is the human sentence beside the machine declaration, not a duplicate
 * of it: `needs` cannot say "on a stream feed the newest row is read", and prose cannot be matched
 * against a capability list.
 */

/** How a widget that binds no feed gets its data, for the catalogue phrase. */
const NO_FEED = Object.freeze([])
/** A widget that binds no feed needs nothing at any path, which is a different statement. */
const NO_NEEDS = Object.freeze([])

export const WIDGET_BINDINGS = Object.freeze({
  clock: Object.freeze({
    modes: NO_FEED,
    needs: NO_NEEDS,
    source: 'nothing',
    payload: 'nothing — the clock reads the device\'s own time.',
  }),
  alert_feed: Object.freeze({
    modes: NO_FEED,
    needs: NO_NEEDS,
    source: 'alerts',
    payload: 'nothing — alerts arrive over the socket, not through a feed.',
  }),
  value_tile: Object.freeze({
    modes: Object.freeze(['value', 'stream']),
    needs: Object.freeze([
      Object.freeze({ path_from: 'path', scope: 'scalar', type: 'scalar' }),
    ]),
    payload: 'one number or string, at `path`. On a stream feed the newest row is read.',
  }),
  gauge: Object.freeze({
    modes: Object.freeze(['value', 'stream']),
    needs: Object.freeze([
      Object.freeze({ path_from: 'path', scope: 'scalar', type: 'number' }),
    ]),
    payload: 'a number at `path`, drawn against min/max.',
  }),
  stream_list: Object.freeze({
    modes: Object.freeze(['stream']),
    // Per ROW, not per newest row: the list paints every row it is given, so a `title_path` that
    // only resolves on the most recent one is still a broken binding for the rest of the card.
    needs: Object.freeze([
      Object.freeze({ path_from: 'title_path', scope: 'row', type: 'scalar' }),
      Object.freeze({ path_from: 'body_path', scope: 'row', type: 'scalar' }),
    ]),
    payload: 'one card per row; `title_path` and `body_path` name the fields to show.',
  }),
  table: Object.freeze({
    modes: Object.freeze(['value', 'stream']),
    // The one widget whose needs depend on the mode it is bound to, which is why `modes` exists.
    // On a VALUE feed a table binds at two levels: `path` reaches the array, and each column's own
    // `path` then resolves INSIDE an element of it (`collection_from: 'path'` says which array — a
    // column path means nothing without the array it is relative to). On a STREAM feed the rows
    // ARE the array: `normalizeTable`'s `isArray(rows)` branch never reads `cfg.path` at all, and
    // each column resolves against a row's payload directly.
    needs: Object.freeze([
      Object.freeze({ path_from: 'path', scope: 'scalar', type: 'array<object>', modes: Object.freeze(['value']) }),
      Object.freeze({ path_from: 'columns[].path', scope: 'collection', collection_from: 'path', type: 'scalar', modes: Object.freeze(['value']) }),
      Object.freeze({ path_from: 'columns[].path', scope: 'row', type: 'scalar', modes: Object.freeze(['stream']) }),
    ]),
    payload: 'an array of objects — a row each, one column per `path`. On a value feed, `path` must reach the array.',
  }),
  text_block: Object.freeze({
    modes: Object.freeze(['value', 'stream']),
    optional: true,
    needs: Object.freeze([
      Object.freeze({ path_from: 'path', scope: 'scalar', type: 'scalar' }),
    ]),
    payload: 'one value at `path` — or no feed at all, and the text is typed in.',
  }),
  chart: Object.freeze({
    modes: Object.freeze(['stream']),
    per_series: true,
    needs: Object.freeze([
      Object.freeze({ path_from: 'series[].y_path', scope: 'row', type: 'number' }),
    ]),
    payload: 'per series: a number at `y_path` on each row, plotted against the row\'s push time.',
  }),
  image: Object.freeze({
    modes: Object.freeze(['image']),
    // The one need with no `path_from`. An image feed's bytes are fetched by revision, never
    // resolved out of a payload, so there is no path for an operator to get wrong — the feed's
    // mode alone decides, and `modes` above already says it. Declared anyway so that "every
    // feed-binding widget declares what it needs" holds without an exception to remember.
    needs: Object.freeze([Object.freeze({ scope: 'scalar', type: 'binary' })]),
    payload: 'the pushed bitmap itself — PNG, JPEG or static WebP. No path.',
  }),
})

/**
 * The feed modes this widget may bind, in the order a picker should offer them. An unknown widget
 * binds nothing rather than throwing: the renderer degrades on unknown ids everywhere else (design
 * ids, backdrops), and a config UI is not the place to start being strict about it.
 */
export function feedModesFor(widget) {
  return WIDGET_BINDINGS[widget]?.modes ?? NO_FEED
}

/**
 * What this widget needs at the paths its config binds. Same degradation as `feedModesFor`: an
 * unknown widget needs nothing rather than throwing.
 */
export function needsFor(widget) {
  return WIDGET_BINDINGS[widget]?.needs ?? NO_NEEDS
}

/** True when this widget can be bound to a feed of this mode. */
export function widgetAcceptsMode(widget, mode) {
  return feedModesFor(widget).includes(mode)
}

/** Every widget type that can bind a feed of this mode — the picker's "what could show this?" */
export function widgetsAcceptingMode(mode) {
  return Object.keys(WIDGET_BINDINGS).filter((w) => widgetAcceptsMode(w, mode))
}

/**
 * The catalogue page's one-line phrase, DERIVED rather than authored beside the modes. Writing it
 * out by hand next to the mode list is what let the two disagree; a phrase that cannot be edited
 * independently cannot drift from what the hub enforces.
 */
export function bindsPhrase(widget) {
  const entry = WIDGET_BINDINGS[widget]
  if (!entry) return 'nothing'
  const modes = entry.modes
  if (modes.length === 0) return entry.source ?? 'nothing'
  const list = modes.length === 1 ? modes[0] : `${modes.slice(0, -1).join(', ')} or ${modes[modes.length - 1]}`
  if (entry.per_series) return `${list} feeds, one per series`
  const article = /^[aeiou]/.test(list) ? 'an' : 'a'
  const phrase = `${article} ${list} feed`
  return entry.optional ? `nothing, or ${phrase}` : phrase
}
