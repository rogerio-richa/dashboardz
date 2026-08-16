#!/usr/bin/env bash
# netdata-dispatch.sh — generic, pluggable alert dispatcher.
#
# Producers (Netdata custom_sender, journal-watcher, critical-services-check)
# call this script with --key value flags. Flags are exported as ND_KEY env
# vars, then the selected backend script is exec'd. To swap backends, drop a
# script at /opt/netdata-dashboardz/bin/backends/<name>.sh and set
# DISPATCH_BACKEND in /opt/netdata-dashboardz/etc/netdata-dispatch.env.

set -euo pipefail

ENV_FILE=/opt/netdata-dashboardz/etc/netdata-dispatch.env
if [ -r "$ENV_FILE" ]; then
    # `set -a` exports every assigned variable so the backend inherits
    # TELEGRAM_* (and any future backend config) after the exec below.
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi
: "${DISPATCH_BACKEND:=noop}"
: "${DISPATCH_BACKENDS_DIR:=/opt/netdata-dashboardz/bin/backends}"

while [ $# -gt 0 ]; do
    key="$1"
    case "$key" in
        --*)
            var="ND_$(printf '%s' "${key#--}" | tr 'a-z-' 'A-Z_')"
            if [ $# -ge 2 ]; then
                export "$var=$2"
                shift 2
            else
                export "$var=1"
                shift
            fi
            ;;
        *)
            echo "dispatch: unexpected positional arg: $1" >&2
            exit 64
            ;;
    esac
done

if [ -z "${ND_SEVERITY:-}" ]; then
    case "${ND_STATUS:-}" in
        CRITICAL) export ND_SEVERITY=critical ;;
        WARNING)  export ND_SEVERITY=warning  ;;
        CLEAR)    export ND_SEVERITY=clear    ;;
        *)        export ND_SEVERITY=info     ;;
    esac
fi

backend="$DISPATCH_BACKENDS_DIR/${DISPATCH_BACKEND}.sh"
if [ ! -x "$backend" ]; then
    echo "dispatch: backend '$DISPATCH_BACKEND' not executable at $backend" >&2
    exit 2
fi

exec "$backend"
