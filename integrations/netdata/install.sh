#!/usr/bin/env bash
# install.sh — place files; do NOT start any service.
# Idempotent. Safe to re-run to re-sync files.
#
# All runtime artifacts (scripts, live config, state, logs) are kept under
# /opt/netdata-dashboardz/ to minimize filesystem pollution. Only the
# things systemd / Netdata / logrotate MUST find at fixed paths live outside
# INSTALL_ROOT (unit files, Netdata health configs, logrotate fragment).

set -euo pipefail

INSTALL_ROOT=/opt/netdata-dashboardz

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh: must run as root (try: sudo ./install.sh)" >&2
    exit 1
fi

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Netdata agent (no Cloud, no telemetry, don't start yet).
# ---------------------------------------------------------------------------
if ! command -v netdata >/dev/null 2>&1; then
    log "Installing Netdata via kickstart.sh (stable, no cloud, don't-start)"
    KICKSTART=/tmp/netdata-kickstart.sh
    curl -fsSL https://get.netdata.cloud/kickstart.sh -o "$KICKSTART"
    sh "$KICKSTART" --stable-channel --disable-telemetry --dont-start-it --non-interactive
    rm -f "$KICKSTART"
else
    log "Netdata already installed; skipping kickstart"
fi

# ---------------------------------------------------------------------------
# 2. Runtime dependencies for the watchers + backends.
# ---------------------------------------------------------------------------
missing=()
for pkg in jq curl; do
    command -v "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if [ "${#missing[@]}" -gt 0 ]; then
    log "Installing runtime deps: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi

# ---------------------------------------------------------------------------
# 2a. dbz-send — only needed for the RELAY transport, and deliberately NOT
#     installed by this script. It's the dashboardz repo's `clients/sender`
#     package (bin `dbz-send`, Node >= 22); get it onto a host with
#     `npm pack` + `npm install -g <tarball>`, or vendor the built dist/
#     tree and point DBZ_SEND in the env file at "node /path/to/dist/cli.js".
#     Hosts pushing DIRECT to a reachable hub (DASHBOARDZ_HUB_URL) need
#     only curl. Both dashboardz scripts fail soft when their transport is
#     unconfigured or dbz-send is missing — delivery no-ops, nothing breaks.
# ---------------------------------------------------------------------------
if ! command -v dbz-send >/dev/null 2>&1; then
    warn "dbz-send not on PATH — the relay transport will no-op until it's installed (direct hub pushes need only curl)"
fi

# ---------------------------------------------------------------------------
# 3. Netdata user needs 'adm' group to read /var/log/journal.
# ---------------------------------------------------------------------------
if id netdata >/dev/null 2>&1; then
    if ! id -nG netdata | tr ' ' '\n' | grep -qx adm; then
        log "Adding netdata to 'adm' group (journal access)"
        usermod -aG adm netdata
    fi
else
    warn "netdata user not found — Netdata install may have failed"
fi

# ---------------------------------------------------------------------------
# 4. Install Netdata overrides into /etc/netdata/ (Netdata-dictated path).
# ---------------------------------------------------------------------------
log "Installing Netdata configs to /etc/netdata/"
install -d -m 0755 -o netdata -g netdata /etc/netdata/health.d /etc/netdata/go.d
install -m 0644 -o netdata -g netdata "$REPO_DIR/config/netdata/netdata.conf"                /etc/netdata/netdata.conf
install -m 0644 -o netdata -g netdata "$REPO_DIR/config/netdata/health_alarm_notify.conf"    /etc/netdata/health_alarm_notify.conf
install -m 0644 -o netdata -g netdata "$REPO_DIR/config/netdata/health.d/ram.conf"           /etc/netdata/health.d/ram.conf
install -m 0644 -o netdata -g netdata "$REPO_DIR/config/netdata/health.d/swap.conf"          /etc/netdata/health.d/swap.conf
install -m 0644 -o netdata -g netdata "$REPO_DIR/config/netdata/health.d/systemdunits.conf"  /etc/netdata/health.d/systemdunits.conf
install -m 0644 -o netdata -g netdata "$REPO_DIR/config/netdata/go.d/systemdunits.conf"      /etc/netdata/go.d/systemdunits.conf

# journald size cap: see the config file's own comment. Restart-or-reload
# journald only when the file actually changed, so re-runs stay quiet.
if ! cmp -s "$REPO_DIR/config/journald/90-size-cap.conf" /etc/systemd/journald.conf.d/90-size-cap.conf 2>/dev/null; then
    log "Capping journald (SystemMaxUse=200M) + vacuuming to the cap"
    install -d -m 0755 /etc/systemd/journald.conf.d
    install -m 0644 "$REPO_DIR/config/journald/90-size-cap.conf" /etc/systemd/journald.conf.d/90-size-cap.conf
    systemctl restart systemd-journald 2>/dev/null || true
    journalctl --vacuum-size=200M >/dev/null 2>&1 || true
    # A journald restart orphans every running `journalctl -f` — a watcher
    # would keep an "active" service around a pipe that never produces
    # another line. try-restart touches only watchers that are running.
    systemctl try-restart netdata-sudo-watcher.service netdata-journal-watcher.service netdata-lifecycle-watcher.service 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 4a. Stale dbengine cleanup. The config above runs netdata with
#     [db] mode = ram — no disk persistence — but a host that ever ran the
#     stock dbengine default keeps its old tiered metric files in
#     /var/cache/netdata forever (netdata never deletes them, and in ram
#     mode never touches them again); they can accumulate to gigabytes.
#     Gated on the freshly-installed config actually saying ram, and
#     deleted with netdata stopped; plain start afterwards (try-restart
#     no-ops on a stopped unit and would leave netdata down).
# ---------------------------------------------------------------------------
if sed -n '/^\[db\]/,/^\[/p' /etc/netdata/netdata.conf | grep -Eq '^\s*mode\s*=\s*ram\s*$'; then
    if [ -d /var/cache/netdata/dbengine ] || [ -d /var/cache/netdata/dbengine-tier1 ] || [ -d /var/cache/netdata/dbengine-tier2 ]; then
        log "Removing stale dbengine metric files ([db] mode = ram; netdata stopped for the deletion)"
        systemctl stop netdata 2>/dev/null || true
        rm -rf /var/cache/netdata/dbengine /var/cache/netdata/dbengine-tier1 /var/cache/netdata/dbengine-tier2
        systemctl start netdata 2>/dev/null || true
    fi
fi

# Pick up config changes on re-runs. try-restart is a no-op when netdata
# isn't yet running (fresh install path).
if systemctl is-active --quiet netdata; then
    log "Restarting netdata to apply new config"
    systemctl try-restart netdata
fi

# ---------------------------------------------------------------------------
# 5. Live runtime tree under INSTALL_ROOT.
# ---------------------------------------------------------------------------
log "Preparing runtime tree under $INSTALL_ROOT"
install -d -m 0755                   "$INSTALL_ROOT/etc"
install -d -m 0755                   "$INSTALL_ROOT/var"
install -d -m 0755                   "$INSTALL_ROOT/var/log"
install -d -m 0755                   "$INSTALL_ROOT/var/state"

# 5a. Scripts — synced on every run so re-running install.sh updates them.
if [ "$REPO_DIR" != "$INSTALL_ROOT" ]; then
    install -d -m 0755 "$INSTALL_ROOT/bin" "$INSTALL_ROOT/bin/backends"
    install -m 0755 "$REPO_DIR/bin/"*.sh          "$INSTALL_ROOT/bin/"
    install -m 0755 "$REPO_DIR/bin/backends/"*.sh "$INSTALL_ROOT/bin/backends/"
else
    chmod 0755 "$INSTALL_ROOT/bin"/*.sh "$INSTALL_ROOT/bin/backends"/*.sh
fi

# 5b. Env file — only if absent; readable by root and netdata.
if [ ! -f "$INSTALL_ROOT/etc/netdata-dispatch.env" ]; then
    log "Installing $INSTALL_ROOT/etc/netdata-dispatch.env (default: DISPATCH_BACKEND=noop)"
    install -m 0640 -o root -g netdata "$REPO_DIR/env/example.env" "$INSTALL_ROOT/etc/netdata-dispatch.env"
else
    log "$INSTALL_ROOT/etc/netdata-dispatch.env already exists; leaving it alone"
fi

# 5c. Watchdog allowlist example (active file is operator-created).
install -m 0644 "$REPO_DIR/config/watchdog/critical-services.conf.example" "$INSTALL_ROOT/etc/critical-services.conf.example"
if [ ! -f "$INSTALL_ROOT/etc/critical-services.conf" ]; then
    log "No $INSTALL_ROOT/etc/critical-services.conf yet — watchdog will no-op until you create one"
fi

# 5d. Log files — writable by both root (watchers) and netdata (custom_sender).
if [ ! -f "$INSTALL_ROOT/var/log/netdata-dispatch.log" ]; then
    install -m 0664 -o root -g adm  /dev/null "$INSTALL_ROOT/var/log/netdata-dispatch.log"
fi
for f in netdata-journal-watcher.err netdata-sudo-watcher.err netdata-lifecycle-watcher.err; do
    if [ ! -f "$INSTALL_ROOT/var/log/$f" ]; then
        install -m 0644 -o root -g root /dev/null "$INSTALL_ROOT/var/log/$f"
    fi
done

# ---------------------------------------------------------------------------
# 6. Systemd units — systemd only reads /etc/systemd/system/ (and friends),
#    so these have to live there. Install, daemon-reload, do NOT enable.
# ---------------------------------------------------------------------------
log "Installing systemd units (not enabling — run ./enable.sh after configuring)"
for unit in netdata-journal-watcher.service netdata-sudo-watcher.service \
            netdata-lifecycle-watcher.service netdata-critical-services.service \
            netdata-critical-services.timer netdata-feed-push.service \
            netdata-feed-push.timer; do
    install -m 0644 "$REPO_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload

# ---------------------------------------------------------------------------
# 7. Logrotate fragment — /etc/logrotate.d/ is the only place logrotate looks.
# ---------------------------------------------------------------------------
install -m 0644 "$REPO_DIR/config/logrotate/netdata-dashboardz" /etc/logrotate.d/netdata-dashboardz

# ---------------------------------------------------------------------------
# 8. Done — widget instructions.
# ---------------------------------------------------------------------------
cat <<MSG

============================================================================
Files placed. Nothing is running yet.

Next:
  1. Edit $INSTALL_ROOT/etc/netdata-dispatch.env
       - fill in the DASHBOARDZ_* values (and TELEGRAM_* if you use it)
       - set DISPATCH_BACKEND (dashboardz, telegram, or fanout for both)
  2. Preflight the dispatch pipeline:
       sudo $INSTALL_ROOT/bin/netdata-dispatch.sh --source test \\
           --host "\$(hostname)" --status CRITICAL --alarm smoke \\
           --value 1 --info "preflight"
       # (expect a card on your dashboardz device within a second)
  3. Activate:
       sudo $INSTALL_ROOT/enable.sh

  Optional: list critical services to watch in
       $INSTALL_ROOT/etc/critical-services.conf
       (one systemd unit per line — see .example)
============================================================================
MSG
