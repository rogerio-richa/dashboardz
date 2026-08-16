#!/usr/bin/env bash
# telegram backend — posts the dispatch to a Telegram chat.
# Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment
# (exported by netdata-dispatch.sh after sourcing
# /opt/netdata-dashboardz/etc/netdata-dispatch.env).

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?telegram backend: TELEGRAM_BOT_TOKEN not set}"
: "${TELEGRAM_CHAT_ID:?telegram backend: TELEGRAM_CHAT_ID not set}"

severity_icon() {
    case "$1" in
        critical) printf '🚨' ;;
        warning)  printf '⚠️' ;;
        clear)    printf '✅' ;;
        *)        printf 'ℹ️' ;;
    esac
}

src="${ND_SOURCE:-unknown}"
host="${ND_HOST:-?}"
sev="${ND_SEVERITY:-info}"
status="${ND_STATUS:-}"
alarm="${ND_ALARM:-}"
chart="${ND_CHART:-}"
unit="${ND_UNIT:-}"
value="${ND_VALUE:-}"
info="${ND_INFO:-}"
msg="${ND_MESSAGE:-}"

icon=$(severity_icon "$sev")
status_tag="${status:-$(printf '%s' "$sev" | tr '[:lower:]' '[:upper:]')}"

# Plain-text body (no Markdown parse_mode — avoids escaping hazards with log
# content that could contain arbitrary characters). `if [ -n ... ]` instead of
# `[ -n ... ] && printf` because the latter returns 1 when the test is false,
# which under `set -o pipefail` bubbles up as the whole pipe's rc even after
# a successful curl — causing alarm-notify.sh to flag every alert as failed.
build_body() {
    printf '%s [%s] %s\n' "$icon" "$status_tag" "$host"
    case "$src" in
        netdata)
            printf 'alarm: %s\n' "$alarm"
            if [ -n "$chart" ]; then printf 'chart: %s\n' "$chart"; fi
            if [ -n "$value" ]; then printf 'value: %s\n' "$value"; fi
            if [ -n "$info" ];  then printf 'info:  %s\n' "$info";  fi
            ;;
        journal)
            printf 'unit:  %s\n' "${unit:-?}"
            if [ -n "${ND_PRIORITY:-}" ]; then printf 'prio:  %s\n' "$ND_PRIORITY"; fi
            if [ -n "$msg" ];             then printf 'msg:   %s\n' "$msg";         fi
            ;;
        watchdog)
            printf 'alarm: %s\n' "$alarm"
            printf 'unit:  %s\n' "${unit:-?}"
            if [ -n "$value" ]; then printf 'state: %s\n' "$value"; fi
            if [ -n "$info" ];  then printf '%s\n'        "$info";  fi
            ;;
        sudo)
            printf 'actor:  %s\n'  "${ND_ACTOR:-?}"
            printf 'target: %s\n'  "${ND_TARGET:-?}"
            printf 'tty:    %s\n'  "${ND_TTY:-?}"
            printf 'cmd:    %s\n'  "${ND_COMMAND:-?}"
            ;;
        lifecycle)
            printf 'unit:  %s\n'  "${ND_UNIT:-?}"
            printf 'event: %s\n'  "${ND_EVENT:-?}"
            if [ -n "${ND_MESSAGE:-}" ]; then printf 'msg:   %s\n' "$ND_MESSAGE"; fi
            ;;
        *)
            if [ -n "$alarm" ]; then printf 'alarm: %s\n' "$alarm"; fi
            if [ -n "$info" ];  then printf 'info:  %s\n' "$info";  fi
            if [ -n "$msg" ];   then printf 'msg:   %s\n' "$msg";   fi
            ;;
    esac
}

build_body | curl -fsS --max-time 10 \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text@-" \
    --data-urlencode "disable_web_page_preview=true" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    >/dev/null
