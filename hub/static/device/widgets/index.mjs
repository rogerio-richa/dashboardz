import { register, lookup, registered, knows } from './registry.mjs'
import { resolveTokens, builtinRamp, themeSeriesRamp } from './tokens.mjs'
import { canvasHtml, prepare } from './surface.mjs'
import { assetsFor } from './assets.mjs'
import { bitmapFor, loadBitmapFor } from './bitmaps.mjs'
import { startAnimation, stopAnimation } from './loop.mjs'
import { CATALOGUE, designMinimum } from './catalogue.mjs'
import { isStale, chartConfig, chartIsStale, chartStaleAgeMs, belowMinimum } from '../layout-core.mjs'

// The shipped designs, registered in catalogue order (which defaultDesignFor depends on).
for (const design of CATALOGUE) register(design)

export { canvasHtml, registered }

// `paintWidgets` takes the board block as a parameter and device.js passes theme.mjs's
// `currentBoard()`. The real built-in board block is `BUILTIN_BOARD` in
// theme.mjs, already pinned to the hub's copy and to index.html's :root, and a duplicate frozen in
// production code is exactly the copy that drifts.

/**
 * null ⇒ this widget has no canvas design yet and keeps its existing DOM rendering.
 *
 * Merge order is cell -> theme -> library default — a strict PRECEDENCE, not a validity cascade:
 * `cell.config.design`, whenever
 * the cell actually names one, is what gets looked up, full stop, even if this build doesn't have
 * that id — it does NOT fall through to the theme's choice on an unresolvable name. Only when the
 * cell names nothing does the theme's per-widget-type choice (`themeWidgets[cell.widget].design`)
 * get looked up instead. `lookup` (registry.mjs) is what supplies the LAST fallback: it never
 * returns undefined for a widget that has designs, resolving any id it doesn't recognise —
 * including `undefined` — to the registry's own default (degradation contract). So a cell naming an
 * id nobody registered lands on the library default even though the theme may have named a design
 * that DOES exist; that's a deliberate, simpler contract (cell always wins when present) rather
 * than a "does the winning name actually resolve" cascade, chosen to preserve the plain
 * "cell wins over theme" wording rather than inventing a second resolution pass. `||`, not `??`:
 * an empty-string `cell.config.design` (e.g. a cleared-but-not-deleted form field) is not a real
 * choice and must not suppress the theme's — it is treated the same as absent. `themeWidgets` is
 * optional so every existing call site that doesn't have a theme in scope keeps working unchanged.
 */
export function designFor(cell, themeWidgets) {
  if (!registered(cell.widget).length) return null
  return lookup(cell.widget, requestedDesign(cell, themeWidgets))
}

/**
 * The design id designFor WILL look up for this cell, before the registry gets a say — or null
 * when the board names none.
 *
 * Split out of designFor rather than restated next to it. Deciding whether a page is older
 * than the catalogue means asking "was the id this board asked for actually resolvable", and the
 * only way that question can be answered honestly is against the very id the renderer looks up. A
 * second copy of the precedence rule here would be two substitution points computing the same
 * answer differently, which is the colour-token contract lesson and has already cost this codebase a day.
 *
 * A theme entry is a bare design id (v11): a theme names geometry, the palette names colour.
 */
export function requestedDesign(cell, themeWidgets) {
  if (!cell || !registered(cell.widget).length) return null
  return cell.config?.design || themeWidgets?.[cell.widget] || null
}

/**
 * Every design this board was asked for that this build cannot draw, deduplicated.
 *
 * Empty is the overwhelmingly common answer, and it has to stay cheap — this runs on the render
 * path. Guarded against a malformed grid for the usual reason: bad data already in the database
 * must never crash a read path, and a reload trigger that throws would take the board with it.
 */
export function unknownDesigns(cells, themeWidgets) {
  const out = []
  if (!Array.isArray(cells)) return out
  for (const cell of cells) {
    const asked = requestedDesign(cell, themeWidgets)
    if (asked && !knows(cell.widget, asked) && !out.includes(asked)) out.push(asked)
  }
  return out
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

/**
 * Widget types named by this board but absent from the definition catalogue loaded with the page.
 * The order is screen order and duplicate cells spend only one catch-up attempt.
 */
export function unknownWidgetTypes(cells, definitions) {
  const out = []
  if (!Array.isArray(cells) || !Array.isArray(definitions)) return out
  const known = new Set()
  for (const definition of definitions) {
    if (isRecord(definition) && owns(definition, 'id') && typeof definition.id === 'string')
      known.add(definition.id)
  }
  for (const cell of cells) {
    if (!isRecord(cell) || !owns(cell, 'widget') || typeof cell.widget !== 'string' || !cell.widget)
      continue
    if (!known.has(cell.widget) && !out.includes(cell.widget)) out.push(cell.widget)
  }
  return out
}

/**
 * How long to wait BEFORE each successive catch-up reload, in local milliseconds. The first
 * sighting of an undrawable id reloads immediately; after that, ~1 min, ~5 min, ~25 min, then never
 * again — four attempts spanning a little over half an hour.
 *
 * This replaced a permanent "one reload per id, ever" guard, which was too absolute: it cannot tell
 * "this id will never exist" (an operator typo, a design that was removed) from "the hub did not
 * have it YET" (a deploy in flight, a theme saved a moment before the design finished shipping).
 * Those need opposite answers, and the second covers a panel that gives up
 * after a single attempt is a panel somebody still has to walk over to, which is the exact thing
 * this feature was built to prevent. Observed live: a session holding `["nixie"]` sat on the wrong
 * clock indefinitely.
 *
 * Deliberately NOT theme.mjs's flat RETRY_MS, and the difference is what a retry COSTS. A theme
 * refetch is one background GET against a steady-state condition, cheap enough to run flat forever
 * and invisible when it fails. A catch-up retry is a full page RELOAD of a wall panel: the board
 * blanks, the socket drops and re-dials, every feed image is refetched. So this ladder is built to
 * widen and then STOP, where that one is built to keep trying.
 *
 * Why a 5x step rather than doubling: doubling from a minute needs five reloads (1, 2, 4, 8, 16) to
 * cover the same half hour this covers in three. The panel's attention is the scarce resource, not
 * the elapsed time, so the coarser step buys the same window for fewer blanked screens.
 *
 * Why it ends at all, and there: every situation where a reload actually helps resolves in minutes
 * — a deploy, a restart, a rolling upgrade. Past half an hour the honest reading is that the id
 * names nothing this hub will ever serve, and the answer to that is degradation contract (draw the
 * widget's default, stay quiet), not a panel reloading itself until someone unplugs it. Nothing is
 * lost permanently either way: the record lives in sessionStorage, so a power cycle or a manual
 * refresh starts a fresh ladder.
 */
export const RELOAD_BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 25 * 60_000])

