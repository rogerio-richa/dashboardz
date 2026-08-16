#!/bin/sh
# Claude Code "Notification" hook -> a card on the wall: this session is waiting on a human.
#
# Reads the hook's JSON from stdin and POSTs the hub's documented /api/notify. Severity is `warn`,
# silent by default (operator feedback: the chime was too loud for something that happens all
# day) — set DASHBOARDZ_HOOK_SOUND=1 for one chime per card. Deliberately never `critical`: a
# session waiting for permission is not a 3am emergency. The dedup key is the session id, so
# however many times one session prompts, the wall shows ONE card, updated in place;
# attention-over.sh retracts it with the same key, and the TTL expires it if nobody comes back.
#
# Every failure path exits 0. A wall that misses a ping is an inconvenience; a hook that blocks a
# Claude Code session is a bug.
set -u

HUB="${DASHBOARDZ_HUB_URL:-http://localhost:8484}"
TOKEN_FILE="${DASHBOARDZ_TOKEN_FILE:-$HOME/.config/dashboardz/local-sender-token}"
TOKEN="${DASHBOARDZ_TOKEN:-$(cat "$TOKEN_FILE" 2>/dev/null || true)}"
[ -n "$TOKEN" ] || exit 0

# python3 (stdlib only) does the JSON work: parsing the hook input AND encoding the payload, so a
# message containing quotes or backslashes cannot break out of the JSON we send.
PAYLOAD=$(python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sid = d.get("session_id") or ""
if not sid:
    sys.exit(0)
msg = d.get("message") or "Waiting for your input"
cwd = d.get("cwd") or ""
body = (cwd + "\n" + msg).strip()[:1500]
# The project name goes in the TITLE — the big bold line — because with several sessions pinging
# the same wall, "which window wants me" is the entire question the card answers. The full path
# stays in the body for the ambiguous cases (two checkouts of the same repo).
project = os.path.basename(cwd.rstrip("/")) if cwd else ""
title = ("Claude Code needs you · " + project if project else "Claude Code needs you")[:200]
print(json.dumps({
    "title": title,
    "body": body,
    "severity": "warn",
    "sound": bool(os.environ.get("DASHBOARDZ_HOOK_SOUND")),
    "ttl_s": 1800,
    "dedup_key": "cc-" + sid[:90],
}, indent=1, ensure_ascii=False))
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
