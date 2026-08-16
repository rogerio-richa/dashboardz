#!/usr/bin/env bash
# enable.sh — validate the env file, then start services.
# Safe to re-run. Refuses cleanly if the config still has placeholders.

set -euo pipefail

INSTALL_ROOT=/opt/netdata-dashboardz
ENV_FILE="$INSTALL_ROOT/etc/netdata-dispatch.env"

if [ "$(id -u)" -ne 0 ]; then
    echo "enable.sh: must run as root (try: sudo ./enable.sh)" >&2
    exit 1
fi

if [ ! -r "$ENV_FILE" ]; then
    echo "enable.sh: $ENV_FILE missing — did you run install.sh?" >&2
    exit 1
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

log()  { printf '\033[1;34m[enable]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[enable]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Refuse noop / placeholder config.
# ---------------------------------------------------------------------------
case "${DISPATCH_BACKEND:-noop}" in
    noop)
        fail "DISPATCH_BACKEND is still 'noop'. Edit $ENV_FILE, set DISPATCH_BACKEND to a real backend (dashboardz, telegram, or fanout), then re-run."
        ;;
    telegram|dashboardz|fanout)
        : # telegram validated below; dashboardz fails soft by design
        ;;
    *)
        backend="$INSTALL_ROOT/bin/backends/${DISPATCH_BACKEND}.sh"
        [ -x "$backend" ] || fail "Unknown DISPATCH_BACKEND=$DISPATCH_BACKEND (no executable at $backend)"
        log "Using custom backend: $DISPATCH_BACKEND"
        ;;
esac

if [ "${DISPATCH_BACKEND}" = "telegram" ]; then
    [ "${TELEGRAM_BOT_TOKEN:-replace-me}" = "replace-me" ] && \
        fail "TELEGRAM_BOT_TOKEN still 'replace-me' in $ENV_FILE"
    [ "${TELEGRAM_CHAT_ID:-replace-me}" = "replace-me" ] && \
        fail "TELEGRAM_CHAT_ID still 'replace-me' in $ENV_FILE"

    log "Probing Telegram API (getMe)"
    if ! curl -fsS --max-time 10 \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" >/dev/null; then
        fail "Telegram getMe failed — check bot token and network"
    fi
fi

# ---------------------------------------------------------------------------
# 2. Start Netdata + watcher + watchdog timer.
# ---------------------------------------------------------------------------
log "Enabling + starting: netdata, netdata-journal-watcher, netdata-sudo-watcher, netdata-lifecycle-watcher, netdata-critical-services.timer, netdata-feed-push.timer"
systemctl enable --now netdata netdata-journal-watcher.service netdata-sudo-watcher.service netdata-lifecycle-watcher.service netdata-critical-services.timer netdata-feed-push.timer

# ---------------------------------------------------------------------------
# 3. Status summary.
# ---------------------------------------------------------------------------
printf '\n'
for svc in netdata netdata-journal-watcher.service netdata-sudo-watcher.service netdata-lifecycle-watcher.service netdata-critical-services.timer netdata-feed-push.timer; do
    state=$(systemctl is-active "$svc" 2>/dev/null || true)
    printf '  %-45s %s\n' "$svc" "$state"
done

# ---------------------------------------------------------------------------
# 4. Hints.
# ---------------------------------------------------------------------------
if [ ! -f "$INSTALL_ROOT/etc/critical-services.conf" ]; then
    cat <<MSG

Hint: $INSTALL_ROOT/etc/critical-services.conf does not exist yet.
      The watchdog timer is running but will no-op until you list services.
      See $INSTALL_ROOT/etc/critical-services.conf.example for the format.
MSG
fi

dbz_unconfigured=1
if [ "${DASHBOARDZ_TOKEN:-replace-me}" != "replace-me" ] && [ -n "${DASHBOARDZ_TOKEN:-}" ]; then
    if { [ "${DASHBOARDZ_HUB_URL:-replace-me}" != "replace-me" ] && [ -n "${DASHBOARDZ_HUB_URL:-}" ]; } || \
       { [ "${DASHBOARDZ_RELAY_URL:-replace-me}" != "replace-me" ] && [ "${DASHBOARDZ_HUB_UID:-replace-me}" != "replace-me" ]; }; then
        dbz_unconfigured=0
    fi
fi
if [ "$dbz_unconfigured" = "1" ]; then
    cat <<MSG

Hint: the DASHBOARDZ_* values in $ENV_FILE are still unset/replace-me.
      netdata-feed-push.timer is running but will log-and-skip every tick
      until DASHBOARDZ_TOKEN plus a transport (DASHBOARDZ_HUB_URL for
      direct, or DASHBOARDZ_RELAY_URL + DASHBOARDZ_HUB_UID for the relay)
      are filled in — and the DASHBOARDZ_FEED_* ids for each push.
      The relay transport also needs the dbz-send CLI, which install.sh
      warns about separately if it isn't on PATH. netdata-feed-push.sh
      reads /proc/stat and /proc/meminfo directly — it has no netdata-API
      or even netdata-running dependency, so it's unaffected by this
      stack's shipped [web] mode = none.
MSG
fi

cat <<MSG

Activated. Sanity checks:
  sudo -u netdata NETDATA_ALARM_NOTIFY_DEBUG=1 \\
      /usr/libexec/netdata/plugins.d/alarm-notify.sh test sysadmin
  logger -p user.err "journal-watcher smoke test"
  # (no localhost:19999 check — this stack ships [web] mode = none, the API is off;
  #  verify alarm plumbing via your configured backend or: journalctl -u netdata -n 20)
MSG
