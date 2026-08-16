export const SCHEMA_V1 = `
CREATE TABLE senders (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  default_screens TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE TABLE screens (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  capabilities  TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  battery       INTEGER,
  charging      INTEGER
);
CREATE TABLE pairing_codes (
  code          TEXT PRIMARY KEY,
  screen_name   TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE TABLE alerts (
  id            TEXT PRIMARY KEY,
  sender_id     TEXT NOT NULL REFERENCES senders(id),
  title         TEXT NOT NULL,
  body          TEXT,
  severity      TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  sound         INTEGER NOT NULL,
  ttl_s         INTEGER,
  dedup_key     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  update_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','dismissed')),
  target_screens TEXT NOT NULL
);
CREATE INDEX alerts_active_dedup ON alerts (sender_id, dedup_key) WHERE status = 'active';
CREATE TABLE deliveries (
  alert_id      TEXT NOT NULL REFERENCES alerts(id),
  screen_id     TEXT NOT NULL REFERENCES screens(id),
  delivered_at  INTEGER,
  displayed_at  INTEGER,
  silenced_at   INTEGER,
  dismissed_at  INTEGER,
  PRIMARY KEY (alert_id, screen_id)
);
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  event         TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '{}'
);
`

/**
 * `senders.relay_key` is 32 bytes of HKDF output derived from the sender token at creation
 * The hub needs it because the relay envelope key derives from the token,
 * the token travels *inside* the ciphertext, and `token_hash` is one-way — so a hub holding
 * only hashes could never decrypt anything. Nullable on purpose: senders created before this
 * migration have no recoverable token, so they get NULL, are skipped by trial decryption, and
 * simply cannot use the relay until they are re-created.
 */
export const SCHEMA_V2 = `
ALTER TABLE alerts ADD COLUMN options TEXT;
ALTER TABLE alerts ADD COLUMN reply_to TEXT;
ALTER TABLE deliveries ADD COLUMN answered_at INTEGER;
ALTER TABLE deliveries ADD COLUMN answer TEXT;
ALTER TABLE senders ADD COLUMN relay_key BLOB;
CREATE TABLE relay_identity (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  hub_uid     TEXT NOT NULL,
  hub_secret  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
`

/**
 * The device rename (naming rule): "screen" was overloaded for three unrelated concepts, and only the
 * paired-hardware entity — token, WebSocket connection, health, online state — becomes "device"
 * here. Stored ids are never rewritten (a `scr_` id from before this migration stays `scr_`
 * forever, grandfathered); only the table and column names change. New devices paired after this
 * migration get a `dev_`-prefixed id from `newId('dev')` (hub/src/db/devices.ts).
 */
export const SCHEMA_V3 = `
ALTER TABLE screens RENAME TO devices;
ALTER TABLE senders RENAME COLUMN default_screens TO default_devices;
ALTER TABLE alerts RENAME COLUMN target_screens TO target_devices;
ALTER TABLE pairing_codes RENAME COLUMN screen_name TO device_name;
ALTER TABLE deliveries RENAME COLUMN screen_id TO device_id;
`

/**
 * Dashboard editor schema: a screen IS a
 * layout. `lay_` ids (never `scr_` — grandfathered pre-v3 device ids already look like that).
 * Orientation is fixed per device at enrollment (fixed-orientation rule) and every layout targets exactly one
 * orientation; existing devices backfill landscape. The reserved 'snd_hub' sender satisfies
 * alerts.sender_id's NOT NULL FK so the hub can raise warn self-notifications (STATE_ACK
 * timeout/mismatch); its token_hash is not a sha256 digest, so it can never authenticate.
 */
export const SCHEMA_V4 = `
CREATE TABLE screens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  orientation TEXT NOT NULL CHECK (orientation IN ('landscape','portrait')),
  grid        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
ALTER TABLE devices ADD COLUMN orientation TEXT NOT NULL DEFAULT 'landscape';
ALTER TABLE devices ADD COLUMN screen_id TEXT REFERENCES screens(id);
ALTER TABLE pairing_codes ADD COLUMN orientation TEXT NOT NULL DEFAULT 'landscape';
INSERT INTO senders (id, name, token_hash, created_at)
  VALUES ('snd_hub', 'Hub', 'system-sender-no-token', CAST(strftime('%s','now') AS INTEGER) * 1000);
`

