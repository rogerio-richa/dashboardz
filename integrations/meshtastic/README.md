# Meshtastic → Dashboardz

A long-running Python daemon that connects to a [Meshtastic](https://meshtastic.org)
node over TCP and puts the mesh on your wall. It demonstrates the daemon
pattern from the [integration walkthrough](../../docs/integrations.md):
reconnect forever, pair a feed push with an alert, own your own config
surface, and never let a wedged radio link touch the hub.

## What it pushes

| What | How | Where it goes |
|---|---|---|
| Node telemetry (battery, voltage, channel utilization, nodes seen) | replaced every `TELEMETRY_EVERY_S` | a **value** feed → gauges/dials |
| Received text messages (sender, text, channel, SNR, hops) | one row per message, per matching **route** | one or more **stream** feeds → list widgets |
| "New message" noise | `POST /api/notify`, `sound: true`, expires on its own | the devices in `ALERT_DEVICES` |

Messages are fanned out by **routes**, configured on the integration's
**own config page** (port `8600`), not in the hub: the hub sees feeds; only
this daemon knows what a Meshtastic channel or node is. A route is a target
stream feed plus an optional channel filter, an optional sender filter, and
a sound level:

- **silent** — the row lands in the feed, no alert at all
- **chime once** — severity `info`: one beep per message, never escalates
- **full alarm** — severity `critical`: the sustained escalating alarm until
  dismissed, for the one sender you never want to miss

A message is pushed to every route it matches (empty filters mean "any");
it sounds once, at the loudest level among the matched routes. A message
matching no route is dropped. So "everything on LongFast into the main
list, and anything from one specific node into its own feed with a real
alarm" is two routes.

A direct message never counts as the channel it was encrypted with — on
the air a DM looks exactly like primary-channel traffic, so treating it
that way would leak private messages into public-channel feeds. Instead
DMs match the **Direct messages** pseudo-channel in the picker (and, like
anything else, routes with no channel filter).

The feed row and the alert are deliberately both sent: the feed is what the
list widget renders, the alert is what makes a noise.

## Setup

On the hub (see the [walkthrough](../../docs/integrations.md) for each step):

1. Mint a sender for it (**Senders** tab; keep the token).
2. Create the feeds on the **Data sources** page: one **value** feed for
   telemetry, and one **stream** feed per message route you want (start
   with one for all messages; add more later without touching the hub
   again beyond creating the feed).
3. Note the device ids that should beep on new messages (**Devices** tab).

## Configuration

All by environment:

| Variable | Required | Meaning |
|---|---|---|
| `MESHTASTIC_HOST` | yes | Hostname/IP of the Meshtastic node (default `meshtastic.local`) |
| `HUB_URL` | yes | Hub base URL, e.g. `http://hub.example.lan:8484` |
| `DASHBOARDZ_TOKEN` | yes | The sender token (`dbz_s_...`) |
| `FEED_TELEMETRY` | yes | Id of the value feed (`feed_...`) |
| `FEED_MESSAGES` | first boot | Stream feed seeding the default all-messages route; ignored once routes exist in `/data` |
| `ALERT_DEVICES` | for sound | Comma-separated device ids to chime/alarm on a new message; unset = no sound (logged loudly) |
| `TELEMETRY_EVERY_S` | no | Telemetry push interval, seconds (default 30) |
| `ALERT_TTL_S` | no | Seconds a message beep-card lives (default 600) |
| `CONFIG_PORT` | no | Port for the channel-selection page (default 8600) |

## Run

As a service of this repo's `docker-compose.yml` (service `meshtastic` —
set `MESHTASTIC_HOST`, `MESH_TOKEN`, `FEED_TELEMETRY`, `FEED_MESSAGES` in
`.env`), or standalone:

```bash
docker build -t meshtastic-dashboardz integrations/meshtastic
docker run -d --restart unless-stopped -p 8600:8600 -v mesh-data:/data \
  -e MESHTASTIC_HOST=... -e HUB_URL=... -e DASHBOARDZ_TOKEN=... \
  -e FEED_TELEMETRY=... -e FEED_MESSAGES=... -e ALERT_DEVICES=... \
  meshtastic-dashboardz
```

Open `http://<host>:8600` to edit the routes. A fresh install (and any
pre-routes config) starts with one route sending every channel to
`FEED_MESSAGES` with a chime — never silently mute. The sender picker lists
the nodes the radio has heard by name; node ids it has not met yet go in
the free-text field as `!hex` ids.

## Uninstall

Stop and remove the container (and the `/data` volume), then delete the
`meshtastic` sender in the hub admin — its token stops working immediately.
Delete the two feeds too if nothing else reads them.
