#!/usr/bin/env bash
# Drives the three Android acceptance checks (see repo root README, "Android screen app") against
# a running hub + a booted, connected emulator or device. Fully automated: no interactive
# `read` prompts. Re-run it as often as you like; each run creates fresh hub state (a new
# pairing code, sender and device) and a fresh screenshot directory.
#
# Prerequisites (not started by this script):
#   - The hub running and reachable, e.g.:
#       cd hub && PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" \
#         ADMIN_PASSWORD=pw PUBLIC_URL=http://10.0.2.2:8484 node dist/index.js
#   - An emulator or device booted, visible to `adb devices`, with the app already installed
#     and MainActivity showing the pairing screen (fresh install, or after Settings > Unpair):
#       adb shell am start -n com.dashboardz.device/.ui.MainActivity
#
# What this script automates:
#   1. Admin login, pairing-code creation, and driving the pairing UI via `adb shell input`.
#   2. Sender creation and notify() for info/warn/critical severities.
#   3. Criterion 1: screen-off, critical wake, DND-bypass, and an alarm-stream audio check.
#   4. Two-stage dismiss: a neutral tap (silence) and a long hold on the Dismiss button.
#   5. Criterion 2: hub kill/restart (only if HUB_PID / HUB_RESTART_CMD are supplied — see below)
#      with an alert posted in the restart window, to exercise a genuine resync.
#   6. Criterion 3: dumps the audit log so the caller can confirm the expected event rows.
#   7. Landscape rotation via the emulator console (requires a telnet-capable emulator, i.e. an
#      AVD, not a physical device).
#
# This script cannot judge a screenshot or a `dumpsys` dump for you — it captures the evidence
# and prints what it did; a human or an agent with image-reading tools must interpret the
# screenshots and `dumpsys` output because this script only captures evidence.
#
# Usage:
#   ADMIN_PASSWORD=pw ./acceptance.sh
#
# To also automate criterion 2 (kill/restart the hub), give this script a way to control the
# hub process it did not start:
#   HUB_PID=12345 \
#   HUB_RESTART_CMD='cd ../../hub && PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" \
#     ADMIN_PASSWORD=pw PUBLIC_URL=http://10.0.2.2:8484 nohup node dist/index.js >/tmp/hub.log 2>&1 & disown' \
#   ADMIN_PASSWORD=pw ./acceptance.sh
# Without these, the script skips the kill/restart itself and just prints instructions, so it
# never blocks on input.
set -uo pipefail

HUB="${HUB:-http://localhost:8484}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-pw}"
DEVICE_NAME="${DEVICE_NAME:-acceptance}"
PACKAGE="com.dashboardz.device"
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

mkdir -p "$OUT_DIR"

say() { printf '\n=== %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

adbs() { adb shell "$@"; }

shot() {
  # shot <name> — saves a screenshot to $OUT_DIR/<name>.png and prints the path.
  adb exec-out screencap -p > "$OUT_DIR/$1.png"
  info "screenshot: $OUT_DIR/$1.png"
}

# Fractional touch targets, resolved against the actual device resolution so this isn't pinned
# to one AVD's pixel grid. Measured against the app's pairing/takeover layout on Pixel_3a_API_34;
# re-verify these fractions with a screenshot if the app's layout changes materially.
tap_frac() {
  # tap_frac <fx> <fy>
  local size fx fy w h x y
  size=$(adb shell wm size | sed -n 's/.*: *\([0-9]*\)x\([0-9]*\).*/\1 \2/p')
  w=$(echo "$size" | awk '{print $1}')
  h=$(echo "$size" | awk '{print $2}')
  fx="$1"; fy="$2"
  x=$(awk -v w="$w" -v f="$fx" 'BEGIN { printf "%d", w * f }')
  y=$(awk -v h="$h" -v f="$fy" 'BEGIN { printf "%d", h * f }')
  echo "$x $y"
}

hold_frac() {
  # hold_frac <fx> <fy> <ms> — a stationary long-press, proven (against the launcher) to
  # deliver a genuine held touch over the requested duration rather than an instant tap.
  local xy
  xy=$(tap_frac "$1" "$2")
  # shellcheck disable=SC2086
  adb shell input touchscreen swipe $xy $xy "$3"
}

tap_at_frac() {
  local xy
  xy=$(tap_frac "$1" "$2")
  # shellcheck disable=SC2086
  adb shell input tap $xy
}

say "Logging into the admin API"
if ! curl -sf -c "$COOKIE_JAR" -X POST "$HUB/admin/api/login" \
  -H 'content-type: application/json' \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}" > /dev/null; then
  echo "FATAL: could not log into $HUB/admin/api/login — is the hub running?" >&2
  exit 1