/** One attempt on first sighting, then one per rung of the ladder. */
export const MAX_RELOAD_ATTEMPTS = RELOAD_BACKOFF_MS.length + 1

/**
 * Whatever came out of sessionStorage, normalised to `{ [designId]: { n, at } }` — attempts spent
 * on that id, and the `Date.now()` of the last one.
 *
 * Never throws, for the same reason unknownDesigns guards its input: this feeds a decision on the
 * render path, and a marker nobody can parse must not be able to take a board down with it.
 *
 * The ORIGINAL bare-array marker (`["nixie"]`) is understood, not discarded — devices upgrading
 * into this build are still holding one, in a session that survives the very reload that delivers
 * the new code. Each id migrates to one attempt at `at: 0` rather than at the current time, because
 * we genuinely do not know when it happened; it may have been hours ago on a panel that has been
 * stuck all afternoon. Dating it to the present would invent a fact and make that panel serve a
 * window it has already served. `at: 0` leaves it due on the next tick — which is precisely the
 * stuck panel getting unstuck — while the carried-over count still costs it a rung, so the
 * migration hands back the REST of the ladder rather than all of it.
 *
 * Unreadable entries resolve toward SPENT, never toward fresh. A key existing at all is proof this
 * id has been reloaded for at least once, whatever state the rest of the entry is in, and guessing
 * low is the guess that reloads a wall panel.
 */
export function reloadHistory(stored) {
  const out = {}
  if (Array.isArray(stored)) {
    for (const id of stored) if (typeof id === 'string' && id) out[id] = { n: 1, at: 0 }
    return out
  }
  if (!stored || typeof stored !== 'object') return out
  for (const [id, entry] of Object.entries(stored)) {
    if (!id) continue
    const n = Math.floor(Number(entry?.n))
    const at = Number(entry?.at)
    out[id] = {
      n: Number.isFinite(n) && n >= 1 ? n : MAX_RELOAD_ATTEMPTS,
      at: Number.isFinite(at) ? at : 0,
    }
  }
  return out
}

/**
 * The catalogue keys that justify reloading the page RIGHT NOW: designs this build cannot draw and,
 * when `definitions` is supplied, widget types this page does not know. Widget keys are prefixed so
 * a design id and widget id cannot spend each other's ladder.
 *
 * The narrow condition is the point. "The catalogue changed" would reload every panel in the
 * building because an entry none of them use was added; "this board asked for something this page
 * does not know" reloads exactly the panels that cannot show the requested design or widget.
 *
 * `history` is what stops a loop, and it now stops one in two directions: a reload already made
 * moments ago does not justify another (the backoff), and an id that has spent the whole ladder
 * does not justify one ever again (the cap). The second is the property the original guard existed
 * for and it is preserved exactly — bounded attempts, not bounded-per-page.
 *
 * `now` is INJECTED rather than read here, which keeps this pure and unit-testable with no fake
 * timers, and — more importantly — leaves the choice of clock at the call site, where it must be
 * `Date.now()` and not `hubNow()`. This measures local elapsed time; a retry window must not jump
 * because the server offset re-synced. Same rule as bitmaps.mjs's failure backoff.
 */
export function designsNeedingReload(cells, themeWidgets, history, now, definitions) {
  const unknown = unknownDesigns(cells, themeWidgets)
  for (const widget of unknownWidgetTypes(cells, definitions)) {
    const key = `widget:${widget}`
    if (!unknown.includes(key)) unknown.push(key)
  }
  if (!unknown.length) return unknown // nothing to weigh: don't normalise a history nobody will read
  const tried = reloadHistory(history)
  // No usable clock means no honest elapsed time. A never-seen id is still safe to act on — "act
  // now" measures nothing — but anything already on the ladder stays put rather than being handed
  // a free attempt.
  const t = Number.isFinite(now) ? now : 0
  return unknown.filter((id) => {
    const seen = tried[id]
    if (!seen) return true // first sighting: the deploy-just-landed case, and it is worth acting on
    if (seen.n >= MAX_RELOAD_ATTEMPTS) return false
    // A clock that stepped backwards (an NTP correction on a kiosk with no RTC) makes this
    // negative, i.e. not due — the same direction theme.mjs's and bitmaps.mjs's failedAt fail in.
    // Being late is a nuisance; reloading early on a jumping clock is the loop this guard prevents.
    return t - seen.at >= RELOAD_BACKOFF_MS[seen.n - 1]
  })
}

/**
 * The history to persist after reloading for `ids`: one more attempt each, stamped with the same
 * clock reading the caller measured the window with. Every other id's record is carried through
 * untouched — two undrawable ids on one board are two independent ladders, and a single reload
 * spends one rung of each.
 *
 * Returns a new object rather than mutating the argument, so a caller whose `setItem` throws can
 * abandon the result and leave the stored history exactly as it found it.
 *
 * Growth is bounded by the number of distinct undrawable ids a single session ever names — a
 * handful of cells' worth — and the whole record dies with the tab, so nothing prunes it.
 */
export function noteReloadAttempts(history, ids, now) {
  const next = reloadHistory(history)
  const t = Number.isFinite(now) ? now : 0
  for (const id of ids) next[id] = { n: (next[id]?.n ?? 0) + 1, at: t }
  return next
}

