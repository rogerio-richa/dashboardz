#!/usr/bin/env bash
# uninstall.sh — remove everything install.sh placed. Does NOT uninstall the
# Netdata agent itself (use netdata's own uninstaller for that — we don't
# want to silently remove a package this script didn't install on its own).

set -euo pipefail

INSTALL_ROOT=/opt/netdata-dashboardz

if [ "$(id -u)" -ne 0 ]; then
    echo "uninstall.sh: must run as root" >&2
    exit 1
fi

log() { printf '\033[1;34m[uninstall]\033[0m %s\n' "$*"; }

log "Disabling + stopping monitor services"
systemctl disable --now netdata-journal-watcher.service 2>/dev/null || true
systemctl disable --now netdata-sudo-watcher.service 2>/dev/null || true
systemctl disable --now netdata-lifecycle-watcher.service 2>/dev/null || true
systemctl disable --now netdata-critical-services.timer 2>/dev/null || true
systemctl disable --now netdata-critical-services.service 2>/dev/null || true
systemctl disable --now netdata-feed-push.timer 2>/dev/null || true
systemctl disable --now netdata-feed-push.service 2>/dev/null || true

log "Removing systemd units"
rm -f /etc/systemd/system/netdata-journal-watcher.service \
      /etc/systemd/system/netdata-sudo-watcher.service \
      /etc/systemd/system/netdata-lifecycle-watcher.service \
      /etc/systemd/system/netdata-critical-services.service \
      /etc/systemd/system/netdata-critical-services.timer \
      /etc/systemd/system/netdata-feed-push.service \
      /etc/systemd/system/netdata-feed-push.timer
systemctl daemon-reload

log "Removing Netdata overrides (leaves Netdata's stock configs intact)"
rm -f /etc/netdata/netdata.conf \
      /etc/netdata/health_alarm_notify.conf \
      /etc/netdata/health.d/ram.conf \
      /etc/netdata/health.d/swap.conf \
      /etc/netdata/health.d/systemdunits.conf \
      /etc/netdata/go.d/systemdunits.conf

log "Removing logrotate fragment"
rm -f /etc/logrotate.d/netdata-dashboardz

log "Keeping: $INSTALL_ROOT/ (scripts, live env, state, logs)."
log "         Netdata agent itself is kept."
log "         rm -rf $INSTALL_ROOT to remove the whole tree if you want it gone."

log "Reloading Netdata to drop overrides"
systemctl reload netdata 2>/dev/null || systemctl restart netdata 2>/dev/null || true
