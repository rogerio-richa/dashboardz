# Dashboardz

Dashboardz turns old phones, tablets, and spare screens into notification
displays for AI agents (Claude Code, Claude Cowork, OpenClaw, Hermes) and
systems (Netdata, Uptime Kuma, Meshtastic, email, any webhook). It shows the
alert, wakes the screen, and makes noise if it's important — like a printer,
but for questions and alerts.

**In:** a notification (`POST /api/notify`). **On screen:** display, wake,
sound. **Out:** the human noticed it.

Why not just ping a chat app? Chat pings drown in noise and die under Do Not
Disturb. Dashboardz's promises: one attention queue for every agent and
system, alerts never leave your network (unless you opt into a relay), it
will actually wake you, and it fails loudly — a device that loses the hub
shows OFFLINE, never silence.

This repository contains the **hub** — the single server that receives
alerts and pushes them to every paired device — plus the Android device app
(`apps/android/`), the reference sender client and CLI (`clients/sender/`),
the MCP server for AI agents (`clients/mcp/`), the relay (`relay/`), and a
Meshtastic integration (`integrations/meshtastic/`). See [License](#license)
for the repository-wide default and the component exceptions.

## Requirements

- **Docker**, for running the hub as a container (recommended — see Quick
  start below).
- **Node.js >= 22**, only if you want to run the hub from source instead of
  Docker. A `.nvmrc` is provided (`nvm use`).

New to Dashboardz? Start with the [five-minute getting started
guide](docs/getting-started.md). Contributors should read the
[development map](docs/development.md) before changing a component.

## Quick start (Docker Compose)

1. Copy both example files:

   ```bash
   cp .env.example .env
   cp docker-compose.example.yml docker-compose.yml
   ```

   Edit `.env`: set `ADMIN_PASSWORD` to a real password and `PUBLIC_URL` to the
   LAN address other devices will reach the hub at (used in the pairing QR code
   shown to devices — see below).

2. Start it:

   ```bash
   docker compose up -d
   ```

3. Open `http://<host>:8484/admin` and log in with `ADMIN_PASSWORD`. Add a
   device in the **Devices** tab and pair it at `http://<host>:8484/device`.

4. Verify the hub is healthy:

   ```bash
   curl http://<host>:8484/api/health
   ```

   A healthy hub returns `{"ok":true,"name":"Dashboardz"}`.

Alerts and the device registry live in the `./data` volume (SQLite), so the
container can be recreated freely without losing state.

## Pairing a browser device

Any browser can act as a device — no install needed (Pi + monitor, an old
laptop, a tablet propped on a shelf all work).

1. In the admin UI (`/admin`), open the **Devices** tab and add a device by
   name. This shows a 6-character pairing code and a QR code, valid for 10
   minutes.
2. On the device you want to pair, open `http://<host>:8484/device` and
   type the pairing code in. (Scanning the QR code is what the Android app
   does — it encodes the hub's `PUBLIC_URL` and the code; the browser page
   takes the code by hand.)
3. Once paired, the device shows its starter screen — a full-screen clock
   the hub created for it (see [Your first dashboard](#your-first-dashboard)
   below). On a critical alert, it takes over the full screen and sounds an
   alarm until dismissed.

**Be honest about one browser quirk:** browsers block audio from playing
until a page has been interacted with. After a cold browser start (fresh
tab, reboot, kiosk restart), the alarm sound stays muted until you tap the
screen once — after that first tap, alarms play normally for the rest of
the session. Give the screen one tap right after pairing (or after any
browser/device restart) so it's ready before the first real alert.

## Your first dashboard

A notification display is the pitch, but a paired device is a full
dashboard: screens are grids of widgets — clocks, weather, calendars, news,
gauges, charts, scrolling lists, tables, images — composed in the admin and
pushed to the device live.

Pairing already created your first screen: a full-screen clock named after
the device. In the admin's **Screens** tab, hit **Edit** on it — it will
offer to add weather and a calendar (each asks where its data should come
from: weather wants your location, a calendar wants an ICS URL — no API
keys needed), and **Add widget** opens the full gallery. Saves push to the
device immediately.

Screens are themeable (the **Themes** tab ships five built-ins, and a theme
is data you can edit), a device can hold several screens as tabs, and
widgets that show your own numbers bind to data feeds you push with a curl
line. The [docs site](https://www.scztech.com.br/dashboardz/docs/) covers
all of it — start with the
[integration gallery](https://www.scztech.com.br/dashboardz/docs/gallery/)
to see what walls actually run.

## Sending notifications

Create a sender token in the admin UI (**Senders** tab), then:

```bash
curl -X POST http://hub:8484/api/notify \
  -H "Authorization: Bearer dbz_s_..." -H "content-type: application/json" \
  -d '{"title": "Backup finished", "severity": "info"}'

curl -X POST http://hub:8484/api/notify \
  -H "Authorization: Bearer dbz_s_..." -H "content-type: application/json" \
  -d '{"title": "RAID degraded!", "body": "sda failed on nas01", "severity": "critical", "dedup_key": "raid-nas01"}'
```

`severity` is one of `info`, `warn`, `critical`. Omit `devices` to fall back
to the sender's configured default devices, or pass an explicit array of
device IDs. `dedup_key` collapses repeated alerts from the same sender into
one updated card instead of a new one each time (e.g. a recurring health
check).

**Senders and the relay.** When you create a sender the hub also stores a key
derived from that sender's token, which is what lets it decrypt messages that
arrive over an optional relay (configured in the admin UI — see below). The
token itself is
still never stored — only its hash and this derived key, and the derived key
is not usable as an `Authorization: Bearer` credential. Be aware of the
trade-off: a hub database now contains material that can decrypt relayed
payloads for its senders. Two consequences worth knowing:

- Senders created before this was added have no such key, so they cannot send
  through a relay. Create a new sender if you need one to.
- A relay can never read your alerts, but it does see which hub a message is
  for, how big it is, and when it arrives. "Cannot read content" is not
  "learns nothing".

For the plain-language tour — when a relay is worth it, and exactly what one
can and cannot see — read the [Remote access
guide](https://www.scztech.com.br/dashboardz/docs/remote-access/).

A remote sender needs three things to connect: the relay URL, the hub's uid on
that relay, and a sender token. Configure the relay from the admin UI — the
relay badge in the masthead opens a dialog with a **Relay URL** field,
**Test**, and **Save** — and once connected, the same dialog shows the hub's
uid with a **Copy** button (the hub also logs `relay: connecting as
hub_...`); the token comes from the admin UI as usual. `clients/sender/`
provides a reference client and the `dbz-send` CLI that take exactly those
three values; `relay/README.md` covers running a relay itself.

The same CLI also pushes data feeds — small values or streams that widgets on
the wall display bind to — over the relay: `dbz-send data <feed-id> --relay
... --hub ... --token ... --json '{"cpu": 42.1}'`. Exit codes: `0` pushed,
`1` send failed, `2` bad usage (`3` doesn't apply — no `--wait` for a data
push). Image feeds can't be pushed this way: sealed-JSON envelopes are the
wrong vehicle for binary data, so the hub rejects it — that stays a LAN-only
push, over `/api/feeds/:id`.

## Environment variables

| Variable         | Required | Default                    | Meaning                                                                 |
| ---------------- | -------- | --------------------------- | ------------------------------------------------------------------------ |
| `ADMIN_PASSWORD` | yes      | —                            | Password for the `/admin` UI.                                            |
| `PORT`           | no       | `8484`                       | Port the hub listens on.                                                 |
| `DATA_DIR`       | no       | `./data` (`/data` in Docker) | Directory holding `hub.db` (SQLite). Mount this as a volume in Docker.    |
| `PUBLIC_URL`     | no       | `http://localhost:<PORT>`   | LAN URL the hub tells devices to use — encoded into pairing QR codes. Must be a full `http://` or `https://` URL; the hub refuses to boot on a malformed value rather than mint QR codes that point nowhere. |
| `RELAY_URL`      | no       | unset                        | Legacy one-time import only: configure the relay in the admin instead (masthead relay badge → **Relay URL**, **Test**, **Save**). If set and the hub's database has no relay setting yet, it's imported into the database on first boot and the env var is ignored from then on — remove it from your environment at your leisure. A set-but-malformed value still fails the hub at startup rather than retrying silently. |
| `DASHBOARDZ_MASTER_KEY` | no | `${DATA_DIR}/master.key` | Base64 of exactly 32 bytes, used to encrypt data-source credentials at rest. Unset means the hub reads — or, on a hub with no secrets yet, creates — a key file under `DATA_DIR` at `0600`. If secrets already exist and no key can be found, the hub refuses to start rather than generating a replacement that would make every stored secret undecryptable. |
| `RETENTION_ALERTS_DAYS` | no | `90` | Days concluded alerts are kept before the retention sweep removes them. Overridable per hub in the admin **Storage** page (the settings value takes precedence over the env var). |
| `RETENTION_AUDIT_DAYS` | no | `180` | Days audit-log rows are kept before the retention sweep removes them. Same admin-settings precedence as above. |

### Backing up a hub with data sources

Source credentials (an authenticated feed URL, a provider token) are encrypted
with the master key, and the key is deliberately not in the database. **A
backup needs `hub.db` and the key together** — restoring the database on its
own leaves every stored secret unrecoverable, and there is no way to recover
them afterwards. Take both, keep them together, and treat the key with the
same care as the database.

## Reverse proxy / TLS

The hub speaks plain HTTP. Use that mode only on a trusted LAN or private
VPN. If any connection crosses an untrusted or public network, HTTPS through
a reverse proxy such as Caddy, nginx, or Traefik is required; the hub itself
does not terminate TLS. Firewall the raw hub port (8484 by default) so it is
not internet-reachable. The proxy must forward WebSocket upgrades
(`Connection: upgrade`, `Upgrade: websocket`) on `/ws/device`, and
`PUBLIC_URL` must be the proxy's `https://` URL so pairing QR codes point
somewhere devices can actually reach. The hub has no built-in login
throttling, so an internet-facing proxy must rate-limit `/admin/api/login`.

## Building the image yourself

```bash
cd hub && docker build -t dashboardz-hub .
```

For a local, non-publishing multi-arch OCI archive (e.g. amd64 + arm64 for a
Raspberry Pi):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t dashboardz-hub \
  --output type=oci,dest=/tmp/dashboardz-hub.oci ./hub
```

## Android device app

`apps/android/` is the Kotlin/Compose kiosk app: pairs by QR or code, keeps a WebSocket open
through a foreground service, and wakes the device with an alarm-grade full-screen takeover
for critical alerts. Requires Android 6.0+ and no Play Services. See
[apps/android/README.md](apps/android/README.md) to build and pair it.

## License

The repository default is **GNU Affero General Public License v3.0
(AGPL-3.0)**, covering the root project, hub (including `hub/admin`), relay,
and every component without its own license file. See the root
[`LICENSE`](LICENSE), [`hub/LICENSE`](hub/LICENSE), and [`relay/LICENSE`](relay/LICENSE).

The explicit **MIT** exceptions are [`clients/sender`](clients/sender),
[`clients/mcp`](clients/mcp), [`integrations/claude/assistant`](integrations/claude/assistant),
and [`apps/android`](apps/android); each has its own local `LICENSE` file.

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
