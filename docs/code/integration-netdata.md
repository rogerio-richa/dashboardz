# Netdata integration

[`integrations/netdata`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/netdata) is a set of Bash scripts,
systemd units and Netdata config that run on a monitored Linux host. Netdata
alarms become alerts, host metrics become value feeds, and security-relevant
journal events become a stream feed. Dependencies are `curl` and `jq` (plus
`dbz-send` for the relay transport). The folder's
[README](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/README.md) is the install guide and has the
pipeline diagram; [Netdata fleet health](../gallery/netdata.md) is the
overview.

## Start here

1. [`bin/netdata-dispatch.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/bin/netdata-dispatch.sh):
   the seam. Producers call it with `--key value` flags; it exports them as
   `ND_*` variables, normalises severity, and `exec`s the backend named by
   `DISPATCH_BACKEND`.
2. [`bin/backends/dashboardz.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/bin/backends/dashboardz.sh):
   the Dashboardz backend. Netdata alarms become `POST /api/notify` with a
   `dedup_key` per host and alarm (a CLEAR sends `resolve: true`); watcher
   events become rows on the journal stream feed. It uses `curl` directly when
   `DASHBOARDZ_HUB_URL` is set, otherwise `dbz-send` over the relay.
3. [`bin/netdata-feed-push.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/bin/netdata-feed-push.sh):
   the metrics path, separate from alerting. Reads CPU, RAM, disk and network
   from `/proc` on a timer and pushes value feeds.

## The other files

| Path | Role |
| --- | --- |
| [`bin/backends/`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/netdata/bin/backends) | `fanout.sh` (run several backends), `noop.sh` (log only), `telegram.sh`. |
| `bin/*-watcher.sh`, [`bin/critical-services-check.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/bin/critical-services-check.sh) | Producers: journal errors, sudo use, unit start/stop, a watchdog over listed services. |
| [`config/`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/netdata/config) | Netdata health and notify overrides, journald size cap, logrotate fragment, watchdog example. |
| [`systemd/`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/netdata/systemd) | Services and timers for the watchers and the feed push. |
| [`install.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/install.sh), [`enable.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/enable.sh), [`uninstall.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/uninstall.sh) | Place files under `/opt/netdata-dashboardz` (starts nothing), validate and start, remove. |
| [`env/example.env`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/netdata/env/example.env) | Every setting: token, hub URL or relay, feed ids, backend choice. |

## How it connects

Only the public sender API: `POST /api/notify` and `POST /api/feeds/:id`
([routes](hub-routes.md)), or the same requests sealed through the relay by
[`dbz-send`](sender.md). The hub knows nothing about Netdata.

## Things that trip people up

- **Fail soft, always.** `dashboardz.sh` and `netdata-feed-push.sh` exit 0
  whatever happens; a hub outage must not look like a monitoring failure.
  Missed pushes show up as a stale feed (give metric feeds `stale_after_s`).
- **Metrics do not go through Netdata.** They read `/proc`, so they keep
  flowing when the Netdata agent is down.
- **Adding a destination is a new file** in `bin/backends/`, not an edit to
  the dispatcher.

## Tests

None automated, and the integration is not part of `scripts/check-all.sh`.
The README's preflight (`netdata-dispatch.sh --source test ...` before
`enable.sh`) is the smoke test on a real host.
