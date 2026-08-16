# Hub

The hub is a single Node.js process (v22 or newer) that speaks HTTP, holds a
WebSocket open to every paired device, and stores everything in a local
SQLite database. It runs as the Docker image built from this repository, or
directly from source — there is no second service, queue, or database to
stand up alongside it.

## HTTP surface

The main route senders use is `POST /api/notify`, authenticated with a
sender token as a Bearer credential:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes\* | The headline shown on the card. Not required when `resolve` is `true`. |
| `severity` | yes\* | One of `info`, `warn`, `critical`. Not required when `resolve` is `true`. |
| `body` | no | Optional detail text under the title. |
| `devices` | no | An explicit list of target device IDs. Omit it and the alert goes to the sender's configured default devices instead. |
| `sound` | no | Whether the alert should make noise. `warn` and `critical` default to on; pass `false` to silence one. `info` is never audible — the hub ignores `sound: true` on it. |
| `ttl_s` | no | Seconds until the alert expires on its own. |
| `dedup_key` | no | Collapses repeats from the same sender into one updated card instead of a new one each time. Required when `resolve` is `true`. |
| `options` | no | Up to four buttons, each `{id, label}`. A tap on one becomes an answer — see the [overview](overview.md) for how that travels back to the sender. |
| `resolve` | no | `true` retracts the sender's active alert for `dedup_key` instead of creating one, so an external condition that clears on its own (a netdata alarm, say) doesn't have to wait out `ttl_s` — see [senders](senders.md#resolving-instead-of-creating). |

Two other groups of routes sit alongside `/api/notify`:

- **`/admin`** — the admin UI and the admin API behind it (creating
  senders and devices, clearing alerts that are still ringing, reading the
  audit log, checking relay status). Access is a password check against
  `ADMIN_PASSWORD`, then a session cookie for everything after.
- **Pairing** — `POST /api/pair` is what the QR-code-or-6-character-code
  flow on a device actually calls to redeem a code for a device token; the
  admin API is what generates that code in the first place.

`GET /api/health` is deliberately separate from all of this: it takes no
auth and returns nothing but `{ok, name}`. That's on purpose, not an
oversight — an unauthenticated route that also reported which devices were
online or offline would hand topology information to anyone who could
reach the port. Anything that needs per-device status has to go through an
authenticated route instead.

The hub serves plain HTTP only. Use plain HTTP on a trusted LAN or private VPN;
if any connection crosses an untrusted or public network, HTTPS through a
reverse proxy is required. Firewall the raw hub port so it is not
internet-reachable, proxy WebSocket upgrades (`Connection: upgrade`,
`Upgrade: websocket`) on `/ws/device`, and set `PUBLIC_URL` to the proxy's
`https://` URL. The hub has no built-in login throttling, so an internet-facing
proxy must rate-limit `/admin/api/login`.

## Push, not poll

Once a device is paired, it keeps a WebSocket open to the hub and the hub
pushes full state down it — a fresh snapshot on connect, then an update
for every add, removal, or change after that. The device holds no logic
of its own about what should currently be showing; it renders whatever
the hub last pushed (see the overview's note on [devices being
stateless](overview.md)).

Only one device may hold a given device's token at a time. If a second
device pairs with (or reconnects using) the same device, the hub closes
the first connection rather than serving both — a device token is a
single seat, not a broadcast group.

## Storage

Everything lives in a SQLite database file under `DATA_DIR`: alerts,
paired devices, senders, the screens devices render, and the data sources
that keep those screens fed. For senders, the hub stores a hash of the
token, never the token itself — and, for senders capable of using the
relay, a key derived from that token (`relay_key`), which is what lets the
hub decrypt envelopes that arrive over the relay without ever having kept
the raw token around. If the hub has a relay connection at all, its own
relay identity is persisted here too, so it reconnects as the same hub
across restarts.

Alerts don't just accumulate forever: a background sweep runs on an
interval and expires anything past its `ttl_s`, removing it from every
device it was pushed to.

### Retention

Some growth is already bounded by design and needs no sweep: a stream feed
is pruned to its `cap` on every push (`pushStreamRow`), and a value feed
simply overwrites the row it had. What isn't bounded is history that
accumulates one row per event forever — concluded alerts (and the
deliveries recorded against them) and the audit log, which now grows
continuously with the hub ingesting from production servers around the
clock.

The same background sweep that expires alerts also runs a retention pass,
gated to once an hour rather than every 15-second tick. Each pass, in one
transaction:

- deletes deliveries and then alerts for anything **not** `active` (an
  alert the sweep expired, or one every target device dismissed) once it's
  older than `RETENTION_ALERTS_DAYS` (default **90**). An alert that is
  still `active`, however old, is never touched — it hasn't concluded yet.
- deletes audit log rows older than `RETENTION_AUDIT_DAYS` (default
  **180**), on its own cutoff and its own clock.

Either knob set to `0` means "keep forever" — the escape hatch for a hub
whose operator wants full history and has the disk for it. A pass that
deletes anything writes one audit row of its own (`retention_swept`, with
the counts) — which is, by construction, itself subject to the audit
cutoff on a later pass. A failed retention pass only logs a warning; it
never blocks or delays the TTL expiry sweep it rides alongside.

