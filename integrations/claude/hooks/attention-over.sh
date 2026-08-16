#!/bin/sh
# Claude Code "UserPromptSubmit" + "Stop" hook -> retract this session's waiting-on-you card.
#
# The moment the human types back (or the turn ends), the session is no longer waiting, so the
# card needs-attention.sh raised is resolved via the documented `{"resolve": true, "dedup_key"}`
# form. Resolving a key with no active card is a no-op on the hub, which is exactly right: this
# fires after every turn and must be safe to over-call.
#
# Every failure path exits 0 — see needs-attention.sh.
set -u

HUB="${DASHBOARDZ_HUB_URL:-http://localhost:8484}"
TOKEN_FILE="${DASHBOARDZ_TOKEN_FILE:-$HOME/.config/dashboardz/local-sender-token}"
TOKEN="${DASHBOARDZ_TOKEN:-$(cat "$TOKEN_FILE" 2>/dev/null || true)}"
[ -n "$TOKEN" ] || exit 0

PAYLOAD=$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sid = d.get("session_id") or ""
if not sid:
    sys.exit(0)
print(json.dumps({"resolve": True, "dedup_key": "cc-" + sid[:90]}, indent=1))
' 2>/dev/null) || exit 0
[ -n "$PAYLOAD" ] || exit 0

if [ -n "${DRY_RUN:-}" ]; then
  printf '%s\n%s\n' "$HUB/api/notify" "$PAYLOAD"
  exit 0
fi

curl -s --max-time 3 -o /dev/null -X POST "$HUB/api/notify" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "$PAYLOAD" || true
exit 0