/**
 * Data feeds are push-only, admin-created, and sender-token pushed.
 * mode is immutable after creation and DB-permissive for 'image' from day one, while the
 * creation API currently restricts new feeds to value|stream. cap bounds
 * (1..500) and allowed_senders shape are enforced at the API layer, not here. feed_rows
 * ordering rides the AUTOINCREMENT id — stable insert order, no timestamp ties.
 */
export const SCHEMA_V5 = `
CREATE TABLE feeds (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  mode            TEXT NOT NULL CHECK (mode IN ('value','stream','image')),
  cap             INTEGER NOT NULL DEFAULT 50,
  stale_after_s   INTEGER,
  alert_on_stale  INTEGER NOT NULL DEFAULT 0,
  allowed_senders TEXT,
  payload         TEXT,
  pushed_at       INTEGER,
  pushed_by       TEXT,
  image_rev       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE TABLE feed_rows (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id   TEXT NOT NULL REFERENCES feeds(id),
  payload   TEXT NOT NULL,
  pushed_at INTEGER NOT NULL,
  pushed_by TEXT NOT NULL
);
CREATE INDEX idx_feed_rows_feed ON feed_rows(feed_id, id);
`

/**
 * Theming: a design declares a colour interface (named slots, each falling
 * back to a board colour); a colorset is a stored row implementing one design's interface, named
 * and reusable across themes; a theme selects a background, the board colour block (the colours
 * no design owns), and a per-widget {design, colorset} pair. `colors`, not `values` — `VALUES`
 * is a SQLite reserved word. `screens.theme_id` NULL means the built-in default (no lookup, no
 * behaviour change) — every screen that exists before this migration keeps that NULL.
 */
export const SCHEMA_V7 = `
CREATE TABLE colorsets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  widget      TEXT NOT NULL,
  design      TEXT NOT NULL,
  colors      TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE themes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  board       TEXT NOT NULL,
  widgets     TEXT NOT NULL DEFAULT '{}',
  chrome      TEXT NOT NULL DEFAULT '{}',
  bg_kind     TEXT NOT NULL DEFAULT 'none',
  bg_color    TEXT,
  bg_rev      INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
ALTER TABLE screens ADD COLUMN theme_id TEXT REFERENCES themes(id);
`

/**
 * v8 — devices report the box a screen is actually drawn into.
 *
 * A screen is authored FOR a device, and a device has a size. Without this the editor could only
 * guess: it offered a target-shape dropdown, an operator picked 16:10 for a 20:9 handset, and
 * every cell came out ~28% shorter in pixels than the preview showed. It is also what makes
 * WIDGET_MIN_PX enforceable at design time rather than discovered on the wall.
 *
 * CSS pixels plus a device-pixel-ratio, not physical pixels: layout, minimum sizes and type are
 * all in CSS px, so storing anything else would need converting at every read. NULL means a device
 * that has not reported yet — an older client, or one that has never connected since this landed —
 * and every consumer must treat it as "unknown", never as zero.
 */
export const SCHEMA_V8 = `
ALTER TABLE devices ADD COLUMN viewport_w INTEGER;
ALTER TABLE devices ADD COLUMN viewport_h INTEGER;
ALTER TABLE devices ADD COLUMN viewport_dpr REAL;
ALTER TABLE devices ADD COLUMN viewport_at INTEGER;
`

/**
 * v10 — a theme's procedural backdrop.
 *
 * DECLARATIVE, not drawing code. The portable renderer emits gradients from the palette, so a backdrop
 * implemented in canvas would either violate it or be forced into banded fillRect loops. It does
 * not need to be drawing code: the board is a web page on every platform (web-renderer boundary), so the backdrop is
 * a NAME the renderer turns into CSS, and a firmware port renders its own way. Nothing enters `g`.
 *
 * A NEW COLUMN rather than a new `bg_kind` value, because the two answer different questions and
 * both can be set: `backdrop` is the always-present procedural layer, `bg_kind`/`bg_color`/`bg_rev`
 * stay exactly as they are for a user-uploaded image that paints OVER it. Overloading bg_kind would
 * have made "this theme has a glow AND the user's photo" unrepresentable.
 *
 * Defaults to 'flat', which renders as plain `bg` — so every existing theme keeps looking exactly
 * as it does.
 */
export const SCHEMA_V10 = `
ALTER TABLE themes ADD COLUMN backdrop TEXT NOT NULL DEFAULT 'flat';
`

