# Relay server

[`relay/`](https://github.com/rogerio-richa/dashboardz/tree/main/relay) is a small Fastify service that routes WebSocket frames
between hubs and senders that cannot reach each other. Both sides dial out to
it; it matches them by `hub_uid` and forwards sealed payloads it cannot read.
It is its own npm package and Docker image, sharing no code with the hub. Its
[README](https://github.com/rogerio-richa/dashboardz/blob/main/relay/README.md) covers running it; the design and the threat
model are in [Relay](../architecture/relay.md).

## Start here

1. [`src/index.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/index.ts) loads config and listens.
2. [`src/server.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/server.ts): `buildRelay`. Registers
   `/health`, the `/ws` socket with a 64 KiB frame cap, the registry (with a
   persistent store when `STATE_PATH` is set), the token store when
   `TOKENS_PATH` is set, and `GET /admin/stats` only when `ADMIN_TOKEN` is
   set.
3. [`src/socket.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/socket.ts): the per-connection state
   machine. The first frame fixes the role: `HELLO_HUB` (register a hub) or
   `HELLO_SENDER` (attach to a hub). Then a sender's `SEND` becomes a
   `DELIVER {conn_id, payload}` to the hub, and a hub's `REPLY {conn_id}` goes
   back to that sender.
4. [`src/protocol.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/protocol.ts): message types, error codes
   and close codes (4401 bad secret, 4403 token required, 4409 superseded,
   4429 rate limited).

## The other files

| File | What it owns |
| --- | --- |
| [`src/registry.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/registry.ts) | `hub_uid` to socket and `conn_id` to socket maps; trust on first use (first hub to claim a uid fixes its secret hash); per-account connection counts. |
| [`src/store.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/store.ts) | Persists hub bindings to `STATE_PATH`, pruned after 90 idle days. |
| [`src/tokens.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/tokens.ts) | Account tokens from `TOKENS_PATH` (hashed), with a per-account `maxClients` cap. |
| [`src/rateLimit.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/rateLimit.ts) | Fixed-window limiter: hub registration per remote address, `SEND` per hub. |
| [`src/config.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/config.ts) | `PORT` (8790), `TRUST_PROXY`, `STATE_PATH`, `TOKENS_PATH`, `REQUIRE_TOKEN`, `ADMIN_TOKEN`; malformed values fail startup. |
| [`scripts/token.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/scripts/token.mjs) | Operator CLI to add accounts and mint or revoke tokens in the tokens file. |

## How it connects

The hub side is [`hub/src/relay/client.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/relay/client.ts)
(see [Relay client](hub-relay-client.md) for the full three-party sequence);
the sender side is [`clients/sender`](sender.md). Payloads are sealed with a
key derived from the sender token, so the relay only ever handles opaque
strings.

## Things that trip people up

- **Logging is off on purpose.** `logger: false` keeps payloads out of logs;
  the e2e test asserts no title, body or answer text reaches the relay's
  output. Do not add request logging.
- **No buffering.** A `SEND` for an offline hub fails immediately with
  `hub_offline`.
- **Close codes are a contract.** The hub duplicates them in its client; 4401
  and 4403 are terminal for a hub, 4409 is a normal reconnect. Change both
  sides together.
- **`REQUIRE_TOKEN=true` without `TOKENS_PATH` refuses to start.**
- **`TRUST_PROXY` only belongs behind a real proxy**; it decides which address
  keys the registration limiter.

## Tests

[`relay/test`](https://github.com/rogerio-richa/dashboardz/tree/main/relay/test): `routing.test.ts`, `registry.test.ts`,
`persistence.test.ts`, `tokenGating.test.ts`, `tokens.test.ts`,
`rateLimit.test.ts`, `registrationAbuse.test.ts`, `frameSize.test.ts`,
`stats.test.ts`, `config.test.ts`, `server.test.ts`, and `e2e.test.ts`, which
boots a real hub and the sender client in the same process (so it needs
`hub/node_modules`). Run with `npm --prefix relay test`.
