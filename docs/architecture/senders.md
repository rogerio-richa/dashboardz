# Senders

A sender is anything that can make an HTTP request: a script, an agent, a
monitoring system, a webhook target. There's no SDK requirement and no
handshake beyond a Bearer token — if it can POST JSON, it can be a sender.

## Anything that can POST

Create a sender token in the admin UI (**Senders** tab), then:

```bash
curl -X POST http://hub:8484/api/notify \
  -H "Authorization: Bearer dbz_s_..." -H "content-type: application/json" \
  -d '{"title": "Backup finished", "severity": "info"}'

curl -X POST http://hub:8484/api/notify \
  -H "Authorization: Bearer dbz_s_..." -H "content-type: application/json" \
  -d '{"title": "RAID degraded!", "body": "sda failed on nas01", "severity": "critical", "dedup_key": "raid-nas01"}'
```

The full field reference (the same one the hub exposes at `/api/notify`):

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes\* | The headline shown on the card, 1–200 characters. Not required when `resolve` is `true`. |
| `severity` | yes\* | One of `info`, `warn`, `critical`. Not required when `resolve` is `true`. |
| `body` | no | Optional detail text under the title, up to 1500 characters. |
| `devices` | no | An explicit, non-empty list of target device IDs. Omit it and the alert goes to the sender's configured default devices instead. A sender with no default devices must pass this, or the hub answers `400 {"error": "no target devices"}`; any id the hub doesn't know is a `400` naming the unknown ids. |
| `sound` | no | Whether the alert should make noise. On by default for `warn` and `critical`; set it `false` to stay quiet. **Ignored for `info`** — a sender cannot make routine traffic audible, because one integration should not be able to decide that a whole house beeps. Whether info alerts chime is set per screen, on the alert feed widget, and is off by default. |
| `ttl_s` | no | Seconds until the alert expires on its own; any integer ≥ 1. **Ignored for `critical`**, which never expires — an alarm ends when a person dismisses it, not when a timer runs out. A critical carrying `options` therefore never times out, so nothing is sent back to a waiting sender until somebody answers on the device. |
| `dedup_key` | no | Up to 100 characters. Collapses repeats from the same sender into one updated card instead of a new one each time — useful for a recurring health check. Required when `resolve` is `true`. **A dedup update never makes a second sound** — see "One chime per alert" below. |
| `options` | no | One to four buttons, each `{id, label}`: `id` is 1–32 characters of `[a-z0-9_-]` and must be unique within the alert; `label` is 1–24 characters. A tap on one becomes an answer — see "Reading the answer" below for how it comes back. |
| `resolve` | no | `true` retracts an alert instead of creating one — see below. |

The errors you will actually hit, all unambiguous:

| Status | Meaning |
| --- | --- |
| `401 {"error": "invalid token"}` | Bad or deleted sender token. |
| `400 {"error": "no target devices"}` | No `devices` in the request and the sender has no default devices. |
| `400 {"error": "unknown devices: dev_x"}` | A `devices` entry the hub doesn't know. |
| `400 {"error": "option ids must be unique"}` | Two options share an `id`. |
| `400` (schema message) | A field outside the table above, or one violating its limits. |

**Retries: reuse the `dedup_key`.** There is no request-level idempotency
key, so a `POST /api/notify` that times out on your side may still have
landed. The safe retry is to send the same request again *with the same
`dedup_key`*: if the first attempt landed, the retry is a silent update to
the same card (one card, one chime); if it didn't, the retry creates it.
Retrying without a dedup key risks two chiming cards for one event.

**Polling etiquette.** The direct HTTP surface has no rate limiting today —
the only guards are body-size caps. Poll answers every 10–30 seconds and
keep one poll loop per open alert (there is no bulk "my active alerts"
endpoint yet); a well-behaved integration is the only throttle there is.

## One chime per alert

A device chimes **at most once per alert** (non-critical): the first time the
card lands with sound on, keyed to the alert's id, and never again for that
id. Updating an alert through its `dedup_key` refreshes the card silently —
which is exactly what you want for a recurring health check, and exactly what
you don't want for a reminder nobody heard.

So to nudge a human a second time, **post a new alert** (a different
`dedup_key`, or none). An escalation pattern that works: post the question,
wait N minutes, and if it is still unanswered post a second alert ("Still
waiting: …") with `sound: true` and its own dedup key — then poll both ids and
treat the first terminal answer as the answer, resolving the other card.
(`critical` is the exception to all of this: it takes the sustained-alarm
path and keeps sounding until a human deals with it.)

## Reading the answer

An alert with `options` is a question, and the sender that asked can read the
outcome with the same token it asked with:

```bash
curl -s http://hub:8484/api/alerts/<alert-id>/answer \
  -H "Authorization: Bearer dbz_s_..."
```

The `<alert-id>` is the `id` that `POST /api/notify` returned. The response is
one of four states:

- `{"state": "pending"}` — nobody has tapped yet; poll again.
- `{"state": "answered", "option_id": "ship", "option_label": "Ship it",
  "answered_at": 1754835600000, "device_id": "dev_..."}` — a human chose.
  First answer wins: on a multi-device alert this reports the earliest tap.
- `{"state": "dismissed"}` — a human saw the question and cleared it without
  choosing (every non-critical card carries a **Dismiss** button; criticals
  take a deliberate press-and-hold). A real outcome, distinct from a
  timeout; stop polling.
- `{"state": "expired"}` — the `ttl_s` ran out unanswered.

Tapping an option clears the card **on the device that was tapped** as soon
as the hub echoes the answer back. On a multi-device ask the other devices
keep showing the card — retract it everywhere by posting
`{"resolve": true, "dedup_key": "..."}` once you've read the answer. (This
is why giving every question a dedup key is a good habit.)