/**
 * v11 — colorsets are deleted (theme migration / theming simplification).
 *
 * They existed so a design could be recoloured independently of the palette. Measured, that was
 * never worth a table: every colour slot in all three clock designs already defaults to a board
 * colour (`@ink`, `@surface`, `@accent`, `@dim`), so every design already renders correctly from
 * the palette alone. The one seeded colorset overrode four slots, of which exactly TWO held values
 * the palette could not produce — and both are derivable (an unlit seven-segment element is just
 * the lit one at low alpha).
 *
 * Two shades. That was the entire payoff of a table, a CRUD API with a delete-cascade, a library
 * page, cell-level pinning and a copy-on-write rule.
 *
 * `themes.widgets` collapses with it, from `{clock: {design, colorset_id}}` to `{clock: 'segment'}`
 * — a theme names a DESIGN per widget type and nothing else. Cells drop `config.colorset` the same
 * way. Both rewrites happen in migrateV11 rather than here, since they are data, not shape.
 */
export const SCHEMA_V11 = `
DROP TABLE IF EXISTS colorsets;
`

/**
 * v14 — screens get a `rev`, so a save can be refused instead of silently winning.
 *
 * The editor PATCHes the WHOLE grid: it is a read-modify-write over a blob, not a field update.
 * Nothing checked that the row had not moved underneath it, so two editors open the same screen,
 * both save, and the second discards everything the first did — with no error, no log line, and no
 * evidence beyond the work being gone. The version check refuses that stale write and preserves
 * the first editor's changes.
 *
 * Same shape and semantics as `themes.rev`, which has had this since v7: a monotonic row version
 * that every write bumps. It is NOT the STATE message's `rev` (a per-connection message counter in
 * stateBuilder) and is deliberately not put on the wire — a device re-renders whatever layout it is
 * sent and has no use for a concurrency token.
 *
 * Defaults to 1 so every existing screen starts at the same place a newly created one does.
 */
export const SCHEMA_V14 = `
ALTER TABLE screens ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
`

/**
 * v15 — orientation belongs to the SCREEN, not the device (reverses fixed-orientation rule).
 *
 * Both tables carried it, and the hub spent real effort keeping them equal: a device could not be
 * flipped while a screen was assigned, a screen could not be flipped while devices were assigned,
 * and assignment refused a mismatch outright. Three guards, all defending an invariant that only
 * existed because the value was stored twice.
 *
 * A layout is authored FOR a shape. The device is a piece of glass that shows whatever layout it
 * is pointed at, so the shape is the layout's property and the device follows. Storing it on both
 * made "which one is right" a question the schema could ask but not answer.
 *
 * `devices.orientation` and `pairing_codes.orientation` go. The WIRE keeps `device.orientation` —
 * derived in stateBuilder from the assigned screen, defaulting to landscape — so every shipped
 * Android build and every loaded board keeps locking its rotation exactly as it does today. This
 * is a change of ownership, not of behaviour, and nothing on a device has to be updated for it.
 */
export const SCHEMA_V15 = `
ALTER TABLE devices DROP COLUMN orientation;
ALTER TABLE pairing_codes DROP COLUMN orientation;
`

/**
 * v16 — the system bars are a property of the SCREEN (following the screen chrome model).
 *
 * The three-way mode shipped device-local: set by hand on each handset, in the app's own settings,
 * invisible to the hub. So "make the wall panel full-bleed" meant walking to the wall panel, and
 * nothing in the admin could tell you what any panel was doing.
 *
 * Same move orientation made in v15, and the same argument: a layout is authored FOR a presentation
 * and the device shows whatever layout it is pointed at. A board designed to bleed to the edges is
 * making a claim about itself, not about the glass it lands on.
 *
 * 'respected' is the default, which is what an unconfigured device already did — so every existing
 * screen keeps today's behaviour and nothing changes until somebody asks for it.
 */
export const SCHEMA_V16 = `
ALTER TABLE screens ADD COLUMN nav_bars TEXT NOT NULL DEFAULT 'respected'
  CHECK (nav_bars IN ('hidden','respected','on_tap'));
`

/**
 * v17 — the system bars move to the DEVICE, superseding v16.
 *
 * v16 put them on the screen, following orientation's move in v15. The difference between the two
 * only becomes obvious once both exist: orientation genuinely belongs to the layout, because a
 * layout is AUTHORED for a shape and will not fit the other one. Bar behaviour is not like that.
 * The same board is correct on a wall panel with no bars and on a handheld that still needs its
 * back gesture — so making it a screen property forced two devices sharing a screen to agree about
 * something they have no reason to agree about.
 *
 * `devices.nav_bars` defaults to `respected`, the value every screen carried at v16 and the value
 * an unconfigured device had before that, so nothing on any glass changes shape on this migration.
 * `screens.nav_bars` goes.
 */