/**
 * Pure reconciliation step for paintWidgets' animation bookkeeping:
 * renderGrid rebuilds the whole board's HTML wholesale on every STATE message and every 1s
 * render tick, so a cell that disappears, changes to a widget with no canvas design, or shifts
 * index is simply never visited by paintWidgets' own forEach on a later render — nothing else
 * ever calls stopAnimation for its key, which would otherwise leave the shared board loop
 * (loop.mjs) painting a detached canvas forever, breaking its documented idle-to-zero invariant.
 *
 * Exported and unit-tested on its own because paintWidgets itself touches `document` and this
 * suite runs in Node with no DOM.
 */
export function keysToStop(previousKeys, currentKeys) {
  const current = new Set(currentKeys)
  return [...previousKeys].filter((key) => !current.has(key))
}

// Keys paintWidgets touched on the previous call — the baseline the next call's sweep diffs
// against. Module-level (not passed in/out) for the same reason `feeds`/`alerts` live at
// module scope in device.js: there is exactly one board per page, painted from one call site.
let previousKeys = new Set()

/**
 * The wire feed a cell is bound to, or null — the seam `dataForCell` and `paintWidgets` share so
 * "which feed, if any, does this cell name" is answered exactly once:
 * `stale`/`age_ms` need the same wire `dataForCell` already finds, and a second hand-rolled lookup
 * is exactly the kind of drift this file's own history warns about). Own-property checks keep
 * names such as `constructor` on Object.prototype from becoming accidental feed bindings.
 */
function feedForCell(cell, feeds) {
  const id = feedIdFor(cell)
  if (id === null || !isRecord(feeds) || !owns(feeds, id)) return null

  const feed = feeds[id]
  return isRecord(feed) && owns(feed, 'mode') ? feed : null
}

/**
 * The feed id a cell NAMES, or `null` when it names none — split out of `feedForCell` because
 * `feedSignalFor` has to tell "this cell binds no single feed at all" (a chart, a `text_block`
 * showing literal text) from "it binds one and the device does not have it", and `feedForCell`
 * answers `null` to both. Own-property checks keep names such as `constructor` on Object.prototype
 * from becoming accidental feed bindings.
 */
function feedIdFor(cell) {
  if (!isRecord(cell) || !owns(cell, 'config') || !isRecord(cell.config) ||
      !owns(cell.config, 'feed') || typeof cell.config.feed !== 'string' || !cell.config.feed) return null
  return cell.config.feed
}

/**
 * Resolve one screen cell's wire feed into the semantic value a portable design consumes.
 * Feed wrappers contain delivery metadata; only the selected value payload or stream row payloads
 * cross this boundary.
 */
export function dataForCell(cell, feeds) {
  const feed = feedForCell(cell, feeds)
  if (!feed) return null
  if (feed.mode === 'value') return owns(feed, 'payload') && feed.payload !== undefined ? feed.payload : null
  if (feed.mode !== 'stream' || !owns(feed, 'rows') || !Array.isArray(feed.rows)) return null

  const data = []
  for (const row of feed.rows) {
    if (!isRecord(row) || !owns(row, 'payload') || row.payload === undefined) return null
    data.push(row.payload)
  }
  return data
}

/**
 * The row-shaping both `rowsForCell` and `seriesForCell` need: a wire feed object to `{ payload,
 * pushed_at }[]`, newest first (wire order), or `null` if `feed` is not a well-formed stream.
 * Split out so a chart's per-series rows and a single-feed cell's rows go through exactly one
 * shaping — restating this loop for `ctx.series` is the second copy this contract exists to
 * prevent (see `seriesForCell`'s docstring).
 */
function rowsFromFeed(feed) {
  if (!feed || feed.mode !== 'stream' || !owns(feed, 'rows') || !Array.isArray(feed.rows)) return null

  const rows = []
  for (const row of feed.rows) {
    if (!isRecord(row) || !owns(row, 'payload') || row.payload === undefined) return null
    rows.push({ payload: row.payload, pushed_at: typeof row.pushed_at === 'number' ? row.pushed_at : null })
  }
  return rows
}

/**
 * A cell bound to a STREAM feed's rows, wire order (newest first), each carrying its own
 * `pushed_at` — the wire metadata `dataForCell` strips because bare payloads are the shape
 * `news/list.mjs` already consumes and every future stream design will expect. `stream_list`
 * needs those timestamps for its per-row age chips, and `ctx.data`'s shape is a contract about to
 * be frozen, so this is a second, additive channel rather than a change to the first.
 *
 * `null` for a value feed, an image feed, an unbound cell, or a malformed wire — the same
 * degradation `dataForCell` already applies, reusing `feedForCell` rather than adding a third way
 * to find a cell's feed (see that function's own docstring).
 */
export function rowsForCell(cell, feeds) {
  return rowsFromFeed(feedForCell(cell, feeds))
}

/**
 * The chart-only twin of `rowsForCell`: `ctx.rows` is single-feed like every other channel, but a
 * chart binds up to FOUR feeds (`chartConfig(config).series`), so it needs one entry per series
 * rather than one row list for the whole cell.
 *
 * `null` when the cell's raw config declares no `series` array at all — "not a chart" (or a chart
 * config that hasn't been given any series yet), the same absence signal `ctx.rows` gives a
 * non-stream cell. Once there IS a series array, every configured entry gets a slot, in
 * `chartConfig`'s order, even one whose feed id is not in `feeds` right now: `chartAllSeriesMissing`
 * needs to tell "this series' feed does not exist on this device" from "it exists and is empty",
 * and the legend must keep rendering a label for a series whose feed vanished. Compacting the
 * array would silently re-index the colour ramp under the remaining entries — the same class of
 * bug `themeSeriesRamp`'s all-or-nothing validation exists to avoid — so a missing feed gets
 * `missing: true` and `rows: []` rather than being dropped.
 */
export function seriesForCell(cell, feeds) {
  const bound = seriesWiresFor(cell, feeds)
  if (!bound) return null
  return bound.map(({ feed, wire, present }) => ({
    feed, rows: present ? (rowsFromFeed(wire) ?? []) : [], missing: !present,
  }))
}

