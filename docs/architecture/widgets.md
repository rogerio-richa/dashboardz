# The widget design contract

This is the contract a **design** must satisfy to render on a Dashboardz
device's canvas kiosk. It's written to be pasted into a prompt alongside a
task:
an outside author, human or model, should be able to produce a correct
design from this page alone, without reading `device.js`.

A **widget type** (`text_block`, `value_tile`, `gauge`, …) is what a board
author picks in the admin — a data shape and a purpose. A **design** is one
way to draw that widget type. A widget type can have several designs (`gauge`
ships `bar` and `ring`); a board or a theme picks which one paints a given
cell, at the cell's own risk of falling back if the pick doesn't resolve (see
[Design resolution and degradation](#design-resolution-and-degradation)).

**Coverage today: 12 of the 12 widget types are on this contract** — `clock`,
`weather_forecast`, `news_list`, `calendar_events`, `text_block`,
`value_tile`, `gauge`, `stream_list`, `table`, `alert_feed`, `image` and
`chart`. Nothing on a board is drawn by the device page's own DOM code any
more: `device.js` emits a canvas per cell and has no widget-specific branch
left. The only DOM a cell can still contain is an authoring notice — the cell
is smaller than its widget's minimum, or names a widget type this build has
never heard of.

## What a design is

A design is one ES module exporting a default object:

```js
export default { meta, draw }
```

- `meta` — a plain object describing the design (below). Checked at
  registration time, not at draw time: a malformed `meta` throws when the
  module registers, before it can ever reach a device.
- `draw(g, ctx, elapsedMs)` — paints one frame. `g` is a canvas-like drawing
  surface restricted to the [portable drawing subset](#the-portable-drawing-subset);
  `ctx` is the [draw context](#the-draw-context) below. `elapsedMs` exists for
  animating designs and can be ignored by everything else.
- `isAnimating(ctx)` — optional. Returning `true` asks the host for another
  frame; a design that omits this is drawn once and left at rest. It answers
  "am I animating *right now*, for this `ctx`", not "do I animate in
  principle" — a design must derive that from `ctx.now`, never start its own
  timer.

**`elapsedMs` restarts on every repaint.** `paintWidgets` stops a cell's
animation, paints frame 0 and re-registers it whenever it repaints the cell —
which happens on every data push, not only when the board changes. For a
*bounded* transition that is exactly right: the ease should run again. For a
**persistent** animation it is a trap, because the animation silently jumps
back to its start each time a feed pushes. `stream/ticker`'s crawl shipped with
that bug and snapped back to the beginning every few seconds on a real board.

The clock a persistent animation should read is **`ctx.now`, on its own**. The
host re-reads its clock inside the frame callback (`paintWidgets`: `const paint
= (elapsed) => { const nowMs = hubNow() … }`), so `ctx.now` is live on every
frame — it is not captured at paint time. `elapsedMs` is for bounded
transitions, which want to run again after a repaint.

Do **not** add the two together. That was tried, and it double-counts: every
repaint drops the sum by whatever `elapsed` had accumulated, so the animation
lurches backwards a few pixels each time a feed pushes. `stream/ticker.mjs` and
`text/led.mjs` read `ctx.now` only, and `widget-ticker.test.ts` pins it by
drawing the same `now` with wildly different `elapsedMs` and requiring identical
pixels.

One thing that clock cannot fix: an animation whose geometry depends on the
DATA — a crawl wraps at its content width — will still jump when the content
changes under it. That is a feed-cadence question, not an animation one.
- `pointer` — optional; see [Pointer input](#pointer-input) below. A design
  that declares it becomes touch-interactive: the host routes gestures on its
  cell into these handlers. A design must never call `addEventListener`
  itself — it has no DOM to listen on (portable drawing subset).

### Pointer input

A design that wants touch input declares a `pointer` group of handlers, all
optional, all called by the HOST (device.js's grid-level gesture code) with
**cell-relative CSS pixels**:

```js
export default { meta, draw, pointer: {
  move(cell, dy),           // one drag step; dy > 0 = finger moving down the glass
  tap(cell, x, y, actions), // a touch that never travelled past the drag slop
  wheel(cell, deltaY),      // a mouse-wheel notch over the cell (desktop preview)
} }
```

`actions` is the channel back out — the only way a design *sends* anything.
The host passes `{ answer(alertId, optionId), dismiss(alertId) }`, wired to
the same wire messages the idle-screen card buttons send, so the hub cannot
tell which surface a human answered from. `alert_feed` is the shipped
consumer: its question cards paint an answer-button row, every card carries
a Dismiss control, an overflowing feed drags/wheels with the card at the
fold showing partially (its counter names only cards entirely below the
edge), and its `tap` routes hits to `actions.answer`/`actions.dismiss`.
Guard the calls (`typeof actions?.answer === 'function'`) — a host older
than the channel passes nothing.

One more `alert_feed` knob, hand-authored because an array is not a shape
`meta.options` can generate: `senders`, an allowlist of sender names. A
screen that exists for one integration's cards (a Claude tab, a netdata
tab) names its senders and stops inheriting every other card aimed at the
same device. Rendering only — chimes and tab dots stay device-wide, so an
alarm still sounds even when its card renders on another tab. Empty or
malformed means every sender, so a typo cannot blank the wall.

Every handler receives the raw grid `cell` (to derive whatever key its state
lives under — `stream/scroll.mjs` uses `cell.config.feed`) and returns a
boolean: `true` means "my state moved, repaint me", and the host repaints
exactly that cell through the same per-cell path the clock tick uses. The
contract's sharp edges:

- Handlers hold state OUTSIDE `ctx.state` (which is a fresh `{}` every paint)
  — a module-level map keyed off the cell is the shipped pattern. Geometry a
  handler needs for hit-testing (arrow positions, scroll bounds) is stored by
  `draw` into that same state, so painter and hit test cannot disagree.
- A gesture can race a first draw: a handler must return `false` for a cell
  it has no state for yet, never throw.
- The host owns the gesture grammar (drag slop, pointer capture, tap-vs-drag)
  so every interactive design behaves identically under a finger. A design
  only ever sees the distilled events above.
- The takeover overlay sits above the grid and wins: no pointer handler runs
  while a critical alert is showing.

A design registers by being imported and listed in
`hub/static/device/widgets/catalogue.mjs`'s `CATALOGUE` array — the one list
a new design is added to. Registration order matters: the first design
registered for a widget type is that widget's default, unless some other
design for the same widget sets `meta.default: true`.

## The `meta` shape

Required on every design: `id`, `widget`, `label`, `suggested_ratio`,
`tokens`, `animations`.

- `id` — string, unique among designs for the same `widget`.
- `widget` — the widget type id this design paints (must match an entry in
  `widgets/definitions.mjs`).
- `label` — human-readable name shown in the design picker.
- `suggested_ratio` — the width/height this design was drawn for. The host
  does **not** resize a cell to it: it is advice, and a design that wants to
  honour its own ratio reads `meta.suggested_ratio` itself inside `draw` and
  letterboxes by hand (`clock/flip.mjs` and `clock/nixie.mjs` are the only
  two that do).
- `tokens` — the design's colour vocabulary: `{ name: { type: 'color',
  default: '@paletteKey' | '#hex' } }`. A token not declared here cannot be
  themed. `default` starting with `@` resolves against the board's palette;
  otherwise it's a literal. Resolution order is theme override → palette →
  this literal default.
- `animations` — `{ transition: [...], persistent: [...] }`, declaring what
  the design animates *in principle*. Every shipped design declares
  both empty, and pairs with the optional `isAnimating` above.

Optional:

- `options` — the knobs the admin can generate a form for (below).
- `assets` — `{ name: 'file.png' }`, a raster asset the design draws with
  `drawImage`. Declared by bare filename only, resolved by the host, never a
  URL the design composes itself. `ctx.assets` returns only the ones decoded
  *right now*; a name being absent is the normal first frame, not an error.
- `default` — `true` marks this design as its widget's default regardless of
  catalogue order.

### `options`

Each entry is `{ type, label, default?, choices?, path? }` — or, for a
repeating group, `{ type: 'list', label, min, max, item }` — checked by
`registry.mjs`'s `validateOptions` at registration time:

- `type` is exactly one of `text`, `number`, `boolean`, `select` or `list`
  — nothing else is accepted at the top level. (`feed` is a fifth type that
  exists **only inside a `list`'s row**; see below.)
- `label` is **required**, a non-empty string: it's what a person reads on
  the generated form field.
- `select` **requires** a non-empty `choices` array.
- `default` is **optional**. A design may legitimately declare none. The
  real example is `value_tile`'s `decimals`: unset has always meant "no
  forced rounding — print the raw number", which isn't a value `decimals`
  could ever hold. A placebo default (e.g. `0`) would be indistinguishable,
  in the generated field, from an operator who typed `0` on purpose — leaving
  `default` off is the honest declaration instead. When a default *is*
  given, it's still checked against the option's own `type`.
- `path` is **optional** and dotted: where this option's value lives on
  `cell.config`. Leave it off and the option is one property directly on
  `cell.config`, named after the option — the original and still the common
  case. Give it and the generated field reads and writes that nested
  location instead. A `list` never takes one.

#### `path`: a knob that isn't a top-level key

```js
options: {
  min: { type: 'number', label: 'Min', default: 0 },
  warn: { type: 'number', label: 'Warn', path: 'thresholds.warn' },
  crit: { type: 'number', label: 'Crit', path: 'thresholds.crit' },
}
```

That is `gauge`'s real declaration (`widgets/gauge/bar.mjs`). `min` has no
`path`, so it writes `config.min`. `warn` writes `config.thresholds.warn`,
which is the shape the save schema has always required — and setting one of
the pair leaves the other alone, because the admin sends the whole
`thresholds` object with its existing siblings intact.

The rules, all enforced at registration:

- A `path` is dot-separated **property names**: a letter or `_`, then
  letters, digits or `_`. `thresholds.warn` and `clamp.title_lines` are
  paths; `''`, `a..b`, `.a` and `a.` are not.
- **No array indices.** `columns.0.header` is refused, and deliberately —
  see the limitation below.
- **No `__proto__`, `constructor` or `prototype` segment.** These become
  object keys on board-authored config carrying whatever an operator typed,
  which this codebase treats as attacker-adjacent; a path that could write
  through a prototype never reaches a device because the design does not
  register.

The knobs this reached, all of them previously hand-built in the admin or
unreachable from it entirely: `gauge`'s `thresholds.warn`/`.crit`,
`alert_feed` and `stream_list`'s `clamp.title_lines`/`.body_lines`, and
`alert_feed`/`stream_list`/`table`'s `overflow.counter`.

#### `list`: a knob that repeats

A `list` is a **repeating group**: `min` to `max` rows, each row an object
built from the fields under `item`. It is what `table`'s columns and
`chart`'s series are, and until it existed each of those cost a hand-written
editor in the admin.

```js
options: {
  columns: {
    type: 'list',
    label: 'column',
    min: 1,
    max: 4,
    item: {
      header: { type: 'text', label: 'header', required: true },
      path: { type: 'text', label: 'path', required: true },
      align: { type: 'select', label: 'align', default: 'left', choices: ['left', 'right'] },
    },
  },
}
```

That is `table`'s real declaration (`widgets/table/grid.mjs`). It writes
`config.columns` — an array of `{ header, path, align? }` — and the admin
generates the whole editor from it: a row per entry, an **Add column** button
while there is room, a **Remove column** button while there is more than one.

The rules, all enforced at registration:

- **`label` names ONE entry**, not the group. The admin builds `Add column`,
  `Remove column` and each row's field labels out of it, and there is no way
  to go from a plural back to a singular.
- **`min` and `max` are required**, whole counts, `max` ≥ `min` ≥ 0. They are
  not decoration: they are the save schema's `minItems`/`maxItems`, and the
  Add/Remove buttons disappear at them. A grid is PATCHed *whole*, so a UI
  that lets an operator build a fifth column costs them every unsaved edit on
  the screen and reports an array length they were never shown a number for.
  `hub/test/option-bounds.test.ts` compares your `min`/`max` against the real
  schema, so the two cannot drift.
- **`item` is an object of ordinary option specs**, checked by exactly the
  rules above — same types, same `label`, same `choices`, same `default`. Two
  extra keys mean something only here:
    - `required: true` marks a key the save schema's `items.required` carries.
      An added row is seeded with it, and clearing its input falls back to
      that seed instead of deleting the key. Leave it off and the field is
      optional: an added row simply doesn't carry it, and emptying it removes
      it. Both item schemas are `additionalProperties: false`, so this is the
      difference between a row that saves and a 400.
    - `unique: true` (on a `select` only) means an added row must not start on
      a value another row already holds. `chart`'s `icon` is the one: the save
      service refuses two series wearing the same glyph, so a second row
      seeded with the first row's icon would fail on a key nobody touched.
- **`feed` is an item type**, and only an item type. It declares that this
  field is a *feed binding*, not free text: the admin draws the same data
  source picker every other widget gets, filtered by the modes
  `widgets/bindings.mjs` declares for the **host widget** — `chart` binds
  `stream` feeds, one per series — so a design never restates a rule the hub
  also enforces. A cell's own top-level `config.feed` already has a control,
  which is why `feed` is refused outside a row.

`chart`'s declaration is the same shape with the binding in it:

```js
series: {
  type: 'list', label: 'series', min: 1, max: 4,
  item: {
    feed: { type: 'feed', label: 'feed', required: true },
    y_path: { type: 'text', label: 'y_path', required: true },
    icon: { type: 'select', label: 'icon', choices: CHART_ICONS, unique: true, required: true },
    label: { type: 'text', label: 'label' },
  },
}
```

### The remaining limits

There is no longer a knob on a shipped widget that `meta.options` cannot
express — `table`'s columns and `chart`'s series were the last two, and both
are declared. What the mechanism still refuses, all of it at registration:

| Refused | Why |
|---|---|
| a `list` inside a `list` | one level only. Nothing in this codebase's save schemas nests an array in an array, and the admin has no control for it. |
| `path` on a `list` | a list writes its array at its own name (`config.columns`). Both shipped ones live there, so nesting would be a capability with no consumer — the kind this contract deletes rather than freezes. |
| `path` on an item field | an item field writes a property directly on its row. Both row schemas are flat. |
| an array index in a `path` (`columns.0.header`) | one position in a repeating group is not a location: the row it names is one an operator can delete. Declare the `list`. |
| `feed` outside a `list` item | a cell's own `config.feed` is a required binding the admin already draws. A design declaring it would put a second control on one key. |
| `required`/`unique` outside a `list` item | neither means anything to a knob that does not repeat. |

If you need one of these, the honest answer today is that it needs work in
the admin — but nothing shipped needs one, and each is a *narrowing* that can
be widened later without invalidating a design that already registers.

A related trap worth stating plainly: a key that some *other* part of the
system reads must **not** be declared as an option. `alert_feed`'s
`sound_info` sits on the widget's config but is read by the Android app
(`Chime.kt`), not by any design — declaring it would let the generated form
start writing a key whose meaning lives outside the renderer entirely.
`stream_list`/`table`'s `chime_activity` (stream-activity contract) is the same trap on the same
two widgets: device-read, admin-hand-built, never a `meta.option`.

## The portable drawing subset

### What a design may reach for

At **draw time** a design gets its world through exactly two things: `g` and
`ctx`. Everything it paints goes through `g`; everything it knows — data,
config, colours, time, size — arrives on `ctx`. Nothing else is in scope.

Concretely, a design may not reach for any of these, and a test enforces it:

| Banned | Why |
|---|---|
| `document`, `window`, `navigator`, `localStorage`, `sessionStorage`, `indexedDB`, `caches` | there is no browser under a firmware renderer |
| `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` | the host loads; a design only draws what it is handed |
| `new Image()`, `new URL()`, `URL.*`, `createImageBitmap()` | asset and bitmap loading is the host's job — see `ctx.assets` and `ctx.bitmap` |
| `setTimeout`, `setInterval`, `requestAnimationFrame`, `queueMicrotask` | a design is drawn, it does not schedule itself — declare `isAnimating` instead |
| `Date.now()`, `new Date()` | **`ctx.now` is the only clock a design may read** |
| `Worker` | a design runs where it is drawn |

Note the last row is about reading a clock, not about the `Date` type.
`new Date(ctx.now)` is formatting a timestamp the host supplied and is
perfectly fine — ten shipped designs do exactly that. It is `Date.now()` and
the no-argument `new Date()` that reach past `ctx`.

That is a rule about *runtime* reach, not a ban on `import`. A design is an
ES module and may import **pure helper modules from the host tree** — modules
that compute and return values, touch no DOM, no network and no clock, and
would behave identically under a recording surface. Three kinds exist today,
and they are the whole legitimate set:

- **Shared pure helpers in `hub/static/device/`** — `layout-core.mjs` is the
  one in use. `value/tile.mjs` imports `resolvePath`, `displayValue`,
  `FLOOR_VALUE` and `FLOOR_LABEL` from it; `gauge/shared.mjs` imports
  `resolvePath`, `displayValue`, `gaugeFraction` and `gaugeSeverity`;
  `clock/digital.mjs` imports `clockTimePx`, `clockDatePx` and `fitSteps`.
  These are formatting and arithmetic, not rendering.
- **Cross-widget helper modules under `widgets/`** — `text-fit.mjs`
  (`fitted`, `paintText`, `wrapClamped`, `centredNotice`, `quietLine`,
  `formatAge`), the shrink-to-fit, line-clamping, empty-state-notice (loud
  `centredNotice` and its quiet one-line sibling `quietLine`) and age-caption
  helpers most text-bearing designs use; and `clock-geometry.mjs`
  (`handAngles`, `segmentsFor`), imported by `clock/analog.mjs` and
  `clock/segment.mjs`.
- **A per-widget sibling module**, for logic two designs of the *same* widget
  type must not compute differently: `gauge/shared.mjs` holds
  `normalizeGauge` for both `gauge/ring.mjs` and `gauge/bar.mjs`, and
  `weather/weather-code.mjs` holds `conditionLabel`/`drawCondition` for
  `weather/forecast.mjs`.

Two things follow that often surprise a new author. First, importing a helper
is **not** a fallback for when a design "can't" do something itself — the
worked example below, `text/block.mjs`, reimplements its own `resolvePath`
locally rather than importing the identical function, and both choices are
legitimate. Prefer importing when the helper *is* the contract (`displayValue`
defines what a formatted number looks like across the whole product, and two
copies of it could drift); prefer restating when the helper is small,
self-contained arithmetic you want to read next to the code that uses it.
Second, a helper module carries the **same** restrictions as the design that
imports it — `gauge/shared.mjs` is bound by every rule below just as
`gauge/ring.mjs` is. An import is not a way to smuggle a browser API in.

What is off the table **absolutely**, in a design and in anything it imports:

- `document`, `window`, and anything that reaches the DOM. A design has to
  run where there is no DOM at all.
- `fetch`, `XMLHttpRequest`, `WebSocket`, or any other network access. All
  data arrives on `ctx.data`; a design never goes and gets any.
- `localStorage`, `sessionStorage`, cookies, or any other persistence. Per-
  frame state belongs on `ctx`.
- `Date.now()`, `new Date()`, and every other clock. Time comes from
  `ctx.now` only — this is what makes a frame reproducible.
- `setTimeout`/`setInterval`/`requestAnimationFrame`. A design never drives
  its own frames; it answers `isAnimating(ctx)` and the host schedules it.

`hub/test/portable-subset.test.ts` enforces part of this mechanically — it
rejects a design file mentioning `document`, `localStorage` or `window.` —
and the rest is on the author. The lexical check is a backstop against the
obvious slip, not a proof of purity; `fetch` and `Date.now()` are no less
forbidden for not being pattern-matched today.

### The `g` subset

`g` is further restricted to a fixed operation subset, enforced by
`hub/test/portable-subset.test.ts` against every design file. The subset was
chosen by one rule: an operation earns its place if a **recording surface**
sitting between the design and real firmware can lower it to primitives that
firmware already has (a curve could be flattened to `lineTo` segments; a
gradient or `clip()` cannot lower cheaply and is excluded). The complete,
current list:

```
arc, beginPath, clearRect, closePath, drawImage, fill, fillStyle, fillText,
font, globalAlpha, lineCap, lineTo, lineWidth, measureText, moveTo, rect,
restore, rotate, save, scale, setTransform, stroke, strokeStyle, textAlign,
textBaseline, translate
```

Anything not on this list — gradients, filters, blend modes, `clip()`,
`shadowBlur` — is off the table permanently, not just unused today.

## The draw context

`draw(g, ctx)` receives:

- `ctx.tokens` — this design's declared token names, already resolved to
  concrete colours (theme → palette → built-in default). Every declared
  token has a value; nothing to guard for `undefined`.
- `ctx.config` — `cell.config`, the raw board-authored config for this cell,
  as saved (`{}` if the cell configured nothing).
- `ctx.data` — the cell's bound feed, already unwrapped: a value feed's
  payload as-is, or a stream feed's rows as an array of payloads (newest row
  first). `null` when no feed is bound, or the wire couldn't be resolved.
- `ctx.box` — `{ w, h, t }`: the cell's drawing surface in device pixels
  (`w`, `h`), plus `t`, a continuous 0–1 size-tier hint some older designs
  use for ramped font sizing. A design should generally size itself directly
  off `w`/`h`.
- `ctx.now` — the host's current time in milliseconds, the *only* clock a
  design may read.
- `ctx.assets` — decoded raster assets this design declared, by name; see
  `meta.assets` above.
- `ctx.stale` / `ctx.age_ms` — the feed's staleness, computed once per frame
  by the host so no two designs can compute it differently. The rule,
  exactly as implemented:
  - `stale` (boolean) drives the design's **own** dimmed treatment of its
    primary reading — nothing else fades.
  - `age_ms` (number or `null`) gates the age caption. It's non-null for
    **any** feed that has actually been **pushed to at least once**, fresh
    or stale alike — staleness and "has an age worth showing" are
    independent signals, not one gating the other.
    **`chart` is the one exception**, and it is deliberate: a chart binds no
    top-level feed, so both values are aggregated across its series and
    `age_ms` is gated on staleness there. If you are writing a multi-feed
    widget, read [the per-series note below](#staleness-for-a-per-series-binding)
    before assuming this bullet applies to you.
  - A cell with **no feed bound**, or a feed **bound but never pushed**,
    gets `stale: false` and `age_ms: null` — no caption. Never-pushed is
    quiet, not stale.
- `ctx.alerts` — the device's live alert list, newest-first, or `[]` when
  there are none. Every design receives it; only `alert_feed` reads it.
  It cannot travel through `ctx.data`: alerts arrive by `ALERT_ADD` and
  live in the device's own state, not behind a feed id — `alert_feed`'s
  config has never had a `feed` key to bind, so routing them through
  `ctx.data` would make the contract claim something false. `[]`, never
  `undefined`, so a design can iterate it unconditionally, and the host
  passes the SAME array whichever path painted the board (a full render or
  a per-cell repaint), so a design never sees different alerts depending
  on which one drew it.
- `ctx.rows` — for a cell bound to a **stream** feed, an array of
  `{ payload, pushed_at }` per row in wire order (newest first). `null`
  for a value feed, an image feed, an unbound cell, or a malformed wire —
  the same degradation `ctx.data` already applies. It exists because
  `ctx.data`'s stream shape (bare payloads) is what `news_list` already
  consumes and every stream design expects — changing it to
  carry wire metadata would be a breaking change to the versioned contract, so
  a stream design that needs `pushed_at` (`stream_list`'s
  per-row age chips, for one) reads it from this second, additive channel
  instead. `null`, not `[]`, when the cell is not stream-bound, so a
  design can tell "not a stream" from "a stream with nothing in it".
- `ctx.series` — the multi-feed twin of `ctx.rows`, for a widget that binds
  its feeds **per series** rather than through one `config.feed`. `null`
  when the cell's config declares no `series` array at all; otherwise ONE
  ENTRY PER CONFIGURED SERIES — `{ feed, rows, missing }` — in config order.
  **Positional and never compacted.** A series whose feed id is absent from
  the device gets `missing: true` and `rows: []` rather than being dropped,
  because entry `i` is also colour index `i`: removing one would silently
  recolour every series after it, and the widget would lose the legend row
  that says which binding is broken. `missing` is about the feed **id**
  being absent, nothing else — a series pointed at a feed that exists but
  is the wrong mode arrives as `missing: false, rows: []`, the same as a
  real stream nobody has pushed to.

  **The row *element* is identical to `ctx.rows`'s; the *absence* semantics
  are not — this is the one place an author following "just like `ctx.rows`"
  gets it wrong.** Each entry present in `ctx.series[i].rows` is the same
  `{ payload, pushed_at }` shape `ctx.rows` uses. What differs is what an
  *absent* row list means, because `ctx.rows` is TRI-state and
  `ctx.series[i].rows` is BI-state:

  | Channel | Not-stream-bound | Well-formed, empty | Has rows |
  | --- | --- | --- | --- |
  | `ctx.rows` | `null` | `[]` | `{payload, pushed_at}[]` |
  | `ctx.series[i].rows` | `[]` | `[]` | `{payload, pushed_at}[]` |

  `ctx.rows === null` means one specific thing: this cell itself is not
  stream-bound. `ctx.series[i].rows === []` is worn by three different
  situations that a design cannot tell apart from the array alone — a value
  feed bound to that series slot, a stream feed that is genuinely empty, and
  a malformed wire — because `seriesForCell` never has a `null` to return
  per entry; `missing: true` is reserved for "this feed id is not on the
  device at all" (above), not for "this series can't be read as rows." A
  design that treats `ctx.series[i].rows` the way it treats `ctx.rows` —
  branching on `null` to mean "not applicable" — will never see that branch
  taken; every one of those three cases already arrives as `[]`, and `chart`
  draws them all alike (`no data`, once a series resolves but nothing
  survives).
- `ctx.ramp` — the series colour ramp: a non-empty array of colour strings,
  never containing `undefined`, indexed `ramp[i % ramp.length]` so a ramp
  of any length cycles. This is a channel and not `meta.tokens` because
  `meta.tokens` is a fixed name→colour vocabulary and a series count is
  config-driven; "however many colours the board declares" cannot be
  spelled there. It comes from the theme's `board.series` when that
  validates whole, else from the board's own info/warn/critical/dim.
  **A design must never read a CSS variable for a colour** — see the
  portable subset below.
- `ctx.bitmap` — for an **image** cell: the drawable that is decoded *right
  now*, or `null`, which is the normal first frame, since decoding is
  asynchronous and `draw` is not. A design never loads anything itself; the
  host owns the fetch, the decode and the backoff, and repaints the cell
  when a bitmap lands.

    **`ctx.bitmap` GATES on the feed's mode; `ctx.feed` REPORTS it.** This is
    the one place two channels describing the same feed deliberately disagree,
    and it will surprise you if you do not know it. Bind a *value* feed to an
    image cell and you get `ctx.bitmap === null` — the host refuses to fetch a
    bitmap from something that is not an image feed — while `ctx.feed` is a
    perfectly ordinary `{ missing: false, mode: 'value', … }`. So `bitmap ===
    null` on its own does **not** mean "nothing has decoded yet"; it can also
    mean "this is not an image feed at all". Ask `ctx.feed` which one you are
    looking at. `image/frame.mjs` reads `ctx.feed.image_rev` rather than the
    mode precisely so a misbound cell falls to the quiet `— no image yet`
    instead of a loud error, which is what the DOM branch it replaced did.
- `ctx.feed` — **does this cell's feed exist?** For a cell that binds one
  single feed (`config.feed`), that feed's delivery facts:
  `{ missing, mode, pushed_at, image_rev }`. Every key is always present,
  and every absent value is spelled `null` — there is no second spelling —
  so a design reads them without guarding.

  **Three answers, and only one of them says something is wrong.** Read
  them in this order:

  - `ctx.feed === null` — **not applicable.** This cell binds no single
    feed: a **chart** (which binds per series and has no `config.feed` at
    all), a `text_block` showing literal typed text, a cell nobody has
    configured yet. `null` is the same "this question doesn't apply here"
    that `ctx.rows === null` ("not stream-bound") and `ctx.series === null`
    ("declares no series array") already mean. **It is not a report that
    anything is broken.** A design that *requires* a feed may of course
    treat "nothing bound" as a misconfiguration — `table`, `value_tile` and
    `image` all do — but that is the design rule on its own binding, not
    something this channel told it.
  - `ctx.feed.missing === true` — **the feed is not there.** The cell names
    a feed id and the device does not have it (the hub omits a
    deleted-but-still-referenced feed from the wire entirely). Somebody has
    to go and fix the cell: this is the **loud** state, and it is the only
    one. The other keys are all `null` beside it — nothing is known about a
    wire that is not there. The flag is spelled exactly like
    `ctx.series[i].missing`, which answers the same question per series; one
    contract should not answer one question two ways.
  - `ctx.feed.missing === false` with `pushed_at === null` — **the feed is
    there and empty.** It exists, it is configured, and nothing has ever
    been pushed to it: the ordinary state of a feed created five minutes
    ago, and the **quiet** state. Never-pushed is quiet, not stale — the
    same rule `ctx.age_ms` states above.

  Nothing else on the contract can tell those apart. `ctx.data` is `null`
  for all three, because a never-pushed value feed's payload is
  legitimately `null`, and `ctx.stale`/`ctx.age_ms` are `false`/`null` for
  all three. Before this channel every single-feed design had to guess, and
  each of them guessed the louder answer — an operator whose feed was
  merely empty was told the feed was **missing**, and went hunting for a
  deletion that had never happened.

  The remaining fields:

  - `mode` — `'value'`, `'stream'` or `'image'`, or `null` for a mode this
    build cannot name (a board served by a newer hub), so a design
    switching on the three documented modes lands on its own default
    branch rather than on a fourth it has never heard of. It answers the
    other half of "can I show this?": a feed can exist, and be empty, and
    still be the wrong *kind* for this cell.
  - `pushed_at` — the wire's hub-clock timestamp of the last push, or
    `null` for a feed nobody has pushed to.
  - `image_rev` — an **image** feed's revision, or `null` for a feed that
    is not an image feed or is one that has never been pushed. `image` uses
    it, and only it, for its own never-pushed test: the bitmap endpoint is
    keyed on the rev, so it and `pushed_at` are not interchangeable.

  The channel **reports, it does not rule**. It states what the wire is and
  never refuses to answer because the cell wanted a different kind of feed;
  what a wrong-kind feed *means* is the design's decision, and the shipped
  designs do not all decide alike. `image` treats a value feed as a feed
  that exists with no revision and draws its quiet line, because that is
  what an image cell has always drawn for it. `table` and `value_tile`
  treat an image feed as unusable and stay **loud** whether or not it has
  ever been pushed, because a table can never show a picture and saying so
  at bind time beats saying so a week later. Both are only expressible
  because `mode` crosses and the channel passes no judgement on it.

  *This replaces `ctx.image_feed`*, a widget-specific `{ rev }` channel
  that existed only because `image` was the first design to need this
  distinction. Every other single-feed widget needed it just as much and
  had no way to ask; the revision carried across under a name that says
  which mode it belongs to, and `ctx.image_feed` is gone.

### Staleness for a per-series binding

`ctx.stale`/`ctx.age_ms` still carry staleness for a cell that binds its
feeds per series, aggregated by the host: `stale` is true when **any** bound
series is stale (a multi-series plot is only as fresh as its stalest input),
and `age_ms` is the age of the **stalest stale** series — `null` when none of
them is. That last part is the one place `age_ms` is gated on staleness
rather than on "has this feed ever been pushed", and it is deliberate: the
chart's corner age caption has always appeared only when something was
actually stale.

## Design resolution and degradation

Which design paints a cell is resolved in strict precedence, cell first:

1. `cell.config.design`, if the cell names one — full stop, whether or not
   *this build* can actually draw that id.
2. Otherwise, the theme's per-widget-type choice.
3. Otherwise, the registry's default for that widget (the catalogue-order or
   `meta.default` design described above).

Critically, this is a precedence rule, not a validity cascade: if the cell
names a design id nobody registered, the cell's request still wins the
precedence, and the registry then substitutes the **widget's own default** —
it does **not** fall through to the theme's choice, even when the theme
named an id that *is* registered. A design added later that a client's
cached page doesn't know yet degrades the same way, quietly, to the
default — never to a blank cell.

A missing or unresolvable data payload is **not an error**. It's the
widget's own "unavailable" state, and each design decides how to show it —
`text_block` and `value_tile` paint a small centred notice ("No text" / "No
value"); `gauge` draws an empty, uncoloured track. A design that actually
*throws* while drawing is the real error path: the host catches it, logs it,
and skips that cell for the frame, leaving every other cell on the board
painting normally.

The shipped designs distinguish **two** unavailable states, and an author
should copy the distinction rather than collapse it. **The rule, stated
once so there is exactly one policy to copy: a design is LOUD when the
binding is *wrong*, and QUIET when the binding is *right* but the feed is
simply empty.** "Wrong" covers no feed bound, a bound id that doesn't
resolve, and a feed of a mode this widget cannot read at all — three
different authoring mistakes, one sentence that fixes all of them. "Right
but empty" is exactly one thing: a feed that exists, is a mode this widget
*can* read, and has never been pushed to.

- **Loud** — the cell is misconfigured and a person needs to fix it.
  `stream_list` and `table` paint a centred **"Feed missing"** notice, and
  `value_tile` a **"No value"** one, when no feed is bound (`ctx.feed ===
  null`) or the bound id resolves to nothing (`ctx.feed.missing`). `table`
  adds a second,
  textually distinct **"Not an array"** for a path that resolves to something
  that isn't a list — deliberately not the same words, so an operator can
  tell "you bound nothing" from "you bound the wrong path". `chart` and
  `image` paint the same **"Feed missing"** notice: `chart` only when *every*
  configured series is unresolvable (one live series among several dead ones
  still draws), `image` when its bound feed id is absent from the device.
- **Quiet** — everything is configured correctly and there is simply nothing
  to show yet. `stream_list` and `table` both draw `— no rows yet`;
  `value_tile` draws `— no value yet`; `alert_feed` with nothing active
  draws `no active alerts`; `chart` draws `no data` once its series resolve
  but no point survives across any of them; `image` draws `— no image yet`
  for a real feed nobody has pushed to. None of these is a failure, and
  dressing them up as one trains operators to ignore the loud state.

A never-pushed feed is quiet, not stale — the same rule `ctx.age_ms` states
above, and `ctx.feed` is what lets a design act on it. A feed that **exists**
(`missing: false`), is a kind the widget can read, and has `pushed_at ===
null` takes the quiet line. `table`, `value_tile` and `stream_list` all read
`ctx.feed` and `widgetAcceptsMode` (`hub/static/device/widgets/bindings.mjs`)
for exactly this gate, rather than each hand-rolling its own mode table — one
policy, one implementation, read by every design that needs it. This shared
state lets them keep a never-pushed feed quiet while still distinguishing it
from a feed that is genuinely gone.
`image` is the one design that does **not** consult `widgetAcceptsMode`: it
is deliberately mode-blind (its own docstring explains why — a value feed
bound to an image cell reads as "exists, no revision", the same quiet line
a never-pushed image feed gets), and that is a considered exception, not a
second policy.

Note the **order** those conditions are read in, because collapsing them is
the mistake this section exists to prevent: `null` on its own means only
"this cell binds no single feed", which for a `chart` is the correct and
permanent state of every board. The loud "the feed is not there" answer is
`ctx.feed.missing`.

What deliberately stays loud is a feed whose data the widget cannot use: a
`path` that resolves to nothing, a payload that isn't a list, a feed of the
wrong **kind** for this cell (an image feed bound to a table, or a value
feed bound to `stream_list`, which only ever reads a stream). Either
something arrived and the cell cannot show it, or nothing it could ever show
was bound — a person's problem either way, not an empty feed.

## Widget-type declarations

Widget *types* — not designs — are declared in
`hub/static/device/widgets/definitions.mjs`, one entry per type, each
carrying:

- `consumes` — for widget types that read a structured feed contract
  (`calendar_events`, `weather_forecast`, `news_list` today): `{ contract_id,
  required_capabilities, optional_capabilities }`, naming which contract and
  which of its capabilities this widget type actually reads. Widget types
  with no structured contract (`text_block`, `value_tile`, `gauge`, …) omit
  `consumes` entirely.
- `emits` — currently `[]` on **every** entry, with no exceptions. This is a
  reserved vocabulary for a widget type *declaring* the interactions it can
  send back out — nothing in the codebase populates or reads a non-empty
  `emits` today. Treat it as reserved, not delivered. The interactions
  themselves already flow through the pointer contract's `actions` channel
  (above), undeclared: `alert_feed`'s answer buttons use it.

## What a widget needs at the path you bind

`consumes` above is the whole contract for a *semantic* widget: it names a
canonical payload shape, so "does this source fit?" is answered by a contract
id and a list of capability names.

The nine ordinary widgets have no such shape. A gauge does not care what a
payload looks like — it cares that whatever `config.path` points at is a finite
number. They are **path-parameterised, not shape-canonical**, so their contract
cannot be a payload shape. It is a **type requirement at a bound path**, and it
is declared as `needs` beside `modes` in
`hub/static/device/widgets/bindings.mjs`.

This is what lets a screen be saved against a feed that does not exist yet: a
source can *promise* to produce a number at `cpu.percent` before anything has
been pushed, and the hub can check that promise.

### The four types

| Type | Passes when the resolved value is | Why it exists |
|---|---|---|
| `number` | a **finite** number — `NaN` and `Infinity` fail | `gauge` and `chart` both test `Number.isFinite` and drop anything else |
| `scalar` | a non-null `number`, `string` or `boolean` | what `displayValue` can print |
| `array<object>` | an array whose every element is a non-array object | a `table` needs rows, and only an object has addressable columns |
| `binary` | never path-resolved — satisfied by the feed's mode alone | an image feed's bytes are fetched by revision, not read out of a payload |

A `number` **is** a `scalar`, so a `scalar` need is satisfied by a number. The
reverse does not hold, and that asymmetry is why the vocabulary has both: a
gauge bound to a hostname is a mistake worth catching, a `value_tile` bound to
a CPU percentage is not.

### The three scopes

A scope says what the path resolves *against*.

| Scope | Resolves against |
|---|---|
| `scalar` | `feedScalarSource(wire)` — a value feed's payload, or a stream feed's **newest row's** payload |
| `row` | each stream row's `payload`, once per row |
| `collection` | each element of the array found at another config key's own path |

### What each widget needs

Read off `WIDGET_BINDINGS`, and pinned against it by
`hub/test/screens-doc.test.ts` — a widget whose needs change without this table
changing fails the suite.

| Widget | Config key | Scope | Type | Feed modes |
|---|---|---|---|---|
| `value_tile` | `path` | `scalar` | `scalar` | any |
| `gauge` | `path` | `scalar` | `number` | any |
| `stream_list` | `title_path` | `row` | `scalar` | any |
| `stream_list` | `body_path` | `row` | `scalar` | any |
| `table` | `path` | `scalar` | `array<object>` | `value` |
| `table` | `columns[].path` | `collection` of `path` | `scalar` | `value` |
| `table` | `columns[].path` | `row` | `scalar` | `stream` |
| `text_block` | `path` | `scalar` | `scalar` | any |
| `chart` | `series[].y_path` | `row` | `number` | any |
| `image` | — | `scalar` | `binary` | any |

`clock` and `alert_feed` bind no feed and declare no needs.

**`table` is the only widget whose needs depend on the mode it is bound to**,
and the only reason the last column exists. `normalizeTable` reads `cfg.path`
*only* when the cell is not stream-bound: on a stream feed the rows already
*are* the array, and each column resolves against a row's payload directly.
Declaring only the value-feed shape would reject a binding the widget has
accepted since it shipped.

### How a feed says what it produces

A capability is spelled `data.<type>@<dotted.path>` — `data.number@cpu.percent`,
`data.scalar@host`, `data.array@items`, `data.scalar@rows[].title`. The `data.`
prefix namespaces these away from semantic capabilities
(`weather.daily.condition`) so one `capabilities` array can carry both without
collision. `array<object>` shortens to `array` because the angle brackets would
need escaping everywhere a capability is matched, logged or put in a URL.

**Nobody is asked to declare these.** A hand-pushed sender declares nothing —
"push it yourself, here's the curl line" stays one line. They are **inferred**
from data the feed already carries: a value feed's stored payload, a stream
feed's recent rows, or, for a source that has not been promoted yet, its draft
preview. A number is reported as both `data.number@p` and `data.scalar@p`, so a
raw capability list is readable without a matcher to interpret it.

Inference is bounded — a depth cap, a node budget and a row sample — because
payloads arrive over the network and this walk runs on the save path.

### What a mismatch does

| Situation | What happens |
|---|---|
| The feed has never been pushed, so nothing can be inferred | **Nothing.** Inconclusive is not incompatible — absence of evidence would otherwise warn on every legacy board, on every save |
| A **live** feed's data does not satisfy the cell | The save **succeeds** and returns a `warnings` array naming the card and the capability it wanted |
| A **pending** binding's draft cannot satisfy the cell | The save is **rejected**, 400, and nothing is promoted |

The asymmetry in the last two is deliberate. A live feed's capabilities were
inferred after the fact, from data whose shape may change on the next push, and
nothing was ever declared for these widgets — so hard-rejecting would make an
already-saved mismatch impossible to correct, because the operator could not
save the screen to fix it. A pending binding is a promise the operator is
making *in that request*; if the draft cannot keep it, promoting a source that
renders nothing helps no one.

## Worked example: `text_block`

`hub/static/device/widgets/text/block.mjs`, quoted in full — the first
design ever migrated onto this contract, and the one every later design
(`value_tile`, `gauge`) copied its shape from: a pure `normalize*(data,
config)` doing every read-path decision, and a `draw` that only paints what
normalize already decided.

```js
/**
 * `text_block` — one line of text, typed in or read off a feed, as big as the cell allows.
 *
 * The first design ever migrated off the hand-written DOM branch (device.js), proving the whole
 * widget contract end to end (portable drawing subset). Structurally it follows calendar/agenda.mjs and news/list.mjs:
 * a pure `normalizeText(data, config)` doing every read-path decision, and a `draw` that only
 * paints what normalize decided. `align` is declared through `meta.options` — tab state's contract —
 * so the admin generates its form field instead of a hand-coded control ever being added for it.
 *
 * `available: false` replaces the old DOM branch's silent em-dash placeholder. A cell configured
 * with neither text nor a resolvable value has nothing to say, and saying so (matching the
 * "unavailable" wording every other migrated design already uses) is more honest than a blank box
 * a person has to guess about.
 *
 * `ctx.stale`/`ctx.age_ms` (widget contract): `paintWidgets` hands every design the same staleness the DOM
 * renderer already computed with `isStale`/`hubNow` for its own `.stale` class and age chip. The
 * age caption renders once a bound feed has actually been PUSHED to (`age_ms !== null`), fresh or
 * stale alike — a bound-but-never-pushed feed stays quiet, same as the DOM branch's own
 * "never-pushed is quiet, not stale" rule (device.js:282-284) — while `stale` alone drives the
 * dimmed treatment; the two are independent signals, not one gating the other. This is the first
 * design to consume them — value_tile and gauge read the same two fields, under the same
 * rule, once they migrate.
 */
import { centredNotice, fitted, formatAge, paintText } from '../text-fit.mjs'

// 'left', matching the DOM branch's own default (layout-core.mjs's textConfig has always defaulted
// here) — the documented default 'center' would have shifted every saved
// text_block that omits `align`, which is not a visual no-op a migration is allowed to cause.
const ALIGN_DEFAULT = 'left'
const ALIGN_CHOICES = new Set(['left', 'center', 'right'])
const DISPLAY_CODE_POINT_LIMIT = 512
// Same floor the DOM branch used for text_block (FLOOR_VALUE) — a single prominent line, not a
// dense list row, so it does not shrink as far as agenda/list's secondary text (floor 10).
const TEXT_FLOOR = 16

const meta = {
  id: 'block',
  widget: 'text_block',
  label: 'Text',
  suggested_ratio: 3 / 2,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    align: { type: 'select', label: 'Alignment', default: ALIGN_DEFAULT, choices: ['left', 'center', 'right'] },
  },
  animations: { transition: [], persistent: [] },
}

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const record = (value) =>
  value !== null && typeof value === 'object' && !isArray(value) ? value : null

/**
 * A own-data-property read. Board payloads are attacker-adjacent by construction — they come from
 * whatever a provider returned — so a getter that runs during rendering is not something this file
 * offers. Same rule and same shape as `calendar/agenda.mjs` and `news/list.mjs`.
 */
function ownData(value, key) {
  const target = value !== null && typeof value === 'object' ? value : null
  if (!target) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Own-data-property path walk into bound data — same discipline as `ownData` above, segment by segment. */
function resolvePath(value, path) {
  if (typeof path !== 'string' || path === '') return value
  let cur = value
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = ownData(cur, seg)
    if (cur === undefined) return undefined
  }
  return cur
}

/**
 * A design's `data` is `dataForCell`'s output: a value feed's payload unwrapped, or (on a stream
 * feed) every row's payload as an array — right for a table or chart, wrong for a widget that
 * shows exactly one line. The newest row is what value_tile/gauge already read from a stream feed
 * (`feedScalarSource`); this is that same rule restated against the new shape. A value feed's
 * payload is used as-is even when it happens to be an array itself — there is no feed mode left in
 * `data` to tell the two apart, and treating every array as "stream rows" would misread that case.
 */
function scalarSource(data) {
  return isArray(data) ? ownData(data, '0') : data
}

/** Bound provider-owned text before trimming, copying or measuring its complete value. */
function boundText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const points = Array.from(trimmed)
    return points.length > DISPLAY_CODE_POINT_LIMIT
      ? `${points.slice(0, DISPLAY_CODE_POINT_LIMIT).join('')}...` : trimmed
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (finite(value)) return String(value)
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }
  return null
}

