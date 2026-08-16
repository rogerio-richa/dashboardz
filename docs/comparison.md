# How Dashboardz compares

There are many good projects that put information on a screen on your wall. This page maps the
neighbours honestly — including what they do better than Dashboardz today — so you can pick the
right tool rather than the loudest one. Facts are as of August 2026.

## The short version

Dashboardz sits on an intersection no single project covers: **self-hosted** × **ambient, themed
dashboards** × **built for old Android devices** × **one hub pushing to many displays** × **an
open, portable widget contract** × **two-way alerts** (a sender can ask a question and get the
human's tap back). Each neighbour covers some of those axes, usually very well — none covers this
combination.

That cuts both ways: Dashboardz is young, and the neighbours have things it does not — mature
communities, huge integration catalogues, years of production mileage. The tables below are the
honest trade.

## The map

| | Self-hosted | Ambient + themed | Old-Android friendly | Push hub, many displays | Open widget contract | Data connectors | Two-way alerts |
|---|---|---|---|---|---|---|---|
| MagicMirror² | ✓ | partial (hand CSS) | ✗ (Pi/Electron) | ✗ (one machine, one mirror) | DOM modules | per-module | ✗ |
| DAKboard / Mango Display | ✗ (cloud) | ✓ | ✓ (native apps) | ✓ (via cloud) | ✗ (closed) | ✓ (hosted) | ✗ |
| Home Assistant dashboards | ✓ | partial (control-first) | ✗ (needs evergreen browsers) | ✗ (pull) | HACS cards (YAML/CSS) | ✓✓ (thousands) | ✓ (inside HA's entity model) |
| Glance / Homepage / Dashy | ✓ | ✗ (browser startpage) | ✗ | ✗ (pull) | YAML/HTTP | some | ✗ |
| TRMNL | partial (BYOS option) | ✓ (1-bit eink) | ✗ (eink hardware product) | ✓ (cloud renders) | ✓ (HTML/Liquid plugins) | ✓ (hosted, 1,000+ plugins) | ✗ (eink is one-way) |
| Digital signage / Grafana kiosk | ✓ | ✗ | partial | partial | ✗ | metrics/media only | ✗ |
| **Dashboardz** | ✓ | ✓ (themes are data) | ✓ (designed for it) | ✓ (hub push, screen tabs) | ✓ (portable canvas contract) | ✓ (built-in, small set) | ✓ (ask → tap → answer) |

## The neighbours, fairly

**MagicMirror²** is the incumbent of DIY wall displays — a decade old, 1,000+ community modules, a
real forum culture. It runs Electron on a Raspberry Pi behind the mirror; modules are DOM + CSS and
each typically fetches its own data. If you have a Pi and enjoy that model, it is proven. It has no
Android story, no theme system beyond hand-edited CSS, and one machine drives one mirror.

**DAKboard and Mango Display** are polished commercial products for family command centers, and
both now ship native Android apps aimed at the tablet you already own. They are cloud services:
your layouts and data flow through their servers, custom layouts sit behind subscriptions, and the
display needs their cloud to stay current. If you want zero self-hosting, they are the mature
choice — the trade is lock-in that a self-hosted hub exists to avoid.

**Home Assistant** is the gravity well of home automation, with integrations for essentially
everything — and if you run HA already, it is the obvious dashboard too. Its dashboards are
control panels first; ambient wall-display use is a community plugin stack, data must exist as HA
entities, and the frontend targets evergreen browsers — old tablets with frozen WebViews
increasingly fall off. HA is a complement rather than a competitor here: an HA connector is a
an additional source for Dashboardz boards.

**TRMNL** proved this product shape works: a calm eink display, trivially authorable plugins, a
fast-growing community, no subscription. Its cloud renders plugins server-side and the device
blits bitmaps; firmware is open and BYOD/BYOS options exist. It is an eink hardware product with
hosted rendering at its center — a different bet than driving screens you already own from a hub
you run. (Its cautionary sibling, Tidbyt, showed what happens to cloud-rendered fleets when the
company is acquired — the community had to fork a self-hosted server to keep devices alive.
Dashboardz's answer to that failure mode is being self-hosted from day one.)

**Glance, Homepage, Dashy, Homarr** ride the enormous appetite for self-hosted dashboards — but
they are browser startpages and service launchers: pull-on-load, no push, no wall-display device
story. Great at what they do; a different product.

**Digital signage (Anthias, Xibo) and Grafana kiosk mode** put content on screens reliably, but
signage loops media rather than composing live widgets, and Grafana is metrics aesthetics for an
ops audience.

## What Dashboardz does that nobody above does

- **Built for the frozen WebView.** Android 8/9 devices are stuck on Chrome 138 forever; every
  tool above renders someone's modern web UI in that old engine and inherits the breakage.
  Dashboardz renders everything through a deliberately tiny canvas drawing subset (26 operations,
  enforced by test) precisely so boards keep rendering on the devices in your drawer.
- **A hub that pushes.** Displays hold an open socket and receive state; one hub drives many
  screens, each with up to 16 tabbed boards with live status dots. No per-device polling, no
  per-screen cloud fees.
- **Themes as data.** A theme is a small palette plus one backdrop word; everything else is
  derived. Restyling every board is editing data, not CSS.
- **A portable, single-file widget contract.** A widget design is one pure file — `meta` plus a
  `draw` over the tiny subset — previewable in the admin, validated mechanically, renderer-agnostic.
  The same contract is served machine-readably to AI agents over
  [MCP](architecture/security.md#agent-tokens), so an assistant can author and manage boards
  against the same rules the hub enforces.
- **Alerts that answer back.** An alert can carry up to four options; the human taps one on the
  wall; the sender that asked gets the answer. Delivery, dedup, expiry, and audit live in the hub.

## Where Dashboardz is honestly behind

- **Age and mileage.** This is a young project with a single maintainer, in production on its
  author's own fleet. The neighbours have years of diverse deployments; treat maturity claims
  accordingly.
- **Connector count.** Built-in data sources today are weather (keyless), ICS calendar, and
  RSS/Atom: a deliberate, OAuth-free minimum. Home Assistant has thousands of integrations;
  TRMNL has 1,000+ plugins. If your dashboard depends on many hosted services, those catalogues
  serve you better today. The gap is real, but it is a much smaller moat than it was. A catalogue
  is years of contributor hours, and contributor hours are exactly what an AI agent now supplies
  on demand: point one at the [integration walkthrough](integrations.md) and the MCP, describe
  the source, and it builds the connector for you. Anything that can POST JSON feeds a board, and
  the feed contract, the walkthrough, and the reference sender are written for an agent to read.
  You still get the connector built rather than downloaded; it is now an afternoon with an
  agent instead of a wait for someone else's pull request.
- **No community yet.** MagicMirror's forum, HA's ecosystem, and TRMNL's plugin gallery represent
  years of accumulated answers. Dashboardz's gallery of community widgets and themes does not
  exist yet — the contract was built for it, but building it is ahead, not behind.
- **Shipped display targets are Android and the browser.** TRMNL ships an eink device; Dashboardz
  uses screens you already own.
- **Interaction is deliberately narrow.** Dashboardz does acknowledgments and small choices, not
  control surfaces — no sliders, toggles, or device control. If you want to *control* your home
  from the wall, that is Home Assistant's lane, and Dashboardz doesn't try to occupy it.

## Choosing

- You run Home Assistant and want a **control panel** → Home Assistant dashboards.
- You want **zero self-hosting** and a polished consumer product → DAKboard or Mango.
- You love the **Pi-behind-a-mirror** build and its module culture → MagicMirror².
- You want a **calm eink gadget** with a huge plugin catalogue → TRMNL.
- You want a **browser homepage** for your homelab services → Glance or Homepage.
- You have old Android devices, want them on walls showing themed live boards, pushed from a hub
  you run, with alerts that can wake you and questions that can be answered with a tap —
  that is the case Dashboardz was built for.
