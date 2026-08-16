# Relay

The relay is a WebSocket switchboard for senders that have no route to your
hub — a laptop on someone else's network, a job running in the cloud,
anything outside your LAN. Both the hub and the sender dial **out** to it;
the relay routes frames between them by the hub's uid. Nobody needs an
inbound port open anywhere — hub behind NAT, sender behind NAT, relay on a
public address in the middle.

## A switchboard, not a hub

The relay holds no alert lifecycle, no rules, no audit log, and no
configuration about anyone. It doesn't know what a device is, what
`dedup_key` means, or who is allowed to notify whom — the hub decides all of
that, on payloads it decrypts itself after the relay has forwarded them.

This isn't a missing feature — it's the point. A relay that cannot read
payloads *cannot* also do hub things: deduplication needs the `dedup_key`,
a TTL needs the expiry, targeting needs the device list, and none of that
is visible in ciphertext. "The relay can't read content" and "the relay
does hub-like work" are mutually exclusive properties. The relay only ever
gets the first one.

## What it deliberately cannot do

**Read payloads.** Every payload that crosses the relay is sealed
end-to-end between sender and hub with a key derived from the sender's
token. The relay forwards the ciphertext verbatim — it never parses it,
and it runs with logging disabled so it can't leak it by accident either.
This is pinned by an end-to-end test that asserts no title, body, or
answer text ever appears on the relay process's own output.

**Store anything.** No database, no disk, no queue. The routing tables
that map a hub's uid to its socket live purely in memory and disappear on
disconnect. If the target hub isn't connected when a sender sends, the
sender gets an immediate `hub_offline` error — the relay never buffers,
because a silent buffer is worse than a loud failure.

**Survive as an authority.** Hub registration is trust-on-first-use: the
first connection to claim a hub uid fixes that uid's secret, and every
later connection has to match it. There are no accounts and no admin for
the relay itself. A relay run with `STATE_PATH` set persists those
bindings across restarts (idle ones are pruned after 90 days), so the
only moment an impostor can fix a uid's secret is genuine first contact —
and hub uids are 128 random bits, so that takes a leaked uid, not a
guessed one.

