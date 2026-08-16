# Security model

This page consolidates the security-relevant claims made elsewhere in these
docs — what's protected, what's traded off, and what isn't solved yet — in
one place.

## Default posture

Nothing leaves your network until you tell it to. With no relay configured
(the default), the hub behaves exactly like a pure-LAN install: every
sender, every device, and every alert stays inside your own network. The
hub is the sole authority over layout, rules, alert lifecycle, and audit —
nothing else in the system makes decisions on your behalf, and nothing
calls out anywhere unless you configure a relay yourself in the admin.

The hub serves plain HTTP only. Use plain HTTP on a trusted LAN or private VPN;
if any connection crosses an untrusted or public network, HTTPS through a
reverse proxy is required. Firewall the raw hub port so it is not
internet-reachable, proxy WebSocket upgrades (`Connection: upgrade`,
`Upgrade: websocket`) on `/ws/device`, and set `PUBLIC_URL` to the proxy's
`https://` URL. The hub has no built-in login throttling, so an internet-facing
proxy must rate-limit `/admin/api/login`.
When `PUBLIC_URL` uses `https://`, the hub marks the full-privilege `dbz_admin`
session cookie `Secure`, so browsers do not send it over plaintext HTTP. An
`http://` public URL intentionally keeps the cookie usable only for trusted
LAN or private-VPN access. This setting does not add built-in TLS termination
or login rate limiting; those remain responsibilities of the HTTPS proxy.

## Sender tokens at rest

A sender token is shown once, at creation, in the admin UI. The hub never
stores the raw token afterward.

For plain HTTP senders, the hub keeps only a one-way hash of the token —
enough to verify a `Bearer` header on `/api/notify`, but not reversible
into anything that could be replayed if the database leaked.