/**
 * The wire feed behind each configured series, positionally — the seam `seriesForCell` and
 * `seriesStaleFor` share so "which feeds does this cell name, in what order" is answered exactly
 * once. `null` when the cell declares no `series` array at all, which is the same "not a chart"
 * signal `seriesForCell` returns to a design.
 *
 * `present` is carried separately from `wire` because the two are not the same question: a feed id
 * can be an OWN key of the map holding `undefined`, and it is the KEY's existence — not the value's
 * shape — that `chartAllSeriesMissing` has always tested (`Object.keys(feeds)`).
 */
function seriesWiresFor(cell, feeds) {
  if (!isRecord(cell) || !isRecord(cell.config) || !Array.isArray(cell.config.series)) return null

  const feedMap = isRecord(feeds) ? feeds : {}
  return chartConfig(cell.config).series.map((s) => {
    const present = owns(feedMap, s.feed)
    return { feed: s.feed, wire: present ? feedMap[s.feed] : undefined, present }
  })
}

/**
 * `ctx.stale`/`ctx.age_ms` for a cell that binds its feeds PER SERIES rather than through
 * `config.feed` — or `null` when this is not such a cell, meaning the single-feed rule below applies
 * unchanged.
 *
 * A chart has never had a `config.feed`, so `feedForCell` finds nothing for it and the single-feed
 * computation would report every chart on every board as permanently fresh — losing both the dimmed
 * plot and the age chip `drawChart` has always drawn. The aggregate is `chartIsStale` /
 * `chartStaleAgeMs`, unchanged and still the single vectored home of the rule: staleness is the OR
 * of every bound series' own `isStale` (a multi-series plot is only as fresh as its stalest input),
 * and the age is the OLDEST among the series that are actually STALE.
 *
 * That second half is the one place a chart's staleness reads differently from every other widget's,
 * and it is deliberate rather than an oversight: `age_ms` is normally non-null for ANY feed pushed
 * at least once, fresh or stale, but `drawChart` drew its corner chip ONLY when something was stale
 * — so `chartStaleAgeMs` returns `null` for a fresh chart and the design draws no chip, exactly as
 * the wall has always shown it (contract). The gate lives here, in the one function that
 * exists for this widget shape, rather than as a `cell.widget === 'chart'` branch on the paint path.
 */
function seriesStaleFor(cell, feeds, nowMs) {
  const bound = seriesWiresFor(cell, feeds)
  if (!bound) return null
  const wires = bound.map((b) => b.wire)
  return { stale: chartIsStale(wires, nowMs), age_ms: chartStaleAgeMs(wires, nowMs) }
}

/**
 * `ctx.ramp` (stream data): a design cycles its series colours over a ramp of ANY length with
 * `ramp[i % ramp.length]` — a `chart`'s series count is config-driven (1-4), and `meta.tokens` is
 * a FIXED name->colour vocabulary that cannot express "however many colours the board declares",
 * so this is a channel rather than a token. Never empty and never `undefined`: a design indexes it
 * unconditionally, so every branch below returns a real array.
 *
 * Prefers `board.series` via `themeSeriesRamp` (tokens.mjs) when it validates whole — that
 * function's own all-or-nothing rule (one bad entry rejects the WHOLE ramp rather than
 * compacting it, which would silently re-order the operator's colours) is reused rather than
 * reimplemented here. Falling back, `tokens.mjs`'s `builtinRamp` — the four palette colours every
 * design already resolves `@info`/`@warn`/`@critical`/`@dim` tokens against, degrading a missing
 * or malformed entry to `LAST_RESORT.color` rather than `undefined`. CSS variables are not used
 * for anything a design consumes, so this channel is the only way a chart's colours are chosen.
 */
function rampFor(board, palette) {
  return themeSeriesRamp(board) ?? builtinRamp(palette)
}

/**
 * `ctx.bitmap` (tab state): the decoded drawable for this cell's bound image feed, or
 * `null` when nothing is decoded RIGHT NOW — the same "present once decoded, absent until then"
 * contract `ctx.assets` already keeps (bitmaps.mjs's own docstring), extended to a feed's pushed
 * bitmap rather than a design-shipped sprite file.
 *
 * A pure lookup, like `seriesForCell`/`rampFor` above: it only reads whatever bitmaps.mjs's
 * module-global cache already holds for this feed. Unlike `assetsFor`, it does NOT kick off a
 * fetch itself — `loadBitmapFor` needs the device's Bearer token, which only the host page holds
 * (bitmaps.mjs's own docstring explains why that dependency is injected rather than baked in), so
 * triggering the load is the host wiring's job, wherever it constructs those real deps, not this
 * pure-lookup helper's.
 */
function bitmapForCell(cell, feeds) {
  const wire = feedForCell(cell, feeds)
  if (!wire || wire.mode !== 'image') return null
  return bitmapFor(cell.config.feed)
}

