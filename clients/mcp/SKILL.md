---
name: dashboardz-screens
description: Use when building or editing dashboard screens, widgets, or data feeds on a Dashboardz hub — covers the imagine → widget → screen → data loop via the dashboardz-mcp tools.
---

# Dashboardz Screens (via dashboardz-mcp)

Build and edit what a Dashboardz hub shows on its wall/bedside devices: screens
(grids of widget cells), the feeds they bind to, and — rarely — new widget
designs. The MCP tools carry every machine-checkable fact (tool schemas,
grid rules, config keys); this skill carries only what a schema cannot say.

## Setup (operator does this once — you only read it)

| What | Where |
|---|---|
| Agent token | minted on the hub admin's **Agents** tab (shown once) |
| Token env/file | `$DASHBOARDZ_TOKEN`, or the file `~/.config/dashboardz/token` (0600) — env wins |
| Hub URL | `$DASHBOARDZ_HUB_URL` (e.g. `http://localhost:8484`) |

If either is missing, tell the operator setup is incomplete — don't hunt for
tokens in repos or scratch files. Same idiom the sender/openclaw skill uses:

```bash
TOKEN="${DASHBOARDZ_TOKEN:-$(cat ~/.config/dashboardz/token)}"
```

Run `./scripts/setup-dev.sh` from the repository root first; it builds the
repo-local CLI at `clients/mcp/dist/cli.js`. Replace
`<absolute-path-to-dashboardz>` below with the absolute path to this checkout.
The npm package is not published, so do not replace this with an `npx` install.
If the hub URL crosses an untrusted or public network, use its HTTPS reverse-
proxy URL; plain HTTP is for a trusted LAN or private VPN only.
Paste-ready MCP client config (the Agents tab shows the same shape):

```json
{
  "mcpServers": {
    "dashboardz": {
      "command": "node",
      "args": ["<absolute-path-to-dashboardz>/clients/mcp/dist/cli.js"],
      "env": { "DASHBOARDZ_HUB_URL": "http://localhost:8484", "DASHBOARDZ_TOKEN": "..." }
    }
  }
}
```

## Tools

| Tool | Reads / writes |
|---|---|
| `list_devices`, `list_screens`, `get_screen`, `list_feeds`, `get_feed`, `list_themes`, `list_sounds` | read-only |
| `create_screen`, `update_screen`, `delete_screen` | screens — live writes (incl. the per-screen `sounds` override: read the vocabulary with `list_sounds` first; `{}` clears back to the theme) |
| `assign_screen`, `set_device_tabs` | point a device at screen(s) — live writes |
| `create_feed`, `create_sender` | feeds and their push credentials — live writes |
| `check_fit` | which feeds CANNOT satisfy a widget+config, before you bind one |

Every write acts immediately on the live hub — no draft, no confirm step.
Each tool's own schema (fetched from the hub at startup) is the source of
truth for its shape and current limits; don't memorize numbers here that the
schema already states.

## The loop

imagine the board → reach for **stock widgets first** (a new design is the
rare branch, below) → build the screen → wire it to data.

Run check_fit before binding a feed to a cell — cheaper than a rejected
save. After every `create_screen`/`update_screen`, read the response's
`warnings[]` and never ignore it: a save can succeed and still warn. If the
real data doesn't exist yet, a cell can carry a pending binding
(`source_draft_id` + `output_contract`) instead of a feed id — wire the feed
up later without re-editing the grid.

## Editing screens safely

A grid PATCH replaces the WHOLE grid, not a diff — send back every cell you
want kept, not just the one you changed. `rev` is the revision you last read
(from `list_screens`, `get_screen`, or a prior write's response) and
`update_screen` requires it. A 409 means a human changed the screen since
that read: re-read it with `get_screen` and reconcile by hand — never blindly retry the same write, or you clobber their change.

## Building a widget design (the rare branch)

Reach here only when no stock widget fits. You need the repo checkout, not
just the MCP: write the widget's `.mjs`, and add one import to
`catalogue.mjs`. `npm test` in `hub/` proves the design is *legal* (schema,
tokens, fit); `npm run build` in `hub/admin` is what makes it *visible* in
the admin gallery — skipping it leaves a design that passes tests but that
no operator can pick. Under Docker, nothing you touch on disk reaches the
running hub without the `./hub/static` bind-mount (commented out in
`docker-compose.example.yml`) or a full `docker compose up --build`.

## Seeing what you built

The board is a web page, not a proprietary render target: point a headless
browser (Playwright) at `<hub-url>/device`, screenshot it, and look before
telling the human it's done. Taste stays the operator's call — this step is
about catching layout breakage, not seeking their approval on every pixel.

## What reads well from across a room

Few cells beat many — a wall isn't a dashboard you scroll. A gauge wants
space; give it a whole cell, not a sliver. When the number IS the story, a
value tile beats a chart. Portrait boards stack; landscape boards tile.

## When a panel goes dark

Operators ask why a panel stopped showing anything. Answer it from
`list_devices` before touching screens or feeds — the device row carries
`online`, `battery`, `charging` and `last_seen_at`, and those settle it.

| What you see | What it means |
|---|---|
| `online: false`, last report `charging: false` | Android Doze parked its wifi. The phone is unplugged with the screen off. Not a hub, network or screen problem. |
| `online: false`, last report `charging: true` | A real network or hub fault — worth investigating. |
| `online: true`, board looks wrong | A screen/binding problem. Start at `get_screen`. |

The rules worth telling an operator, in order of impact: keep the panel
plugged in (Doze never engages while charging); grant *Ignore battery
optimizations*; check the manufacturer's own battery manager, which overrides
the Android setting; and turn on *Beep when the hub connection drops*, which
is **off by default** and is the only thing that announces a lost connection
at the wall. Panel settings are reached by swiping down with two fingers on
the board.

Locking the phone does not disconnect a panel — the connection lives in a
foreground service. A locked panel that went offline was unplugged.

Full prose: `docs/architecture/devices.md`, "Power and sleep".

## Errors

| Symptom | Meaning |
|---|---|
| `401` | token revoked, or pointed at the wrong hub |
| tools changed mid-session | the hub was upgraded; the server adopts the new contract, re-advertises its tools and carries on — nothing to do |
| `400` | comes with a sentence explaining what's wrong — read it before retrying |

## Deep reference

`docs/architecture/widgets.md` and `screens.md` (the published site) carry
prose and worked examples for humans learning the system. They are not how
*you* learn the contract — the tool schemas already carry it, and are always
current for the hub you're actually talking to.