For senders capable of using the relay, the hub *additionally* stores a
key derived from that token (via HKDF — see [the envelope](#the-envelope)
below). That derived key is what lets the hub decrypt envelopes arriving
over the relay. It is not, however, a working `Authorization: Bearer`
credential — it can't stand in for the token itself even if someone
extracted it from the database.

**The honest trade-off.** A hub database now holds material that can
decrypt relayed payloads for its senders. "The relay cannot read your
alerts" stays true — the relay never sees this key. But "nobody but you can
read your alerts" would not be true, since anyone with read access to the
hub's database can now decrypt relayed traffic for every sender that has a
key. This is a real change from hash-only storage and worth being clear
about, rather than glossing over it — though it's worth noting that anyone
with read access to `hub.db` already has every alert's title and body sitting
in plaintext in the alerts table, so this widens the blast radius by
comparatively little.

**Senders created before this existed have no such key** — their tokens
were shown once and never stored, so there's nothing to derive a key from
after the fact. They keep working over the direct HTTP path, but they
can't use the relay. If you need a sender to use the relay, create a new
one.

## Source credentials at rest

Data sources can need credentials — an authenticated feed URL, a provider API
token. These are encrypted before they touch the database, with a 32-byte
master key that is deliberately stored outside it: either
`DASHBOARDZ_MASTER_KEY` in the environment, or a `0600` key file under
`DATA_DIR`. Somebody who walks off with `hub.db` alone gets ciphertext.

The corollary is the part that bites operators: **the key and the database
are one backup, not two.** Restoring the database without the key leaves every
stored secret permanently undecryptable. When no key can be found and secrets
already exist, the hub refuses to boot rather than quietly minting a fresh key
and presenting a healthy-looking process that has silently orphaned them.

Typed secrets are never sent back to the browser. Editing a source shows its
secret fields blank, and leaving one blank retains the stored value rather
than clearing it — so an operator fixing a URL cannot wipe a token by not
retyping it.

**This once had an exception, and no longer does.** The pre-contract collection
runtime stored a source's URL as ordinary config, in plaintext. The migration
that replaced it copied those credentials into the secret box but, being
append-only, left the rows it had read untouched — so an upgraded hub carried
every migrated credential twice, once encrypted and once not. A later migration
drops that table outright, and the hub rewrites the database file as it does
so: dropping a table frees its pages without erasing them, so the drop alone
would have moved the plaintext from a table into free space rather than out of
the file. `source_instances.legacy_connector_id` keeps the migration trail
without keeping the secret.

Deleting anything else is zeroed as it goes (`secure_delete`), so a revoked
sender's hash or a discarded draft's credential does not linger in freed pages
either.

## The envelope

Every relayed payload is sealed with:

- **Key**: HKDF-SHA256 of the sender's token, with the info string
  `dashboardz-relay-v1`. Using a distinct info string means this
  encryption key is not the bearer token reused for a second purpose —
  leaking one does not directly hand over the other's role.
- **Cipher**: ChaCha20-Poly1305, with a fresh random 12-byte nonce per
  message.
- Both come from Node's own `node:crypto` built-ins — no hand-rolled
  cryptography, no external dependency to audit.

The sender token itself never travels inside the payload. Instead, a
successful AEAD open *is* the authentication: the hub holds a derived
relay key per relay-capable sender and tries each one against an
incoming frame until one decrypts it cleanly. Whichever key opens it
identifies the sender at the same time. Because the token never rides
along even inside the encrypted plaintext, there's no credential to leak
even if a payload were somehow read back out after decryption.

## Failure discipline

- **The hub never answers a frame it cannot decrypt.** If nothing
  authenticates it, the hub doesn't know who sent it and holds no key to
  seal a reply with — answering anyway would also let a stranger probe
  which ciphertexts are valid against this hub. It's dropped, silently as
  far as the wire is concerned.
- **Malformed input is never fatal**, to either the hub or the relay. A
  relayed frame crosses a public relay and is treated as hostile input by
  default: bad shapes, wrong types, and oversized fields all get rejected
  explicitly rather than crashing anything.
- **The relay never logs payload content.** It runs with logging disabled
  for exactly this reason, and an end-to-end test pins that no title,
  body, or answer text ever appears on its output.

## Known limits, stated plainly

- **Relay metadata is visible.** The relay can't read a payload's
  contents, but it does see which hub a message is addressed to, the size
  of each encrypted payload, and the timing and frequency of traffic.
  "Cannot read content" is not "learns nothing."
- **Replay protection is the hub's job, and it is not implemented in
  v0.** The relay has no way to deduplicate anything it can't read, so
  responsibility falls to the hub — and today the hub doesn't do it either.
  This is a known gap, not an oversight to be discovered later.
- **The relay's trust-on-first-use registration has a reset limitation.**
  See [relay](relay.md#what-it-deliberately-cannot-do) for the full
  picture: because the relay's registry is in-memory, a restart lets
  whoever reconnects first claim a hub's uid, and the real hub is refused
  until the impostor's claim is cleared by the next restart. The impostor
  still can't read or forge anything — it just denies delivery.
- **Answers that arrive after a remote sender has disconnected are not
  redelivered.** A human's tap on an option is always recorded hub-side
  regardless of transport. Over the relay, though, delivering that answer
  back to the sender requires the sender to still be connected and
  waiting for it — if it isn't, the answer is committed but nothing pushes
  it anywhere further.

## Agent tokens

An agent token is a named Bearer credential for an AI assistant working against the admin API
(`Authorization: Bearer dbz_a_…`). It is minted and revoked on the admin **Agents** tab, stored
hashed, shown once at mint, and tracked with a last-used timestamp.

**It grants everything the admin password grants.** There are no scopes: the token exists so an
assistant can build screens, feeds and senders, which is read-write work — a narrower grant would
protect a credential nobody mints. The mitigations are containment, not prevention:

- **Minting and revoking are human-only.** Those two routes require the admin session cookie and
  refuse Bearer outright. A token that could mint tokens would make revocation meaningless — a
  leaked credential would simply replace itself.
- **Shrinking or forcing the retention window is human-only too**, for the same reason: audit log
  retention is what lets an operator reconstruct what a compromised token did, so a token must not
  be able to shorten it (`PATCH /admin/api/retention`) or make a shorter window take effect
  immediately (`POST /admin/api/retention/sweep`). Reading current sizes and policy
  (`GET /admin/api/storage`) stays Bearer-reachable — it grants no comparable leverage.
- **Clearing an alert is human-only** (`POST /admin/api/alerts/:id/dismiss`). An agent that
  raised a critical could otherwise clear it before anyone read the glass — an alarm silenced by
  the thing it was raised about. Listing what is active (`GET /admin/api/alerts/active`) stays
  Bearer-reachable; seeing what is ringing grants no comparable leverage.
- **Revocation is immediate and soft.** A revoked token authenticates nothing from the next
  request on, but its row survives so the audit trail keeps its name. Attempted use of a revoked
  token is itself audited (`agent_auth_rejected`).

### Which token does what

The three credential classes do not overlap — in particular, an agent token
**cannot** push data or raise alerts; an integration that both provisions its
feeds and pushes into them needs an agent token for the first and a sender
token for the second.

| | Sender (`dbz_s_`) | Device (`dbz_c_`) | Agent (`dbz_a_`) |
|---|---|---|---|
| `POST /api/notify`, resolve, read own answers | ✅ | — | — |
| `POST /api/feeds/:id` (push data) | ✅ | — | — |
| Device pairing, live socket, feed-image reads | — | ✅ | — |
| `/admin/api/*` management (screens, feeds, senders, devices, themes) | — | — | ✅ |
| Mint/revoke agent tokens, shrink retention, dismiss an alert, login/logout | — | — | — (human session only) |
- **Every write is attributed.** Admin-surface audit entries record the acting credential
  (`actor_type: 'agent'`, `actor_id`), so "which agent deleted that screen?" is answerable from
  the Activity view.

Treat the token like the admin password, because that is what it is: prompt injection reaching an
assistant that holds it reaches this hub.

An assistant typically connects through the repo-local `dashboardz-mcp` MCP server
(`node <absolute-path-to-dashboardz>/clients/mcp/dist/cli.js`), configured from the Agents tab's
paste-ready block. Run `./scripts/setup-dev.sh` from the repository root to build the CLI, then
replace the placeholder with the checkout's absolute path. The npm package is not published, so
`npx` is not a supported installation path. The server shapes its tools from
`GET /admin/api/widget-contract` at startup, so it always describes the hub it is actually
connected to.
