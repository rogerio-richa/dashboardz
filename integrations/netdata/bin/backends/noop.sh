#!/usr/bin/env bash
# noop backend — appends one line per dispatch to the local log. Default on
# first install so nothing attempts network delivery until the operator sets
# DISPATCH_BACKEND=telegram (or another backend).

set -euo pipefail

LOG_FILE="${NETDATA_DISPATCH_LOG:-/opt/netdata-dashboardz/var/log/netdata-dispatch.log}"
ts=$(date -u +%FT%TZ)

printf '%s source=%s host=%s severity=%s alarm=%s status=%s unit=%s value=%s info=%q message=%q\n' \
    "$ts" \
    "${ND_SOURCE:-}" \
    "${ND_HOST:-}" \
    "${ND_SEVERITY:-}" \
    "${ND_ALARM:-}" \
    "${ND_STATUS:-}" \
    "${ND_UNIT:-}" \
    "${ND_VALUE:-}" \
    "${ND_INFO:-}" \
    "${ND_MESSAGE:-}" \
    >> "$LOG_FILE"
