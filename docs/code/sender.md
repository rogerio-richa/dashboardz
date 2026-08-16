# Sender client

[`clients/sender`](https://github.com/rogerio-richa/dashboardz/tree/main/clients/sender) is the reference client for the relay
path: a small library (`SenderClient`) and the `dbz-send` CLI. It seals a
notify or a feed push end to end to one hub, sends it through a relay, waits
for the hub's ack, and can wait for the human's answer. A sender on the same
network as the hub does not need it: plain `curl` to `POST /api/notify` is the
direct path ([integration walkthrough](../integrations.md)). Design:
[Senders: Remote senders](../architecture/senders.md#remote-senders).

## Start here

1. [`src/client.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/sender/src/client.ts): `SenderClient`.
   `connect()` sends `HELLO_SENDER`; `notify()` and `data()` seal a request
   with a fresh `req_id` and resolve on the matching sealed ack (15 second
   default timeout, whose message says the likely cause: a token the hub
   cannot open the message with); `onAnswer()` receives the later answer or
   timeout event.
   The socket is injectable for tests.
2. [`src/cli.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/sender/src/cli.ts): `dbz-send`. Two forms:
   `dbz-send --relay URL --hub UID --token TOKEN --title ... --severity ...`
   (with `--resolve`, `--dedup-key`, `--option`, `--wait`) and
   `dbz-send data <feed-id> ... --json '<payload>'`. Exit codes: 0 ok, 1 send
   failed, 2 bad usage, 3 `--wait` elapsed.
3. [`src/envelope.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/sender/src/envelope.ts): the sealing code,
   a byte-for-byte fork of
   [`hub/src/relay/envelope.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/relay/envelope.ts).

## How it connects

The plaintext it seals is exactly what
[`hub/src/relay/handler.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/relay/handler.ts) accepts (`op:
'notify'` or `op: 'data'`); the sender token never appears in the payload,
because successful decryption is the authentication. The relay frames are
defined in [`relay/src/protocol.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/src/protocol.ts). The full
sequence is drawn on the [Relay client](hub-relay-client.md) page. The Netdata
integration and the OpenClaw skill shell out to `dbz-send`.

## The OpenClaw skill

[`clients/openclaw/SKILL.md`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/openclaw/SKILL.md) is the
`dashboardz-notify` skill: it teaches an agent with no route to the hub to
alert and ask through the relay with `dbz-send`, reading
`$DASHBOARDZ_RELAY_URL`, `$DASHBOARDZ_HUB_UID` and the sender token. It is a
document, not code; `hub/test/skill-doc.test.ts` pins its token idiom.

## Things that trip people up

- **Two envelope copies, one vector.** Change both `envelope.ts` files
  together; `clients/sender/test/envelope.test.ts` and
  `hub/test/envelope.test.ts` share a test vector and fail if they drift.
- **`--wait` is invalid with `--resolve`** and with `data`: there is no answer
  to wait for.
- **The relay throttles bursts** per hub; a burst of sends can see
  `rate_limited`.

## Tests

[`clients/sender/test`](https://github.com/rogerio-richa/dashboardz/tree/main/clients/sender/test): `client.test.ts`,
`cli.test.ts`, `envelope.test.ts`. Run with
`npm --prefix clients/sender test`. The client is also exercised against a
real relay and hub in [`relay/test/e2e.test.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/test/e2e.test.ts).
