# Remote access

Everything in Dashboardz works with no internet at all: devices talk to the
hub over your own network, and nothing leaves it. This page is about the two
situations where something of yours is *not* on that network — and what the
options cost you in privacy, stated plainly. The deep technical reference is
the [relay architecture page](architecture/relay.md).

## Network boundary

Plain HTTP is for a trusted LAN or private VPN only. If any connection to a
hub crosses an untrusted or public network, HTTPS through a reverse proxy is
required. Firewall the raw hub port so it is not internet-reachable; proxy
WebSocket upgrades (`Connection: upgrade`, `Upgrade: websocket`) on
`/ws/device`, and set `PUBLIC_URL` to the proxy's `https://` URL. The hub has
no built-in login throttling, so an internet-facing proxy must rate-limit
`/admin/api/login`.

## When you need a relay — and when you don't

If every sender (the scripts, agents and systems that notify you) runs on the
same network as your hub, you do not need a relay. Stop reading.

You need one when a sender lives somewhere else: a job in the cloud, a laptop
on another network, an agent on a server in a datacenter. Neither that sender
nor your hub can reach the other directly — home networks don't accept
inbound connections, and you shouldn't open a port to change that. A relay is
the meeting point: both your hub and the sender dial **out** to it, and it
passes frames between them. No inbound port anywhere.

## What a relay can and cannot see

Every payload that crosses a relay is sealed between the sender and your hub
with a key derived from that sender's token. The relay forwards ciphertext.

- It **cannot** read titles, bodies, questions, or answers — and because it
  can't read them, it also can't dedupe, filter, target or otherwise act on
  your alerts. Those are hub decisions, made after decryption, on your hub.
- It **can** see which hub a message is for, roughly how big each sealed
  payload is, and when traffic happens. Metadata, not content.

One honest weakness: registration is trust-on-first-use. If your hub's uid
leaks *and* the relay restarts, whoever reconnects first with that uid owns
its routing slot until the next restart. They still can't read or forge
anything — they can only deny delivery, and your hub says so loudly in the
admin (the relay badge turns red and stops retrying). Uids are 128 random
bits; this cannot be guessed, only leaked.

## The hosted relay

SCz Tech runs a relay at `wss://relay.scztech.com.br/ws` (health:
`https://relay.scztech.com.br/health`). It is free to use and runs exactly
the code in this repository — same guarantees, same blind spots — plus one
requirement: an account token.

Sign in with Google at `https://dashboardz.scztech.com.br` and mint a
token, then open the relay badge in the admin masthead and paste the
relay's address into **Relay URL** and the token into **Relay token**,
click **Test**, then **Save**. Once connected, your hub's uid appears in
the same dialog with a **Copy** button. You can revoke a token from the
same `dashboardz.scztech.com.br` page whenever you like — revocation takes
effect the next time your hub reconnects, not immediately.

Get the token wrong, leave it out, or have it revoked: the relay closes the
connection with code 4403 and a plain-language reason, and the badge stays
red naming the fix rather than retrying forever.

## Run your own

The relay ships as a small container with no database and no state worth
backing up. Any public address you control will do — see
[deployment](deployment.md). Choose where to run it knowing what a relay
sees (the metadata above).
