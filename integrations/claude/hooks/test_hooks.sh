#!/bin/sh
# Tests for the wall hooks, no network needed: DRY_RUN=1 prints "<path>\n<json>" instead of curling.
# Run: sh integrations/claude/hooks/test_hooks.sh
set -u
cd "$(dirname "$0")"
fails=0

check() { # name expected_substring actual
  case "$3" in
    *"$2"*) echo "ok: $1" ;;
    *) echo "FAIL: $1"; echo "  wanted substring: $2"; echo "  got: $3"; fails=$((fails+1)) ;;
  esac
}

NOTIF='{"session_id":"abc123","cwd":"/Users/x/proj","hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}'

out=$(printf '%s' "$NOTIF" | DRY_RUN=1 DASHBOARDZ_TOKEN=t sh needs-attention.sh)
check "posts to /api/notify"            "/api/notify"                          "$out"
check "project name headlines the card" '"title": "Claude Code needs you · proj"' "$out"
check "session-scoped dedup key"        '"dedup_key": "cc-abc123"'             "$out"
check "severity warn"                   '"severity": "warn"'                   "$out"
check "silent by default"               '"sound": false'                       "$out"
check "ttl set"                         '"ttl_s": 1800'                        "$out"
check "message lands in body"           "permission to use Bash"               "$out"
check "project dir lands in body"       "/Users/x/proj"                        "$out"

out=$(printf '%s' "$NOTIF" | DRY_RUN=1 DASHBOARDZ_TOKEN=t DASHBOARDZ_HOOK_SOUND=1 sh needs-attention.sh)
check "sound opt-in via env"            '"sound": true'                        "$out"

out=$(printf '{"session_id":"abc123"}' | DRY_RUN=1 DASHBOARDZ_TOKEN=t sh attention-over.sh)
check "resolve posts to /api/notify"    "/api/notify"                          "$out"
check "resolve carries same dedup key"  '"dedup_key": "cc-abc123"'             "$out"
check "resolve flag"                    '"resolve": true'                      "$out"

# No session_id -> nothing to key on -> do nothing, exit 0 (hooks must never break a session).
out=$(printf '{}' | DRY_RUN=1 DASHBOARDZ_TOKEN=t sh needs-attention.sh; echo "rc=$?")
check "no session id is a silent no-op" "rc=0"                                 "$out"
case "$out" in *"/api/notify"*) echo "FAIL: no-op still built a request"; fails=$((fails+1));; esac

# No token -> silent no-op too.
out=$(printf '%s' "$NOTIF" | DRY_RUN=1 DASHBOARDZ_TOKEN= DASHBOARDZ_TOKEN_FILE=/nonexistent sh needs-attention.sh; echo "rc=$?")
check "no token is a silent no-op"      "rc=0"                                 "$out"

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails failing"; exit 1; }
