# Development

Dashboardz is a multi-component repository. The hub owns persistence and
delivery; clients and integrations remain external processes that authenticate
with sender or agent tokens.

## Repository map

| Path | Owns |
| --- | --- |
| `hub/src/` | Fastify server, SQLite data, HTTP routes, WebSocket state, and source polling |
| `hub/admin/` | React admin UI for devices, screens, widgets, senders, feeds, and settings |
| `hub/static/device/` | Browser device runtime and the shared JavaScript widget designs |
| `relay/` | Optional WebSocket switchboard for senders that cannot reach a hub directly |
| `clients/sender/` | Reference sender library and `dbz-send` CLI |
| `clients/mcp/` | MCP server for agent access to hub management APIs |
| `integrations/claude/` | Claude assistant and hook integration |
| `integrations/meshtastic/` | Python daemon that turns radio messages and telemetry into feeds and alerts |
| `integrations/netdata/` | Shell integration for Netdata alerts and metrics |
| `apps/android/` | Kotlin/Compose kiosk app for Android devices |
| `docs/` | Operator, integration, architecture, and contributor documentation |

## Setup and the full check

Use Node.js 22 or newer, Python 3, Docker, and JDK 17 for Android work. The
scripts resolve the repository root internally, but the relative commands
below start from that root:

```bash
cd <checkout>
./scripts/setup-dev.sh
./scripts/check-all.sh
```

Setup runs `npm ci` for every Node package, creates the ignored root `.venv`,
installs Meshtastic and MkDocs dependencies, and builds the admin bundle and
MCP CLI. The latter creates the ignored `clients/mcp/dist/cli.js` entrypoint
used by the repo-local agent configuration. The check script runs the Node
tests, typechecks and builds, admin lint, Claude hooks, Meshtastic tests, strict
MkDocs build, Compose validation, and Android unit tests.

The admin bundle step matters on a clean checkout: `hub/static/admin/` is
ignored generated output, and the hub server tests serve it. Build it before
running the hub suite:

```bash
npm --prefix hub/admin run build
npm --prefix hub test
```

## Focused checks

Run the smallest relevant command while iterating:

```bash
npm --prefix hub test
npm --prefix hub run typecheck
npm --prefix hub/admin test
npm --prefix hub/admin run lint
npm --prefix relay test
npm --prefix relay run typecheck
npm --prefix clients/sender test
npm --prefix clients/mcp test
npm --prefix integrations/claude/assistant test
sh integrations/claude/hooks/test_hooks.sh
.venv/bin/python -m unittest discover -s integrations/meshtastic -p 'test_*.py'
apps/android/gradlew -p apps/android test
```

Package `build` and `typecheck` scripts are available for the sender, MCP,
relay, and Claude assistant packages. Use `npm --prefix <directory> run
build` or `run typecheck` when a change crosses their compiled boundary.

## Develop the hub and admin together

Use two terminals from the repository root. The admin's Vite server proxies API
requests to the hub:

```bash
# terminal 1
npm --prefix hub/admin run dev

# terminal 2
ADMIN_PASSWORD=dev-only-password PUBLIC_URL=http://localhost:8484 \
  npm --prefix hub run dev
```

Open `http://localhost:5173/admin/` for the Vite-served admin and
`http://localhost:8484/device` for a device view. Build the admin bundle when
you need to exercise the hub's own static serving path:

```bash
npm --prefix hub/admin run build
```

To preview the documentation locally:

```bash
.venv/bin/mkdocs serve
```

MkDocs prints a local preview URL, normally `http://127.0.0.1:8000/`.

## Common change locations

- Add or adjust a browser widget in `hub/static/device/widgets/`, then update
  the widget catalogue and its tests as needed. The admin preview imports the
  same JavaScript design modules.
- Change an HTTP endpoint in `hub/src/routes/`; preserve its auth, schema,
  response, and audit behavior.
- Change an admin screen in `hub/admin/src/pages/` and its colocated tests.
- Add an external-system integration under `integrations/` and document the
  sender token, configuration, and observable output in the matching README or
  docs page.
- Change Android pairing, kiosk behavior, or alert handling under
  `apps/android/`; use the Gradle unit test command above.

Keep runtime boundaries explicit: browser widgets are shared JavaScript loaded
by the hub and admin preview, while the admin UI talks to the hub's documented
HTTP APIs. Do not put integration-specific concepts into hub persistence or
routes.
