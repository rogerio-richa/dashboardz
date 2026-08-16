# Meshtastic integration

[`integrations/meshtastic`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/meshtastic) is a long-running
Python daemon, shipped as a container, that connects to a Meshtastic radio
node over TCP. It pushes node telemetry to a value feed, fans received text
messages out to stream feeds by configurable routes, and raises an alert for
messages that should make noise. It owns its own small config page; the hub
only ever sees feeds and alerts. The folder's
[README](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/README.md) is the setup guide;
[Meshtastic radios](../gallery/meshtastic.md) is the overview.

## Start here

1. [`main.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/main.py): starts the config page on
   a daemon thread (port `CONFIG_PORT`, default 8600) and runs the radio
   listener on the main thread.
2. [`monitor.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/monitor.py): `Monitor`, the
   radio loop. Reconnects forever, pushes telemetry every
   `TELEMETRY_EVERY_S`, and for each text message pushes a row to every
   matching route's feed and sends one `POST /api/notify` at the loudest
   matched level. `push()` and `notify()` are the two HTTP calls.
3. [`routing.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/routing.py): pure functions:
   which routes a message matches, the loudest sound, severity for a sound
   level, route normalisation and the v1 config migration.

## The other files

| File | Role |
| --- | --- |
| [`config_store.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/config_store.py) | `ConfigStore`: routes persisted as JSON on the container's volume; seeds one catch-all route from `FEED_MESSAGES` on first boot. |
| [`config_http.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/config_http.py) | The config page: stdlib `http.server`, no JavaScript, one form of route cards. |
| [`Dockerfile`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/Dockerfile), [`requirements.txt`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/requirements.txt) | Container image and Python dependencies. |

## How it connects

Two public sender calls: `POST /api/feeds/:id` for telemetry and message rows,
and `POST /api/notify` for the alert ([routes](hub-routes.md)). Feeds are
created in the hub admin; the daemon is configured by environment
(`MESHTASTIC_HOST`, `HUB_URL`, `DASHBOARDZ_TOKEN`, `FEED_TELEMETRY`,
`FEED_MESSAGES`, `ALERT_DEVICES`, ...).

## Things that trip people up

- **A direct message is never treated as its channel.** On air a DM looks like
  primary-channel traffic; routing maps it to a "Direct messages"
  pseudo-channel so private messages cannot leak into public feeds.
- **Empty filters mean "any".** An empty route that matched nothing would look
  identical to a dead radio link.
- **`FEED_MESSAGES` only matters on first boot.** After that the routes in the
  config file are the truth.
- **Keep `routing.py` free of `meshtastic` and `requests` imports** so its
  tests run anywhere.

## Tests

Standard-library `unittest`, one file per module:
[`test_routing.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/test_routing.py),
[`test_config_store.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/test_config_store.py),
[`test_config_http.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/test_config_http.py),
[`test_monitor.py`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/meshtastic/test_monitor.py). Run with
`.venv/bin/python -m unittest discover -s integrations/meshtastic -p 'test_*.py'`.
