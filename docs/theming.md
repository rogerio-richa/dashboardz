# Theming

A theme decides what a board looks like: its colours, and the texture behind
them. Every screen picks one, or picks none and gets the built-in default.

Themes are deliberately small. A theme is **eight colours, a chart ramp, and
one word for the backdrop** — and everything else on the board is worked out
from those. It is not a stylesheet, and it cannot move anything: fonts, card
shapes, spacing and widget geometry are the same on every theme, on purpose.
That is what makes a good-looking theme something you can finish in an
afternoon rather than a project.

## The palette

Eight colours, each named for what it *means* rather than where it appears:

| | |
|---|---|
| `bg` | the board behind everything |
| `surface` | cards and panels sitting on it |
| `ink` | text |
| `dim` | secondary text — labels, timestamps, units |
| `accent` | the board's signature colour |
| `info` `warn` `critical` | the three severities, used by alerts, gauge thresholds and status text |

Plus `series` — four colours a chart cycles through — and `scrim`, a 0-to-1
dimming strength that only applies to a background image (see below).

## You do not author the rest

There are twelve more colours on a board that the palette does not name:
hairlines, borders, chips, the warn and critical card tints, the four colours
of the critical takeover overlay, and the hole punched in the middle of a ring
gauge.

**You never write those.** Each one is derived from your palette — a hairline
is your `ink` at 8%, a border is your `surface` nudged toward your `ink`, and
so on. Change one palette colour and everything that depends on it follows.

This is the difference between a theme being eight decisions and twenty-two.
It is also what lets a **light** theme exist at all: before derivation, the
fallbacks were a fixed dark set, so a cream board rendered with dark-theme
furniture — a white hairline invisible on cream, a near-black disc in the
middle of every gauge.

If you ever need to override one of the derived colours, you can, per theme.
You should not need to, and none of the built-ins do.

## Backdrops

The backdrop is the texture behind the whole board. It is a **name**, not an
image, and it is drawn from your own palette:

| | |
|---|---|
| `flat` | plain `bg`, and nothing else |
| `wash` | a soft diagonal lift from `bg` toward `surface` — reads as paper on a light theme, as depth on a dark one |
| `glow` | an accent bloom from the lower left, plus a gentle edge vignette |
| `grid` | a hairline lattice at 40px, in your `ink` at very low opacity |
| `cards` | plain `bg` behind cells drawn as bordered `surface` cards — the paper-dashboard look |

Nothing is downloaded, decoded or licensed, they are sharp at any resolution,
and recolouring your palette recolours the backdrop with it. A device that is
older than a backdrop name draws a plain board rather than a blank one.

### Card settings (the `cards` backdrop)

Under `cards`, every cell is drawn as a rounded card — `surface` fill,
`border` outline — by the widget pipeline itself, on the same canvas the
widget draws on (so it ports to any renderer, and widget content is
automatically inset to respect it). Two board numbers tune the geometry, and
one cell property opts out:

| | | |
|---|---|---|
| `board.card_gap` | `0`–`16` px, default `2` | space between the cell edge and its card — neighbouring cards sit two gaps apart |
| `board.card_padding` | `0`–`24` px, default `8` | interior space between the card's border and the widget's content |
| cell `card: false` | per-cell, default on | draws that one cell directly on the board, no card — a title strip, say |

Both board numbers are edited next to `scrim` in the theme editor; the cell
opt-out is the `card` checkbox on the cell. Themes on any other backdrop
ignore all three.

## Background images

Separate from the backdrop, and both can be set. Upload an image to a theme
and it paints *over* the procedural layer; `scrim` then darkens it so cards
stay readable. Built-in themes ship no images at all.

## The built-in themes

Five, chosen so that two are dark, two are light, and one is neither
comfortable nor trying to be:

| Theme | Character | Backdrop | Clock |
|---|---|---|---|
| **Default** | dark slate — the original board, unchanged | `flat` | digital |
| **Cypherpunk** | near-black, neon red | `glow` | segment |
| **Toscana** | cream and terracotta, warm brown text | `wash` | analog |
| **Nordic** | cool light grey, slate text, muted blue | `flat` | digital |
| **Terminal** | pure black, phosphor green, amber alerts | `grid` | segment |

