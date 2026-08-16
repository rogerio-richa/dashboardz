#!/usr/bin/env bash
# dashboardz backend — mirrors dispatch events to a dashboardz hub. Runs
# alongside (not instead of) whatever else fanout.sh also runs.
#
# Two transports, picked by what's configured in the env file:
#   direct — DASHBOARDZ_HUB_URL set: plain HTTPS/HTTP to the hub's
#            /api/notify and /api/feeds/:id, authenticated with the sender
#            token. This is the path the integration walkthrough teaches;
#            all it needs is curl.
#   relay  — DASHBOARDZ_RELAY_URL + DASHBOARDZ_HUB_UID set (and no hub
#            URL): the `dbz-send` CLI (dashboardz repo, clients/sender)
#            over the relay websocket, payloads sealed so the relay sees
#            only ciphertext + routing metadata. For hosts with no route
#            to the hub.
#
# Branches on ND_SOURCE:
#   netdata (custom_sender alarms) -> a notify with dedup key
#            netdata:$ND_HOST:$ND_ALARM. Severity comes from ND_SEVERITY
#            (already normalized to critical/warning/clear/info by
#            netdata-dispatch.sh off ND_STATUS, since custom_sender never
#            passes --severity itself). A CLEAR becomes a resolve of that
#            same dedup key, so the card retracts when the alarm clears.
#   anything else (journal, sudo, lifecycle, watchdog, ...) -> a row
#            appended to the DASHBOARDZ_FEED_JOURNAL stream feed.
#
# Missing DASHBOARDZ_FEED_JOURNAL only disables the journal-feed branch;
# no transport configured disables the backend entirely; a missing
# dbz-send binary disables the relay transport. Every case is a logged
# no-op, never a failure — see below.
#
# Deliberately NOT `set -e`: a hub/relay outage, a timeout, a bad or
# rotated token — none of that may ever surface as a dispatch failure,
# because fanout.sh runs this alongside telegram.sh and a non-zero exit
# here must never stop (or look like it broke) the other backend's
# delivery. Every branch below checks its own command's result explicitly;
# the script always exits 0.

set -uo pipefail

TIMEOUT_SECONDS=5

log() { printf 'dashboardz: %s\n' "$*" >&2; }

: "${DASHBOARDZ_HUB_URL:=}"
: "${DASHBOARDZ_RELAY_URL:=}"
: "${DASHBOARDZ_HUB_UID:=}"
: "${DASHBOARDZ_TOKEN:=}"
: "${DASHBOARDZ_HOST_LABEL:=}"
: "${DASHBOARDZ_FEED_JOURNAL:=}"
: "${DBZ_SEND:=dbz-send}"

# The example env ships every slot as replace-me; treat that the same as
# unset so a half-filled file degrades to a logged no-op, not a push to a
# host literally named replace-me.
is_set() { [ -n "$1" ] && [ "$1" != "replace-me" ]; }

TRANSPORT=
if is_set "$DASHBOARDZ_TOKEN"; then
    if is_set "$DASHBOARDZ_HUB_URL"; then
        TRANSPORT=direct
    elif is_set "$DASHBOARDZ_RELAY_URL" && is_set "$DASHBOARDZ_HUB_UID"; then
        TRANSPORT=relay
    fi
fi
if [ -z "$TRANSPORT" ]; then
    log "no transport configured (need DASHBOARDZ_TOKEN plus HUB_URL, or RELAY_URL+HUB_UID) — skipping"
    exit 0
fi

if [ "$TRANSPORT" = "relay" ]; then
    # DBZ_SEND may be a single binary name (default: "dbz-send", resolved on
    # PATH) or a multi-word command (e.g. "node /opt/.../dist/cli.js") for a
    # host where it's vendored rather than installed globally.
    # shellcheck disable=SC2206
    DBZ_SEND_CMD=($DBZ_SEND)
    if [ "${#DBZ_SEND_CMD[@]}" -eq 0 ] || ! command -v "${DBZ_SEND_CMD[0]}" >/dev/null 2>&1; then
        log "dbz-send not found (DBZ_SEND='${DBZ_SEND}') — is it installed on this host? skipping"
        exit 0
    fi
fi

hub_post() {
    # $1 = path, $2 = JSON body
    curl -fsS --max-time "$TIMEOUT_SECONDS" -X POST "$DASHBOARDZ_HUB_URL$1" \
        -H "Authorization: Bearer $DASHBOARDZ_TOKEN" \
        -H "content-type: application/json" \
        -d "$2" >/dev/null 2>&1
}

