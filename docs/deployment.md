# Deployment

There are two things you can deploy: the hub itself, and — only if you need
it — a relay. Most installs never touch the second one.

## Self-hosting the hub

### Docker Compose (recommended)

1. Copy both example files:

   ```bash
   cp .env.example .env
   cp docker-compose.example.yml docker-compose.yml
   ```

   Edit `.env`: set `ADMIN_PASSWORD` to a real password and `PUBLIC_URL` to the
   address other devices will reach the hub at, e.g. `http://<host>:8484` — this
   is what gets encoded into the pairing QR code shown to devices.

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

Alerts and the device registry live in the `./data` volume (SQLite), so the
container can be recreated freely without losing state.

!!! danger "Never point host `sqlite3` at the database while the hub is running"
    Not even for a `SELECT`. This has already cost a silently lost write.

    SQLite's file locks do not cross a bind mount into the container's
    filesystem view — notably Docker Desktop's virtiofs on macOS. A host
    `sqlite3` process therefore cannot see the hub's connection, concludes it is
    the only one, and **on exit checkpoints and unlinks `hub.db-wal` and
    `hub.db-shm`**. The running hub is then holding deleted inodes: its writes
    are visible to nobody else — the admin API and a host query will disagree
    about the same row, at the same instant — and if the process exits without
    closing the database, those writes are freed with the inode. That is how a
    device's screen assignment vanished.

    Read it through the container instead:

    ```bash
    scripts/hub-sql.sh "SELECT id, screen_id FROM devices;"
    ```

    That runs the query inside the container, read-only, taking no lock the hub
    cares about and creating no journal of its own. It refuses politely when the
    container is not running — with no live writer, a direct host read is fine.

    The hub also checkpoints and closes cleanly on `SIGTERM`/`SIGINT`, so
    `docker compose stop` leaves no `-wal` behind. That is defence in depth, not
    the cure: nothing in SQLite can defend against another process deleting its
    files.

The database does not grow forever: a retention sweep ages out concluded
alerts (90 days by default) and audit rows (180 days by default). Both
windows are adjustable in the admin **Storage** page, which also shows what
is using the space; `RETENTION_ALERTS_DAYS` / `RETENTION_AUDIT_DAYS` set the
defaults from the environment, and a value saved in the admin takes
precedence over the env var. Active alerts are never swept, whatever their
age.

### From source

You need Node.js >= 22 instead of Docker (a `.nvmrc` is provided —
`nvm use`). Everything else about the hub — the routes it serves, the data
it stores — is identical either way; see [the hub](architecture/hub.md) for
what it actually does once it's running.

### Resetting the admin password

The hub cannot recover or email the existing password. Its admin password is
the `ADMIN_PASSWORD` value supplied when the process starts, so resetting it
means changing that value and restarting the hub:

- **Docker Compose:** edit `ADMIN_PASSWORD` in `.env` or your Compose file,
  then run `docker compose up -d hub`. Compose recreates the hub with the new
  environment; `docker compose restart hub` alone keeps the old value.
- **From source:** stop the hub, set `ADMIN_PASSWORD` to the new value in the
  environment that launches it, then start it again.

The restart invalidates existing admin sessions. Sign in at `/admin` with the
new password.

### Reverse proxy / TLS

The hub speaks plain HTTP and does not terminate TLS itself. Plain HTTP is for
a trusted LAN or private VPN only. If any connection crosses an untrusted or
public network, HTTPS through a reverse proxy — Caddy, nginx, or Traefik — is
required. Firewall the raw hub port (8484 by default) so it is not
internet-reachable. Two things have to be right for pairing to keep working:

- The proxy must forward WebSocket upgrades (`Connection: upgrade`,
  `Upgrade: websocket`) on `/ws/device` — devices hold that
  connection open for as long as they're paired.
- `PUBLIC_URL` must point at the proxy's externally reachable URL, not the
  hub directly, so pairing QR codes send devices somewhere they can actually
  reach. For a public or otherwise untrusted network, this must be the
  proxy's `https://` URL.

The proxy must rate-limit `/admin/api/login`: the hub has no built-in login
throttling.

## Enabling the relay

By default the hub calls out to nothing. Leave the relay unconfigured and
you get pure-LAN behavior, guaranteed — every sender, every device, and
every alert stays inside your own network (see the [security
model](architecture/security.md) for exactly what that default posture
means).

To let a sender with no route to your hub reach it anyway, open the relay
badge in the admin masthead, paste a relay's WebSocket address
(`wss://...`) into **Relay URL**, click **Test**, then **Save**. If the
relay requires an account token — the hosted relay does, see below — paste
it into **Relay token** first; a missing, wrong, or revoked token closes
the connection with code 4403 instead of connecting. Once connected, the
same dialog shows your hub's uid with a **Copy** button — the hub also logs
it:

```
relay: connecting as hub_...
```

That uid, together with the relay URL and a sender token issued from the
admin UI, is everything a remote sender needs to connect — see
[senders](architecture/senders.md) for how the token is issued and used.

**Senders created before relay support existed have no key to use it.**
The relay key is derived from the sender's token at creation time, so
there's nothing to derive it from after the fact for a sender that already
existed. Create a fresh sender if you need one to go over the relay.

### Upgrading

Hubs from before this version configured the relay with the legacy `RELAY_URL`
env var — that still works, but only as a one-time import.

On first boot after upgrading, if the legacy `RELAY_URL` env var is set and
the database has no relay setting yet, the hub imports it and logs
`relay: imported RELAY_URL into settings; the env var is now ignored`.

From then on it's ignored — the relay badge is the only way to change the
URL — and a leftover legacy `RELAY_URL` in your compose file or `.env` just
draws a harmless warning on every boot. Remove it at your leisure.

## Choosing a relay

A relay is a plain WebSocket switchboard — it never sees anything but
ciphertext, timing, size, and which hub each frame is for. See [the relay](architecture/relay.md) and the
[security model](architecture/security.md) for exactly what an operator can
and cannot see before picking one.

- **Use the hosted relay.** SCz Tech runs one at
  `wss://relay.scztech.com.br/ws` — free to use, no infrastructure of your
  own to run. It requires an account token: sign in with Google at
  `https://dashboardz.scztech.com.br`, mint a token, then paste the relay's
  address into the relay badge's **Relay URL** field and the token into
  **Relay token**, click **Test**, then **Save**. Revoke a token from the
  same page whenever you want to free it up for use elsewhere — revocation
  takes effect the next time your hub reconnects. A missing, wrong, or
  revoked token closes the connection with code 4403 and a plain error
  naming the fix, rather than retrying forever.
- **Run your own.** The relay ships as a container, so you can put it on
  any public address you control:

  ```bash
  cd relay
  cp docker-compose.example.yml docker-compose.yml   # edit as needed
  docker compose up -d
  ```

  A few things to know before you do:

  - It listens on `PORT` (default `8790`).
  - Set `TRUST_PROXY=true` only when a reverse proxy actually sits in front
    of it — otherwise a client can spoof its own rate-limit bucket. Leave
    it `false` (the default) if there's no proxy.
  - The relay speaks plain HTTP/WebSocket; TLS is the proxy's job, same as
    the hub — terminate `wss://` at the proxy, forward `/ws` upgrades
    through it.
  - `GET /health` answers `{ "ok": true, "service": "dashboardz-relay" }` for
    liveness checks.
  - There's no state to back up. A restart drops only live connections —
    hubs and senders both reconnect on their own.
