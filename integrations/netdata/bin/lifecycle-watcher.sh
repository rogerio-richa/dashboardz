#!/usr/bin/env bash
# lifecycle-watcher.sh — tails systemd's own journal narration and fires a
# dispatch when a unit in the critical-services allowlist emits a Started
# or Stopped message. Catches fast restarts that the 60s watchdog timer
# misses.
#
# Shares the allowlist with critical-services-check.sh:
#   /opt/netdata-dashboardz/etc/critical-services.conf
# One systemd unit name per line. Empty file / missing file ⇒ no-op (the
# service runs but sleeps forever). Edit the file and restart this service
# to pick up changes.
#
# Run as root via netdata-lifecycle-watcher.service.

set -euo pipefail

HOST=$(hostname -s)
DISPATCH=/opt/netdata-dashboardz/bin/netdata-dispatch.sh
CONF=/opt/netdata-dashboardz/etc/critical-services.conf

declare -A watched
load_watched() {
    watched=()
    [ -r "$CONF" ] || return 0
    while IFS= read -r raw || [ -n "$raw" ]; do
        local unit="${raw%%#*}"
        unit=$(printf '%s' "$unit" | tr -d '[:space:]')
        [ -z "$unit" ] && continue
        watched["$unit"]=1
    done < "$CONF"
}

load_watched
if [ "${#watched[@]}" -eq 0 ]; then
    # Nothing to watch. Sleep so systemd doesn't restart-loop us.
    # Restart the service after populating the allowlist.
    exec sleep infinity
fi

journalctl -f -t systemd -o json --since=now --no-pager | \
while IFS= read -r line; do
    [ -z "$line" ] && continue
    msg=$(printf '%s' "$line" | jq -r '.MESSAGE // ""')

    case "$msg" in
        "Started "*)  event=started ;;
        "Stopped "*)  event=stopped ;;
        *)            continue ;;
    esac

    # Reload on each matching line so allowlist edits are picked up without
    # requiring a service restart. Cheap — small file, OS-cached.
    load_watched

    unit=$(printf '%s' "$line" | jq -r '.UNIT // ""')
    if [ -z "$unit" ]; then
        # Fallback: parse from message like "Started nginx.service - The ..."
        unit=$(printf '%s' "$msg" | sed -nE 's/^(Started|Stopped) ([^ .]+\.[a-z]+).*/\2/p')
    fi
    [ -z "$unit" ] && continue
    [ -n "${watched[$unit]:-}" ] || continue

    "$DISPATCH" \
        --source  lifecycle \
        --host    "$HOST" \
        --status  WARNING \
        --alarm   systemd_lifecycle \
        --unit    "$unit" \
        --event   "$event" \
        --message "$msg" \
        || true
done