/**
 * The one line to draw, or word that there isn't one. A literal `text` always wins when present —
 * matching the old DOM branch's `cfg.text != null` check — and only an all-whitespace literal
 * counts as nothing to say; a bound value falls through the same "nothing to say" rule as any
 * other unresolvable path.
 */
export function normalizeText(data, config) {
  // `c`, not `settings`: layout-core.mjs's own *Config normalizers use the same short name for a
  // sanitized config record, and `hub/test/knob-coverage.test.ts` greps for exactly that
  // convention (`c.<knob>`) when it looks for where a schema-accepted property is actually read.
  const c = record(config) ?? {}
  const align = ALIGN_CHOICES.has(c.align) ? c.align : ALIGN_DEFAULT
  const scale = finite(c.scale) ? Math.min(2, Math.max(0.5, c.scale)) : 1

  if (typeof c.text === 'string') {
    return c.text.trim() === ''
      ? { available: false, text: '', align, scale }
      : { available: true, text: c.text, align, scale }
  }

  const path = typeof c.path === 'string' ? c.path : null
  const bound = boundText(resolvePath(scalarSource(data), path))
  if (bound === null) return { available: false, text: '', align, scale }
  return { available: true, text: bound, align, scale }
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const normalized = normalizeText(data, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (!normalized.available) {
    centredNotice(g, 'No text', 'Type text or bind a feed', box, tokens, pad, normalized.scale)
    return
  }

  // `ctx.stale`/`ctx.age_ms` (widget contract): a cell with no
  // feed bound always gets `stale: false, age_ms: null` from `paintWidgets`, so this branch is
  // silent for typed-in text — there is nothing to be stale about. `age_ms !== null` is NOT "a feed
  // is bound" — `paintWidgets` also yields `age_ms: null` for a bound feed whose wire has no numeric
  // `pushed_at`, i.e. one that has never actually been pushed to. The true gate is "this feed has
  // been pushed to at least once": the caption then shows fresh OR stale, matching the old DOM
  // branch's `ageChipHtml`, whose own comment (device.js:282-284) states the same invariant:
  // "never-pushed is quiet, not stale" — a feed nobody has written to yet gets neither the chip nor
  // the stale styling, same as one with no feed bound at all.
  //
  // `stale` alone still drives the dimmed TREATMENT: the two concerns are independent.
  // A fresh, already-pushed feed's age is a normal at-a-glance signal, not a
  // warning, so it must not wait for the feed to actually go stale to appear — that would make a
  // silently-stopped feed indistinguishable from a live one until it crosses `stale_after_s`).
  const stale = ctx.stale === true
  const ageMs = typeof ctx.age_ms === 'number' ? ctx.age_ms : null
  const showAge = ageMs !== null

  const usableWidth = Math.max(0, box.w - pad * 2)
  const usableHeight = Math.max(0, box.h - pad * 2)
  // Sized off the smaller of the two axes, scaled by `t` through `box`'s caller — a tall narrow
  // cell must not blow past its own width, nor a short wide one past its own height.
  const preferredPx = Math.max(TEXT_FLOOR, Math.round(Math.min(usableHeight * 0.7, box.w * 0.16) * normalized.scale))
  const x = normalized.align === 'left' ? pad : normalized.align === 'right' ? box.w - pad : box.w / 2
  const color = stale ? tokens.dim : tokens.ink

  if (!showAge) {
    paintText(g, normalized.text, x, box.h / 2, {
      px: preferredPx, floor: TEXT_FLOOR, maxWidth: usableWidth,
      color, align: normalized.align, baseline: 'middle', weight: 600,
    })
    return
  }

  // A bound feed adds a second, smaller line — its age, always in `tokens.dim` regardless of
  // staleness, the same way the old `.age-chip` CSS class was always dim — so the pair is centred
  // as a group the same way `centredNotice`'s headline+detail are, rather than the main line
  // staying dead centre and the caption crowding whichever edge it lands nearest.
  const captionPx = Math.max(10, Math.round(preferredPx * 0.42))
  const gap = Math.max(2, Math.round(preferredPx * 0.12))
  const mainFit = fitted(g, normalized.text, preferredPx, TEXT_FLOOR, usableWidth, 600)
  const top = box.h / 2 - (mainFit.px + gap + captionPx) / 2
  paintText(g, normalized.text, x, top, {
    px: preferredPx, floor: TEXT_FLOOR, maxWidth: usableWidth,
    color, align: normalized.align, baseline: 'top', weight: 600,
  })
  paintText(g, formatAge(ageMs), x, top + mainFit.px + gap, {
    px: captionPx, floor: 10, maxWidth: usableWidth,
    color: tokens.dim, align: normalized.align, baseline: 'top', weight: 400,
  })
}

export default { meta, draw }
```
