---
name: dashboardz-notify
description: Use when you need to reach the user away from the keyboard — alerting them on their Dashboardz wall/bedside screens about warnings, failures, completions, or urgent conditions, or asking a question they answer with a tap on the screen (and acting on their answer). Also use when deciding how urgent an alert should be (info vs warn vs critical) or when a recurring condition should update an existing alert instead of stacking duplicates.
---

# Dashboardz Notify (via the cloud relay)

Send alerts to the user's self-hosted Dashboardz hub through the cloud relay
using `dbz-send`. The payload is sealed end-to-end to the hub with a key
derived from the sender token — the relay only ever sees ciphertext.

## Setup (operator does this once — you only read it)

| What | Where |
|---|---|
| Relay URL | `$DASHBOARDZ_RELAY_URL` (e.g. `wss://dashboardz-hub.example.com/ws`) |
| Hub UID | `$DASHBOARDZ_HUB_UID` (`hub_...`) |
| Sender token | `$DASHBOARDZ_TOKEN`, or the file `~/.config/dashboardz/token` (0600) |
| `dbz-send` | on PATH (built from the hub repo's `clients/sender`; needs node ≥22) |

Never hunt for tokens in repos or scratch files. If any of these are missing,
tell the operator setup is incomplete — senders are created in the hub admin
(token shown once) and should have default devices set there.

## Sending

```bash
TOKEN="${DASHBOARDZ_TOKEN:-$(cat ~/.config/dashboardz/token)}"
dbz-send --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" --token "$TOKEN" \
  --title "Nightly backup: 2 warnings" \
  --body "tar exited 0; 2 files skipped (details in /var/log/backup.log)" \
  --severity warn --dedup-key nightly-backup
```

Exit codes: `0` delivered (hub acked) · `1` send failed · `2` bad usage ·
`3` `--wait` elapsed with no answer.

## Flag reference

| Flag | Notes |
|---|---|
| `--title` | required, ≤200 chars — what they read from across the room |
| `--severity` | required: `info` \| `warn` \| `critical` (policy below) |
| `--body` | ≤1500 chars — detail; log paths and numbers go here |
| `--dedup-key` | same key + still-open alert ⇒ UPDATES it (re-surfaces). Use for anything recurring — never stack duplicates |
| `--ttl SECONDS` | auto-expire. Use for transient states ("deploy running") |
| `--device ID` | repeatable; omit to use the sender's defaults (hub-side) |
| `--option ID=LABEL` | up to 4 answer buttons; id `[a-z0-9_-]`≤32, label ≤24 |
| `--sound` | request sound explicitly (severity defaults apply otherwise) |
| `--wait SECONDS` | after the ack, stay connected for the human's answer |

## Severity policy

| Level | Screen behavior | Use for |
|---|---|---|
| `info` | quiet card (layouts may filter it) | FYIs, completions |
| `warn` | card + sound | needs attention soon |
| `critical` | full-screen takeover + alarm, wakes the device | wake-the-human-now ONLY. A false critical at 3am erodes all trust |

## Asking questions and acting on the answer

`--option` + `--wait` gives you a real round-trip: the buttons render on the
screen, and the tap comes back to this process.

```bash
if out=$(dbz-send --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" --token "$TOKEN" \
    --title "Importer stuck — restart it?" --severity warn \
    --option yes=Restart --option no="Leave it" --ttl 900 --wait 900); then
  case "$out" in *yes*) systemctl restart importer ;; esac
else
  [ $? -eq 3 ] && echo "no answer within window — leaving importer alone"
fi
```

Rules: keep the `dbz-send` process ALIVE for the whole wait (a restarted
`dbz-send` cannot claim an earlier question's answer — answers are still
recorded hub-side, but you won't see them); size `--wait` to the decision,
pair it with a matching `--ttl`; always handle exit `3` (no answer) with a
safe default, never by assuming consent. If YOUR OWN lifetime is shorter
than the window (supervised/restarting agent), detach it from your process
group and collect the result from disk on a later run:

```bash
setsid nohup dbz-send ... --ttl 900 --wait 900 \
  > /var/tmp/dbz-answer.txt 2>&1 < /dev/null &
# later runs: [ -s /var/tmp/dbz-answer.txt ] && act on its contents
```

## Pushing data feeds

Some hubs also have data feeds — small values or event streams that widgets
on the wall display bind to (CPU load, queue depth, latest deploy, etc.),
separate from the alert cards above. Push one with `dbz-send data <feed-id>`,
sealed the same way as an alert — same env vars from Setup:

```bash
TOKEN="${DASHBOARDZ_TOKEN:-$(cat ~/.config/dashboardz/token)}"
dbz-send data feed_status --relay "$DASHBOARDZ_RELAY_URL" --hub "$DASHBOARDZ_HUB_UID" \
  --token "$TOKEN" --json '{"state": "idle", "queue": 0}'
```

Exit codes: `0` pushed, `1` send failed, `2` bad usage — `3` never applies
(no `--wait` for data pushes; there's no human answer to wait for).

Image feeds cannot be pushed this way — sealed-JSON envelopes are the wrong
vehicle for binary data, so the hub rejects an image-mode feed id with
`image push not supported over relay`. That's a LAN-only HTTP push, not
available from this skill.

## Errors

| Outcome | Meaning / action |
|---|---|
| exit `1` | relay unreachable or hub offline/not acking — note it, retry later with backoff; do NOT queue-spam. If you have another channel to the user, say the hub is unreachable |
| exit `2` | your flags are malformed — fix the call, don't retry as-is |
| exit `3` | question expired unanswered — take the safe default |
| hub-side `unknown devices` style failures | stale/empty sender defaults — ask the operator to fix them in the hub admin |

## LAN alternative (not this deployment)

Senders on the hub's own network can skip the relay: `POST $HUB_URL/api/notify`
with `authorization: Bearer $TOKEN` and the same fields as JSON — but note the
answer round-trip does NOT exist on that path yet; it is relay-only.

## Common mistakes

- Re-sending a recurring alert without `--dedup-key` — the screen fills with duplicates.
- `critical` for routine failures — see severity policy.
- Backgrounding or restarting `dbz-send` mid-`--wait` — the answer is lost to you.
- Treating exit `3` (silence) as a yes.
- Scraping tokens from files not listed in Setup.
