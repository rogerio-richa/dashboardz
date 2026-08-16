# Building an integration

An integration is any process that holds a sender token and talks to the hub
over HTTP. That is the whole model: there is no plugin API, no manifest, no
SDK to vendor, nothing to install into the hub. Netdata pushing CPU alarms, a
Python daemon relaying radio messages, an AI agent asking a question on your
wall — each is just a program somewhere with a token, composing the same three
calls you are about to make by hand.

The division of labour is strict, and it is what keeps a wedged integration
from taking down the board: **your process pushes data and raises alerts; the
hub owns the screens, the devices, and the policy** for what shows where and
what makes noise. If your process hangs, the widgets it fed go stale and say
so — nothing else is harmed.

This page is a walkthrough. By the end you will have pushed live data onto a
screen, made a device beep, asked a question and read back which button was
tapped — everything a real integration does, from your terminal. Each step
ends with something you can see.

You need a running hub ([deployment](deployment.md)), admin access, and at
least one paired device. Examples use `hub.example.lan` for the hub and
truncated placeholders (`dbz_s_...`, `feed_...`) for credentials and ids —
substitute your own.

## 1. Mint a sender token

Everything an integration sends is authenticated by a **sender token**. In the
admin, open the **Senders** tab and add one — name it after the thing it will
represent (`greenhouse`, not `test`). Two things to know before you click:

- The token (it starts with `dbz_s_`) is **shown once**. The hub stores only
  a hash, so nobody — including the admin — can read it back later. Put it
  somewhere safe now.
- **Default devices** are which screens this sender's alerts land on when a
  push doesn't say. Pick the device you can see.

A sender token can push to data feeds, raise and resolve alerts, and read
back the answers to its own questions. It cannot create feeds or screens,
see anyone else's alerts, or touch the admin — that separation is the
[security model](architecture/security.md), and it is why handing a token to
a third-party box is safe.

**You should see:** your sender listed in the Senders table. In your
terminal:

```bash
export HUB=http://hub.example.lan:8484
export TOKEN=dbz_s_...   # the token you just copied
```

## 2. Create a feed

A **feed** is a named slot on the hub that your integration pushes into and
widgets read from. It is the only piece of vocabulary the hub asks you to
learn, and it comes in three modes:

- **value** — one current thing, replaced on every push. A temperature, a
  queue depth, a build status. Feeds gauges and stat tiles.
- **stream** — a rolling list, one row appended per push, capped. Log lines,
  chat messages, recent events. Feeds list and chart widgets.
- **image** — one current picture, replaced on every push. A camera still, a
  rendered chart.