export const SCHEMA_V17 = `
ALTER TABLE devices ADD COLUMN nav_bars TEXT NOT NULL DEFAULT 'respected'
  CHECK (nav_bars IN ('hidden','respected','on_tap'));
ALTER TABLE screens DROP COLUMN nav_bars;
`

/**
 * v18 — connectors: the hub fetches data for itself (hub collection, the feed inversion).
 *
 * Every feed so far has been PUSHED into: something outside the hub holds a sender token and posts.
 * That is the right primitive and it is not changing — but it means the kitchen-display persona
 * cannot get weather onto a wall without first writing a cron job, which is a wall they do not get
 * over. A connector is the hub polling a source on a timer and pushing the result in through the
 * ordinary feed path.
 *
 * A connector pushes into an ORDINARY feed. The feeds table gains nothing here, and every existing
 * mechanism — staleness alerting, the DATA wire shape, widget bindings, the screen editor's
 * preview — works on a connector-fed feed with no idea that it is one. That is the entire design:
 * the only new thing in the system is a row that says "re-fill this feed every N seconds".
 *
 * `feed_id` carries a real FK. A connector whose feed has been deleted has nothing to write to and
 * would fail forever on every pass, so the state is worth making unrepresentable rather than
 * defending against — and it forces `deleteFeed` to cascade in its own transaction (db/feeds.ts)
 * instead of leaving that to whoever remembers.
 *
 * `last_status` is 'ok' or the error text, deliberately in the ROW rather than only in the audit
 * log: a poll every 15 minutes would bury the log, and "is this thing working right now" is a
 * question about current state. Failures are audited as well, because those are events.
 *
 * `type` is NOT constrained to an enum here, for the same reason design ids and backdrops are not:
 * the set grows, the registry (src/connectors/registry.ts) is the authority, and a hub that has
 * stored a type its code no longer knows should show an unknown row an operator can delete — not
 * refuse to open its database.
 */
export const SCHEMA_V18 = `
CREATE TABLE connectors (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,
  feed_id     TEXT NOT NULL REFERENCES feeds(id),
  interval_s  INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT,
  created_at  INTEGER NOT NULL
);
`

/**
 * v19 — semantic source instances sit above feeds without replacing the feed persistence or DATA
 * wire boundary. The v18 connector table remains intact for migration diagnosis; migrateV19 owns
 * the append-only data copy into these tables.
 */
export const SCHEMA_V19 = `
CREATE TABLE source_instances (
  id                  TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL,
  package_id          TEXT NOT NULL,
  package_version     TEXT NOT NULL,
  name                TEXT NOT NULL,
  config              TEXT NOT NULL,
  strategy            TEXT NOT NULL DEFAULT 'scheduled',
  interval_s          INTEGER NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  state               TEXT NOT NULL DEFAULT 'healthy',
  next_run_at         INTEGER,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_run_at         INTEGER,
  last_success_at     INTEGER,
  last_status         TEXT,
  legacy_connector_id TEXT UNIQUE,
  last_used_at        INTEGER,
  rev                 INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_source_instances_due ON source_instances(enabled, next_run_at);

CREATE TABLE source_secrets (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES source_instances(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(source_id, name)
);

CREATE TABLE source_outputs (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES source_instances(id) ON DELETE CASCADE,
  contract_id   TEXT NOT NULL,
  feed_id       TEXT NOT NULL UNIQUE REFERENCES feeds(id),
  capabilities  TEXT NOT NULL DEFAULT '[]',
  content_hash  TEXT,
  last_valid_at INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE(source_id, contract_id)
);

CREATE TABLE source_drafts (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  package_id        TEXT NOT NULL,
  package_version   TEXT NOT NULL,
  name              TEXT NOT NULL,
  config            TEXT NOT NULL,
  strategy          TEXT NOT NULL DEFAULT 'scheduled',
  interval_s        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_source_drafts_expiry ON source_drafts(expires_at);

CREATE TABLE source_draft_secrets (
  id          TEXT PRIMARY KEY,
  draft_id    TEXT NOT NULL REFERENCES source_drafts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(draft_id, name)
);

CREATE TABLE source_draft_outputs (
  id            TEXT PRIMARY KEY,
  draft_id      TEXT NOT NULL REFERENCES source_drafts(id) ON DELETE CASCADE,
  contract_id   TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('value','stream')),
  result        TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(draft_id, contract_id)
);
`

