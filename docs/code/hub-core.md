# Hub core and boot

The files at the root of [`hub/src`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src) plus the small
[`auth/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/auth) and [`secrets/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/secrets) folders. They
start the process, build the Fastify instance every route hangs off, and hold
the helpers too small for a folder of their own. Design background:
[Hub](../architecture/hub.md) and [Security model](../architecture/security.md).

## Start here

1. [`index.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/index.ts): the process entry. Loads config, opens
   `DATA_DIR/hub.db`, loads the master key, checks every stored secret can be
   decrypted, installs shutdown handlers, then calls `boot`.
2. [`boot.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/boot.ts): the boot sequence as a testable function.
   `buildServer`, then `startRelay`, then `listen`, then the four timers: the
   source-draft sweep, the TTL and retention sweep, the stale-feed sweep and
   the source loop.
3. [`server.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/server.ts): `buildServer`. Declares the Fastify
   decorators (`db`, `registry`, `statePusher`, `dataPusher`, `sessions`,
   `sourceFetch`, `secretBox`, ...), registers every route plugin and the
   device socket, and serves `hub/static` with its cache headers.

## The other root files

| File | What it owns |
| --- | --- |
| [`config.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/config.ts) | Reads the environment: `ADMIN_PASSWORD` (required), `PUBLIC_URL`, `PORT` (default 8484), `DATA_DIR`, `RELAY_URL`, `DASHBOARDZ_MASTER_KEY`, `RETENTION_*_DAYS`. |
| [`shutdown.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/shutdown.ts) | Checkpoints the WAL (`TRUNCATE`) and closes SQLite on SIGTERM/SIGINT. |
| [`ttl.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/ttl.ts) | The periodic sweep: expires alerts past their TTL and, at most hourly, runs retention. |
| [`validationMessage.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/validationMessage.ts) | Turns AJV's `oneOf` error wall for grid cells into one readable line. |
| [`feedImage.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/feedImage.ts) | Sniffs PNG/JPEG/WebP headers, caps size and dimensions, names image files on disk. |
| [`packStore.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/packStore.ts) | Installed theme packs on disk under `<DATA_DIR>/packs/`: checks an upload with `hub/packs` (importing its designs), writes a pack in one rename, resolves served design files safely. |
| [`feedRejections.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/feedRejections.ts) | The fixed codes for why a push was refused (stored on the feed row as its last rejection) and their admin labels. |
| [`sounds.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sounds.ts) | The five sound events and the theme-then-screen family resolution. |
| [`themeDefaults.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/themeDefaults.ts), [`builtinThemes.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/builtinThemes.ts) | The built-in board palette and the shipped themes, seeded by migrations. |
| [`landingPage.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/landingPage.ts) | Self-contained HTML for `/` and for browser 404s. |
| [`network.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/network.ts) | The computer's private LAN addresses (virtual, VPN and Docker adapters skipped) for the admin's "connect a device" panel. Empty inside a container, where the hub only sees its bridge network. |
| [`brand.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/brand.ts), [`ids.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/ids.ts) | Product name constant; `newId(prefix)` for row ids. |
| [`auth/sessions.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/auth/sessions.ts) | In-memory admin sessions, 24 hour TTL. |
| [`auth/tokens.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/auth/tokens.ts) | Token minting and SHA-256 hashing. Prefixes: `dbz_s_` sender, `dbz_c_` device, `dbz_a_` agent. |
| [`secrets/box.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/secrets/box.ts) | AES-256-GCM `seal`/`open` for source credentials (`v1.` strings). |
| [`secrets/masterKey.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/secrets/masterKey.ts) | Loads `DASHBOARDZ_MASTER_KEY` or creates `DATA_DIR/master.key` (mode 0600). |

## How it connects

`server.ts` is the composition root. Route plugins in
[`routes/`](hub-routes.md) read `app.db` and call the
[`db/`](hub-db.md) modules, then push to devices through `app.registry`,
`app.statePusher` and `app.dataPusher` from [`ws/`](hub-ws.md). `boot.ts`
starts the [relay client](hub-relay-client.md) and the
[source loop](hub-sources.md), and hands the relay manager to the TTL sweep so
an expired question can report a timeout to a relayed sender.

## Things that trip people up

- **Boot order is load-bearing.** `startRelay` decorates the Fastify instance
  and Fastify refuses decoration after `listen`. `startRelay` throws if called
  late, and `boot.test.ts` pins the order.
- **`index.ts` has no tests on purpose.** It runs its side effects on import.
  Anything worth testing belongs in `boot.ts`, whose `BootSeams` let tests
  inject fake sockets, clocks and intervals.
- **The master key is only created on a fresh database.** If `hub.db` already
  holds source secrets and `master.key` is missing, startup fails rather than
  minting a new key that could never decrypt them.
- **Sessions do not survive a restart.** `SessionStore` is a `Map`; restarting
  the hub logs every admin out. Agent tokens are rows in SQLite and survive.
- **Scripts are served `no-store`, everything else `no-cache`.** The comment in
  `server.ts` explains why: an Android WebView kept executing stale ES modules
  under `no-cache`.
- **Never open the live `hub.db` from the host while the container runs.**
  `shutdown.ts` explains the WAL loss; use
  [`scripts/hub-sql.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/hub-sql.sh) instead.

## Tests

In [`hub/test`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test): `boot.test.ts`, `server.test.ts`,
`config.test.ts`, `shutdown.test.ts`, `ttl.test.ts`, `landing.test.ts`,
`masterKey.test.ts`, `secretBox.test.ts`, `tokens.test.ts`, `sounds.test.ts`,
`feedImage.test.ts`, `builtinThemes.test.ts`. See [Hub tests](hub-tests.md).