fi

say "Creating a pairing code"
CODE=$(curl -sf -b "$COOKIE_JAR" -X POST "$HUB/admin/api/devices/pairing-codes" \
  -H 'content-type: application/json' -d "{\"name\":\"$DEVICE_NAME\"}" \
  | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
info "pairing code: $CODE"

# 10.0.2.2 is the host loopback alias as seen from inside an Android emulator; it is what the
# app should reach the hub on. Override HUB_FROM_DEVICE if pairing a real device on the LAN.
HUB_FROM_DEVICE="${HUB_FROM_DEVICE:-http://10.0.2.2:8484}"

say "Driving the pairing UI"
shot 01-pairing-before
tap_at_frac 0.498 0.440   # Hub address field
adb shell input text "$HUB_FROM_DEVICE"
tap_at_frac 0.498 0.534   # Pairing code field
adb shell input text "$CODE"
adb shell input keyevent KEYCODE_BACK   # dismiss the keyboard so the Pair button is visible
sleep 1
tap_at_frac 0.726 0.618   # Pair button
sleep 3
shot 02-pairing-after

say "Confirming the device registered with the hub"
DEVICE_ID=$(curl -sf -b "$COOKIE_JAR" "$HUB/admin/api/devices" \
  | sed -n 's/.*"id":"\(dev_[^"]*\)"[^}]*"name":"'"$DEVICE_NAME"'".*/\1/p' | tail -1)
if [ -z "$DEVICE_ID" ]; then
  # Fall back to "most recently created device" if the name-scoped match above is empty
  # (e.g. re-running against a device that was renamed).
  DEVICE_ID=$(curl -sf -b "$COOKIE_JAR" "$HUB/admin/api/devices" \
    | sed -n 's/.*"id":"\(dev_[^"]*\)".*/\1/p' | tail -1)
fi
if [ -z "$DEVICE_ID" ]; then
  echo "FATAL: pairing did not produce a device — check $OUT_DIR/02-pairing-after.png" >&2
  exit 1
fi
info "device: $DEVICE_ID"

say "Creating a sender targeting the paired device"
TOKEN=$(curl -sf -b "$COOKIE_JAR" -X POST "$HUB/admin/api/senders" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$DEVICE_NAME\",\"default_devices\":[\"$DEVICE_ID\"]}" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

notify() {
  curl -sf -X POST "$HUB/api/notify" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$1"
  echo
}

say "Idle rendering + severity mix (info, warn, critical/sound:false)"
notify '{"title":"Nightly build green","body":"All 62 suites passed.","severity":"info"}'
sleep 1
notify '{"title":"Backup finished late","body":"took 4h12m, expected under 2h","severity":"warn"}'
sleep 1
notify '{"title":"Disk /data at 97%","body":"used 233 GB of 240 GB. Writes will fail within the hour.","severity":"critical","sound":false}'
sleep 2
shot 03-severity-takeover
info "a sound:false critical still takes over the screen (silently) — tap to silence and inspect the card stack"
tap_at_frac 0.5 0.32
sleep 2
shot 04-idle-with-cards
info "check: sort order critical > warn > info; severity stripe visible and coloured per severity"

say "Criterion 1: screen off, then a critical must wake it and alarm"
adb shell input keyevent KEYCODE_SLEEP
sleep 2
BEFORE_WAKE=$(adbs dumpsys power | grep -o 'mWakefulness=[A-Za-z]*')
info "wakefulness before notify: $BEFORE_WAKE"
notify '{"title":"Payment gateway 5xx spike","body":"42% of checkout requests failing.","severity":"critical"}'
sleep 4
AFTER_WAKE=$(adbs dumpsys power | grep -o 'mWakefulness=[A-Za-z]*')
info "wakefulness after notify: $AFTER_WAKE"
shot 05-wake-takeover
if [ "$AFTER_WAKE" != "Awake" ]; then
  info "FAIL (or needs a manual KEYCODE_WAKEUP to confirm): screen did not report Awake after a critical."
  info "  Known cause on API 34: DeviceService's startActivity() to bring MainActivity forward is"
  info "  blocked by Android's background-activity-launch restrictions when the screen is off."
  adb shell input keyevent KEYCODE_WAKEUP
  sleep 2
  shot 05b-manual-wake
fi
info "alarm-stream audio check (active=yes, ST=4/STREAM_ALARM, Usg=4/USAGE_ALARM expected):"
adbs dumpsys media.audio_flinger 2>/dev/null | grep -A 4 "Tracks of which" | sed 's/^/    /'

say "DND must not silence a critical (the whole point of USAGE_ALARM)"
adb shell cmd notification set_dnd priority
sleep 1
notify '{"title":"DND bypass check","body":"Should alarm even with DND priority mode active.","severity":"critical"}'
sleep 3
shot 06-dnd-critical
adbs dumpsys media.audio_flinger 2>/dev/null | grep -A 4 "Tracks of which" | sed 's/^/    /'
adb shell cmd notification set_dnd off

say "Two-stage dismiss: a neutral tap silences (card remains); a 1s+ hold on Dismiss clears it"
tap_at_frac 0.5 0.32
sleep 2
shot 07-after-silence-tap
info "expect: takeover cleared, card still present in the idle list, audit row tap_silence"
notify '{"title":"Hold-to-dismiss probe","body":"Used to test the two-stage dismiss button.","severity":"critical"}'
sleep 3
shot 08-fresh-takeover
info "long-pressing Hold to dismiss (fractional target 0.5, 0.90 — verify against 08-fresh-takeover.png"
info "if this AVD's layout differs) for 2s:"
hold_frac 0.5 0.90 2000
sleep 2
shot 09-after-hold-dismiss
info "expect: takeover cleared and audit row tap_dismiss. If the screenshot is unchanged, this is"
info "a known open issue — see apps/android README — not a script bug; the identical"
info "touch technique was verified against the Android launcher's own long-press context menu."

say "Criterion 2: kill the hub -> OFFLINE, restart -> resync including any alert posted while down"
if [ -n "${HUB_PID:-}" ]; then
  kill "$HUB_PID"
  sleep 2
  shot 10-hub-killed
  for _ in $(seq 1 20); do
    curl -sf -m 1 "$HUB/api/health" > /dev/null 2>&1 || break
    sleep 1
  done
  shot 11-offline-banner
  info "expect: OFFLINE banner and a hollow status-strip dot"
  if [ -n "${HUB_RESTART_CMD:-}" ]; then
    eval "$HUB_RESTART_CMD"
    for _ in $(seq 1 40); do
      curl -sf -m 1 "$HUB/api/health" > /dev/null 2>&1 && break
      sleep 1
    done
    # The hub's admin sessions are in-memory, so a restart invalidates the cookie jar from the
    # top-of-script login even though the sender token (persisted to disk) still works fine —
    # re-login now or the closing audit-log fetch below will fail silently.
    curl -sf -c "$COOKIE_JAR" -X POST "$HUB/admin/api/login" \
      -H 'content-type: application/json' -d "{\"password\":\"$ADMIN_PASSWORD\"}" > /dev/null
    notify '{"title":"Posted while hub was restarting","body":"Should arrive via full resync, not a live push.","severity":"warn"}'
    sleep 8
    shot 12-resync
    info "expect: OFFLINE banner cleared, hub-connected dot restored, the alert above present"
  else
    info "HUB_RESTART_CMD not set — restart the hub yourself, then re-run with the same device"
    info "paired to see the resync, or take shot 12 manually: adb exec-out screencap -p > 12.png"
  fi
else
  info "HUB_PID not set — skipping the automatic kill/restart."
  info "To exercise this by hand: stop the hub, screenshot, restart it, screenshot again."
fi

say "Criterion 3: audit log"
curl -sf -b "$COOKIE_JAR" "$HUB/admin/api/audit?limit=60"
echo
info "expect rows for: paired, ws_connected, notify, tap_silence, tap_dismiss"

say "Rotation: landscape adaptive split (requires an AVD console, not a physical device)"
AUTH_TOKEN_FILE="$HOME/.emulator_console_auth_token"
if [ -f "$AUTH_TOKEN_FILE" ] && command -v nc > /dev/null; then
  { echo "auth $(cat "$AUTH_TOKEN_FILE")"; sleep 0.3; echo "rotate"; sleep 0.3; echo "quit"; } \
    | nc -w 2 localhost 5554 > /dev/null 2>&1
  sleep 2
  shot 13-landscape
  info "expect: clock column + alert column when alerts are present"
  { echo "auth $(cat "$AUTH_TOKEN_FILE")"; sleep 0.3; echo "rotate"; sleep 0.3; echo "quit"; } \
    | nc -w 2 localhost 5554 > /dev/null 2>&1
  sleep 2
  shot 14-portrait-again
else
  info "no emulator console auth token found — skipping rotation (physical device, or console"
  info "disabled). Rotate by hand and screenshot if you need this evidence."
fi

say "Done"
info "All screenshots: $OUT_DIR"
info "Read them back (they are evidence, not a verdict) to confirm what actually happened."