Only the asking sender can read it: another sender's token gets the same 404
an invented alert id would, so alert ids are not probeable across senders.

Relay senders don't poll — a hub behind a relay has no HTTP surface to poll.
Their answer is pushed back over the socket the question was asked on
(`dbz-send --option ID=LABEL --wait SECONDS` prints it). This route is the
LAN sender's equivalent of that push.

## Resolving instead of creating

Some senders track an external condition that comes and goes on its own —
netdata clearing an alarm, a monitor flipping back to healthy — and need to
retract a card the moment that happens rather than waiting for its `ttl_s`
to run out. Posting `{"resolve": true, "dedup_key": "..."}` does that: the
hub finds *this sender's* active alert carrying that `dedup_key`, retracts
it from every device it's currently on, and replies
`{"ok": true, "resolved": true, "alert_id": "..."}`. `title` and `severity`
are not needed for a resolve — only `dedup_key` is.

```bash
curl -X POST http://hub:8484/api/notify \
  -H "Authorization: Bearer dbz_s_..." -H "content-type: application/json" \
  -d '{"resolve": true, "dedup_key": "raid-nas01"}'
```

A resolve for a `dedup_key` the hub isn't currently holding active — never
seen, already resolved, expired, or dismissed on-device — is not an error:
it replies `{"ok": true, "resolved": false}`. That keeps a dispatcher that
doesn't track hub-side state (netdata's alarm-notify script, for one) quiet
rather than noisy: a CLEAR the hub never has anything to do with is expected
traffic, not a bug report.

## Tokens

A sender token is created once, in the admin UI, and shown to you exactly
once — there's no way to retrieve it again afterward, so save it somewhere a
password manager would be proud of. The hub itself never stores the token;
it keeps only a one-way hash of it, which is enough to verify a `Bearer`
header on `/api/notify` without ever holding onto something that could be
replayed if the database leaked.

For senders that use the relay, the hub additionally stores a key derived
from that sender's token. This derived key is what lets the hub decrypt
envelopes that arrive over the relay — but it is not usable as an
`Authorization: Bearer` credential, so it can't stand in for the token
itself even if it were extracted from the database. This trade-off — a
compromised hub database now holds material that can decrypt this sender's
relayed traffic, even though it can't hold the token — is covered in more
depth under the [security model](security.md).

## Remote senders

A sender with no direct route to the hub goes through the relay instead,
and needs exactly three values to do it:

- the relay's URL
- the hub's uid on that relay (open the relay badge in the admin masthead
  and click **Copy** next to it — the hub also logs
  `relay: connecting as hub_...` once it's connected)
- a sender token, from the admin UI as usual

The reference implementation is `clients/sender` (MIT-licensed). It exports
`SenderClient({relayUrl, hubUid, senderToken})` for use as a library, plus a
`dbz-send` CLI that wraps it:

```
dbz-send --relay wss://relay.example/ws --hub hub_... --token dbz_s_... \
         --title "Disk 97%" --severity critical [--wait Ns]
```

`--wait` keeps the CLI connected after the ack so it can block for the
human's answer if the alert carries options — the round trip a tap makes
back to whoever sent the alert. Exit codes: `0` sent (and, with `--wait`, an
answer or alert-timeout arrived), `1` send failed, `2` bad usage, `3` `--wait`
elapsed with no answer.

`--resolve` retracts instead of creates — the relay's version of the
[`resolve` field](#resolving-instead-of-creating) above, for a sender with no
direct route to the hub:

```
dbz-send --resolve --dedup-key raid-nas01 \
         --relay wss://relay.example/ws --hub hub_... --token dbz_s_...
```

`--title`/`--severity` are not needed with `--resolve`, and `--dedup-key` is.
`--wait` is invalid together with `--resolve` (exit `2`) — a resolve retracts
an alert, so there's no human answer left to wait for. Resolving a
`--dedup-key` the hub isn't holding active is not an error; it still exits
`0`.

### Pushing data feeds over the relay

`dbz-send data <feed-id>` pushes a data feed the same way `--title`/`--severity`
push an alert — sealed to the hub, the relay sees ciphertext only:

```
dbz-send data feed_abc123 --relay wss://relay.example/ws --hub hub_... \
         --token dbz_s_... --json '{"cpu": 42.1}'
```

A value-mode feed overwrites; a stream-mode feed appends a row. Exit codes:
`0` pushed, `1` send failed, `2` bad usage (`3` never applies — a data push
takes no `--wait`, there is no human answer to wait for). Image feeds cannot
be pushed this way: sealed-JSON envelopes are the wrong vehicle for binary
data, so the hub rejects an image-mode feed id with `image push not
supported over relay` — that push stays LAN-only, over `/api/feeds/:id`.

## Which path do I need?

If your sender is on the hub's LAN, or the hub is behind an HTTPS reverse
proxy with a public address your sender can already reach, you don't need the
relay at all — a direct POST to `/api/notify` is simpler and has one fewer
thing that can go wrong. Plain HTTP is only for a trusted LAN or private VPN;
firewall the raw hub port when using a public reverse proxy. The relay exists
specifically for senders with no route to the hub: a laptop on someone else's
network, a job running in the cloud, anything outside your LAN.

Hub plugins that poll external systems (checking a monitoring dashboard, an
inbox, whatever) don't need it either — they connect *from* the hub outward,
so they're never on the receiving end of a notification and never touch the
relay.
