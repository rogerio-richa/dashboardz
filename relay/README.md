# Dashboardz relay

A WebSocket switchboard that lets a sender with **no route to a hub** deliver
notifications and receive the human's answer back. Both the hub and the sender
dial **out** to the relay; the relay routes frames between them by hub uid.
Nobody needs an inbound port open — hub behind NAT, sender behind NAT, relay on
a public address in the middle.

The relay is transport, not a hub. It holds no alert lifecycle, no rules, no
audit log, no configuration about anyone. The hub remains the sole authority:
it validates the sender's credentials inside the encrypted payload and rejects
what it does not like.

## What it deliberately cannot do

- **Read payloads.** Every payload that crosses the relay is sealed end-to-end
  between sender and hub with a key derived from the sender token
  (HKDF-SHA256, then authenticated encryption). The relay forwards the
  ciphertext verbatim — it never parses it, and it runs with logging disabled
  so it cannot leak it by accident either. The end-to-end test asserts that no
  title, body, or answer text ever appears on the relay process's output.
- **Store anything.** No database, no disk, no queue. The routing tables
  (`hub_uid → socket`, `conn_id → socket`) live purely in memory and are
  dropped on disconnect. If the target hub is not connected when a sender
  sends, the sender gets an immediate `hub_offline` error — the relay never
  buffers, because a silent buffer is worse than a loud failure.
- **Survive as an authority.** Hub registration is trust-on-first-use: the
  first connection to claim a `hub_uid` fixes its secret, and later
  connections must match. There are no accounts and no admin. Set `STATE_PATH`
  and those bindings persist across restarts (pruned after 90 idle days), so
  the impostor window shrinks to genuine first contact — which 128-bit random
  uids already defend. Without `STATE_PATH` the registry is in-memory and the
  old **TOFU reset limitation** applies: a restart wipes it and the uid
  re-keys to the first claimant after the restart. Someone who has learned a
  `hub_uid` and wins that race owns the routing slot: the real hub is refused
  (a terminal bad-secret close, logged as an error, reported as the relay
  state on its admin API, not retried — loud, not silent), and senders'
  messages route to the impostor. Either way an impostor cannot read or forge
  alerts — it holds no sender keys, so everything it receives is ciphertext it
  cannot open and it cannot produce a reply that authenticates — the damage is
  denial of delivery.

## What the relay still sees

"Cannot read content" is not "learns nothing". The relay necessarily sees
**which hub** a message is for (`hub_uid`), the **size** of each encrypted
payload, and the **timing and frequency** of traffic. Anyone who learns a
`hub_uid` can also push ciphertext at that hub — the hub rejects what does not
authenticate, but it costs a round trip; per-hub rate limiting at the relay
bounds the abuse. Choose where you run a relay with that metadata exposure in
mind.

## Running it

With Docker Compose:

```bash
cp docker-compose.example.yml docker-compose.yml   # edit as needed
docker compose up -d
```

Or from source (Node.js >= 22):

```bash
npm ci
npm run build && node dist/index.js    # or: npm run dev
```

The WebSocket endpoint is `/ws`; `GET /health` answers
`{ "ok": true, "service": "dashboardz-relay" }` for liveness checks. With
`STATE_PATH` set, the one file worth backing up is that state file (hub
registrations); everything else is live connections, which hubs re-establish
on their own (senders are expected to redial).

### Environment variables

| Variable      | Required | Default | Meaning                                                                                                     |
| ------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `PORT`        | no       | `8790`  | Port to listen on. Strictly a non-negative integer; a set-but-malformed value fails startup loudly.          |
| `TRUST_PROXY` | no       | `false` | Set to `true` **only** when a reverse proxy sits in front of the relay. Strictly `"true"` or `"false"`.      |
| `STATE_PATH`  | no       | unset   | File where hub registrations persist (e.g. `/data/relay-state.json`). Unset = in-memory: bindings reset on restart (the TOFU reset limitation above). Bindings idle for 90 days are pruned. |

## TLS and reverse proxies

The relay process speaks plain HTTP/WebSocket. For any real deployment, put a
TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front so every party
connects over `wss://`, and make sure the proxy forwards WebSocket upgrades on
`/ws`.

When — and only when — such a proxy is in front, set `TRUST_PROXY=true`. It
controls whether the relay reads the client address from `X-Forwarded-For`,
which keys the hub-registration rate limiter. Both misconfigurations fail
silently, which is why the default is the safe `false`:

- `TRUST_PROXY=true` with no real proxy: any client can spoof
  `X-Forwarded-For` and sidestep the per-address limiter.
- `TRUST_PROXY=false` behind a proxy: every client appears as the proxy's
  address and collapses into one shared rate-limit bucket.

## Pointing a hub and senders at it

Configure a hub to use this relay from its own admin UI: open the relay
badge in the masthead, paste the relay's WebSocket address
(`wss://relay.example/ws`) into **Relay URL**, click **Test**, then
**Save**. (A hub's `RELAY_URL` env var still works as a one-time legacy
import on its first boot after an upgrade — see the Upgrading note on the
[deployment docs](../docs/deployment.md#upgrading) — but the admin is the
normal path now.) Once connected, the hub logs its relay address:

```
relay: connecting as hub_...
```

That `hub_...` uid, together with the relay URL and a sender token issued by
that hub's admin UI, is the full connection string a remote sender needs —
e.g. with the reference client in `clients/sender`:

```bash
dbz-send --relay wss://relay.example/ws --hub hub_... --token dbz_s_... \
         --title "Disk 97%" --severity warn
```

## License

GNU AGPL-3.0, same as the hub — see [`LICENSE`](LICENSE).
