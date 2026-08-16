# Netdata → Dashboardz

Shell scripts, no dependencies beyond `curl` and `jq`: [Netdata](https://www.netdata.cloud)
alarms become alerts on your wall, host metrics become gauges, and security-
relevant journal events become a scrolling stream. It demonstrates the
pipeline pattern from the [integration walkthrough](../../docs/integrations.md):
**alarm → dispatch → backend**, where Dashboardz is just one pluggable
backend — swap or fan out to others without touching the producers.

```
netdata custom_sender ─┐
journal-watcher (err) ─┤                        ┌─ noop.sh      (local log)
sudo-watcher ──────────┼─ netdata-dispatch.sh ──┼─ telegram.sh
lifecycle-watcher ─────┤   (--key val → ND_*)   └─ dashboardz.sh
critical-services ─────┘                            (alerts + journal feed)

netdata-feed-push.timer ── /proc → cpu/ram/disk/net value feeds (its own path,
                           deliberately independent of the alert pipeline)
```

## What lands on the hub

| Source | Becomes | Notes |
|---|---|---|
| Netdata health alarms (RAM, swap, OOM kills, failed systemd units, …) | alert (`/api/notify`), `warn`/`critical` by alarm status, `dedup_key` per host+alarm | a CLEAR retracts the card via `resolve` |
| Journal errors (`journalctl -p err`), sudo invocations, Started/Stopped of watched units, critical-service watchdog | rows on a **stream** feed | one list widget shows the host's security/ops narrative |
| CPU %, RAM %, root-disk %, network MB/s every ~15 s | **value** feeds | read from `/proc`, not netdata's API — survives netdata being down |

Give the metric feeds `stale_after_s` when you create them: a host that
stops pushing then *shows* stale instead of lying with old numbers — that,
not a failed systemd unit, is the designed failure signal for missed pushes.

## Install (5 minutes)

On the hub first (walkthrough steps 1–2): mint a **sender** for the host,
create the feeds — a stream feed for the journal, value feeds for
cpu/ram (disk/net optional), per host.

On the monitored host:

```bash
sudo ./install.sh          # places files; starts nothing
sudo vi /opt/netdata-dashboardz/etc/netdata-dispatch.env   # token, hub URL, feed ids, backend
sudo /opt/netdata-dashboardz/bin/netdata-dispatch.sh \
    --source test --host "$(hostname)" --status CRITICAL \
    --alarm smoke --value 1 --info "preflight"             # card appears on the wall
sudo ./enable.sh           # validates config, enables + starts everything
```

Two transports, chosen in the env file: **direct** (`DASHBOARDZ_HUB_URL`,
plain curl — use this when the host can reach the hub) or the **relay**
(`DASHBOARDZ_RELAY_URL` + `DASHBOARDZ_HUB_UID`, for hosts with no route to
the hub; needs the `dbz-send` CLI from the dashboardz repo's
`clients/sender` — `npm pack` it there and `npm install -g` the tarball on
the host, or vendor `dist/` and set `DBZ_SEND="node /path/to/cli.js"`).

Optionally list units in `/opt/netdata-dashboardz/etc/critical-services.conf`
(one per line) to get a CRITICAL when any of them leaves `active`, plus a
WARNING on every restart.

## How it maps onto the walkthrough

| Walkthrough step | Here |
|---|---|
| Mint a sender | one per host, `DASHBOARDZ_TOKEN` |
| Create feeds | journal (stream) + cpu/ram/disk/net (value), ids in the env file |
| Push with curl | `netdata-feed-push.sh` and `dashboardz.sh` are that same curl, wrapped in fail-soft plumbing |
| Alerts + resolve | `custom_sender` → dispatch → `dashboardz.sh`, CLEAR → `resolve` |
| Off-LAN | the relay transport via `dbz-send` |
| Ship it | env file + systemd units + this README |

## Design notes worth stealing

- **The dispatch seam.** Producers call `netdata-dispatch.sh --key value…`;
  it exports `ND_*` vars and exec's one backend script. Adding a
  destination is a new file in `bin/backends/`, not an edit to anything.
- **Fail soft, always.** `dashboardz.sh` and `netdata-feed-push.sh` exit 0
  no matter what: a hub outage must not look like a monitoring failure,
  and a missed 15 s push must not page anyone — the feed's staleness is
  the honest signal.
- **`fanout` + `FANOUT_SKIP_CLEAR`.** Run several backends per event, and
  let each opt out of CLEAR noise individually instead of filtering
  upstream where no backend gets a say.

## Uninstall

```bash
sudo ./uninstall.sh    # stops + removes units, netdata overrides, logrotate
sudo rm -rf /opt/netdata-dashboardz   # if you want the tree gone too
```

Then delete the host's sender in the hub admin (its token dies
immediately) and the feeds, if nothing else reads them. The Netdata agent
itself is left installed — remove it with its own uninstaller.
