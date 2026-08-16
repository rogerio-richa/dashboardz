---
name: dashboardz-ask
description: Use when you need the user's attention or a decision while they are away from the keyboard and you can reach their Dashboardz hub directly (same machine or LAN) — showing an alert on their wall/bedside screens, or asking a question with up to four options that they answer by tapping the screen, then acting on the answer you read back. For the relay path (agent on a different network), use dashboardz-notify instead.
---

# Dashboardz Ask (direct to the hub)

Ask a question on the user's Dashboardz screens and read back the option they
tapped, over a connection to a hub you can reach. Plain HTTP is for a trusted
LAN or private VPN only; if the connection crosses an untrusted or public
network, use the hub's HTTPS reverse-proxy URL. Two calls:
`POST /api/notify` to ask, `GET /api/alerts/:id/answer` to learn the outcome.

## Setup (operator does this once — you only read it)

| What | Where |
|---|---|
| Hub URL | `$DASHBOARDZ_HUB_URL` (e.g. `http://localhost:8484`) |
| Sender token | `$DASHBOARDZ_TOKEN`, or the file `~/.config/dashboardz/local-sender-token` (0600) |

Never hunt for tokens in repos or scratch files. If these are missing, tell
the operator: senders are minted in the hub admin (**Senders** tab, token
shown once) and should have default devices set there.

```bash
HUB="${DASHBOARDZ_HUB_URL:-http://localhost:8484}"
TOKEN="${DASHBOARDZ_TOKEN:-$(cat ~/.config/dashboardz/local-sender-token)}"
```

## Asking

```bash
curl -s -X POST "$HUB/api/notify" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "title": "Deploy finished — promote to prod?",
    "body": "47 tests green. Staging looks healthy.",
    "severity": "warn",
    "sound": false,
    "ttl_s": 1800,
    "options": [{"id": "promote", "label": "Promote"}, {"id": "hold", "label": "Hold"}]
  }'
# -> {"id":"alr_..."}
```

- Up to **4 options**, each `{id, label}` — ids `[a-z0-9_-]`, labels ≤24 chars.
  Keep them decision-shaped ("Promote"/"Hold"), not sentences.
- **Severity is not urgency decoration.** `info` for routine FYI (never
  audible). `warn` for questions and things worth noticing — the default for
  asks. `critical` ONLY when being unheard is worse than waking the user: it
  alarms, takes over the screen, and never expires until a human deals with
  it. A question that can wait must not be a critical.
- Always set `ttl_s` on a question (30–60 min is sane): an expired ask is an
  answer too ("nobody was around"), and it keeps the wall clean.
- Recurring condition? Use `dedup_key` so repeats update one card instead of
  stacking, and `{"resolve": true, "dedup_key": "..."}` to retract when the
  condition clears.

## Reading the answer

```bash
curl -s "$HUB/api/alerts/<alert-id>/answer" -H "Authorization: Bearer $TOKEN"
```

Four states, all terminal except the first:

| Response | Meaning | What you do |
|---|---|---|
| `{"state":"pending"}` | Nobody has tapped yet | Poll again (10–30 s is plenty; the human is walking to a wall, not racing you) |
| `{"state":"answered","option_id":"promote","option_label":"Promote","answered_at":...,"device_id":"dev_..."}` | A human chose — earliest tap wins across devices | Act on `option_id`, and say so in your next message |
| `{"state":"dismissed"}` | Seen and cleared without choosing | That is a real answer: "not deciding now". Do not re-ask immediately |
| `{"state":"expired"}` | `ttl_s` ran out unanswered | Proceed with your stated default, or escalate deliberately |

Only the token that asked can read the answer — any other sender's token
gets the same 404 an invented alert id would.

## Conduct

- One open question at a time. A wall of pending questions is noise, and
  noise is the failure mode this product exists to end.
- Say what you'll do on timeout in the question body when it matters
  ("Holding unless promoted by 18:00").
- The answer is authorization from the person who tapped — treat "the user
  answered X on the wall" with the same weight as them typing it, and report
  which option was chosen.