A relay run without `STATE_PATH` keeps the registry only in memory, and
that has an honest cost: restarting wipes it, and the uid re-keys to
whichever connection claims it first after the restart. If someone has
learned a hub's uid and wins that race, they own the routing slot: the
real hub is refused with a terminal bad-secret close (logged as an error,
surfaced on the hub's own admin API, and not retried — loud, not silent),
and senders' messages route to the impostor instead.

In either mode an impostor still can't read or forge anything — it holds
no sender keys, so everything it receives is ciphertext it can't open,
and it can't produce a reply that authenticates. All it can do is deny
delivery.

## What it still sees

"Cannot read content" is not "learns nothing." The relay necessarily sees
**which hub** a message is for, the **size** of each encrypted payload, and
the **timing and frequency** of traffic. Anyone who learns a hub's uid can
also push ciphertext at it — the hub rejects anything that doesn't
authenticate, but that costs a round trip, so per-hub rate limiting at the
relay bounds how much of that abuse is possible. Frames are capped at 64
KiB, which is far more than a sealed envelope needs.

Choose where you run a relay with that metadata exposure in mind.

## Account tokens

By default a relay takes any hub that shows up — no accounts, no login, no
change from everything above. An operator running a relay — their own, or
SCz Tech's hosted one — can opt into per-account gating instead, so a set of
hubs can be attributed to an account; the same mechanism can cap how many
senders an account holds open at once, though no such cap is configured on
the hosted relay today. SCz Tech's hosted relay (below) has this gating
turned on; a self-hosted relay stays fully anonymous unless its operator
turns it on too.

A hub that has a token configured sends it on `HELLO_HUB` as
`account_token`. If the relay it's talking to rejects that token —
because the relay doesn't recognize it, it's been revoked, or the relay
requires one and none was sent — it closes the connection with code
**4403**, the same terminal treatment `4401` (bad secret) already gets: the
hub stops retrying immediately rather than hammering a relay that can never
accept it, and the admin relay badge turns red and stays that way until a
valid token is pasted in and **Save**d.

Token validation happens at connect time only. Revoking a token or deleting
an account does not disconnect a hub that is already connected, and does
not free the allowance it's holding, until that hub next reconnects — the
relay checks `account_token` once, on `HELLO_HUB`, and never again for the
life of that socket. Today the only immediate lever an operator has is
restarting the relay process, which drops every connection on the
service, hub and sender alike, and forces them all to reconnect (and get
re-validated) from scratch.

Three environment variables on the relay drive this, all optional:

- **`TOKENS_PATH`** — path to a JSON file of accounts and their hashed
  tokens. Unset, there is no token store at all, and this section doesn't
  apply to you: **a relay with no `TOKENS_PATH` behaves exactly as it
  always has**, taking any hub with no concept of an account.
- **`REQUIRE_TOKEN`** — `true` refuses any hub that doesn't present a token
  this relay recognizes; the default (`false`, or unset) only validates a
  token when one is actually sent, so anonymous hubs keep working
  side-by-side with attributed ones. Setting `REQUIRE_TOKEN=true` without
  `TOKENS_PATH` refuses to boot — that combination would refuse every hub.
- **`ADMIN_TOKEN`** — a bearer credential that, if set, exposes
  `GET /admin/stats` on the relay: a live count of accounts, their
  configured caps, and current hub/sender numbers. No account tokens or
  other secrets appear in that response. Leave it unset and the route
  doesn't exist — a 404, not a 401, so its presence isn't advertised to
  anyone probing the relay either. It gates a census an operator needs
  most during an abuse response and carries no rate limit of its own, so
  make it a long random value, not a memorable one.

The token file is hot-reloaded: the relay re-reads it whenever its
modification time changes, so minting or revoking a token never requires a
restart — a restart would drop every live connection on the service, hub
and sender alike. Manage it with `relay/scripts/token.mjs`:
`account add <label> [--max N]`, `account list`, `token add <accountLabel>
[--note "..."]`, `token revoke <id>`, and `token list`. A newly minted token
is printed to the terminal exactly once; the file on disk only ever stores
its SHA-256 hash, never the token itself.

Self-hosters can require tokens on their own relay this way regardless of
whether any of their hubs also talk to SCz Tech's hosted relay — it's a
plain per-deployment setting on the relay they run, with no signup
involved. Signing up for an account only matters for the hosted relay,
covered next.

Run the relay behind `wss://`, not `ws://`: `account_token` goes out on
`HELLO_HUB` in plaintext, and a plain `ws://` relay puts it on the wire
for anyone on the path to read.

## The hosted relay

SCz Tech operates a hosted relay at `wss://relay.scztech.com.br/ws` (health
check: `https://relay.scztech.com.br/health`). Using it is free, and it is
exactly the switchboard described above: same code, same guarantees, same
blind spots — with `REQUIRE_TOKEN` turned on, so an account token (above) is
mandatory, not optional. You still run the hub yourself; the hosted relay only
connects remote senders to it.

To get a token, sign in with Google at `https://dashboardz.scztech.com.br`
and mint one; you can revoke it from the same page at any time, which frees
it for reuse elsewhere. Revocation only takes effect at your hub's next
connect — see above.

You don't have to use any of this. The relay ships as a container with no
account system unless its operator turns one on, so you can run your own on
any public address you control, entirely account-free — see the
[deployment page](../deployment.md).

## Pointing a hub and a sender at it

Open the relay badge in the admin masthead, paste the relay's WebSocket
address into **Relay URL**. If the relay requires an account token — the
hosted relay always does — paste it into **Relay token** too. Click
**Test** to confirm it answers, then **Save**. Once connected, the hub logs
its uid:

```
relay: connecting as hub_...
```

and the same dialog shows it too, with a **Copy** button.

A hub whose token is missing, unrecognized, or revoked gets a terminal
close from the relay — code 4403, reason "an account token is required on
this relay" — instead of a connection. The relay badge turns red and names
the problem rather than looping retries forever; fix it by pasting a valid
token and clicking **Save** again, or by removing the token with **Remove
token** if you're moving to a relay that doesn't need one.

That uid, the relay URL, and a sender token from the admin UI are the full
connection string a remote sender needs. See [senders](senders.md) for how
a sender token is issued and [security](security.md) for how the envelope
that carries it is built.
