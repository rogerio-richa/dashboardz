# Claude → Dashboardz

The agent pattern: the skill-only setup needs no daemon and no container —
an AI assistant *is* the integration. It holds a sender token like any other
integration and runs the ask/answer loop from the
[walkthrough](../../docs/integrations.md): raise an alert on the wall, ask a
question with up to four tap-able options, read back which one the human
chose, act on it. An optional resident daemon (below) builds on this for
reminders and escalation.

Two pieces live here or nearby:

- **`SKILL.md`** (this folder) — the `dashboardz-ask` skill: teaches Claude
  Code (or any agent that reads skills) the two HTTP calls, the severity
  discipline, and the conduct rules for interrupting a human. Install it by
  copying the folder into your agent's skills directory, e.g.:

  ```bash
  mkdir -p ~/.claude/skills/dashboardz-ask
  cp SKILL.md ~/.claude/skills/dashboardz-ask/
  ```

- **`dashboardz-mcp`** (`clients/mcp` in this repo) — the bigger surface:
  an MCP server exposing screens, feeds, and devices as tools, so an agent
  can *build* what it shows on, not just alert. It authenticates with an
  **agent token** (a separate credential class minted on the admin's
  **Agents** tab — it can manage screens and feeds but never mint or revoke
  credentials). The Agents tab shows a paste-ready config; the shape:

  ```json
  {
    "mcpServers": {
      "dashboardz": {
        "command": "node",
        "args": ["<absolute-path-to-dashboardz>/clients/mcp/dist/cli.js"],
        "env": {
          "DASHBOARDZ_HUB_URL": "http://hub.example.lan:8484",
          "DASHBOARDZ_TOKEN": "..."
        }
      }
    }
  }
  ```

  Run `./scripts/setup-dev.sh` from the repository root first; it builds the
  repo-local CLI. Replace `<absolute-path-to-dashboardz>` with the absolute
  path to this checkout. The npm package is not published, so an `npx`
  install is not a supported setup.

## Setup

1. Mint a **sender** for the assistant (admin → Senders, e.g. `claude-code`)
   and set its default devices to the screens the human actually looks at.
2. Give the agent the token via `$DASHBOARDZ_TOKEN` or a `0600` file the
   skill reads (`~/.config/dashboardz/local-sender-token`). Never commit it.
3. Install the skill (above). Done — the skill-only setup has nothing
   resident to run; the agent calls the hub only when it needs to. (For
   reminders and escalation as a standing process, see the daemon below.)

## The wall hooks (`hooks/`)

The skill covers what the agent *chooses* to say; the hooks cover the moment
it can't say anything — a Claude Code session sitting blocked on a permission
prompt while you are away from the keyboard. Two dependency-free shell
scripts (POSIX sh + curl + python3, all stock on macOS/Linux):

- **`needs-attention.sh`** — wired to Claude Code's `Notification` hook.
  Posts a `warn` card with `ttl_s: 1800`, silent by default (set
  `DASHBOARDZ_HOOK_SOUND=1` for one chime per card). The title
  carries the project name ("Claude Code needs you · myrepo") so a wall of
  sessions stays tellable-apart at a glance; the body carries the full path
  and the prompt message. The `dedup_key` is the session id, so however
  many times one session prompts you get ONE card, updated in place — and
  one chime, since dedup updates are silent.
- **`attention-over.sh`** — wired to `UserPromptSubmit` and `Stop`. The
  moment you type back (or the turn ends) it retracts the card with
  `{"resolve": true, "dedup_key": ...}`. Firing with no card up is a
  documented no-op, so over-calling is safe; if you never come back, the
  TTL clears the wall instead.

Install: reuse the same sender/token as the skill (Setup above), then merge
`hooks/settings-example.json` into `~/.claude/settings.json`, replacing
`/PATH/TO/dashboardz` with where you cloned this repo. Set
`DASHBOARDZ_HUB_URL` if your hub is not `http://localhost:8484` (the
scripts also honor `DASHBOARDZ_TOKEN` / `DASHBOARDZ_TOKEN_FILE`). Hooks
config is read at session start, so it takes effect from the next session.
Deliberately NOT hooked: a card per finished turn — that would spam the
wall while you're at the keyboard. "Task done, come look" pings stay a
judgment call the skill makes.

Test without a hub: `sh hooks/test_hooks.sh` (uses `DRY_RUN=1`). Smoke with
one: `printf '{"session_id":"smoke","cwd":"'$PWD'","message":"hello wall"}' | sh hooks/needs-attention.sh`
— the card appears on the sender's default devices; retract it with the same
JSON through `attention-over.sh`.

## What it looks like

The agent finishes a deploy while you make coffee:

```
POST /api/notify   {"title":"Deploy finished — promote to prod?",
                    "severity":"warn","ttl_s":1800,
                    "options":[{"id":"promote","label":"Promote"},
                               {"id":"hold","label":"Hold"}]}
GET  /api/alerts/alr_.../answer   → {"state":"pending"}   (you're walking over)
GET  /api/alerts/alr_.../answer   → {"state":"answered","option_id":"promote",...}
```

The tap on the wall carries the same weight as typing the answer — the skill
tells the agent to treat it that way, report which option was chosen, and
never stack questions.

## Uninstall

Remove the skill folder and delete the sender in the hub admin; its token
stops working immediately and its open questions disappear from every
device.

## The assistant daemon (`assistant/`)

The resident half of this integration: reminders with tap-to-snooze, escalating
asks, and on-demand agent sessions with the dashboardz MCP attached.

    cd assistant && npm install && npm run build
    cp example.env .env && $EDITOR .env      # tokens, hub URL, ANTHROPIC_API_KEY
    node --env-file=.env dist/cli.js remind add "Take meds" --at 21:00 --escalate 15
    node --env-file=.env dist/cli.js daemon  # or install the launchd plist:

    sed -e "s#/PATH/TO/dashboardz#$(git rev-parse --show-toplevel)#" \
        -e "s#/PATH/TO/node#$(command -v node)#" \
        assets/com.dashboardz.assistant.plist > ~/Library/LaunchAgents/com.dashboardz.assistant.plist
    launchctl load ~/Library/LaunchAgents/com.dashboardz.assistant.plist

Uninstall: `launchctl unload ~/Library/LaunchAgents/com.dashboardz.assistant.plist`,
delete the plist and `~/.config/dashboardz-assistant/`, then delete the sender
and agent tokens in the hub admin.