/**
 * `ctx.feed`: the delivery facts about the single feed this cell binds — `{ missing, mode,
 * pushed_at, image_rev }` — or `null` when the cell binds no single feed at all.
 *
 * THE QUESTION THIS CHANNEL EXISTS TO ANSWER is "does this cell's feed exist?", and nothing else on
 * the contract could answer it. `dataForCell` returns `null` for BOTH "no such feed" and "a value
 * feed nobody has ever pushed to" — a never-pushed value feed's `payload` is legitimately `null` —
 * and `ctx.stale`/`ctx.age_ms` are `false`/`null` for both as well. So every single-feed design had
 * to guess, and each of them guessed the LOUDER answer: an operator whose feed existed and was
 * simply empty was told "Feed missing" and sent hunting for a deletion that never happened.
 *
 * THREE ANSWERS, AND `null` IS THE ONE THAT SAYS NOTHING IS WRONG:
 *   - `null` — NOT APPLICABLE. This cell binds no single feed: a chart (which binds per SERIES and
 *     has no `config.feed`), a `text_block` showing literal typed text, a cell nobody has configured
 *     yet. It is not a verdict on anything — exactly like `ctx.rows === null` ("not stream-bound")
 *     and `ctx.series === null` ("declares no series array"). A design that REQUIRES a feed may of
 *     course treat "unconfigured" as loud, but that is its own rule about its own binding, not
 *     something this channel asserted.
 *   - `missing: true` — the cell names a feed id and the device does not have it (the hub OMITS a
 *     deleted-but-still-referenced feed from the wire; see dataPush.ts). THIS is the loud "the feed
 *     is not there" state, and it is a flag rather than a sentinel for one reason: `ctx.series`
 *     already spells this exact fact `missing: true` per entry (`seriesForCell`), and one contract
 *     should not answer one question two ways. The other keys are all `null` beside it — nothing is
 *     known about a wire that is not there.
 *   - `missing: false` — the feed exists, and the rest of the object is the facts. `pushed_at ===
 *     null` on top of that is the QUIET "exists and empty" state: the ordinary condition of a feed
 *     created five minutes ago. Never-pushed is quiet, not stale — the same rule `age_ms` states.
 *
 * `null` is reserved for an unbound feed. Using `null` for every state would conflate an unbound
 * feed, a missing feed, and an existing feed that may never have been pushed to; `missing` keeps
 * those three meanings distinct for every design.
 *
 * The channel also carries `image_rev` for image feeds. A bitmap can be dropped from the cache and
 * re-fetched; the revision is the wire fact that identifies the current image.
 *
 * NORMALISED HERE, AT THE SEAM, so a malformed wire cannot put `undefined` on a published contract:
 * every key is always present, and every one is either its own type or `null` — no second "absent"
 * spelling anywhere on the channel, so a design reads them unconditionally.
 *   - `missing` — always a boolean, never absent.
 *   - `mode` — `'value' | 'stream' | 'image'`, or `null` for a wire whose mode this build does not
 *     recognise (a board served by a newer hub). `null` rather than the raw string, so a design
 *     switching on the three documented modes lands on its own default branch instead of on a
 *     fourth it has never heard of. It is what lets a design ask the OTHER half of "can I show
 *     this?": `table` and `value_tile` take the quiet never-pushed line only for a feed of a kind
 *     they could actually read, so an IMAGE feed bound to a table stays loud from the moment it is
 *     bound rather than only once somebody pushes to it (`widgetAcceptsMode`, bindings.mjs).
 *   - `pushed_at` — the wire's own hub-clock timestamp, or `null`. Nullable in the schema
 *     (`hub/src/db/schema.ts`) and genuinely null until the first push, which is the whole point.
 *   - `image_rev` — the image feed's revision, or `null` for a feed that is not an image feed or is
 *     one nobody has pushed to. NAMED for the mode it belongs to: a bare
 *     `rev` on a general channel does not say which of three modes it describes, and `0`-for-absent
 *     was a second absence spelling this object no longer has. `image`'s own `rev <= 0` test still
 *     coerces a garbage or absent rev to 0 on its side — a design degrades on its own inputs.
 *
 * `stale_after_s` IS DELIBERATELY NOT HERE. It rode along unread: `isStale`
 * (layout-core.mjs) is the one place the rule is applied and `ctx.stale` is how a design receives the
 * verdict, so the raw threshold answered no question any design was asking. Adding a field to a
 * frozen contract is cheap and removing one is not, so an unread field is not a free option.
 *
 * MODE-BLIND ABOUT WHAT IT REPORTS, deliberately (`imageFeedFor`'s own contract): the
 * channel states what the wire IS and never refuses to answer because the cell wanted a different
 * kind of feed. Deciding what a wrong-kind feed MEANS is the design's job, and the shipped designs
 * do not all answer alike — `image` treats a value feed as a feed that exists with no revision (the
 * quiet `— no image yet` the DOM branch drew for exactly that case), while `table` treats an image
 * feed as unusable and stays loud, which is equally what its own DOM branch did. Both are only
 * expressible because the channel reported rather than judged. The gate stays where it costs
 * something — `bitmapForCell` (nothing decodable comes off a non-image wire) and `loadCellBitmaps`
 * (never spend an authenticated fetch).
 *
 * The whole wire does NOT cross: no `payload`, no `rows`, no `credentials`. A design consumes
 * semantic facts, never the delivery wrapper (`dataForCell`'s own rule, and the reason `ctx.rows`
 * reshapes to `{payload, pushed_at}` instead of handing over the feed object).
 */
const FEED_MODES = ['value', 'stream', 'image']
const finiteOr = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

function feedSignalFor(cell, feeds) {
  if (feedIdFor(cell) === null) return null
  const wire = feedForCell(cell, feeds)
  if (!wire) return { missing: true, mode: null, pushed_at: null, image_rev: null }
  return {
    missing: false,
    mode: FEED_MODES.includes(wire.mode) ? wire.mode : null,
    pushed_at: finiteOr(wire.pushed_at, null),
    image_rev: finiteOr(wire.image_rev, null),
  }
}

