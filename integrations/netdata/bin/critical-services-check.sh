#!/usr/bin/env bash
# critical-services-check.sh — pages when any unit listed in
# /opt/netdata-dashboardz/etc/critical-services.conf is not in 'active'
# state. Invoked every ~60s by netdata-critical-services.timer. Tracks
# per-unit state in /opt/netdata-dashboardz/var/state/ so it doesn't
# re-page on every tick, and emits a single CLEAR on recovery.

set -euo pipefail

CONF=/opt/netdata-dashboardz/etc/critical-services.conf
STATE_DIR=/opt/netdata-dashboardz/var/state
DISPATCH=/opt/netdata-dashboardz/bin/netdata-dispatch.sh

# shellcheck disable=SC1091
[ -r /opt/netdata-dashboardz/etc/netdata-dispatch.env ] && . /opt/netdata-dashboardz/etc/netdata-dispatch.env
: "${WATCHDOG_REPEAT_MINUTES:=30}"

[ -r "$CONF" ] || exit 0

mkdir -p "$STATE_DIR"
HOST=$(hostname -s)
now=$(date +%s)
repeat_seconds=$((WATCHDOG_REPEAT_MINUTES * 60))

sanitize() { printf '%s' "$1" | tr '/:' '__'; }

read_state_file() {
    local f="$1" key="$2"
    [ -r "$f" ] || { printf ''; return; }
    awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/, ""); print; exit}' "$f"
}

while IFS= read -r raw || [ -n "$raw" ]; do
    unit="${raw%%#*}"
    unit="$(printf '%s' "$unit" | tr -d '[:space:]')"
    [ -z "$unit" ] && continue

    state=$(systemctl is-active "$unit" 2>/dev/null || true)
    [ -z "$state" ] && state=unknown

    file="$STATE_DIR/$(sanitize "$unit")"
    prev_state=$(read_state_file "$file" state); : "${prev_state:=unknown}"
    prev_ts=$(read_state_file "$file" ts);       : "${prev_ts:=0}"

    if [ "$state" != "active" ]; then
        should_page=0
        if [ "$prev_state" = "active" ] || [ "$prev_state" = "unknown" ]; then
            should_page=1
        elif [ "$((now - prev_ts))" -ge "$repeat_seconds" ]; then
            should_page=1
        fi

        if [ "$should_page" = "1" ]; then
            "$DISPATCH" \
                --source watchdog \
                --host   "$HOST" \
                --status CRITICAL \
                --alarm  critical_service_down \
                --unit   "$unit" \
                --value  "$state" \
                --info   "Critical service $unit is $state (expected active)" \
                || true
            printf 'state=%s\nts=%s\n' "$state" "$now" > "$file"
        fi
    else
        if [ "$prev_state" != "active" ] && [ "$prev_state" != "unknown" ]; then
            "$DISPATCH" \
                --source watchdog \
                --host   "$HOST" \
                --status CLEAR \
                --alarm  critical_service_down \
                --unit   "$unit" \
                --value  active \
                --info   "Critical service $unit recovered" \
                || true
        fi
        printf 'state=%s\nts=%s\n' "$state" "$now" > "$file"
    fi
done < "$CONF"