They are starting points. Edit any of them, or copy one and change it — a
built-in cannot be deleted, but nothing stops you recolouring it.

## Designs

Some widgets can be drawn more than one way. The clock has five faces —
digital, seven-segment, analog, split-flap and nixie tube — and a theme names
which one it wants. Everything else has a single design today.

The choice resolves in this order, most specific first:

1. what the **cell** asks for, if it asks for anything
2. what the **theme** asks for
3. the widget's own default

A design named by a theme is only geometry. Its colours come from the palette,
which is why any clock face looks right under any theme without either knowing
about the other.

If a device is running an older build that has never heard of a design, it
draws the default rather than an empty box — and, since it can tell that it was
asked for something it does not have, it reloads itself to pick up the newer
catalogue.

## Sound

A theme also suggests a voice, not just a look: for each of five alert events — **critical**,
**warn**, **info**, **offline**, and **activity** (stream-activity contract — a soft tick for stream cells that opted
into "chime on new entries"; see [Screens](architecture/screens.md#stream_list) for the opt-in and
[Devices](architecture/devices.md#sound) for how it reaches a device) — it names one of the hub's
shipped **sound families** to play. `classic` reproduces the tones the app has always made (it
ships no files at all — it's generated on the device or in the browser); `bells` and `8bit` are
pre-rendered `.wav` files the hub serves from its own static assets. A theme with no opinion on an
event falls back to `classic`. Three of the built-ins actually do have opinions — Cypherpunk
suggests `8bit` on every event including `activity`, Toscana and Nordic suggest `bells` on every
event including `activity` — but that curated set is seeded onto a theme's row only on a **fresh
install**; an existing install upgrading into this feature keeps every theme, built-in or not, at
`classic` across the board, whichever one is assigned. Upgrading never changes what a room already
sounds like — it just makes a *new* room's default themes sound different from an *old* room's.
(This applied to the original four events at 0.4, and applies the same way now that `activity`
joined them at 0.5 — the fresh-install-only rule is per event, not just per theme.)

A screen can override any subset of those five events — "soft bells for critical, leave the rest
on the theme" — and the hub resolves theme, then screen, then `classic` into the one mapping it
actually pushes to a device. Neither the theme nor the screen has to name every event; whatever
is left unset just falls through to the next layer.

In the admin UI, both the theme editor and a screen's editor show this as a **Sounds** mixer: one
row per event, a picker for the family, and a ▶ chip that auditions the pick right there in the
browser. On the Screens page the mixer also marks each row **from theme** or **overridden**, so
it's clear at a glance which events a screen has actually taken control of. See
[Devices](architecture/devices.md#sound) for how that resolved mapping actually reaches a device
and what happens when a sample isn't there yet.

## Making your own

In the admin UI, open **Themes**, then either **New theme** or **copy** an
existing one. Set the eight palette colours and a backdrop; leave the chrome
section alone unless you have a specific reason not to. Assign it to a screen
from the **Screens** list — each screen carries its own theme, so a wall panel
and a desk tablet can look completely different.

Two things worth doing before you put a theme on a wall:

- **Check it against real data**, not an empty board. `hub/scripts/demo-data.mjs`
  fills every widget type with plausible moving values, including gauges that
  cross their warn and critical thresholds, so you can see what your palette
  does when something is wrong rather than only when everything is fine.
- **Check the contrast.** The built-ins all clear WCAG AA — 4.5:1 for body
  text, 3:1 for labels, gauge strokes, severity colours and the chart ramp,
  each against whatever it is actually drawn on. A palette that fails those is
  legible on your laptop at arm's length and unreadable on a panel across the
  room.

## What a theme will not do

By design, a theme cannot change typography, spacing, corner radius, density,
or how any widget is laid out. Those are the same everywhere so that a screen
you built looks like the screen you built, whichever theme is on it — and so
that a new theme can never break a layout.