/**
 * Kick off (or re-check) the bitmap load for every image cell on this board — the LOAD half of
 * `ctx.bitmap`, whose read half (`bitmapForCell`) is a pure cache lookup that would otherwise never
 * have anything to look up.
 *
 * This is the direct replacement for device.js's deleted `ensureImageLoaded`, and it is called from
 * the same place: once per full render, over the board's cells. Everything expensive or stateful —
 * "already decoded", "already in flight", the 30s per-feed failure backoff, "never pushed, do not
 * fetch" — lives in `loadBitmapFor` (bitmaps.mjs) and is deliberately not restated here; this
 * function's whole job is deciding WHICH feeds a board asks for.
 *
 * Three gates, and all matter:
 *   - `cell.widget === 'image'`: a bitmap fetch is authenticated, costs a round trip and is the one
 *     network call a render can trigger, so only the widget that actually draws one asks for it.
 *   - `belowMinimum(cell.widget, box.px.width, box.px.height)`, the SAME check `widgetHtml` gates
 *     its own paint on (layout-core.mjs). The host owns this gate because the DOM branch's
 *     `ensureImageLoaded` was called from
 *     INSIDE `widgetHtml`, AFTER `belowMinimum` had already returned `tooSmallHtml(...)` for a cell
 *     too small to draw, so a below-minimum image cell never fetched. Without this gate, a mis-sized
 *     cell on a feed pushed every 10s re-fetches and re-decodes every 10s, forever, on a panel that
 *     runs for weeks, to paint nothing but a "needs 60×60" notice. `box` comes from the caller
 *     (device.js's `boxes`, parallel to `cells`) because pixel size depends on the live grid
 *     container's `clientWidth`/`clientHeight` (`rectToPx`), which only renderGrid has.
 *   - the wire's `mode === 'image'` mirrors `bitmapForCell`'s own gate, so the load side and the
 *     read side agree about what an image feed is; without it a cell pointed at a value feed that
 *     happens to carry an `image_rev` key would spend an authenticated fetch on a bitmap
 *     `bitmapForCell` would then refuse to hand the design. This gate is NOT on `ctx.feed` — see
 *     `feedSignalFor` for why that channel itself must stay mode-blind.
 *
 * "Never fetch at `image_rev` 0" is deliberately NOT a fourth gate here. `loadBitmapFor` opens with
 * exactly that gate and owns it; a copy in this loop would be a second home for
 * one rule, and — proven by mutating it — a copy no test could ever tell apart from its absence.
 *
 * `boxes` is OPTIONAL and positional-matched to `cells` (`boxes[i]` sizes `cells[i]`), never a
 * lookup by id: every unit test below calls this with no extra argument, exercising
 * the widget/mode gates with no opinion on size, and a missing/short `boxes` degrades to "no size
 * gate" rather than throwing — the same "malformed board must not blank a panel" rule the
 * `isRecord`/`Array.isArray` guards already follow.
 *
 * `deps` is injected all the way from device.js (`bitmapDeps(token)`) rather than built here for
 * the reason bitmaps.mjs's docstring gives: the device Bearer token lives in device.js's private
 * `token()`, and importing that here is the circular import that crashes every widget-paint test.
 * Malformed boards are tolerated rather than trusted — bad data already in the database must never
 * blank a panel.
 */
export function loadCellBitmaps(cells, feeds, deps, boxes) {
  if (!Array.isArray(cells)) return
  cells.forEach((cell, idx) => {
    if (!isRecord(cell) || cell.widget !== 'image') return
    const box = Array.isArray(boxes) ? boxes[idx] : null
    if (box && belowMinimum(cell.widget, box.px?.width, box.px?.height, designMinimum(cell.widget, cell.config?.design))) return
    const wire = feedForCell(cell, feeds)
    if (!wire || wire.mode !== 'image') return
    // The rev goes through `feedSignalFor` rather than being re-read off the wire, so the load side
    // and the design see one normalisation. `null` (never pushed) hits `loadBitmapFor`'s own
    // `if (!rev) return` exactly as `0` did — that gate remains owned by `loadBitmapFor`.
    const feed = feedSignalFor(cell, feeds)
    // Fire-and-forget: nothing here can await a decode, which is the whole reason
    // `onBitmapReady` exists. `loadBitmapFor` swallows its own fetch/decode failures, so a
    // rejection reaching this catch is a programming error and is worth seeing rather than losing.
    loadBitmapFor(cell.config.feed, feed.image_rev, deps).catch((err) => console.error('bitmap load failed', err))
  })
}

/**
 * The real browser primitives `bitmaps.mjs` runs on, bound to a device token source.
 *
 * bitmaps.mjs takes these as an injected `deps` so its state machine can be driven from Node with
 * no DOM; this is the one place the actual browser APIs are named, and it lives here rather than in
 * device.js so it is reachable by a test at all (device.js runs DOM code at module top level and
 * cannot be imported). `token` is a FUNCTION, read per call: a page that pairs after load, or a
 * driven page whose shell hands the token over late, must still authenticate.
 *
 * ── THE decode/revoke PAIRING, which is a real trap ──────────────────────────────────────────
 * `bitmaps.mjs` hands `revoke` the value `fetchBlob` RETURNED (`current.raw`) — never the decoded
 * drawable. So the raw has to BE the resource that needs releasing. It is an object URL, released
 * with `URL.revokeObjectURL`, and that is what makes the pair consistent.
 *
 * The tempting alternative — `decode: createImageBitmap(blob)` — is wrong here in both directions:
 * no object URL is ever created (so `revoke` would have nothing to release), while the `ImageBitmap`
 * that DOES hold decoded pixels only frees on `.close()` and is never passed to `revoke` at all. On
 * a panel that runs for weeks that is one leaked bitmap per revision, which is precisely the leak
 * device.js's original revoke comment existed to prevent.
 *
 * `<img src>` cannot carry an Authorization header, which is why the bytes are fetched with Bearer
 * and turned into a blob URL first — the same shape the deleted `ensureImageLoaded` used, and the
 * same shape device.js still uses for a theme's background image.
 */
export function bitmapDeps(token) {
  return {
    fetchBlob: async (feedId) => {
      const res = await fetch(`/api/feeds/${feedId}/image`, { headers: { authorization: `Bearer ${token()}` } })
      // Throw rather than mint a URL for an error body: bitmaps.mjs treats a rejection as a
      // failure to park for 30s, and keeps the last good bitmap on screen meanwhile.
      if (!res.ok) throw new Error(`image fetch ${res.status}`)
      return URL.createObjectURL(await res.blob())
    },
    decode: async (url) => {
      try {
        const img = new globalThis.Image()
        img.src = url
        // `decode()` on every engine that matters; the load/error fallback is for an older WebView
        // where its absence would otherwise mean a board that silently never shows an image.
        if (typeof img.decode === 'function') await img.decode()
        else await new Promise((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('image decode failed'))
        })
        // Fully decoded before it is cached, so the very first `drawImage` paints pixels rather
        // than a blank frame that nothing would repaint.
        return img
      } catch (err) {
        // bitmaps.mjs only ever revokes a raw it managed to CACHE, so a URL whose decode failed is
        // this function's own to release — otherwise every corrupt push leaks a blob for the life
        // of the page, on the retry path that runs most often.
        URL.revokeObjectURL(url)
        throw err
      }
    },
    revoke: (url) => URL.revokeObjectURL(url),
    // Date.now, never hub time: the failure backoff measures LOCAL elapsed time and must not jump
    // when the server offset re-syncs. Same rule the deleted `imageFailedAt` carried.
    now: () => Date.now(),
  }
}

