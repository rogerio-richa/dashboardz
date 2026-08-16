# Database and migrations

[`hub/src/db`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/db) is the hub's only persistence: one SQLite file
(`DATA_DIR/hub.db`) opened with better-sqlite3. It holds the schema, the
migration runner, and one query module per table family. Routes, the socket
and the sweeps never write SQL of their own; they call these modules. Design
background: [Hub: Storage](../architecture/hub.md#storage).

## Start here

1. [`index.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/index.ts): `openDb` sets WAL, `busy_timeout`,
   `foreign_keys` and `secure_delete`, runs `migrate`, and vacuums once when a
   database crosses v20 (the version that dropped plaintext connector
   credentials). Also `databaseHasProtectedSecrets` and `verifySecretStore`,
   which `hub/src/index.ts` calls before boot.
2. [`migrate.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/migrate.ts): the `MIGRATIONS` array and the
   runner. Each entry is either a SQL string or a function; index `i` brings
   the database to `user_version` `i + 1`, each step in its own transaction.
3. [`schema.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/schema.ts): the SQL strings (`SCHEMA_V1` ...
   `SCHEMA_V29`). Read it to see what a table looks like today, remembering
   that later versions alter earlier ones.

## Query modules

| Module | Tables | Used by |
| --- | --- | --- |
| [`alerts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/alerts.ts) | `alerts`, `deliveries` | notify route, device socket, relay handler, TTL sweep |
| [`devices.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/devices.ts) | `devices`, `pairing_codes`, `device_screens` | pairing, device socket, admin devices routes |
| [`senders.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/senders.ts) | `senders` | sender-token auth, relay key lookup |
| [`agents.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/agents.ts) | `agent_tokens` | `requireAdmin`, agent token routes |
| [`feeds.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/feeds.ts) | `feeds`, `feed_rows`; the last rejected push (`recordFeedRejection`, v28; every accepted push zeroes `rejected_count`) | feed push route, source output writer, relay handler |
| [`screens.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/screens.ts) | `screens` | screen save service, state builder |
| [`themes.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/themes.ts) | `themes`, including `recommended` (v29: suggested designs per widget, admin-only, never sent to devices) | theme routes, state builder |
| [`sources.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/sources.ts) | `source_instances`, `source_secrets`, `source_outputs` | source runtime and admin routes |
| [`sourceDrafts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/sourceDrafts.ts) | `source_drafts`, `source_draft_secrets`, `source_draft_outputs` | draft service |
| [`settings.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/settings.ts) | `settings` (key/value) | retention windows, relay URL and relay token |
| [`audit.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/audit.ts) | `audit_log` | everything that changes state |
| [`retention.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/retention.ts), [`retentionSettings.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/retentionSettings.ts) | `alerts`, `deliveries`, `audit_log` | TTL sweep, storage admin routes |
| [`storageStats.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/storageStats.ts) | read-only counts | storage admin route |

Two migrations are big enough to live in [`migrations/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/db/migrations):
[`v6-rects.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/migrations/v6-rects.ts) (template grids to
per-cell rects) and [`v19-sources.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/migrations/v19-sources.ts)
(the old connector rows into `source_instances`, with credentials sealed by
the secret box). The other function steps sit in `migrate.ts` itself.

## How it connects

Every module takes the `DB` handle as its first argument; nothing holds a
global connection. Writes that must be atomic with an audit row or a second
table run inside `db.transaction(...)` at the caller (see
[`screens/save.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/save.ts) and
[`sources/run.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/run.ts)). Device-facing reads go
through [`ws/stateBuilder.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/ws/stateBuilder.ts) and
[`ws/dataPush.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/ws/dataPush.ts).

## Things that trip people up

- **Append only.** Never edit a shipped entry in `MIGRATIONS`; add a new one.
  The constant names are a guide, the array position is the truth: the
  function `migrateV11` is the step that produces version 12, because
  `SCHEMA_V11` already occupies version 11.
- **Old names survive in SQL history.** The `devices` table started life as
  `screens` and was renamed at v3; `SCHEMA_V1` still says `screens`.
- **Device tokens use the `dbz_c_` prefix** ("client") for the same
  historical reason. Stored tokens are never rewritten.
- **Bad stored data must not crash a read path.** JSON columns (`grid`,
  `payload`, `sounds`) are parsed defensively; follow that pattern in new
  readers.
- **Tokens are stored hashed.** `senders.ts` also stores a derived
  `relay_key` per sender so the relay handler can decrypt without holding a
  working bearer token.
- **`migrate()` accepts `targetVersion`.** Migration tests use it to build a
  database at an old version and then upgrade it.

## Tests

`db.test.ts`, `migrate.test.ts` and one `migrateV*.test.ts` per migration that
rewrites data (`migrateV7`, `V11`, `V19`, `V20`, `V21`, `V22`, `V27`), plus
`alerts.test.ts`, `devices.test.ts`, `senders.test.ts`, `feeds.test.ts`,
`screens.test.ts`, `sources.test.ts`, `sourceDrafts.test.ts`,
`settings.test.ts`, `retention.test.ts`, `retentionSettings.test.ts` and
`storageStats.test.ts`, all in [`hub/test`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test).
