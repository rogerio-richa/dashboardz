# How to build a screen

This is the other half of [the widget design contract](widgets.md). That page
teaches you how to write the code that paints ONE cell. This one teaches you
how to assemble the widgets that already exist into a **screen** and save it,
without opening the admin UI.

It is written to be pasted into a prompt alongside a task. An author with no
prior context — human or model — should be able to produce a screen that saves
on the first attempt from this page alone. Where a value is a bound, an enum or
a default, it is quoted from the source that enforces it, because the whole
point of this page is that its reader cannot tell a wrong doc from a right one.

You do **not** need to read `widgets.md` to build a screen. Read it when you
want a new way of DRAWING something; read this when you want to arrange the
drawings that ship.

## What a screen is

A screen is one row in the `screens` table (`hub/src/db/schema.ts`, v4 onward)
and nothing else — there is no separate "layout" object:

| Column | Type | Meaning |
|---|---|---|
| `id` | `TEXT` | `lay_`-prefixed. Never `scr_`: pre-v3 device ids already look like that. |
| `name` | `TEXT`, **UNIQUE** | Operator-facing. 1–100 characters. A duplicate is a save error, not a silent rename. |
| `orientation` | `TEXT` | `'landscape'` or `'portrait'`, CHECK-constrained. |
| `grid` | `TEXT` | The JSON blob below. |
| `theme_id` | `TEXT NULL` | `NULL` means the built-in default theme — a first-class state, not an error. |
| `rev` | `INTEGER` | Row version, starts at 1, bumped by every write. The lost-update guard; see [Saving a screen](#saving-a-screen). |
| `created_at` | `INTEGER` | Epoch milliseconds. |

Three things live where you might not expect them, and all three moved on
purpose:

- **Orientation belongs to the SCREEN, not the device** (migration v15). A
  layout is *authored for* a shape and will not fit the other one; a device is
  a piece of glass that shows whatever layout it is pointed at. Orientation is
  stored only on the screen, so the hub needs no guards to keep two copies equal. Assigning a
  portrait screen to a device is never rejected for a mismatch now, because a
  mismatch is unrepresentable.
- **The system bars belong to the DEVICE** (`devices.nav_bars`, v17,
  `'hidden' | 'respected' | 'on_tap'`, default `'respected'`). They tried
  living on the screen for exactly one migration. The difference shows once
  both exist: the same board is correct on a bar-less wall panel and on a
  handheld that still needs its back gesture, so putting bar behaviour on the
  screen forced two devices sharing a screen to agree about something they have
  no reason to agree about.
- **A theme is referenced, not embedded.** `theme_id` names a row in `themes`;
  colours are never written into a cell's config. See [Theming](../theming.md).

### The `grid` blob

`grid` is stored as a JSON string and validated as this object:

```json
{
  "cells": [
    { "rect": { "x": 0, "y": 0, "w": 0.5, "h": 1 },
      "widget": "clock",
      "config": { "scale": 1.2 } }
  ]
}
```

- `cells` is **required**, an array, **1–12 entries**. Zero cells is a save
  error, not an empty board.
- `additionalProperties: false` on the grid object: `cells` is the only key.
  A `template`, a `columns`, a `version` — anything you invent — is a 400.
- Every cell is `{ widget, config, rect }`, **all three required**, and the
  cell object itself is `additionalProperties: false`. There is no `id`, no
  `title`, no `z`. Draw order is array order and nothing overlaps anyway (see
  below), so there is nothing for a `z` to mean.

`widget` is one of exactly twelve strings, and the schema enumerates them:

```
clock, alert_feed, calendar_events, value_tile, gauge, stream_list,
table, text_block, chart, image, weather_forecast, news_list
```

`config` is where every per-cell decision lives, and its accepted shape depends
entirely on `widget`. That is [the catalogue](#the-widget-catalogue) below, and
it is the part worth reading twice.

## The coordinate model

A cell carries `{x, y, w, h}` as **fractions of the whole screen**. Not pixels,
not grid columns — there is no grid. The `template` model this replaced is gone
(layout model), and a cell places itself absolutely inside the
board.

The numeric contract, enforced in two places for two different reasons:

| Rule | Value | Enforced by |
|---|---|---|
| `x`, `y` | number, `0 ≤ v ≤ 1` | AJV, at the route |
| `w`, `h` | number, `0.05 ≤ v ≤ 1` | AJV, at the route (`RECT_MIN = 0.05`) |
| every value | an exact multiple of `0.001` | the save service |
| `x + w` | `≤ 1` | the save service |
| `y + h` | `≤ 1` | the save service |
| any two cells | must not overlap | the save service |

AJV covers shape and per-value bounds. Quantization, the sums and the overlap
check are things a JSON Schema cannot express, so `hub/src/screens/save.ts`'s
`validateRectangles` does them — which is why those four errors read like
sentences (`cards 1 and 2 overlap`) while the bound errors read like AJV.

**Origin is the top-left corner.** `x` grows right, `y` grows down. `{x: 0, y:
0, w: 1, h: 1}` is the whole screen, and is a perfectly good one-cell board.

### Thousandths, not floats

Every comparison the hub makes about a rect is done in **integer
thousandths**, and you should author in them too. `0.7 + 0.3 > 1` is `true` in
IEEE-754 and `false` here, which is the entire reason: a board that tiles
exactly to the edges must not be rejected for a rounding artefact. The
quantization rule (`Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-9`
is a save error) exists so that the integer comparison is always exact rather
than always nearly exact.

So `0.333` is a legal width and `1/3` is not. If you are computing a layout,
round each value to three decimals before you send it.

### Sharing an edge is not overlapping

Overlap is tested with **half-open intervals**: two cells at `x: 0, w: 0.5` and
`x: 0.5, w: 0.5` are disjoint, not overlapping. Full-cover boards are the
common case and must never be rejected. The pixel conversion agrees with this
by construction — `rectToPx` rounds **both edges and subtracts**, never
`round(w * screenW)`, so two cells sharing the value `0.5` on a 721px-wide
board both compute `round(0.5 * 721) = 361` for that boundary and one ends
exactly where the other begins. No 1px seam, no 1px overlap, at any screen
size.

```js
// hub/static/device/layout-core.mjs
export function rectToPx(rect, screenW, screenH) {
  const left = Math.round(rect.x * screenW)
  const top = Math.round(rect.y * screenH)
  const right = Math.round((rect.x + rect.w) * screenW)
  const bottom = Math.round((rect.y + rect.h) * screenH)
  return { left, top, width: right - left, height: bottom - top }
}
```

### What silently degrades, and what does not

Two different failure modes, and confusing them is the mistake this section
exists to prevent.

**A rect that fails validation never reaches a device.** The save is refused
with a 400 and the screen is unchanged. You cannot save an off-canvas cell.

**A rect that is already IN the database is coerced, not rejected.** The
renderer's `safeRect` clamps rather than throws, because bad data already in
the database must never crash a read path — a hand-edited row or a legacy blob
renders a real (if oddly placed) card instead of blanking the whole board. It
clamps in integer thousandths end to end: `x`/`y` to `[0, 1000 - 50]`, then
`w`/`h` to `[50, 1000 - x]` — so `w`'s upper bound derives FROM `x` and the two
can never disagree. A missing rect becomes `{x: 0, y: 0, w: 1, h: 1}`.

You will not meet `safeRect` if you go through the API. It is worth knowing
only so you do not read a full-bleed cell on a device as proof that your
malformed rect was accepted.

### The minimum a widget will draw in

A rect is legal at `0.05 × 0.05`. That does not mean every widget will draw in
it. `WIDGET_MIN_PX` (derived from each widget's `minimum_px` in
`hub/static/device/widgets/definitions.mjs`) is the smallest box each widget
renders properly in, **in CSS pixels**:

| Widget | Minimum | Widget | Minimum |
|---|---|---|---|
| `clock` | 120×60 | `text_block` | 80×40 |
| `alert_feed` | 160×110 | `chart` | 160×100 |
| `calendar_events` | 180×130 | `image` | 60×60 |
| `value_tile` | 100×70 | `weather_forecast` | 300×140 |
| `gauge` | 120×110 | `news_list` | 180×120 |
| `stream_list` | 160×110 | `table` | 180×110 |

A cell below its widget's minimum is an **authoring** mistake, not a rendering
condition to cope with, and it gets the same treatment as a cell bound to a
feed that does not exist: a loud dashed placeholder reading
`<widget> needs <w>×<h>`, drawn instead of the widget. Nothing shrinks its way
out of this — degrading that far produces something that looks deliberate and
is unreadable, and nothing would tell the operator why.

This is **not** checked at save time, and it cannot be: the minimum is in
pixels and the rect is a fraction, so the answer depends on the device's
viewport, which the hub only knows once a device has reported one
(`devices.viewport_w`/`_h`/`_dpr`, NULL until then). Do the arithmetic
yourself: on a 1280×720 landscape panel, a `weather_forecast` needs
`w ≥ 300/1280 = 0.235` and `h ≥ 140/720 = 0.195`.

## Feeds, briefly

A screen with no data is a clock and some alerts. Everything else on the board
reads a **feed**: a named, push-only inbox the hub stores (`feeds` table, v5).
A feed is created by the admin, written to by a sender token, and read by
whichever cells bind it. See [Data sources](data.md) for how a feed gets
filled; what a screen author needs is the shape.

A feed has one of **three modes**, fixed at creation and immutable afterward
(`mode` is absent from the PATCH schema, so a body containing it is *rejected*,
not ignored):

- **`value`** — one JSON payload, overwritten on every push. "The current
  temperature."
- **`stream`** — an append-only list of JSON rows, newest first, capped at
  `cap` rows (1–500, default 50). "The last fifty build results."
- **`image`** — raw PNG / JPEG / static WebP bytes, plus a monotonic
  `image_rev`. Pushed as a body with an `image/*` content type, not as JSON.

A cell binds a feed by **feed id**, in its own config:

- most widgets: `config.feed` — one id, plus an optional `config.path` into the
  payload;
- `chart`: `config.series[].feed` — one id **per series**, and no top-level
  `config.feed` at all;
- `clock` and `alert_feed`: nothing. Neither has a `feed` key in its schema.
  Alerts arrive over the device socket and live in the device's own state, not
  behind a feed id.

### Binding a source that does not exist yet

Every binding above has a second form. Instead of `feed`, a cell may carry
`source_draft_id` + `output_contract` — a **pending binding** against a source
draft, which the save promotes into a real source and feed and then rewrites
into a plain `feed` id before storing. The stored grid never contains a draft
id.

```json
{ "rect": {"x":0,"y":0,"w":1,"h":1}, "widget": "gauge",
  "config": { "source_draft_id": "drf_…",
              "output_contract": "dashboardz.weather.current/v1",
              "path": "current.temp", "min": 0, "max": 50 } }
```

The two forms are exclusive: a config carrying both `feed` and
`source_draft_id` is a 400, and so is one carrying neither (on a widget that
needs data). Everything else the widget requires is required in both forms — a
gauge still needs its `path` whether the feed exists or not.

`chart` takes the pending form **per series**, because that is where a chart
binds, and a chart may mix a series on a feed that exists with one on a source
that does not.

This is what removes "define the feed before you can build the screen". A
pending binding **is** checked against what the draft's preview really carries,
and rejected if the draft cannot satisfy it — unlike a live feed, which only
warns. See [what a mismatch does](widgets.md#what-a-mismatch-does).

**Which widget accepts which mode is enforced at save time, from one table**
(`WIDGET_FEED_MODES` in `hub/src/screens/save.ts`, cross-checked against the
renderer's own `hub/static/device/widgets/bindings.mjs` by
`hub/test/widget-bindings.test.ts`). Binding a mode a widget does not accept is
a 400 — you cannot save it and discover it on the wall.

### `path`

`path` is a dot-separated walk into the resolved payload, and its rules are
exact:

- `''` (or an absent `path`) resolves to the **whole payload**.
- On an object: the segment must be an **own** property. Inherited names
  (`toString`) never resolve.
- On an array: the segment must be **all digits**, and is an index. A non-digit
  segment on an array misses rather than reaching `length`.
- Anything else, or an index out of range, resolves to `undefined`, which is
  the widget's placeholder state. **Resolution never throws.**

So for a payload `{"sensors": [{"c": 23.4}]}`, the path to the number is
`sensors.0.c`.

### Value widgets on a stream feed

`value_tile`, `gauge` and `text_block` accept both `value` and `stream`. On a
`value` feed they resolve `path` against `payload`; on a `stream` feed they
resolve it against **the newest row's payload** (`rows[0].payload`) — "the
latest reading". An empty stream resolves to `undefined`, i.e. the placeholder.

## The widget catalogue

This section is the reason the page exists. For each of the twelve widget
types: what it draws, what it can bind, and **every key its `config` accepts**.

Read these three rules before the tables, because they apply to all twelve:

1. **Every branch is `additionalProperties: false`.** A key that is not in the
   widget's table is not "ignored" — it fails the save, and because the grid is
   PATCHed whole, it fails the save of every *other* cell along with it.
2. **Nested keys must be written nested.** `thresholds.warn` means
   `{"thresholds": {"warn": 80}}`. A flat `"thresholds.warn": 80` is an unknown
   key and a 400. Same for `clamp.*` and `overflow.*`. This is the single most
   common way a hand-written grid fails.
3. **`design` is accepted on every widget**, always as `{ type: 'string',
   minLength: 1, maxLength: 40 }`, and is deliberately **not** enumerated in
   the schema. The design catalogue lives in the renderer and grows without a
   hub release, so an id this build has never heard of is stored happily and
   degrades to the widget's own default *at render time* rather than being
   refused at save time. See [Design resolution and
   degradation](widgets.md#design-resolution-and-degradation).

`scale` is accepted on eleven of the twelve (every one except `image`), always
as `{ type: 'number', minimum: 0.5, maximum: 2 }`, and always means the same
thing: multiply this widget's text sizes, floor at 16px for primary values and
10px for labels. It moves **text only** — card and row heights are inputs to
the overflow arithmetic and are deliberately not scaled.

`card` is accepted on every widget, as `{ type: 'boolean' }`, and is read by
the render **pipeline**, not by any design (the same boundary `sound_info`
sits on): under a theme whose backdrop is `cards`, `card: false` opts this one
cell out of the card chrome and its content inset, so it draws directly on the
board. Unset means "card when the theme says cards" — a stored `true` would
only restate that, which is why the editor's checkbox writes nothing when
checked. See [theming — card settings](../theming.md#card-settings-the-cards-backdrop).

### The binding summary

| Widget | Feed modes it accepts | How it binds | What must be at the path |
|---|---|---|---|
| `clock` | none | binds nothing — reads the device's own time | — |
| `alert_feed` | none | binds nothing — alerts arrive over the socket | — |
| `value_tile` | `value`, `stream` | `config.feed` + `config.path`, both required | a `scalar` at `path` |
| `gauge` | `value`, `stream` | `config.feed` + `config.path`, both required | a finite `number` at `path` |
| `stream_list` | `stream` | `config.feed`, required | a `scalar` at `title_path` and `body_path`, per row |
| `table` | `value`, `stream` | `config.feed`, required; `config.path` required on a value feed | on a value feed, an `array<object>` at `path` and a `scalar` at each `columns[].path` inside it; on a stream feed, a `scalar` at each `columns[].path` per row |
| `text_block` | `value`, `stream` | `config.feed` + `config.path`, or literal `config.text` — never both | a `scalar` at `path` |
| `chart` | `stream` | `config.series[].feed`, one per series | a finite `number` at each `series[].y_path`, per row |
| `image` | `image` | `config.feed`, required — the only widget that *requires* an image feed | `binary` — no path at all |
| `weather_forecast` | via a source output | `config.feed`, checked against a contract, not a mode | the contract's shape, not a path |
| `news_list` | via a source output | `config.feed`, checked against a contract, not a mode | the contract's shape, not a path |
| `calendar_events` | via a source output | `config.feed`, checked against a contract, not a mode | the contract's shape, not a path |

The last column is the **data contract**: what the widget needs at the path you
bind, rather than a payload shape it insists on. A binding that does not satisfy
it still saves — you get a `warnings` array back naming the card — because
nothing was ever declared for these widgets and refusing would make an existing
mismatch impossible to correct. See [what a widget needs at the path you
bind](widgets.md#what-a-widget-needs-at-the-path-you-bind) for the full
vocabulary and where the types come from.

The last three are **semantic widgets** and work differently enough to have
[their own section](#semantic-widgets-weather_forecast-news_list-calendar_events)
below. Do not try to bind one to a feed you created by hand; it will not save.

---

### `clock`

The time, drawn in the design you choose. Binds nothing.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `digital` |

That is the entire schema — `config: {}` is a valid, complete clock. Designs:
`digital` (declares `meta.default: true`), `segment`, `analog`, `flip`,
`nixie`. None of the five declares any `meta.options`, so there is nothing else
to set.

### `alert_feed`

Active alerts, newest first, filtered by severity. Binds **no feed** — its
config has never had a `feed` key, because alerts arrive by `ALERT_ADD` and
live in the device's own state.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `min_severity` | enum `info` \| `warn` \| `critical` | no | `'info'` |
| `sound_info` | boolean | no | off — see below |
| `senders` | array of sender names | no | every sender |
| `clamp.title_lines` | integer, `1`–`10` | no | `1` |
| `clamp.body_lines` | integer, `1`–`10` | no | `2` |
| `body_scale` | number, `1`–`3` | no | `1` |
| `overflow.counter` | boolean | no | `true` |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `feed` |

`clamp` and `overflow` are objects, each `additionalProperties: false` with
exactly the properties listed. The feed lays out like the scrolling list it
is: cards paint from the top and the one at the fold shows partially — the
scroll affordance — with drag (or mouse-wheel) reaching the rest.
`overflow.counter` controls the `and N more` line pinned inside the bottom
edge, counting only cards *entirely* below the fold; it disappears as the
scroll brings them up. Cards are interactive — every card carries a Dismiss
button, and an alert asking a question renders its options as tap-to-answer
buttons on the card.

`senders` scopes the cell to the named senders (case-insensitive; empty or
malformed means everyone) — rendering only, since chimes and tab dots stay
device-wide. `scale` moves every text size together; `body_scale` grows just
the body run, for walls read from a distance where the title is already a
headline. Both filters and sizes compose with everything else in the table.

`sound_info` is the odd one out and worth stating plainly: it decides whether
this screen's device chimes for **info**-severity alerts, and it is the only
way an info alert makes any noise at all — a sender cannot ask for it.
Audibility for routine traffic belongs to the room, not to whatever happens to
be integrated with the hub. It is read by the Android app (`Chime.kt`), never
by any design, which is why `alert/feed.mjs` deliberately does not declare it
as a `meta.option`. "This screen's device" means whichever screen is the
**visible tab** on a multi-tab device — the same governing rule that decides
[which sound family plays at all](devices.md#sound), applied here to the one
event that already had an opt-in before sound families existed.

The design (`alert_feed/feed`) declares `min_severity`, `clamp.title_lines`,
`clamp.body_lines`, `body_scale` and `overflow.counter` as options — the
clamp and overflow knobs via a nested `path`. `senders` is hand-authored
only: an array is not a shape `meta.options` can generate.

### `value_tile`

One number or short value, as large as the cell allows.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `feed` | string, 1–84 chars | **yes** | — |
| `path` | string, ≤ 200 chars | **yes** | — (may be `""`) |
| `label` | string, ≤ 40 chars | no | `''` |
| `unit` | string, ≤ 12 chars | no | `''` |
| `format` | enum `raw` \| `abbrev` | no | `'raw'` |
| `decimals` | integer, `0`–`3` | no | unset = no forced rounding |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `tile` |

`format: 'raw'` prints integral numbers with no decimal point (`5`, never
`5.0`); `format: 'abbrev'` divides at 1e9/1e6/1e3 and appends `B`/`M`/`K` with
no zero-stripping, so `1000` renders `1.0K`. `value/tile.mjs` declares it as a
two-choice `meta.options` select, so it is a dropdown in the admin as well as a
key you can write here.

`decimals` is **legitimately absent by default**. Unset has always meant "no
forced rounding — print the raw number", which is not a value `decimals` could
ever hold, so `value/tile.mjs` declares the option with no `default` rather
than a placebo `0` that an operator could not tell from a deliberate one.

`feed` and `path` are both required by the schema even though the renderer
tolerates an empty path. `"path": ""` is legal and means "the whole payload".

`design` is `tile` or `statusbar`. `tile` is the default by registration
order — one number or short value, as large as the cell allows, described
above. `statusbar` is a different shape entirely: a slim full-width header
strip, the cell's `label` as a title on the left and a `Connected: <node>
(Battery: NN%)` fragment plus a freshness dot on the right (green while
fresh, gray once the feed has gone quiet, red once it is stale or unbound).
When the strip is tall enough it draws a second line, `Mesh Active | Nodes
seen: N`. `node.name`, `battery_pct` and `nodes_seen` are read off the
payload by fixed field name, the same discipline as the `battery` gauge
design's `plugged_in`/`voltage` (see `gauge` below); on any other value
payload it degrades to the title, `Connected: —`, and the dot. Built for the
Meshtastic telemetry feed.

### `gauge`

A ring or bar against a range, coloured by threshold.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `feed` | string, 1–84 chars | **yes** | — |
| `path` | string, ≤ 200 chars | **yes** | — (may be `""`) |
| `min` | number | no | `0` |
| `max` | number | no | `100` |
| `label` | string, ≤ 40 chars | no | `''` |
| `unit` | string, ≤ 12 chars | no | `''` |
| `decimals` | integer, `0`–`3` | no | unset = no forced rounding |
| `thresholds.warn` | number | no | none |
| `thresholds.crit` | number | no | none |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `bar` |

`min` and `max` are **optional**, and omitting both is the ordinary 0–100
gauge: both designs declare `min: 0`/`max: 100` and `normalizeGauge` falls back
to the same, so the cell renders identically to one that spelled them out.

`min < max` is checked by the save service, not by AJV — sending `min: 100,
max: 0` is a 400 reading `gauge min must be < max`. The check resolves each
side through the fallback above, so a **half**-specified range is caught too:
`{"min": 200}` with no `max` is refused, because the gauge would draw against
0–100 and never fill.

Fill fraction is `(clamp(v, min, max) - min) / (max - min)`. Thresholds are in
**value units**, not fractions, both optional, and each checked
**independently**: `value >= crit` paints critical, else `value >= warn` paints
warn, else info. `crit >= warn` is deliberately not enforced — a board that
wants them the other way round is describing a metric where lower is worse, and
the renderer just answers the two questions in order.

There is no `format` key on `gauge`, and that is not an oversight: the widget
has never had one, and adding it would be a new feature rather than a
migration.

`design` is `bar`, `ring` or `battery`. `bar` is the default by registration
order, matching every gauge cell saved before designs existed. A retired
`style` key (`'bar' | 'ring'`) is **gone** — migration v21 rewrote every
stored `style` into `design`, and no legacy alias survives in the schema, so
sending `style` on a gauge is a 400.

`battery` draws a three-quarter horseshoe arc (open at the bottom) instead of
`ring`'s full circle, with the percentage large in the middle. When the bound
payload carries `plugged_in: true` it adds a lightning bolt above the number,
and when it carries a numeric `voltage` it prints a voltage line below —
both read off the payload by fixed field name, not `meta.options` knobs, so a
feed that spells them differently simply draws the plain horseshoe. Built for
the Meshtastic telemetry feed but happy on any numeric gauge.

### `stream_list`

Recent rows shown as titled cards. **Stream feeds only** — a value feed is a
save error.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `feed` | string, 1–84 chars | **yes** | — |
| `title_path` | string, ≤ 200 chars | no | `'title'` |
| `body_path` | string, ≤ 200 chars | no | none (no body line) |
| `clamp.title_lines` | integer, `1`–`10` | no | `1` |
| `clamp.body_lines` | integer, `1`–`10` | no | `2` |
| `overflow.counter` | boolean | no | `true` |
| `ticker.speed` | number, `0`–`400` (px/s) | no | `40` |
| `ticker.family` | `sans` \| `mono` \| `serif` | no | `sans` |
| `ticker.text_px` | integer, `8`–`96` | no | `18` |
| `ticker.separator` | string, ≤ 8 chars | no | `·` |
| `ticker.direction` | `left` \| `right` | no | `left` |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `list` |
| `chime_activity` | boolean | no | off — see below |

**There is no `path` key on `stream_list`.** It reads rows naturally off the
stream and addresses fields inside each row with `title_path` / `body_path`.
Sending `path` is a 400, and it is an easy mistake to make from the other data
widgets' shape.

`chime_activity` (stream-activity contract) is the `activity`-event sibling of `alert_feed`'s
`sound_info`: opting a cell in makes the device tick when its bound stream
feed receives new rows, on whichever tab currently carries the opted-in cell
(visible or not — unlike `sound_info` and every other sound event, this one is
any-tab, not visible-tab-only, since an opted-in cell always belongs to
exactly one screen and there's no ownership to arbitrate the way an alert's
routing sometimes has to).
Like `sound_info`, it is read by the Android app, never by a design, so
`stream/list.mjs` and `stream/scroll.mjs` deliberately do not declare it as a
`meta.option`. Full noise-discipline rules (cooldown, batching, alarm
suppression) are part of the stream-activity behavior described above.

Card height depends on whether a body line is drawn (96px with, 48px without),
which is what the overflow arithmetic divides the cell by.

`design` is `list` (the default, by registration order), `scroll`, `chat` or
`ticker`.
`list` is the fixed window described above: it shows the newest rows that fit
and counts the rest into `overflow.counter`. `scroll` shows the same cards in
a column the viewer moves through — drag (or mouse-wheel) to scroll back
through the queue, with an arrow rail on the right edge: tap **▲** to jump to
the newest row, **▼** to jump to the oldest on the wire. At the top the column
is **locked to the latest row** and every arriving row is considered seen;
scrolled anywhere else the column holds still (arrivals do not shove the rows
being read down the screen) and the ▲ arrow carries a count of the unseen rows
waiting above. Tapping ▲, or dragging back to the top, re-enters the lock and
clears the count. `overflow.counter` is ignored by `scroll` — scrolling is
that design's answer to overflow — and scroll depth is bounded by the feed's
own row cap, since the wire never carries more rows than that.

`chat` draws the stream as a message board: a clock-time column on the left,
a bold `@sender:` line (`title_path`) with the message text (`body_path`)
under it, and a hairline divider between rows. It scrolls exactly as `scroll`
does — the same drag/wheel gestures, arrow rail, follow-lock and unseen-count
badge described above — so its options are byte-identical to `scroll`'s
(there is no `overflow.counter`: scrolling is this design's answer to
overflow). `title_path`/`body_path` are conventionally pointed at the
Meshtastic messages feed's `from`/`text` fields.

`ticker` is the crawl: every row on ONE line, moving sideways, for a strip too
short to hold a card at all — a band across the top or bottom of a board. Rows
are laid out in wire order as `title_path`, then `body_path`, then
`ticker.separator`, and the whole run is painted twice, one content width
apart, so what leaves one end is already entering the other. The `ticker.*`
keys above are its own: `speed` in px/s, `family` and `text_px` for the type,
`separator` for what sits between rows (`''` runs them together), `direction`
for which way it travels.

**`ticker.speed: 0` is a real setting, not a disabled one.** The strip lays out
and paints exactly once, and the design reports itself as not animating, so a
still ticker costs a panel nothing. That matters more here than on any other
design: the board runs ONE `requestAnimationFrame` loop that must idle to zero
frames when nothing moves (a wall panel is on 24/7), and a crawl is the first
design with no natural end. It also stops under the viewer's reduced-motion
preference, and when there is nothing to scroll.

`family` offers `sans`/`mono`/`serif` and nothing else, because those are the
stacks a panel already has — a design cannot ship a font file, and `assets`
carries rasters only.

A gain and a loss are tinted apart: a row body that starts with `+` draws in
the design's `up` token, one starting with `-` or `−` in `down`, and anything
else in `ink`. That rule reads the text the feed already formatted rather than
a configured field, so it works on any stream whose body carries a signed
number, and both tints are themeable like every other token.

### `table`

Rows organised into named columns.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `feed` | string, 1–84 chars | **yes** | — |
| `columns` | array of column objects, **1–4 items** | **yes** | — |
| `columns[].header` | string, ≤ 24 chars | **yes** | — |
| `columns[].path` | string, ≤ 200 chars | **yes** | — |
| `columns[].align` | enum `left` \| `right` | no | `'left'` |
| `path` | string, ≤ 200 chars | conditionally — see below | none |
| `headers` | boolean | no | `true` |
| `overflow.counter` | boolean | no | `true` |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `grid` |
| `chime_activity` | boolean | no | off — see `stream_list` above |

Each column object is itself `additionalProperties: false` — `header`, `path`,
`align` and nothing else. `columns` must have at least one and at most four
entries.

`chime_activity` (stream-activity contract) means exactly what it means on `stream_list` — see
above; `table.mjs` does not declare it as a `meta.option` either.

**On a `stream` feed** the rows *are* the table's rows and `path` is not
needed. **On a `value` feed** `path` must reach the array to render, and
omitting it is a 400 reading `table on a value feed needs a path to an array`.
That check is in the save service, because AJV cannot see which mode the feed
is in.

A `path` that resolves to something that is not a list draws a **"Not an
array"** notice — deliberately different words from "Feed missing", so an
operator can tell "you bound nothing" from "you bound the wrong path".

`columns` is an array of objects, and its option declaration names each location
and value. `grid.mjs` declares it as a repeating group, and the admin's column editor
is generated from that declaration rather than hand-written; see
[`list`: a knob that repeats](widgets.md#list-a-knob-that-repeats).

### `text_block`

Fixed text, or one value from a feed. This is the one widget whose config is
itself a `oneOf`: **literal text OR a feed binding, never both, never
neither.**

**Arm 1 — literal text** (`required: ['text']`):

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `text` | string, ≤ 2000 chars | **yes** | — |
| `align` | enum `left` \| `center` \| `right` | no | `'left'` |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `block` |
| `led.lines` | integer, `1`–`6` | no | `1` |
| `led.color` | string, ≤ 7 chars (hex) | no | none — the theme's `on` token |
| `led.colors` | string, ≤ 64 chars (comma-separated hex) | no | none |
| `led.effect` | `none` \| `scroll` \| `blink` \| `rainbow` | no | `none` |
| `led.speed` | number, `0`–`400` | no | `40` |
| `led.off_dots` | boolean | no | `true` |
| `led.glow` | boolean | no | `true` |
| `led.border` | `none` \| `chase` \| `blink` \| `alternate` | no | `none` |
| `led.border_color` | string, ≤ 7 chars (hex) | no | none — the sign's own colour |

**Arm 2 — bound value** (`required: ['feed', 'path']`):

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `feed` | string, 1–84 chars | **yes** | — |
| `path` | string, ≤ 200 chars | **yes** | — (may be `""`) |
| `align` | enum `left` \| `center` \| `right` | no | `'left'` |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `block` |
| `led.lines` | integer, `1`–`6` | no | `1` |
| `led.color` | string, ≤ 7 chars (hex) | no | none — the theme's `on` token |
| `led.colors` | string, ≤ 64 chars (comma-separated hex) | no | none |
| `led.effect` | `none` \| `scroll` \| `blink` \| `rainbow` | no | `none` |
| `led.speed` | number, `0`–`400` | no | `40` |
| `led.off_dots` | boolean | no | `true` |
| `led.glow` | boolean | no | `true` |
| `led.border` | `none` \| `chase` \| `blink` \| `alternate` | no | `none` |
| `led.border_color` | string, ≤ 7 chars (hex) | no | none — the sign's own colour |

Sending `text` *and* `feed` matches neither arm and is a 400. At draw time a
literal `text` always wins if present, and an all-whitespace literal counts as
"nothing to say" (the cell paints its "No text" notice rather than a blank
box).

`design` is `block` (the default, by registration order) or `led`.

`led` draws the cell's text as a dot-matrix sign: a grid of round dots, the lit
ones spelling the message, the unlit ones left faintly visible so the panel
reads as a panel rather than as floating text. Newlines split the message into
rows and `led.lines` caps how many are shown. It works on both arms — a fixed
sign (`text: "OPEN"`) and a live one (a value off a feed) are the same design.

The glyphs are a 5×7 table in `widgets/text/led-font.mjs`, written out as dot
rows rather than packed, because a typo in a font table is a character that
renders as garbage on a wall with nothing to catch it. Coverage is **uppercase
A–Z, 0–9, space and common punctuation**; lowercase folds onto uppercase (a 5×7
cell has no room for descenders), and anything uncovered draws as a hollow box
rather than vanishing.

**Colour, and the deliberate hole in theming.** Panel colour normally comes from
the design's `on`/`off`/`glow` tokens, so a theme owns it like everything else.
`led.color` takes a full RGB hex (`#f04`, `#ff0044` and bare `ff0044` all work)
and **overrides the theme** for that panel; `led.colors` does the same per line,
comma-separated. That override is intentional — "pick the colour of my sign" has
to mean the sign keeps that colour under every theme — and it is the only place
in the widget system where config beats a token. A value that is not a valid hex
falls back to the token rather than reaching the canvas as a `fillStyle`.

`led.effect` is `none` (default), `scroll`, `blink`, `rainbow`, `wipe` or
`snow` — the entry-effect vocabulary a programmable sign ships with. `wipe` runs
a front across the matrix left to right (the "scan"/"cover" family) with a run
of blank columns behind it so the sweep repeats cleanly; `snow` gives every dot
its own landing time inside a 3s cycle, so the message assembles out of
scattered dots and then starts again. Both are per-DOT reveals computed from an
integer hash of the dot's position — not `Math.random`, which a design may not
reach for (portable drawing subset) and which would make the same sign look different on two
panels. Unlit dots are unaffected: they are hardware, not content, so they stay
put while the message assembles over them.

`led.border` lights a ring of marquee bulbs around the panel — bigger lamps,
spaced further apart than the matrix dots, painted last so their bloom lies over
the matrix edge the way a real sign's border lamps sit in front of it. `chase`
walks a one-in-three run around the ring, `blink` flashes the whole ring,
`alternate` swaps odds and evens; `led.border_color` overrides the sign's colour
for the lamps alone. The matrix is inset to make room, so a bulb never lands on
a glyph — and a border on its own keeps the animation alive even when the text
is `none`.
**`none` costs no frames**: the sign paints once and reports itself as not
animating, which is what keeps the board's single animation loop idle on a panel
that is on 24/7. The other three ask for frames only while set, stop under the
viewer's reduced-motion preference, and are pure functions of elapsed time, so a
dropped frame changes only when the next one lands. `led.speed` is the rate for
all of them: px/s for `scroll`, and the blink period is derived from the same
number (1200ms at the default 40, halving as the speed doubles).

`align` defaults to `'left'`, matching what every saved `text_block` that omits
it has always rendered as. Do not assume `'center'`.

### `chart`

Up to four data series plotted over time. **Stream feeds only**, and it binds
them per series — there is no top-level `feed` or `path`.

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `series` | array of series objects, **1–4 items** | **yes** | — |
| `series[].feed` | string, 1–84 chars | **yes** | — |
| `series[].y_path` | string, ≤ 200 chars | **yes** | — |
| `series[].icon` | enum, see below | **yes** | — |
| `series[].label` | string, ≤ 24 chars | no | none |
| `style` | enum `line` \| `bar` | no | `'line'` |
| `candles.mode` | `ticks` \| `ohlc` | no | `ticks` |
| `candles.rolling` | boolean | no | `true` |
| `candles.bucket_s` | integer, `1`–`86400` | no | `60` (ticks mode only) |
| `candles.wick` | boolean | no | `true` |
| `window_s` | integer, `≥ 5`, no maximum | no | none (all points) |
| `y_min` | number | no | auto |
| `y_max` | number | no | auto |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `plot` |

`design` is `plot` (the default, by registration order) or `candles`.

`candles` draws OHLC bars, from one of two sources — and they are not equally
good.

**`mode: 'ohlc'` — each row IS a bar.** The feed carries `{t, o, h, l, c}` per
row and the design draws what it was given. This is the correct source for
anything a person would call a candle chart: only whatever holds the trades
knows an interval's true high and low, and only it can supply history the hub
never had. `t` is the BAR's own time rather than the push time, which is what
lets a sender backfill a chart's worth of history in one burst; re-pushing a bar
with the same `t` updates it in place, so a forming candle can move. A row
missing any of the four is dropped rather than half-drawn.

**`mode: 'ticks'` (default) — derived, and an approximation.** It buckets a
plain value feed: first tick opens, last closes, extremes wick. The max of the
SAMPLES is not the interval's high — every extreme between samples is invisible
— and a stream keeps at most 500 rows, so the push interval hard-caps how far
back it can see. **A 4h bar from a feed sampling every few seconds cannot
exist**: that data was never retained. Use it for a quick shape of a value feed
you already have, not to chart an instrument. The design says so on the board:
its footer reads `~1m`, and the tilde is the admission.

A bucket holding a single tick is a doji, which is the truth about that interval
rather than a fabricated range, and buckets with no ticks are skipped rather
than carried forward as flat bars.

**Both axes are decided, not inferred.** A chart is a claim about a range — these
bars, over this span of time, between these prices — so `candles` computes both
extents and lays the bars out against them:

- **y** comes from the WICKS (the extremes are the point of a candle), unless the
  cell names `y_min`/`y_max`, which always win.
- **x is TIME.** Bars sit at their own timestamp rather than in evenly-spaced
  slots, so a missing bar leaves a hole and a sparse week does not stretch to
  fill the width of a busy hour. Bar width comes from the interval the bars are
  actually on — the median gap between them, so one missing bar does not widen
  every other — since an OHLC feed's rows carry their own interval and nothing in
  the config knows it.

`candles.rolling` (default `true`) decides what x spans. Rolling means
`[now - window_s, now]`: a fixed frame the bars march leftward through, which is
what a wall chart wants, and the right edge is labelled `now`. Turn it off and x
spans the DATA — its first bar to its last, plus one bar width so the newest has
room to finish — which is the framing for a period that has ended rather than one
still running. Either way both ends of the time axis are labelled (clock time, or
day/month once the span passes a day), because a time axis nobody can read is a
decoration.

Buckets are anchored to absolute time (`floor(t / bucket) * bucket`), so a
candle covers the minute a person would call that minute and two devices on the
same feed draw the same bars. Bars are laid out by slot, evenly spaced, so a gap
shows as a missing bar rather than a wider one.

`candles` draws the **first configured series only** and ignores the rest.
Overlaid candle bodies are a smear rather than a comparison — a candle chart of
two instruments is two charts. Colour comes from the design's own `up`/`down`
tokens rather than the series ramp, because a candle's colour is semantic
(it closed up, or it closed down), not an identity.

`style` stays `line`/`bar` and is not extended: candles are a DESIGN, so a
client that does not know it falls back to drawing the same series as a line
rather than to nothing.

`icon` is drawn from the shared glyph set, in this exact order:

```
circle, square, triangle, diamond, star, cross, heart, bolt, drop,
sun, moon, flag
```

Two save-service checks AJV cannot do: **every series feed must exist and must
be a stream feed** (`chart needs stream feeds`), and **icons must be unique
across the series** (`chart series icons must be unique`) — the icon is how a
reader tells two lines apart, so two series wearing the same one is not a style
choice.

A series may instead carry `source_draft_id` + `output_contract`, binding a
source that does not exist yet, and a chart may **mix** the two: one series on
a live feed, another on a source the same save will promote. The binding is
per series because that is where a chart binds, and each pending series is
checked against its own `y_path` alone — asking one draft to satisfy the other
series' paths would reject exactly the chart this is for.

Each point's x is the row's **push time**, not a field in the payload; `y_path`
names the number on each row. Series are positional and never compacted: entry
`i` is also colour index `i`, so a series whose feed is missing keeps its slot
rather than silently recolouring every series after it.

`series` is a declared repeating group on `chart/plot.mjs`
([`list`](widgets.md#list-a-knob-that-repeats)), so the admin generates its
editor — the per-series feed picker included, because an item field may be
declared `type: 'feed'` and is then filtered to exactly the modes a chart
binds. `style` is optional: `chart/plot.mjs` declares it with `default:
'line'` and `chartConfig` maps anything absent — or unknown — to `line`, so a
chart that omits it is a line chart.

### `image`

The latest bitmap pushed to an image feed. **The one widget that requires — not
forbids — an image-mode feed.**

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `feed` | string, 1–84 chars | **yes** | — |
| `fit` | enum `contain` \| `cover` | no | `'contain'` |
| `design` | string, 1–40 chars | no | `frame` |

**`image` has no `scale` and no `path`.** It has no on-canvas resize knob (a
bitmap is what it is), and there is nothing inside a bitmap to address. Sending
either is a 400.

Binding a non-image feed here fails the save with `image widget needs an image
feed`; binding an image feed to anything else fails with `image feeds are not
bindable`. Image feeds render, they are not queried.

### Semantic widgets: `weather_forecast`, `news_list`, `calendar_events`

These three do **not** bind by feed mode. They bind to a **source output** — a
feed that some configured data source owns and fills, tagged with a contract id
and a set of capabilities. The save service checks the contract and the
capabilities and ignores the mode entirely (`hub/src/widgets/requirements.ts`).

**You cannot create a plain feed and bind one of these to it.** A feed with no
row in `source_outputs` is rejected with `<widget> requires a semantic source
output`, and a feed carrying the wrong contract with `<widget> requires
<contract_id>`. Set up the source first — see [Data sources](data.md).

| Widget | Contract | Required capabilities |
|---|---|---|
| `weather_forecast` | `dashboardz.weather.daily-forecast/v1` | `weather.daily.condition`, `weather.daily.date`, `weather.daily.entries.5`, `weather.daily.temperature.high`, `weather.daily.temperature.low` |
| `news_list` | `dashboardz.news.items/v1` | `news.item.id`, `news.item.title` |
| `calendar_events` | `dashboardz.calendar.events/v1` | `calendar.event.times`, `calendar.event.title` |

A calendar asks for very little on purpose: there is no minimum number of
events, because an empty week is a legitimate answer that the widget renders as
"Nothing on". Requiring entries would make a quiet calendar look broken.

Each of the three accepts **two config shapes**, as a `oneOf`. The first binds
a feed that already exists:

- `feed` — string, 1–84 chars, **required in this arm**.

The second binds a **source draft** — a source you previewed but have not
committed — and the save promotes the draft into a real source in the same
transaction, rewriting the cell's config to the resulting `feed` id before
storing it:

- `source_draft_id` — string matching `^drf_[A-Za-z0-9_-]{1,80}$`, **required
  in this arm**;
- `output_contract` — one of the contract ids, **required in this arm**.

The two arms are exclusive: sending `feed` alongside either draft key fails
with `<widget> needs exactly one source binding`. A draft that has expired is a
**410**, and a draft that never existed a **404** — neither is a 400. If you
are building a screen programmatically against feeds that already exist, use
the first arm and ignore the draft keys entirely.

The visual keys are the same in both arms:

**`weather_forecast`**

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `days` | integer, `5`–`7` | no | `5` |
| `show_humidity` | boolean | no | off |
| `show_precipitation` | boolean | no | off |
| `show_wind` | boolean | no | off |
| `show_pollen` | boolean | no | off |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `forecast` |

Setting `days` also tightens the binding check: the save additionally requires
the capability `weather.daily.entries.<days>`, so asking for 7 days from a
source that only offers 5 is refused at save time rather than drawing two blank
columns.

**`news_list`**

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `items` | integer, `1`–`10` | no | `5` |
| `show_summary` | boolean | no | off |
| `show_source` | boolean | no | off |
| `show_time` | boolean | no | off |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `list` |

**`calendar_events`**

| Key | Type / bound | Required | Default |
|---|---|---|---|
| `events` | integer, `1`–`10` | no | `5` |
| `show_location` | boolean | no | off |
| `scale` | number, `0.5`–`2` | no | `1` |
| `design` | string, 1–40 chars | no | `agenda` |

`events` and `show_location` are the only two knobs `calendar/agenda.mjs`
reads, and it declares both as `meta.options`, so both are ordinary controls in
the admin. They are also the only two the `calendar_events` branch accepts
beyond `scale`/`design` and the binding keys — in particular `items`,
`show_summary`, `show_source` and `show_time` belong to `news_list` and are a
400 here.

Note that every `show_*` flag is opt-**in**: each design tests `=== true`, so
an absent key and an explicit `false` are the same thing.

## Saving a screen

Everything below `/admin/api` is behind a session cookie. There is no API key
and no bearer token for the admin surface — you log in, keep the cookie, and
send it on every subsequent request.

Errors are always `{"error": "<one line>"}`. That includes schema failures: the
hub installs an error handler that rewrites AJV's `oneOf` wall into one
sentence naming the cell and the widget, because a bad config key otherwise
produced ten clauses and never said where.

Not everything the hub notices is an error. A grid save returns a `warnings`
array alongside the saved screen: a binding whose feed does not carry what the
cell needs is reported there and **saved anyway**. Only a *pending* binding
that its draft cannot satisfy is a 400.

### Log in

```bash
curl -s -c /tmp/dbz.jar -X POST http://localhost:8484/admin/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"YOUR_ADMIN_PASSWORD"}'
```

`204` on success and the cookie (`dbz_admin`) is now in the jar. `401
{"error":"wrong password"}` otherwise. The body accepts exactly one key,
`password`.

### Create a screen

`POST /admin/api/screens` — `required: ['name', 'orientation', 'grid']`.

```bash
curl -s -b /tmp/dbz.jar -X POST http://localhost:8484/admin/api/screens \
  -H 'content-type: application/json' \
  -d '{
    "name": "Kitchen",
    "orientation": "landscape",
    "grid": { "cells": [
      { "rect": {"x":0,"y":0,"w":0.5,"h":1}, "widget":"clock", "config": {} },
      { "rect": {"x":0.5,"y":0,"w":0.5,"h":1}, "widget":"alert_feed",
        "config": {"min_severity":"warn"} }
    ] }
  }'
```

Returns **200** and the stored screen, with the grid parsed back out:

```json
{ "id": "lay_…", "name": "Kitchen", "orientation": "landscape",
  "grid": { "cells": [ … ] }, "theme_id": null, "rev": 1,
  "created_at": 1754…, "warnings": [] }
```

`warnings` is a property of **this save**, not of the screen: the list endpoint
does not carry it, and re-reading the screen later will not resurface a
judgement about data that has been pushed many times since. Each entry names a
card and what it wanted:

```json
{ "warnings": ["card 1: gauge needs data.number@host"] }
```

A save with warnings **has still been written**. See [what a mismatch
does](widgets.md#what-a-mismatch-does) for why these advise rather than refuse.

`theme_id` is optional here (`string | null`). `rev` is **not accepted on
POST** — a create has nothing to have read, and admitting a number that is
silently ignored is exactly the class of bug the guard exists to remove.

### Update a screen

`PATCH /admin/api/screens/:id`. Every field is optional but the body must have
at least one (`minProperties: 1`). The `:id` must match
`^lay_[A-Za-z0-9_-]{1,80}$`, so a wrong-shaped id is a **400**, not a 404.

There are two kinds of PATCH and they behave differently:

**A grid save** (`grid` present) **must carry `rev`.** Omit it and you get
`400 {"error":"rev is required when saving a grid"}`. It returns **200** and
the full updated screen, the same body a create returns.

```bash
curl -s -b /tmp/dbz.jar -X PATCH http://localhost:8484/admin/api/screens/lay_XXX \
  -H 'content-type: application/json' \
  -d '{
    "rev": 1,
    "grid": { "cells": [
      { "rect": {"x":0,"y":0,"w":1,"h":1}, "widget":"clock", "config": {} }
    ] }
  }'
```

**A field-only save** (`name`, `orientation`, `theme_id`) may omit `rev`, and
returns **204** with no body. It comes from a control that never loaded the
grid and so has no read-modify-write to lose. It still bumps the row's `rev`,
because the row did change.

```bash
curl -s -b /tmp/dbz.jar -X PATCH http://localhost:8484/admin/api/screens/lay_XXX \
  -H 'content-type: application/json' -d '{"name":"Kitchen wall"}'
```

### `rev`, and what a 409 means

**A grid PATCH replaces the WHOLE `cells` array.** It is not a merge, and there
is no per-cell endpoint. You read the screen, you edit the array, you send all
of it back.

That is why `rev` exists. Two editors open the same screen, both save, and
without the guard the second one discards everything the first did — with no
error, no log line, and no evidence beyond the work being gone. The version
check refuses that stale write and preserves the first editor's changes.

The compare-and-swap is in the UPDATE's own `WHERE` clause (`SET rev = rev + 1
… WHERE id = ? AND rev = ?`), not in a read-then-write around it. A check
before the write would happen to be safe today — better-sqlite3 is synchronous
— but it would be safe by accident, and the whole point is that a write which
quietly wins is the bug.

So:

```json
409 {"error": "screen changed elsewhere", "rev": 4}
```

means **somebody else's save landed since you read**. The `rev` in the body is
the version the row is actually on, so you can say how far behind you are. The
fix is never to retry with a bumped number: re-`GET` the screen, re-apply your
changes to the grid you just fetched, and PATCH again with the `rev` that came
back. Retrying with `rev + 1` is how you reintroduce the lost update the guard
was built to stop.

`rev` is a row version and is **not** on the device wire. It is unrelated to
the STATE message's `rev`, which is a per-connection message counter; a device
re-renders whatever layout it is sent and has no use for a concurrency token.

### List, read and delete

```bash
curl -s -b /tmp/dbz.jar http://localhost:8484/admin/api/screens
```

Returns every screen with its grid parsed and an `assigned_count`. A screen
whose stored grid will not parse is still listed, with `{"cells": []}` — the
admin list is where an operator finds and deletes a broken row, so hiding it
would make it undeletable.

`DELETE /admin/api/screens/:id` returns **204**. Every device assigned to it is
reset to no screen **in the same transaction**, each reset audited, and each
device re-pushed. A layout id must never dangle.

### Assigning a screen to a device

A device is paired first, and gets its own row. Then:

```bash
curl -s -b /tmp/dbz.jar -X PATCH http://localhost:8484/admin/api/devices/dev_XXX \
  -H 'content-type: application/json' -d '{"screen_id":"lay_XXX"}'
```

**204** on success. The device row's `screen_id` is set, a STATE push and a
DATA snapshot go out immediately, and the panel re-renders without a reload.

- `screen_id: null` clears the assignment back to the default view.
- An unknown screen id is `400 {"error":"unknown screen"}` — checked
  explicitly, before the write.
- **No orientation cross-check happens.** A portrait screen on a device that
  was paired in landscape is fine; the device locks its rotation from the
  screen it is pointed at.
- The same endpoint also accepts `name` (1–100 chars) and `nav_bars`
  (`hidden` | `respected` | `on_tap`), and `minProperties: 1` means an empty
  body is a 400.

To get a device in the first place, mint a pairing code:

```bash
curl -s -b /tmp/dbz.jar -X POST http://localhost:8484/admin/api/devices/pairing-codes \
  -H 'content-type: application/json' -d '{"name":"Kitchen panel"}'
```

and enter it on the panel. `GET /admin/api/devices` then lists it with `online`
and `rendering` flags alongside its row. See [Devices](devices.md).

## Tabs on the wire

A device with more than one tab is still driven by a single `STATE` message
per push — the hub does not send one message per tab, it sends every tab's
screen at once and lets the device decide what to show. [Assigning tabs to a
device](devices.md#tabs) is the admin-facing half of this; this section is
what actually crosses the wire.

### `screens`, and why `screen` still exists

Alongside the `screen` field `STATE` has always carried, a device with tabs
also receives `screens`: the same ordered list `device_screens` holds, each
entry a normal screen wire object plus an optional `label` — the operator-set
tab name, distinct from the screen's own `name`. A tab with no label falls
back to the screen's name in the device's UI.

`screen` itself never goes away, and it never means anything different:
**`StateMsg.screen` keeps carrying tab 0 forever**, the exact object it would
have been before tabs existed. A build of the Android app that predates tabs
does not know the `screens` key exists; under this protocol's
ignore-what-you-don't-recognize rule it just keeps reading `screen`, and a
fleet does not need updating for a household to start using tabs. `screens`
is present only when the device has at least one renderable tab — the same
"a screen whose stored grid won't parse is silently dropped, never crashes
the read" rule applies per tab, so `screens` (and `screen`) can be shorter
than what is actually assigned if one tab's grid is corrupt.

A tab list is only ever assigned across one orientation — the [admin PATCH
enforces it](devices.md#tabs) by rejecting a mixed-orientation list before it
is ever saved. That is the one place two screens' orientations are compared
against each other rather than against nothing: ordinarily a screen's
orientation is a fact about that screen alone (see [what a screen
is](#what-a-screen-is)), but a tab bar has one physical shape, so every screen
a `screens` array ever contains agrees on `orientation` by construction —
never something the device itself has to reconcile.

Where the bar sits is the screen's own call. A grid may declare
`tab_bar: "bottom" | "top" | "left" | "right" | "hidden"` (absent means
`bottom`), because bar placement is a layout fact: the editor reserves the
declared edge while the operator designs, so "fits in the editor" means
"fits on the wall with the bar showing", and the renderer places the bar on
that edge when the screen is the active tab. Two more agreement rules ride
the same PATCH-time check as orientation: every screen in a multi-tab list
must declare the same edge (a switch must never teleport the control being
tapped), and a `hidden` declaration — legal for a screen that wants every
pixel — makes that screen ineligible for multi-tab lists, since switching is
touch-only and a bar-less tab would strand the viewer. Editing a screen that
already lives in a multi-tab list is held to the same line from the other
side. A device showing a single screen never lays out a bar at all, whatever
the declaration says: the reservation is a design-time guarantee, and a
screen designed with a bar that renders without one only ever gains room.

### The dots: `tab_status`

`STATE` also carries `tab_status`, a map from screen id to the worst active
alert severity attributed to that screen — `info` < `warn` < `critical` —
present under the same gate as `screens`. A screen absent from the map has no
active alert attributed to it. This is what lets the device paint a colored
dot on a tab that is not the one currently in front, without switching to it
or waking anyone up.

Attribution is derived, not assigned: an active alert from sender `S` lights
every screen that references a feed `S` pushes to — a feed whose `pushed_by`
is `S`, or whose `allowed_senders` names `S` — and the worst severity across
every matching alert wins. Nothing about a screen or a sender declares this
relationship directly; it falls out of the same feed bindings the grid
already has, which is what makes it work with zero configuration in the
ordinary case of one sender per environment — the household's one monitoring
script lights every tab its feeds appear on, and nobody had to tell the hub
which tabs belong to which sender.

Because alerts change far more often than a `STATE` push happens, the dots
also travel on their own: `TAB_STATUS` (`{"tab_status": {...}}`) is broadcast
to every online device with two or more tabs whenever an alert is added,
resolved (answered or dismissed), expires, or is retracted because its
sender was deleted. It carries only the map — repainting a dot never touches
the grid that is actually on screen, so a device switched away from the
alerting tab is not disturbed by it.

### Switching, and what the hub is told about it

Switching tabs is entirely the device's business. A tap picks a tab and
repaints from a screen the hub already sent — there is no request to make and
nothing to wait for, because the fat `STATE` push put every tab's layout on
the device up front. The device still sends `{"type": "TAB", "screen_id":
"..."}` afterward, but only to keep the hub's admin view honest about what is
actually on the wall (`rendering.active_screen_id` — see
[Devices](devices.md#tabs)); nothing about the switch depends on the hub
receiving it, or on how quickly.

### Set-acks, and the legacy rule

A device's `STATE_ACK` has always carried the single screen it applied,
`{"screen_id": "..."}`. A tab-aware device instead sends the **set** it now
holds across all its tabs, `{"screen_ids": ["...", "..."]}` — order does not
matter, only membership.

An old build that only ever knew `screen_id` still works against a multi-tab
push, and this is the one compatibility rule worth stating exactly: **a
legacy `STATE_ACK {screen_id}` sent against a multi-tab push is compared
against tab 0 only, no warning.** The hub does not, and cannot, ask an old
client about the tabs it has never heard of, so it never checks them and
never raises the "rendering the wrong screen" warning just because it started
pushing more than one screen. A device that acks tab 0 correctly is `ok`
regardless of how many other tabs came along with it; only a genuine mismatch
on tab 0 itself still triggers that warning, exactly as it always could for a
plain single-screen device.

## A complete worked example

One screen, from nothing: a kitchen wall panel with a clock, a temperature
gauge, a build-status table and a text banner. Every request in full, in order.
Substitute your own host and admin password; everything else is literal.

### 1. Log in

```bash
curl -s -c /tmp/dbz.jar -X POST http://localhost:8484/admin/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"YOUR_ADMIN_PASSWORD"}'
```

### 2. Create the feeds

> **You no longer have to do this first.** This example creates its feeds up
> front because they are hand-pushed, and a hand-pushed feed has to exist
> before anything can push to it. If your data comes from a **source** — a
> provider you configure in the admin — the recommended order is inverted:
> build the screen, bind each cell to the source *draft* with
> `source_draft_id` + `output_contract` (see [binding a source that does not
> exist yet](#binding-a-source-that-does-not-exist-yet)), and let the save
> promote the draft into real sources and feeds in one transaction. You then
> design the board while looking at it, rather than modelling your data before
> you know what the board wants.

A `value` feed for the temperature and a `stream` feed for the builds.
`required: ['name', 'mode']`; `name` is 1–64 chars and unique.

```bash
curl -s -b /tmp/dbz.jar -X POST http://localhost:8484/admin/api/feeds \
  -H 'content-type: application/json' \
  -d '{"name":"kitchen-temp","mode":"value","stale_after_s":900,"alert_on_stale":true}'
```

```json
{ "id": "feed_aaa", "name": "kitchen-temp", "mode": "value", "cap": 50,
  "stale_after_s": 900, "alert_on_stale": true, "allowed_senders": null,
  "pushed_at": null, "pushed_by": null, "image_rev": 0, "created_at": 1754… }
```

```bash
curl -s -b /tmp/dbz.jar -X POST http://localhost:8484/admin/api/feeds \
  -H 'content-type: application/json' \
  -d '{"name":"ci-builds","mode":"stream","cap":100}'
```

```json
{ "id": "feed_bbb", "name": "ci-builds", "mode": "stream", "cap": 100, … }
```

Keep both ids. `cap` defaults to 50 (1–500), `stale_after_s` to `null` (minimum
5 when set), `alert_on_stale` to `false`, `allowed_senders` to `null` (any
sender may push; a list of up to 50 sender ids restricts it).

### 3. Create the screen

Four cells on a 2×2 board. Note the rects tile exactly — `0.5 + 0.5 = 1` on
both axes — which is legal precisely because shared edges are not overlaps.

```bash
curl -s -b /tmp/dbz.jar -X POST http://localhost:8484/admin/api/screens \
  -H 'content-type: application/json' \
  -d '{
    "name": "Kitchen wall",
    "orientation": "landscape",
    "grid": {
      "cells": [
        {
          "rect": { "x": 0, "y": 0, "w": 0.5, "h": 0.5 },
          "widget": "clock",
          "config": { "design": "segment", "scale": 1.2 }
        },
        {
          "rect": { "x": 0.5, "y": 0, "w": 0.5, "h": 0.5 },
          "widget": "gauge",
          "config": {
            "feed": "feed_aaa",
            "path": "value",
            "min": 0,
            "max": 40,
            "label": "Kitchen",
            "unit": "°C",
            "decimals": 1,
            "thresholds": { "warn": 28, "crit": 34 },
            "design": "ring"
          }
        },
        {
          "rect": { "x": 0, "y": 0.5, "w": 0.7, "h": 0.5 },
          "widget": "table",
          "config": {
            "feed": "feed_bbb",
            "columns": [
              { "header": "Project", "path": "project" },
              { "header": "Branch",  "path": "branch" },
              { "header": "Result",  "path": "status", "align": "right" }
            ],
            "headers": true,
            "overflow": { "counter": true }
          }
        },
        {
          "rect": { "x": 0.7, "y": 0.5, "w": 0.3, "h": 0.5 },
          "widget": "text_block",
          "config": { "text": "Bins go out Tuesday", "align": "center" }
        }
      ]
    }
  }'
```

Four things in that payload are worth pointing at:

- **`thresholds` is nested.** `"thresholds": {"warn": 28}` — a flat
  `"thresholds.warn": 28` would be an unknown config key and would fail the
  whole save.
- **`overflow` is nested** the same way, and `"overflow": {"counter": true}`
  is the only shape the schema accepts.
- **The gauge needs `min` and `max`.** They are required, and `min < max` is
  checked separately by the save service.
- **The `text_block` sends `text` and no `feed`.** Sending both would match
  neither arm of its `oneOf`.

The response carries the new id and `rev: 1`:

```json
{ "id": "lay_ccc", "name": "Kitchen wall", "orientation": "landscape",
  "grid": { "cells": [ … ] }, "theme_id": null, "rev": 1, "created_at": 1754… }
```

### 4. Assign it to a device

```bash
curl -s -b /tmp/dbz.jar -X PATCH http://localhost:8484/admin/api/devices/dev_ddd \
  -H 'content-type: application/json' -d '{"screen_id":"lay_ccc"}'
```

**204**, and the panel repaints. The board is live at this point, showing the
clock, an empty gauge track, a "no rows yet" table and the banner.

### 5. Push some data

A sender token, not the admin cookie. `POST /api/feeds/:id` with a JSON body:

```bash
curl -s -X POST http://localhost:8484/api/feeds/feed_aaa \
  -H 'authorization: Bearer SENDER_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"value": 23.4}'
```

```bash
curl -s -X POST http://localhost:8484/api/feeds/feed_bbb \
  -H 'authorization: Bearer SENDER_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"project":"hub","branch":"main","status":"passed"}'
```

Each returns `{"ok": true, "pushed_at": …}` and pushes to every device whose
screen references that feed. A `value` push overwrites; a `stream` push
appends a row.

### 6. Edit it later

Read it back, change the array, send `rev`:

```bash
curl -s -b /tmp/dbz.jar http://localhost:8484/admin/api/screens
```

```bash
curl -s -b /tmp/dbz.jar -X PATCH http://localhost:8484/admin/api/screens/lay_ccc \
  -H 'content-type: application/json' \
  -d '{ "rev": 1, "grid": { "cells": [ … all four cells, edited … ] } }'
```

The response's `rev` is now 2. Use that number next time.

## The errors you will actually hit

Every one of these is a real message from the real code path, and every one
arrives as `{"error": "…"}`. A schema failure **inside a grid cell** is
rewritten into one line naming the cell and the widget; a schema failure
anywhere else (a bad `orientation`, a `name` over 100 characters) keeps AJV's
own wording, which is already specific enough there.

### `cell 1 (clock): unknown config key "nonsense"`

**400.** Every widget's config branch is `additionalProperties: false`. You
used a key that widget does not have.

Check it against [the catalogue](#the-widget-catalogue). The four keys most
often sent to a widget that does not have them: `path` to a `stream_list`,
`scale` to an `image`, `style` to a `gauge` (retired in v21 — it is `design`
now), and `feed` to a `clock` or `alert_feed`.

Remember the blast radius: the grid saves whole, so one bad key on one cell
loses every unsaved edit on the screen.

### The same error, from a key written flat

**400**, and it looks identical, which is why it deserves its own entry.
`{"thresholds.warn": 80}` is not "the nested key, spelled conveniently" — it is
a top-level property called `thresholds.warn`, which no widget declares. The
message will be `unknown config key "thresholds.warn"` and the fix is
`{"thresholds": {"warn": 80}}`.

The nested locations, in full: `thresholds.warn` / `thresholds.crit` on
`gauge`; `clamp.title_lines` / `clamp.body_lines` on `alert_feed` and
`stream_list`; `overflow.counter` on `alert_feed`, `stream_list` and `table`.
Each container is itself `additionalProperties: false`, so a typo *inside* one
fails the same way.

### `cards 1 and 2 overlap`

**400**, from the save service. Two rects share area. Cells are numbered from
1, in array order.

Sharing an *edge* is not overlapping — `x: 0, w: 0.5` beside `x: 0.5, w: 0.5`
is fine. If you did not intend an overlap, you almost certainly have a rect
whose `x + w` runs into its neighbour by a thousandth or two; the comparison is
exact, so "almost adjacent" is genuinely overlapping.

### `card 1 x must be a multiple of 0.001`

**400.** You sent an unquantized fraction — `1/3`, or the output of a division
you did not round. Round every rect value to three decimals before sending.
`card 1 extends past the right edge` and `… past the bottom edge` are the
sibling errors for `x + w > 1` and `y + h > 1`.

### `stream_list needs a stream feed`

**400**, from the save service after it looks the feed up. The widget cannot
read that feed's mode. The family of messages:

| Message | Cause |
|---|---|
| `<widget> needs a stream feed` | a `value` feed bound to `stream_list`; also the generic wrong-mode message |
| `chart needs stream feeds` | a series pointing at a non-stream feed |
| `image widget needs an image feed` | `image` bound to anything but an image feed |
| `image feeds are not bindable` | an image feed bound to any widget except `image` |
| `unknown feed "feed_xyz"` | the feed id does not exist at all |
| `table on a value feed needs a path to an array` | `table` on a `value` feed with no `path` |
| `gauge min must be < max` | exactly what it says |
| `chart series icons must be unique` | two series wearing the same glyph |

Note the first and the last two are *not* AJV errors — they need the database,
so they are checked after the schema passes. A payload can be schema-perfect
and still fail here.

### `weather_forecast requires a semantic source output`

**400.** You bound a semantic widget to a feed you created by hand. Those three
widgets check a contract and its capabilities, not a mode; the feed has to be
an output of a configured source. `weather_forecast requires
dashboardz.weather.daily-forecast/v1` is the neighbouring error for a feed that
*is* a source output but of the wrong contract, and `weather_forecast is
missing weather.daily.entries.7` is what you get for asking `days: 7` from a
five-day source.

### `screen changed elsewhere` with a `rev`

**409.** Somebody saved between your read and your write. The body carries the
row's real `rev`.

Do not retry with `rev + 1`. Re-`GET` the screen, re-apply your edit to the
grid that came back, and PATCH with that `rev`. See [`rev`, and what a 409
means](#rev-and-what-a-409-means).

### `rev is required when saving a grid`

**400.** A PATCH whose body contains `grid` must also contain `rev`. A
field-only PATCH (`name`, `orientation`, `theme_id`) may omit it.

### `name already exists`

**400.** `screens.name` is UNIQUE. Note that this message is produced by
catching the constraint, so it is also what you would get from any other
`SQLITE_CONSTRAINT` on that write — which is exactly why `theme_id` is checked
explicitly first and reports `unknown theme "thm_xyz"` instead of being
mislabelled as a name clash.

### `unauthorized`

**401.** Your session cookie is missing or expired. Log in again; every
`/admin/api` route except `/admin/api/login` is behind the same guard, attached
plugin-wide rather than per route so a route added later is guarded by
construction.

## A stated limitation

**There is no partial grid write.** No endpoint adds, moves or deletes a single
cell. Everything about the layout goes through one read-modify-write of the
whole `cells` array, guarded by `rev`.

That is a deliberate consequence of storing the grid as a blob, and it has a
practical cost worth knowing before you design around it: two agents editing
different cells of the same screen will conflict, and one of them will have to
re-read and re-apply. The alternative — a normalized `cells` table with
per-cell endpoints — buys concurrent cell edits and pays for them with a
migration, a join on every read, and an ordering column. Nothing has needed it
yet.

The same shape applies to the rest of a cell's data: a config is replaced, not
merged. Sending `{"design": "ring"}` as a cell's whole config does not leave
`feed` and `path` where they were — it *is* the new config, and the save will
reject it for missing the keys the widget requires.