/**
 * Post-insert paint pass: the placeholders exist in the DOM by now and have real dimensions, which
 * a canvas needs before its backing store can be sized. This is the single post-insert pass.
 *
 * A design is registered with the board loop only while it says it is animating RIGHT NOW —
 * `design.isAnimating(ctx)`, not `meta.animations` being non-empty.
 * `meta.animations` says what a design animates in principle, which is true of a segment clock for
 * every one of the 59.8 seconds a minute it is sitting perfectly still; registering on it pinned
 * the loop at full rate forever and broke the contract's idle-to-zero rule. Nothing here knows
 * when any particular design's transition starts or ends — the design owns its own timing, and the
 * existing 1s render tick is what re-arms it at the next boundary. Nothing here starts a timer.
 *
 * The first paint is guarded the way the deleted `paintCharts` guarded `drawChart`,
 * An unguarded throw here would propagate out through renderGrid to render(), skipping
 * the takeover/critical-alert block that runs after renderGrid — a design bug in one clock cell must
 * not be able to hide a critical alert. A design that cannot draw once is not handed frames: its
 * animation is not registered. THIS IS THE ONLY SUCH GUARD A DESIGN GETS OR NEEDS: a design that
 * adds its own local try/catch duplicates it and swallows the `widget paint failed for cell` log
 * this one emits.
 *
 * `board` is the theme's board block (or the built-in fallback — see theme.mjs's currentBoard),
 * the same `@palette` source `resolveTokens`' `builtin()` already read before theming existed;
 * only the caller-supplied object changed, not the resolution logic in tokens.mjs. `themeWidgets`
 * is the theme's per-widget-type map (or `{}`/`undefined` before any theme has loaded); each
 * design's own declared token wins there, ahead of the board and ahead of its own built-in.
 *
 * `alerts` is the device's live alert list, newest-first, handed to EVERY design (only `alert_feed`
 * reads it) because it cannot travel through `ctx.data`: alerts arrive by `ALERT_ADD` and live in
 * the device's own state, not behind a feed id, so `alert_feed`'s config has never had one to bind.
 * Defaults to `[]` rather than `undefined` so a design can iterate it unconditionally. The caller
 * must pass the SAME array at every call site that paints a board — a design must not see different
 * alerts depending on whether a full render or a per-cell repaint painted it.
 */
// The `cards` backdrop's cell chrome, drawn by the pipeline below rather than CSS: widgets own
// every pixel of a cell (the DOM branch is gone for exactly that reason), so the card a theme asks
// for has to be painted onto the same canvas the design draws on — anything else is invisible to a
// recording surface and silently absent on a non-browser renderer.
export const CARD_RADIUS = 12
export const CARD_BORDER = 2
export const CARD_PADDING = 8

/**
 * How far a carded cell's CONTENT is pushed in from the cell rect: the gap outside the border,
 * the border itself, and the interior padding (`board.card_padding`, default CARD_PADDING).
 * Zero when no card is painted (no chrome, or the cell opted out with `card: false`). Exported
 * because the pointer path (device.js pointerCellAt) must shift tap coordinates by exactly the
 * amount the paint path shifted the design's origin — one function so they cannot disagree.
 */
export function cardContentInset(chrome, cell) {
  if (!chrome || cell?.config?.card === false) return 0
  const finite = (v) => typeof v === 'number' && Number.isFinite(v)
  const gap = finite(chrome.gap) ? Math.min(16, Math.max(0, chrome.gap)) : 2
  const padding = finite(chrome.padding) ? Math.min(24, Math.max(0, chrome.padding)) : CARD_PADDING
  return gap + CARD_BORDER + padding
}

/**
 * One cell's card: a rounded surface rectangle with a border, inset so the stroke stays inside the
 * canvas. Portable ops only (moveTo/lineTo/arc/fill/stroke) — same discipline as a design, because
 * on a recording surface this IS part of the cell's drawing. Painted before the design so the
 * design's own pixels always win.
 */
export function paintCardChrome(g, w, h, chrome) {
  if (!(w > 0) || !(h > 0) || !chrome) return
  // `gap` (the theme's `board.card_gap`, default 2) insets the whole card from the cell rect, so
  // flush cells read as separate cards with board background between them.
  const gap = typeof chrome.gap === 'number' && Number.isFinite(chrome.gap) ? Math.min(16, Math.max(0, chrome.gap)) : 2
  const inset = gap + CARD_BORDER / 2
  const r = Math.max(0, Math.min(CARD_RADIUS, w / 2 - inset, h / 2 - inset))
  const path = () => {
    g.beginPath()
    g.moveTo(inset + r, inset)
    g.lineTo(w - inset - r, inset)
    g.arc(w - inset - r, inset + r, r, -Math.PI / 2, 0)
    g.lineTo(w - inset, h - inset - r)
    g.arc(w - inset - r, h - inset - r, r, 0, Math.PI / 2)
    g.lineTo(inset + r, h - inset)
    g.arc(inset + r, h - inset - r, r, Math.PI / 2, Math.PI)
    g.lineTo(inset, inset + r)
    g.arc(inset + r, inset + r, r, Math.PI, Math.PI * 1.5)
    g.closePath()
  }
  path()
  g.fillStyle = chrome.surface
  g.fill()
  path()
  g.lineWidth = CARD_BORDER
  g.strokeStyle = chrome.border
  g.stroke()
}