/**
 * v20 — the retired v18 connector table goes, and its contents with it.
 *
 * v19 copied every connector into a source instance and moved its URL into the secret box, but it
 * is an append-only migration: it never rewrote the rows it read. That left a hub upgraded from
 * v18 holding each migrated source's credential twice — once encrypted, and once in plaintext in
 * `connectors.config`, which is where it had always been. Nothing has read that table since the
 * connector runtime was deleted, so the only thing it still did was keep a copy of a secret.
 *
 * DROP rather than a scrub of the config column: a table nothing reads is not used by the runtime, it is a
 * liability with a comment attached. `source_instances.legacy_connector_id` still records which
 * connector each source came from, so the migration trail survives the table that produced it.
 */
export const SCHEMA_V20 = `
DROP TABLE IF EXISTS connectors;
`

/**
 * v23 — agent tokens.
 *
 * A named Bearer credential granting what the admin password grants, for an operator's AI
 * assistant. Modelled on senders: stored hashed, shown once, last_used_at tracked. Revocation is
 * SOFT (revoked_at, not DELETE): audit_log.actor_id will carry these ids, and deleting the row
 * would turn "which agent deleted that screen?" back into an unanswerable question — the exact
 * question this table exists to answer. A revoked row authenticates nothing (requireAdmin checks
 * revoked_at) and exists only as the name behind old audit entries.
 */
export const SCHEMA_V23 = `
CREATE TABLE agent_tokens (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
`

/**
 * v24 (tabs): ordered per-device screen list. Additive — devices.screen_id remains until
 * v25 so the migration can dual-write both representations; assignScreen dual-writes both.
 */
export const SCHEMA_V24 = `
CREATE TABLE device_screens (
  device_id TEXT NOT NULL REFERENCES devices(id),
  screen_id TEXT NOT NULL REFERENCES screens(id),
  position  INTEGER NOT NULL,
  label     TEXT,
  PRIMARY KEY (device_id, position),
  UNIQUE (device_id, screen_id)
);
-- The extra AND guards a dangling devices.screen_id (a screen deleted out from under an
-- assignment, pre-tabs, left no FK to enforce it): foreign_keys = ON means an INSERT naming a
-- screen that no longer exists throws and aborts this migration on boot rather than skip that one
-- row (dangling assignment guard) — the existence check prevents a stale assignment from aborting this migration.
INSERT INTO device_screens (device_id, screen_id, position, label)
  SELECT id, screen_id, 0, NULL FROM devices WHERE screen_id IS NOT NULL AND screen_id IN (SELECT id FROM screens);
`

/**
 * v25 (tabs): the dual-write window closes. `device_screens` (v24) has been the
 * complete copy of every assignment since the migration above ran, and every write path
 * (`setDeviceTabs`/`assignScreen`) has kept it current since the join table was introduced — so `devices.screen_id` is a
 * second copy of data the join table already owns, not a second source of it.
 *
 * DROP COLUMN on this FK child column (which references `screens(id)`) is covered by
 * `deviceTabs.test.ts` against a populated column, not just an empty one.
 */
export const SCHEMA_V25 = `
ALTER TABLE devices DROP COLUMN screen_id;
`

/**
 * v26 (storage & retention): a generic admin-editable key/value settings table. Its first
 * consumer is the two retention windows — `retention_alerts_days` / `retention_audit_days` — that
 * were env-only until now (`config.ts`'s `RETENTION_ALERTS_DAYS` / `RETENTION_AUDIT_DAYS`); a row
 * here, when present, outranks the env value (precedence: setting → env → built-in default — see
 * `db/retentionSettings.ts`). `value` is always TEXT: each caller (`db/settings.ts`'s accessors
 * plus whatever reads a given key) parses and validates its own key's shape, so a future setting
 * of a different type needs no schema change, only a new key.
 */
export const SCHEMA_V26 = `
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`

/**
 * v27 (alert sounds, alert-sound contract): sparse event→family maps. '{}' resolves to the `classic` family
 * everywhere (hub/src/sounds.ts), which is the programmatic tone path — so this migration
 * changes nothing a device plays. Curated builtin mappings are seeded by migrateV27 on FRESH
 * installs only (fromVersion === 0); an upgrade never changes what a room sounds like.
 */
export const SCHEMA_V27 = `
ALTER TABLE themes ADD COLUMN sounds TEXT NOT NULL DEFAULT '{}';
ALTER TABLE screens ADD COLUMN sounds TEXT NOT NULL DEFAULT '{}';
`
