#!/usr/bin/env bash
# fanout backend — runs every backend named in FANOUT_BACKENDS, in order,
# ignoring individual failures. This is how a second backend (dashboardz)
# rides along with an existing one (telegram) without editing the shipped
# netdata-dispatch.sh or telegram.sh at all: set DISPATCH_BACKEND=fanout
# and FANOUT_BACKENDS="telegram dashboardz" in
# /opt/netdata-dashboardz/etc/netdata-dispatch.env.
#
# Each named backend runs as its own process (not sourced), so a `set -e`
# exit or unset-variable blowup in one backend can't abort the rest — and
# each inherits the same ND_*/env-file variables netdata-dispatch.sh
# already exported via `set -a` before exec'ing into this script.
#
# FANOUT_SKIP_CLEAR (space-separated backend names, e.g. "telegram") skips
# a listed backend entirely for a CLEAR event (ND_STATUS=CLEAR — set for
# netdata recoveries and for the critical-services watchdog's ND_SOURCE=
# watchdog recovery, both of which pass --status CLEAR). This exists
# because config/netdata/health_alarm_notify.conf no longer filters CLEAR
# out before dispatch (it has to reach dashboardz.sh for the --resolve
# path), so a backend that never wanted CLEAR noise — historically
# Telegram, to avoid resolve-spam — opts out here instead, per backend,
# rather than the event being dropped upstream of every backend.
#
# Deliberately NOT `set -e`, for the same reason as the loop body below:
# one backend's failure must not stop the loop from reaching the next
# backend.

set -uo pipefail

: "${DISPATCH_BACKENDS_DIR:=/opt/netdata-dashboardz/bin/backends}"
: "${FANOUT_BACKENDS:=}"
: "${FANOUT_SKIP_CLEAR:=}"

if [ -z "$FANOUT_BACKENDS" ]; then
    echo "fanout: FANOUT_BACKENDS is empty — nothing to run" >&2
    exit 0
fi

declare -A skip_clear
for name in $FANOUT_SKIP_CLEAR; do
    skip_clear["$name"]=1
done

status=0
for name in $FANOUT_BACKENDS; do
    backend="$DISPATCH_BACKENDS_DIR/${name}.sh"
    if [ ! -x "$backend" ]; then
        echo "fanout: backend '$name' not executable at $backend — skipping" >&2
        status=1
        continue
    fi
    if [ "${ND_STATUS:-}" = "CLEAR" ] && [ -n "${skip_clear[$name]:-}" ]; then
        echo "fanout: backend '$name' skipped for a CLEAR event (FANOUT_SKIP_CLEAR)" >&2
        continue
    fi
    if ! "$backend"; then
        echo "fanout: backend '$name' exited non-zero — continuing" >&2
        status=1
    fi
done

exit "$status"
