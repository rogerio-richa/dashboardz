#!/usr/bin/env bash
# netdata-feed-push.sh — pushes this host's CPU/RAM/disk/network numbers to
# its dashboardz value feeds. Invoked every ~15s by netdata-feed-push.timer,
# as its own systemd unit — entirely separate from the alert dispatch path
# (netdata-dispatch.sh / bin/backends/*), so a stuck or failing push can
# never block netdata or a real alert. Failure here just means the board
# renders those feeds as stale; nothing about netdata itself is affected.
#
# Same two transports as bin/backends/dashboardz.sh: direct HTTP to
# DASHBOARDZ_HUB_URL (curl only), or the relay via `dbz-send` when only
# DASHBOARDZ_RELAY_URL + DASHBOARDZ_HUB_UID are set.
#
# Metrics are read straight from the kernel (/proc/stat, /proc/meminfo),
# NOT from netdata's own HTTP API — this stack ships `[web] mode = none`
# (netdata's HTTP listener off entirely), and this script deliberately has
# no netdata-API or even netdata-running dependency at all.
#
#   cpu_pct: two samples of /proc/stat's aggregate "cpu" line ~1s apart,
#            100 * (1 - idle_delta/total_delta), idle meaning idle+iowait.
#            The ~1s sample window means this script's own oneshot run
#            takes a bit over a second — comfortably inside the timer's
#            15s cadence, but worth knowing before tightening that cadence.
#   ram_pct: from /proc/meminfo, 100 * (1 - MemAvailable/MemTotal).
#   disk:    df -P on / — {used_pct, free_gb}. The root filesystem only.
#   net:     two samples of /proc/net/dev ~1s apart, summed over every
#            interface except lo — {rx_mbps, tx_mbps} in MB/s (decimal
#            megabytes). Its own sample window (not shared with cpu's)
#            keeps each metric independent; total runtime stays ~2.5s
#            inside the 15s cadence.
#
# Push payloads are exactly {"cpu_pct": N} / {"ram_pct": N} — widgets bind
# to those path names, so the keys are not free-form here. A feed id is the
# hub's opaque id (feed_...), shown on the admin Data sources page when the
# feed is created — NOT the human-readable feed name that labels it.
#
# Deliberately NOT `set -e`: the metrics are independent pushes and one
# failing (unreadable /proc file, hub/relay unreachable, feed id unset)
# must not skip the others.
#
# ALWAYS exits 0: exiting non-zero on a missed push puts the systemd unit
# in `failed`, which this stack's own systemd-unit alarm then escalates to
# a CRITICAL on the wall — for a single missed 15s push whose real cost is
# a briefly-stale gauge. The board already renders staleness honestly
# (feeds carry stale_after_s), so staleness IS the alarm; the unit state
# is not. Misses stay visible via journalctl.

set -uo pipefail

# 10s, not 5: a relay push is a fresh node process + TLS + relay round
# trip, and on a small VM a cold first push can take over 5s — a transient
# miss, not a failure worth alarming on.
TIMEOUT_SECONDS=10