Both knobs no longer live in the environment alone. The admin console's
Storage tab (`GET /admin/api/storage`, `PATCH /admin/api/retention`) can
edit them directly, stored as rows in a small generic `settings` table
that outranks the environment variable, which in turn outranks the
built-in default — a settings row beats `RETENTION_ALERTS_DAYS` /
`RETENTION_AUDIT_DAYS`, which beat 90/180. The retention pass re-reads
this precedence chain fresh on every hourly run rather than once at boot,
so a value saved in the admin console takes effect on the very next pass
with no restart. The storage endpoint reports which layer is currently in
force for each knob — `setting`, `env`, or `default` — so an operator who
has never touched a value can tell "inherited from the environment" apart
from "just the shipped default" before they ever save anything.

The same Storage tab sizes what the retention pass actually shrinks:
concluded alerts (and their deliveries), active alerts, the audit log,
feed rows, and feed value payloads, each in MB, alongside the sqlite
file's own size and the on-disk image bytes `feedImage.ts` writes outside
it — enough to inform the two knobs above without a shell on the host.
Byte counts prefer SQLite's `dbstat` virtual table where the build
supports it (probed with a try/catch, since it's a compile-time SQLite
extension, not a guarantee); a pool that is a row subset of a table
shared with other pools — concluded vs. active alerts, feed value
payloads living inside the wider `feeds` table — falls back to a
`LENGTH()`-based estimate instead, because `dbstat` accounts for whole
tables, not predicates. The API marks those pools `approx: true` rather
than presenting a rounding as if it were exact. An operator can also
force one pass immediately (`POST /admin/api/retention/sweep`), without
waiting on the hourly gate — useful right after tightening a window, to
see its effect at once instead of up to an hour later.

Source credentials are the one thing not readable from the database alone:
they are encrypted with a master key held outside it. A restore therefore
needs both the database file and the key — see
[data sources](data.md#secrets-and-the-master-key).

## Collecting data on a schedule

Alongside the request-driven routes, the hub runs a scheduler that polls
configured data sources on their own intervals and writes the results into
feeds, pushing to devices on every write. A screen showing a forecast is
not asking anyone for it; the hub fetched it on a timer and pushed it down
the same socket it pushes alerts down. The [data sources](data.md) page
covers how a widget's needs and a provider's abilities get matched up.

## The relay client

The relay is configured in the admin UI — the relay badge in the masthead
opens a dialog with a **Relay URL** field, **Test**, and **Save**. With no
relay configured (the default), the hub behaves exactly like a pure-LAN
install — the relay is strictly opt-in, never something you have to reason
about if you never configure it. The URL lives in the hub's own settings
table, not the environment; `RELAY_URL` is consulted only as a **legacy
one-time import** on first boot after an upgrade (see
[Configuration](#configuration) below).

When a relay is configured, the hub dials out to it, registering its own
identity (`hub_uid`). The uid is printed to the hub's logs — `relay:
connecting as hub_...` — and shown in the same admin dialog with a **Copy**
button, which is what a remote sender's operator needs, alongside the
relay URL and a sender token, to reach this hub. If the connection drops,
the client reconnects on its own with a backoff; current relay state
(connected, connecting, or off) is visible through the admin API.

One outcome is not retried: if the relay rejects this hub's registration
because its identity doesn't match the secret the relay has on file, that
is treated as terminal, not a transient hiccup. The hub logs it loudly and
stops trying, rather than hammering the relay with an identity it knows
is wrong.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | yes | — | Password for the `/admin` UI. |
| `PORT` | no | `8484` | Port the hub listens on. |
| `DATA_DIR` | no | `./data` (`/data` in Docker) | Directory holding `hub.db` (SQLite). Mount this as a volume in Docker. |
| `PUBLIC_URL` | no | `http://localhost:<PORT>` | The URL the hub tells devices to use — encoded into pairing QR codes. |
| `RELAY_URL` | no | unset | legacy one-time import only — configure the relay in the admin UI instead (relay badge → **Relay URL**, **Test**, **Save**). If set and the database has no relay setting yet, the hub imports it on first boot and logs that it did; the env var is ignored from then on. A value that's set but doesn't parse as a valid `ws(s)://` URL still fails the hub at startup. |
| `DASHBOARDZ_MASTER_KEY` | no | `${DATA_DIR}/master.key` | Base64 of exactly 32 bytes, used to encrypt data-source credentials. Unset means the hub reads (or creates) a key file under `DATA_DIR` at `0600` instead. If secrets already exist and no key can be found, the hub refuses to start rather than generating a replacement that would make them undecryptable. |

The hub itself speaks plain HTTP and terminates no TLS. Use plain HTTP only on
a trusted LAN or private VPN. If any connection crosses an untrusted or
public network, HTTPS through a reverse proxy (Caddy, nginx, Traefik, whatever
you already run) is required. Firewall the raw hub port so it is not
internet-reachable, forward WebSocket upgrades (`Connection: upgrade`,
`Upgrade: websocket`) to `/ws/device`, and set `PUBLIC_URL` to the proxy's
`https://` address so pairing QR codes point somewhere a device can actually
reach. The hub has no built-in login throttling; an internet-facing proxy must
rate-limit `/admin/api/login`.
