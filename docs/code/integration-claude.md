# Claude integration

[`integrations/claude`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/claude) makes an AI assistant the
integration. It has three independent pieces: a skill (a document an agent
reads), two shell hooks for Claude Code, and an optional resident daemon. All
of them hold an ordinary sender token and use only the public HTTP API. The
folder's [README](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/README.md) is the install guide;
[Claude and AI agents](../gallery/claude.md) is the overview.

## The pieces

| Piece | Files | What it does |
| --- | --- | --- |
| `dashboardz-ask` skill | [`SKILL.md`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/SKILL.md) | Teaches an agent the ask loop: `POST /api/notify` with up to four options, then poll `GET /api/alerts/:id/answer`. LAN path; the relay path is the OpenClaw skill in [Sender client](sender.md). |
| Wall hooks | [`hooks/needs-attention.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/hooks/needs-attention.sh), [`hooks/attention-over.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/hooks/attention-over.sh), [`hooks/settings-example.json`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/hooks/settings-example.json) | On Claude Code's `Notification` hook, post a `warn` card deduped by session id; on `UserPromptSubmit` and `Stop`, retract it with `resolve: true`. POSIX sh, curl and python3. |
| Assistant daemon | [`assistant/`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/claude/assistant) | `dbz-assistant`: reminders with tap-to-snooze, escalating asks, and on-demand agent sessions with the Dashboardz MCP attached. |

## The assistant daemon

A TypeScript package (MIT, like the sender and MCP clients). Start at
[`assistant/src/cli.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/cli.ts), which
dispatches `remind add|list|rm`, `ask`, `run <prompt>` and `daemon`.

| File | What it owns |
| --- | --- |
| [`daemon.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/daemon.ts) | The tick loop: finds due reminders and fires each without blocking the tick. |
| [`scheduler.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/scheduler.ts) | `dueReminders`: which reminders are due, late, or inside the catch-up window. |
| [`reminders.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/reminders.ts) | `fireReminder`: marks a reminder fired first (so a crash cannot double-fire), asks, records the outcome. |
| [`escalate.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/escalate.ts) | `askWithEscalation`: posts a `warn` question, polls the answer route, and after a delay raises a *new* alert so the device chimes again. |
| [`hub.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/hub.ts) | Minimal HTTP client for notify and answer. |
| [`session.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/session.ts) | Runs a Claude Agent SDK session with `clients/mcp` attached (imported lazily). |
| [`store.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/store.ts), [`runtime.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/runtime.ts), [`config.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/src/config.ts) | Reminder file, runtime settings, and environment (`ASSISTANT_*`, hub URL, tokens). |

[`assets/com.dashboardz.assistant.plist`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/assets/com.dashboardz.assistant.plist)
is the launchd template; [`example.env`](https://github.com/rogerio-richa/dashboardz/blob/main/integrations/claude/assistant/example.env)
lists the variables.

## How it connects

Everything goes through `POST /api/notify` and `GET /api/alerts/:id/answer`
([`hub/src/routes/notify.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/notify.ts)). The daemon's
`run` command starts the MCP server from
[`clients/mcp`](mcp.md), which needs an agent token.

## Things that trip people up

- **Escalation needs a new alert id.** Devices chime once per alert id, so a
  dedup update to the original could never make a second sound.
- **`SKILL.md` is pinned.** `hub/test/skill-doc.test.ts` checks it names both
  routes and exactly the four answer states the hub returns.
- **Hooks are read at session start;** a settings change takes effect in the
  next Claude Code session.
- **Build from public docs only.** Per CONTRIBUTING, anything here must be
  buildable from [Building an integration](../integrations.md) without reading
  hub source.

## Tests

`sh integrations/claude/hooks/test_hooks.sh` (dry run, no hub, checks the
JSON each hook would post) and
[`assistant/test`](https://github.com/rogerio-richa/dashboardz/tree/main/integrations/claude/assistant/test) (Vitest, one file
per module) via `npm --prefix integrations/claude/assistant test`.