ENV_FILE=/opt/netdata-dashboardz/etc/netdata-dispatch.env
if [ -r "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

: "${DASHBOARDZ_HUB_URL:=}"
: "${DASHBOARDZ_RELAY_URL:=}"
: "${DASHBOARDZ_HUB_UID:=}"
: "${DASHBOARDZ_TOKEN:=}"
: "${DASHBOARDZ_FEED_CPU:=}"
: "${DASHBOARDZ_FEED_RAM:=}"
: "${DASHBOARDZ_FEED_DISK:=}"
: "${DASHBOARDZ_FEED_NET:=}"
: "${DBZ_SEND:=dbz-send}"

log() { printf 'netdata-feed-push: %s\n' "$*" >&2; }

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
    log "no transport configured (need DASHBOARDZ_TOKEN plus HUB_URL, or RELAY_URL+HUB_UID) — nothing to do"
    exit 0
fi

if [ "$TRANSPORT" = "relay" ]; then
    # shellcheck disable=SC2206
    DBZ_SEND_CMD=($DBZ_SEND)
    if [ "${#DBZ_SEND_CMD[@]}" -eq 0 ] || ! command -v "${DBZ_SEND_CMD[0]}" >/dev/null 2>&1; then
        log "dbz-send not found (DBZ_SEND='${DBZ_SEND}') — is it installed on this host? nothing to do"
        exit 0
    fi
fi

# 100 * (1 - idle_delta/total_delta) across two /proc/stat samples ~1s
# apart. "idle" is idle+iowait, matching the kernel's own accounting split
# (iowait is CPU sitting idle waiting on I/O, not doing work, so it counts
# toward idle here the same way top/htop treat it).
cpu_pct() {
    local snap1 snap2 pct
    snap1=$(awk '/^cpu / {print; exit}' /proc/stat)
    [ -z "$snap1" ] && return 1
    sleep 1
    snap2=$(awk '/^cpu / {print; exit}' /proc/stat)
    [ -z "$snap2" ] && return 1

    pct=$(awk -v s1="$snap1" -v s2="$snap2" '
        BEGIN {
            n1 = split(s1, a1, " "); n2 = split(s2, a2, " ")
            idle1 = a1[5] + a1[6]; idle2 = a2[5] + a2[6]
            tot1 = 0; for (i = 2; i <= n1; i++) tot1 += a1[i]
            tot2 = 0; for (i = 2; i <= n2; i++) tot2 += a2[i]
            dtot = tot2 - tot1; didle = idle2 - idle1
            if (dtot <= 0) exit 1
            printf "%.1f", (1 - didle / dtot) * 100
        }
    ') || return 1
    printf '%s' "$pct"
}

# 100 * (1 - MemAvailable/MemTotal) from /proc/meminfo (values in kB, but
# the unit cancels out — only the ratio matters).
ram_pct() {
    local pct
    pct=$(awk '
        /^MemTotal:/     { total = $2 }
        /^MemAvailable:/ { avail = $2 }
        END {
            if (total == "" || avail == "" || total <= 0) exit 1
            printf "%.1f", (1 - avail / total) * 100
        }
    ' /proc/meminfo) || return 1
    printf '%s' "$pct"
}

# {used_pct, free_gb} for the root filesystem, via POSIX df (1K blocks).
disk_json() {
    df -P -k / | awk 'NR == 2 {
        total = $2; avail = $4
        if (total <= 0) exit 1
        printf "{\"used_pct\": %.1f, \"free_gb\": %.1f}", (1 - avail / total) * 100, avail / 1048576
    }'
}

# {rx_mbps, tx_mbps} in MB/s: two samples of /proc/net/dev ~1s apart, bytes
# summed over every interface except lo. Decimal MB (1e6), 2 decimals —
# idle links legitimately read 0.00.
net_json() {
    local snap1 snap2
    snap1=$(awk -F'[: ]+' '/:/ { gsub(/^ +/, ""); if ($1 != "lo") { rx += $2; tx += $10 } } END { printf "%d %d", rx, tx }' /proc/net/dev)
    [ -z "$snap1" ] && return 1
    sleep 1
    snap2=$(awk -F'[: ]+' '/:/ { gsub(/^ +/, ""); if ($1 != "lo") { rx += $2; tx += $10 } } END { printf "%d %d", rx, tx }' /proc/net/dev)
    [ -z "$snap2" ] && return 1
    awk -v s1="$snap1" -v s2="$snap2" '
        BEGIN {
            split(s1, a, " "); split(s2, b, " ")
            drx = b[1] - a[1]; dtx = b[2] - a[2]
            if (drx < 0 || dtx < 0) exit 1     # counter wrap/reset between samples
            printf "{\"rx_mbps\": %.2f, \"tx_mbps\": %.2f}", drx / 1e6, dtx / 1e6
        }
    '
}

push_payload() {
    local feed_id="$1" payload="$2" label="$3"
    if ! is_set "$feed_id"; then
        log "$label: no feed id configured — skipping"
        return 1
    fi
    if [ "$TRANSPORT" = "direct" ]; then
        if ! curl -fsS --max-time "$TIMEOUT_SECONDS" -X POST "$DASHBOARDZ_HUB_URL/api/feeds/$feed_id" \
                -H "Authorization: Bearer $DASHBOARDZ_TOKEN" \
                -H "content-type: application/json" \
                -d "$payload" >/dev/null 2>&1; then
            log "$label: push to hub failed"
            return 1
        fi
    else
        if ! timeout "$TIMEOUT_SECONDS" "${DBZ_SEND_CMD[@]}" data "$feed_id" \
                --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" --token "$DASHBOARDZ_TOKEN" \
                --json "$payload" >/dev/null 2>&1; then
            log "$label: dbz-send push to hub failed"
            return 1
        fi
    fi
}

push_value() {
    local feed_id="$1" key="$2" value="$3" label="$4" payload
    if ! payload=$(jq -nc --arg key "$key" --argjson value "$value" '{($key): $value}'); then
        log "$label: failed to build payload"
        return 1
    fi
    push_payload "$feed_id" "$payload" "$label"
}

status=0

if cpu=$(cpu_pct); then
    push_value "$DASHBOARDZ_FEED_CPU" cpu_pct "$cpu" "cpu" || status=1
else
    log "cpu: could not read /proc/stat"
    status=1
fi

if ram=$(ram_pct); then
    push_value "$DASHBOARDZ_FEED_RAM" ram_pct "$ram" "ram" || status=1
else
    log "ram: could not read /proc/meminfo"
    status=1
fi

# disk/net are optional: an unset feed id means the hub side hasn't been
# given them — skip quietly rather than logging a failure every 15s.
if is_set "$DASHBOARDZ_FEED_DISK"; then
    if disk=$(disk_json) && [ -n "$disk" ]; then
        push_payload "$DASHBOARDZ_FEED_DISK" "$disk" "disk" || status=1
    else
        log "disk: could not read df /"
        status=1
    fi
fi

if is_set "$DASHBOARDZ_FEED_NET"; then
    if net=$(net_json) && [ -n "$net" ]; then
        push_payload "$DASHBOARDZ_FEED_NET" "$net" "net" || status=1
    else
        log "net: could not read /proc/net/dev"
        status=1
    fi
fi

[ "$status" -ne 0 ] && log "one or more pushes failed this run (see above) — gauges go stale, not critical"
exit 0
