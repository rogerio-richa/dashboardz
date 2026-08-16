# Integrations

An integration is any external process holding a **sender token**. The whole
contract:

1. Push data: `POST /api/feeds/:id` with `Authorization: Bearer dbz_s_...`
   (JSON for value/stream feeds, raw image bytes for image feeds).
2. Raise attention: `POST /api/notify` — severity, optional sound, optional
   answer buttons; poll `GET /api/alerts/:id/answer` for the tap.
3. Off-LAN, the same calls travel sealed through the relay via `dbz-send`
   (`clients/sender`).

The hub owns screens, devices, and policy; an integration never installs
anything into it. No manifest, no registry — the process and its README
*are* the integration.

**Start with the walkthrough:** [docs/integrations.md](../docs/integrations.md)
builds one end-to-end from your terminal.

Then read the examples, simplest first:

| Example | Pattern it demonstrates |
|---|---|
| [`netdata/`](netdata/) | Shell, no deps — bolting onto an existing alerting pipeline (alarm → dispatch → backend) |
| [`meshtastic/`](meshtastic/) | Long-running Python daemon in a container, feed+alert pairing, owns its own config page |
| [`claude/`](claude/) | The agent pattern — no daemon; a skill, wall hooks, and an MCP server make an AI assistant the integration |
| [`claude/`](claude/) | Agent, no daemon — the ask-on-the-wall / read-the-answer loop as a skill |