On the **Data sources** page, create a feed named `demo-temp` with mode
**value**. Mode is fixed at creation — a gauge and a log are different
promises to the widgets reading them, so changing your mind means a new
feed. (Feeds can also be created over the [admin API](architecture/screens.md#a-complete-worked-example)
or by an agent through `dashboardz-mcp`; the shape is the same.)

Two settings worth noticing now, both optional: `stale_after_s` makes the
hub mark the feed — and the widgets on it — stale when your integration goes
quiet for that long, and `alert_on_stale` turns that silence into an alert.
Together they are your dead-man's switch: turn them on for anything that
pushes on a schedule, and the difference between "all quiet" and "sender
died" stays visible.

**You should see:** `demo-temp` on the Data sources page, marked as never
pushed.

## 3. First push

Every feed row has a **Copy curl** button that emits a working command for
that feed's mode. For `demo-temp` it looks like this — swap in your token:

```bash
curl -X POST $HUB/api/feeds/feed_... \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"value": 21.5}'
```

```json
{"ok": true, "pushed_at": 1754835600000}
```

The JSON body is yours to shape — any JSON up to 16 KB; widgets are
configured to pick fields out of whatever you send. Push again with a
different number and watch the payload change on the Data sources page.

A **stream** feed takes the identical request and appends a row instead of
replacing (oldest rows fall off past the feed's cap — 50 by default, 500 at
most, so a stream is a rolling window, not an archive). An **image** feed
takes the binary variant — raw bytes, not JSON:

```bash
curl -X POST $HUB/api/feeds/feed_... \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: image/png" \
  --data-binary @image.png
```

PNG, JPEG or static WebP; 512 KB and 2048×2048 at most; the declared
content-type must match the actual bytes. Errors are unambiguous and worth
knowing on sight:

| Status | Meaning |
|---|---|
| `401 invalid token` | Bad or deleted token |
| `404 unknown feed` | Feed id wrong or feed deleted |
| `403 sender not allowed` | The feed restricts which senders may push (its `allowed_senders` list) |
| `415` / `413` | Wrong content type / body too large |

**You should see:** the feed's payload and a fresh pushed-at timestamp on
the Data sources page, updating on every push.

## 4. Show it on glass

Data on the hub becomes data on the wall through a **screen** — a grid of
widgets, each bound to a feed by id. In the admin **Screens** page: create a
screen, add a stat or gauge widget, set its feed to `demo-temp`, and assign
the screen to your device. The full grid model, widget catalogue, and a
worked example from empty hub to finished wall live in
[screens](architecture/screens.md) — this tutorial won't repeat them.

**You should see:** your number, on glass. Push a new value; it changes
within a second. That round trip — `curl` to wall — is the whole data half
of an integration.

## 5. Alerts: when to interrupt

Feeds are for state; **alerts** are for attention. The test: is this a thing
someone should *do something about*? A temperature is a feed. A temperature
that has been over the safe limit for five minutes is an alert.

```bash
curl -X POST $HUB/api/notify \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"title": "Greenhouse over 30°C", "severity": "warn", "sound": true, "ttl_s": 1800}'
```

```json
{"id": "alr_..."}
```

The full field table is in [senders](architecture/senders.md) — what to
internalize here is the **severity discipline**, because the hub enforces
it and your integration should mean it:

- `info` — routine, and **never audible** no matter what you set. The card
  appears; nobody is interrupted.
- `warn` — worth noticing. Sounds once (unless you pass `"sound": false`),
  then expires on its `ttl_s`.
- `critical` — reserved for "being unheard is worse than waking someone".
  It alarms, takes over the screen, and **never expires** — `ttl_s` is
  ignored; only a human dismissing it, or your integration resolving it,
  ends it.

For a condition that can clear itself, pass a `dedup_key` so repeats update
one card instead of stacking, and retract with
`{"resolve": true, "dedup_key": "..."}` when the world is right again — the
card vanishes from every device. One thing to know before you build anything
that nags: a device chimes **at most once per alert**, and dedup updates are
silent — so a second audible nudge means posting a second alert, not
updating the first ([details](architecture/senders.md#one-chime-per-alert)). On devices showing several screens as
tabs, each tab carries a dot with the worst live severity among the senders
feeding that screen, so a problem shows through even from the wrong tab.

**You should see:** the alert card on your device — and hear it.

## 6. Ask a question

An alert with `options` (up to four) renders as buttons on the device, and
turns your integration from a broadcaster into something that can wait for
a human decision:

```bash
curl -X POST $HUB/api/notify \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "title": "Disk 87% on backup host — prune old snapshots?",
    "severity": "warn",
    "ttl_s": 3600,
    "options": [{"id": "prune", "label": "Prune"}, {"id": "wait", "label": "Wait"}]
  }'
```

Then poll for the tap (only the token that asked can read it):

```bash
curl -s $HUB/api/alerts/alr_.../answer -H "Authorization: Bearer $TOKEN"
```

`{"state":"pending"}` until someone taps, then
`{"state":"answered","option_id":"prune",...}` — or `"dismissed"` (seen,
not deciding) or `"expired"` (nobody was around), which are answers too:
design your integration's default behaviour for them. All four states and
their exact shapes: [senders](architecture/senders.md#reading-the-answer).
Poll every 10–30 seconds; the human is walking to a wall, not racing you.

**You should see:** buttons on the wall, and — after you tap one — the
option id in your terminal. That loop is the entire agent-integration
pattern.

## 7. Going off-LAN: the relay

Everything so far assumed your process can reach the hub directly. When it
can't — a cloud box, a machine on another network — the **relay** is the
optional switchboard: the hub dials out to it, your sender connects to it,
and frames pass through **sealed**. The relay carries ciphertext; the key is
derived from your sender token, which the relay never has. It can see that
traffic flows and for which hub — routing metadata — but not titles, bodies,
or data. The honest details, including what the relay *can* observe, are in
[relay](architecture/relay.md) and [remote access](remote-access.md).

The reference CLI `dbz-send` (`clients/sender`, MIT) speaks this path:

```bash
dbz-send --relay wss://relay.example.com --hub hub_... --token $TOKEN \
  --title "Nightly backup failed" --severity warn

dbz-send data feed_... --relay wss://relay.example.com --hub hub_... \
  --token $TOKEN --json '{"value": 21.5}'
```

Same fields, same semantics as the HTTP calls above — `--option ID=LABEL`
and `--wait SECONDS` do the ask/answer loop in one command. One asymmetry:
image feeds can't be pushed over the relay. Flags and exit codes:
[senders](architecture/senders.md#remote-senders).

## 8. Ship it

Conventions the in-tree integrations follow, so operators always know where
to look:

- **Config is an env file.** Hub URL (or relay URL + hub uid), sender token,
  feed ids, target device ids, tunables — one file, `chmod 600`, next to
  nothing hard-coded. Ship an `example.env`; the operator copies and fills
  it. Device ids are operator-supplied: there is no sender-token route that
  lists devices, so the operator reads them off the admin's Devices tab
  (or sets them as the sender's default devices and omits them entirely).
- **Run it as a container or a systemd unit** with restart-on-failure. Your
  process should survive a hub that is down or restarting: log loudly, retry
  with backoff, never crash on a failed push — the meshtastic example's
  `push()` is the pattern. When retrying an alert, reuse its `dedup_key`
  so an ambiguous timeout can't produce two chiming cards
  ([details](architecture/senders.md#anything-that-can-post)).
- **Decide your missed-schedule policy up front.** If your integration fires
  things on a schedule, the machine it runs on will eventually sleep through
  one. The pattern that behaves well on a wall: on wake, fire anything
  missed within a bounded catch-up window (an hour is sane), mark it as
  late in the title, and skip anything older — a stale reminder firing at
  3am is worse than a skipped one.
- **Uninstall cleanly.** Removing the unit or container plus deleting the
  sender in the admin must leave no trace: deleting a sender kills its token
  immediately and removes its live alerts from every device. Feeds stay (an
  operator may keep the history) — note in your README which ones you
  created.

## 9. Read the real ones

Three integrations live in the repository's `integrations/` folder, each
self-contained with its own README. Read them in this order:

1. **netdata** — shell scripts, no dependencies. Netdata alarms become
   alerts and metrics become feeds; the dispatch→backend split shows how to
   bolt Dashboardz onto an existing alerting pipeline.
2. **meshtastic** — a long-running Python daemon in a container, with its
   own tiny config page. Shows reconnect-forever, feed+alert pairing, and
   why an integration owns its own config surface instead of asking the hub
   to.
3. **claude** — the agent pattern: no daemon at all, just a skill that
   teaches an AI assistant to use the ask/answer loop you ran in step 6.

Copy the closest one and start swapping parts. For the story of what each
one puts on a wall and why — the showcase rather than the source — see the
[integration gallery](gallery/index.md).