export function paintWidgets(cells, boxes, board, hubNow, themeWidgets, feeds, only, alerts = [], cardChrome = null) {
  const wanted = only ? new Set(only) : null
  const currentKeys = new Set()
  document.querySelectorAll('canvas.widget-canvas[data-cell]').forEach((canvas) => {
    const idx = Number(canvas.dataset.cell)
    if (wanted && !wanted.has(idx)) return
    const cell = cells[idx]
    const design = cell && designFor(cell, themeWidgets)
    if (!design) return
    const box = boxes[idx]
    // No per-widget colour override any more (v11): a design's slots resolve straight against the
    // board palette, which is what every one of them already defaulted to.
    const tokens = resolveTokens(design.meta, {}, board)
    const key = `cell${idx}`
    currentKeys.add(key)

    // Returns whether the design is still animating, which is both the registration decision
    // below and — once registered — the loop's signal to drop the key. `now` is re-read per frame,
    // so a transition that has run out is reported as finished on the very frame it ends.
    const paint = (elapsed) => {
      const nowMs = hubNow()
      // `stale`/`age_ms`: the draw-contract twin of the DOM renderer's own
      // `isStale(wire, hubNow())` + age chip, reusing the SAME `isStale` rule rather than a design
      // reimplementing it. A cell that binds no feed gets `stale: false, age_ms: null` — "there is
      // nothing to be stale about", the old text_block DOM branch's own words for this case. A cell
      // that binds PER SERIES (a chart, which has no `config.feed` at all) gets the aggregate
      // instead — see seriesStaleFor for the rule and for why its age half is stale-gated.
      const wire = feedForCell(cell, feeds)
      // `ctx.feed` — the delivery facts, normalised once here so "does this cell's feed exist" has
      // exactly one answer on the board (see feedSignalFor). `pushed_at` is read back off it rather
      // than re-derived from the wire: the age caption below and a design's own quiet/loud choice
      // must never disagree about whether anything was ever pushed.
      //
      // `pushed_at` passes through `finiteOr`, so `NaN` and `Infinity` become `age_ms: null`.
      // `value_tile` and `text_block` then draw no age chip, matching a feed nobody has pushed to.
      const feed = feedSignalFor(cell, feeds)
      const pushedAt = feed ? feed.pushed_at : null
      // Non-null only for a per-series binding (a chart), where `config.feed` does not exist and the
      // single-feed rule below would report every chart as permanently fresh — see seriesStaleFor.
      const seriesStale = seriesStaleFor(cell, feeds, nowMs)
      // A carded cell's design draws in a box shrunk by the card's content inset, with the origin
      // translated to match (below) — so every design's own layout automatically respects the
      // card without knowing cards exist.
      const inset = cardContentInset(cardChrome, cell)
      const drawCtx = {
        tokens, config: cell.config ?? {}, data: dataForCell(cell, feeds),
        box: { w: Math.max(0, box.px.width - inset * 2), h: Math.max(0, box.px.height - inset * 2), t: box.t },
        now: nowMs, state: {}, motion: 'full',
        stale: seriesStale ? seriesStale.stale : (wire ? isStale(wire, nowMs) : false),
        age_ms: seriesStale ? seriesStale.age_ms : (pushedAt !== null ? Math.max(0, nowMs - pushedAt) : null),
        // `{ missing, mode, pushed_at, image_rev }` for a cell that binds a single feed, `null`
        // when it binds none — NOT APPLICABLE, the same thing `null` means on `ctx.rows` and
        // `ctx.series`, and not a verdict on anything. A chart lands there too: it binds PER SERIES
        // and has no `config.feed` at all, so `ctx.series`' own `missing` flag is where that
        // widget's "does this feed exist" question is answered. The LOUD state is `missing: true`.
        // See feedSignalFor's own docstring.
        feed,
        // Only the assets that are decoded RIGHT NOW (assets.mjs). A design must render without
        // them — loading is async and draw is not — so a name being absent is the normal first
        // frame, not an error. The 1s render tick repaints once they arrive.
        assets: assetsFor(design.meta),
        // The live alert list — every design gets it, only alert_feed reads it (see paintWidgets'
        // own docstring for why this can't be ctx.data).
        alerts,
        // `null`, not `[]`, when this cell is not stream-bound, so a design can tell "not a
        // stream" from "a stream with nothing in it" — see rowsForCell's docstring.
        rows: rowsForCell(cell, feeds),
        // `null` for a widget whose config declares no `series` array; otherwise one entry per
        // configured series, positionally matching `chartConfig(config).series` — see
        // seriesForCell's docstring.
        series: seriesForCell(cell, feeds),
        // Never empty, never `undefined` — see rampFor's own docstring. `board` doubles as the
        // palette here, the same object `resolveTokens` above already resolved `tokens` against.
        ramp: rampFor(board, board),
        // The decoded drawable for this cell's bound image feed, or `null` — see
        // bitmapForCell's own docstring.
        bitmap: bitmapForCell(cell, feeds),
      }
      const g = prepare(canvas, box.px.width, box.px.height, globalThis.devicePixelRatio || 1)
      // `cardChrome` is `{surface, border, gap, padding}` when the theme's backdrop asks for
      // cards (device.js's cardChrome()), null for every other backdrop. `config.card === false`
      // opts a single cell out (cellSchema's shared `card` knob) — a title strip sitting directly
      // on the board is the case it exists for. The card paints against the FULL cell, then the
      // origin moves so the design lands inside the padded interior; prepare() resets the
      // transform every frame, so the translate never accumulates.
      if (inset > 0) {
        paintCardChrome(g, box.px.width, box.px.height, cardChrome)
        g.translate(inset, inset)
      }
      design.draw(g, drawCtx, elapsed)
      return design.isAnimating?.(drawCtx) ?? false
    }

    stopAnimation(key)
    let animating = false
    try {
      animating = paint(0)
    } catch (err) {
      console.error('widget paint failed for cell', idx, err)
      return
    }
    if (animating) startAnimation(key, paint)
  })

  // The sweep is only meaningful after a paint that visited the WHOLE board. A partial paint skips
  // cells because they were not due, not because they disappeared, so diffing against its subset
  // would stop the animation of everything the tick left alone — the clock tick killing the clock's
  // own crossfade. Its keys are not a baseline either: the next full render still has to diff
  // against the whole board, or a cell that genuinely did vanish would keep its frames.
  if (wanted) return
  keysToStop(previousKeys, currentKeys).forEach(stopAnimation)
  previousKeys = currentKeys
}

/**
 * Tear down every animation this board registered, for the paths where the sweep above never runs
 * render() only calls renderGrid — and therefore paintWidgets — when a
 * screen is assigned, and returns before rendering anything at all when the device is unpaired.
 * On either path the grid's canvases are gone or hidden while their keys are still in the loop,
 * which would leave it painting a detached canvas at full rate for as long as the device stays up.
 */
export function stopAllWidgets() {
  previousKeys.forEach(stopAnimation)
  previousKeys = new Set()
}