send_notify() {
    # $1 = title, $2 = severity (info|warn|critical), $3 = body, $4 = dedup key
    if [ "$TRANSPORT" = "direct" ]; then
        local payload
        payload=$(jq -nc --arg title "$1" --arg sev "$2" --arg body "$3" --arg dedup "$4" \
            '{title: $title, severity: $sev, body: $body, dedup_key: $dedup}') || return 1
        hub_post /api/notify "$payload"
    else
        timeout "$TIMEOUT_SECONDS" "${DBZ_SEND_CMD[@]}" \
            --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" --token "$DASHBOARDZ_TOKEN" \
            --title "$1" --severity "$2" --body "$3" --dedup-key "$4" >/dev/null 2>&1
    fi
}

send_resolve() {
    # $1 = dedup key
    if [ "$TRANSPORT" = "direct" ]; then
        local payload
        payload=$(jq -nc --arg dedup "$1" '{resolve: true, dedup_key: $dedup}') || return 1
        hub_post /api/notify "$payload"
    else
        timeout "$TIMEOUT_SECONDS" "${DBZ_SEND_CMD[@]}" \
            --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" --token "$DASHBOARDZ_TOKEN" \
            --resolve --dedup-key "$1" >/dev/null 2>&1
    fi
}

send_data() {
    # $1 = feed id, $2 = JSON payload
    if [ "$TRANSPORT" = "direct" ]; then
        hub_post "/api/feeds/$1" "$2"
    else
        timeout "$TIMEOUT_SECONDS" "${DBZ_SEND_CMD[@]}" data "$1" \
            --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" --token "$DASHBOARDZ_TOKEN" \
            --json "$2" >/dev/null 2>&1
    fi
}

# Severity mapping (netdata alarm path only): WARNING->warn, CRITICAL->
# critical, CLEAR->resolve (a sentinel handled below, not an API value),
# anything else->info.
map_severity() {
    case "${ND_SEVERITY:-}" in
        critical) printf 'critical' ;;
        warning)  printf 'warn' ;;
        clear)    printf 'resolve' ;;
        *)        printf 'info' ;;
    esac
}

post_notify() {
    local sev dedup title body

    sev=$(map_severity)
    dedup="netdata:${ND_HOST:-unknown}:${ND_ALARM:-unknown}"

    if [ "$sev" = "resolve" ]; then
        if ! send_resolve "$dedup"; then
            log "resolve failed for alarm=${ND_ALARM:-?} (dedup=$dedup)"
            return 1
        fi
        return 0
    fi

    title="${ND_ALARM:-alarm} on ${ND_HOST:-?}"
    body=$(printf 'chart: %s\nvalue: %s\n%s' "${ND_CHART:-?}" "${ND_VALUE:-?}" "${ND_INFO:-}")
    if is_set "$DASHBOARDZ_HOST_LABEL"; then
        body=$(printf 'env: %s\n%s' "$DASHBOARDZ_HOST_LABEL" "$body")
    fi

    if ! send_notify "$title" "$sev" "$body" "$dedup"; then
        log "notify failed for alarm=${ND_ALARM:-?}"
        return 1
    fi
}

post_journal_feed() {
    local payload

    if ! is_set "$DASHBOARDZ_FEED_JOURNAL"; then
        log "DASHBOARDZ_FEED_JOURNAL not set — skipping journal feed push for source=${ND_SOURCE:-?}"
        return 0
    fi

    if ! payload=$(jq -nc \
        --arg env      "${DASHBOARDZ_HOST_LABEL}" \
        --arg source   "${ND_SOURCE:-}" \
        --arg host     "${ND_HOST:-}" \
        --arg unit     "${ND_UNIT:-}" \
        --arg event    "${ND_EVENT:-}" \
        --arg actor    "${ND_ACTOR:-}" \
        --arg target   "${ND_TARGET:-}" \
        --arg tty      "${ND_TTY:-}" \
        --arg command  "${ND_COMMAND:-}" \
        --arg priority "${ND_PRIORITY:-}" \
        --arg message  "${ND_MESSAGE:-}" \
        '{env: $env, source: $source, host: $host, unit: $unit, event: $event,
          actor: $actor, target: $target, tty: $tty, command: $command,
          priority: $priority, message: $message}
         | with_entries(select(.value != ""))'); then
        log "failed to build journal feed payload for source=${ND_SOURCE:-?}"
        return 1
    fi

    if ! send_data "$DASHBOARDZ_FEED_JOURNAL" "$payload"; then
        log "journal feed push failed for source=${ND_SOURCE:-?}"
        return 1
    fi
}

case "${ND_SOURCE:-}" in
    netdata) post_notify || true ;;
    *)       post_journal_feed || true ;;
esac

exit 0
