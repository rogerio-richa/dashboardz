#!/usr/bin/env bash
# sudo-watcher.sh — tails the systemd journal for sudo invocations and fires
# one dispatch per command execution (both successful and
# incorrect-password-attempt cases, which both include COMMAND= in the log
# line). Skips sudo's PAM session/auth-failure narration, and routine
# validation (`sudo -v`) which has no COMMAND=.
#
# Run as root via netdata-sudo-watcher.service.

set -euo pipefail

HOST=$(hostname -s)
DISPATCH=/opt/netdata-dashboardz/bin/netdata-dispatch.sh

journalctl -f SYSLOG_IDENTIFIER=sudo -o json --since=now --no-pager | \
while IFS= read -r line; do
    [ -z "$line" ] && continue
    msg=$(printf '%s' "$line" | jq -r '.MESSAGE // ""')
    case "$msg" in
        *COMMAND=*) ;;
        *)          continue ;;
    esac

    actor=${msg%% :*}
    actor=${actor## }
    target=$(printf '%s' "$msg" | sed -n 's/.*USER=\([^ ;]*\).*/\1/p')
    tty=$(printf    '%s' "$msg" | sed -n 's/.*TTY=\([^ ;]*\).*/\1/p')
    cmd=$(printf    '%s' "$msg" | sed -n 's/.*COMMAND=\(.*\)$/\1/p')

    "$DISPATCH" \
        --source  sudo \
        --host    "$HOST" \
        --status  WARNING \
        --alarm   sudo_command \
        --actor   "${actor:-?}" \
        --target  "${target:-?}" \
        --tty     "${tty:-?}" \
        --command "${cmd:-?}" \
        --message "$msg" \
        || true
done
