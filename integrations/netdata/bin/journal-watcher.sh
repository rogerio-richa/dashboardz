#!/usr/bin/env bash
# journal-watcher.sh — tails journalctl at PRIORITY<=3 (err/crit/alert/emerg)
# and fires one dispatch per line. Run as root via netdata-journal-watcher.service.
#
# Set JOURNAL_WATCHER_IGNORE_UNITS in /opt/netdata-dashboardz/etc/netdata-dispatch.env to a
# comma- or space-separated list of unit names to skip (e.g. "nginx.service")
# — for services whose err-level logs are known noise (bot scanning, upstream
# flaps) and not actionable. Prefer fixing the source of err logs over adding
# here; only list a unit when the noise is genuinely unfixable.

set -euo pipefail

HOST=$(hostname -s)
DISPATCH=/opt/netdata-dashboardz/bin/netdata-dispatch.sh

# shellcheck disable=SC1091
[ -r /opt/netdata-dashboardz/etc/netdata-dispatch.env ] && . /opt/netdata-dashboardz/etc/netdata-dispatch.env
: "${JOURNAL_WATCHER_IGNORE_UNITS:=}"

declare -A ignore
for u in ${JOURNAL_WATCHER_IGNORE_UNITS//,/ }; do
    [ -n "$u" ] && ignore["$u"]=1
done

journalctl -f -p err -o json --since=now --no-pager | \
while IFS= read -r line; do
    [ -z "$line" ] && continue
    unit=$(printf '%s' "$line" | jq -r '._SYSTEMD_UNIT // .SYSLOG_IDENTIFIER // "kernel"')
    [ -n "${ignore[$unit]:-}" ] && continue
    msg=$(printf '%s' "$line" | jq -r '.MESSAGE // "(no message)"')
    pri=$(printf '%s' "$line" | jq -r '.PRIORITY // "3"')

    # MESSAGE can be a byte array for binary content — coerce to string.
    if [ "$msg" = "null" ] || [ -z "$msg" ]; then
        msg=$(printf '%s' "$line" | jq -r '.MESSAGE | if type=="array" then (map(tostring) | join(",")) else "(no message)" end' 2>/dev/null || echo "(no message)")
    fi

    "$DISPATCH" \
        --source   journal \
        --host     "$HOST" \
        --status   CRITICAL \
        --alarm    journal_error \
        --unit     "$unit" \
        --priority "$pri" \
        --message  "$msg" \
        || true
done
