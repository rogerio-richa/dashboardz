# MCP server

[`clients/mcp`](https://github.com/rogerio-richa/dashboardz/tree/main/clients/mcp) is `dashboardz-mcp`, a stdio MCP server that
lets an AI agent read and edit a hub's screens, feeds and device assignments.
It is a thin client of the hub's `/admin/api/*` routes, authenticated with an
agent token (`dbz_a_...`). It is a separate npm package and never imports hub
source at runtime. The agent-facing instructions are
[`SKILL.md`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/SKILL.md); token classes are explained in
[Security model: Agent tokens](../architecture/security.md#agent-tokens).

## Start here

1. [`src/cli.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/src/cli.ts): the entry point. Resolves the
   hub URL and token, fetches the widget contract, and connects the server to
   stdio. Startup errors go to stderr, never stdout (stdout carries MCP
   framing).
2. [`src/tools.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/src/tools.ts): `TOOLS`, one row per tool.
   Each row has a name, a description, an `inputSchema` (some shaped from the
   contract) and a `call` that is usually one `hub.request(...)`.
   `create_feed` and `update_feed` share `FEED_PROPS` and the `FEED_FIELDS`
   description, which spells out `allowed_senders` (`null` any, `[]` nobody). The table is
   effectively the route map.
3. [`src/server.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/src/server.ts): `buildServer` wires the
   tool table into the MCP SDK and serves `SKILL.md` as the server's
   `instructions`.

## The other files

| File | What it owns |
| --- | --- |
| [`src/config.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/src/config.ts) | `DASHBOARDZ_HUB_URL`, and `DASHBOARDZ_TOKEN` or `~/.config/dashboardz/token` (env wins). |
| [`src/hub.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/src/hub.ts) | `HubClient` (Bearer auth, JSON) and `HubError`, which carries the hub's own `{error}` text. |
| [`src/contract.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/clients/mcp/src/contract.ts) | Consumer-side copy of the `WidgetContract` type, `fetchContract` and a retrying variant for startup. |

## How it connects

The contract comes from `GET /admin/api/widget-contract`, built by
[`hub/src/screens/widgetContract.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/widgetContract.ts)
from the same schema AJV validates with. Before each schema-shaped call
(`create_screen`, `update_screen`, `check_fit`) the server re-fetches the
contract; if its `revision` changed it adopts the new one and notifies the
client that the tool list changed. Writes are validated by the hub, not here.

## Things that trip people up

- **Run it from the repo build.** The package is not published to npm;
  `scripts/setup-dev.sh` builds `clients/mcp/dist/cli.js`, which is what MCP
  client configs point at.
- **Every write is live.** There is no draft step; `update_screen` needs the
  `rev` last read and a 409 means someone else changed the screen.
- **Tool names are pinned.** `hub/test/skill-doc.test.ts` reads the `name:`
  fields in `tools.ts` and requires `SKILL.md` to mention each one. Renaming a
  tool means updating the skill.
- **The type in `contract.ts` is a copy,** not an import, because the package
  is built independently of the hub.

## Tests

[`clients/mcp/test`](https://github.com/rogerio-richa/dashboardz/tree/main/clients/mcp/test): `tools.test.ts`, `server.test.ts`,
`contract.test.ts`, `config.test.ts`, `hub.test.ts`, and `hub-pin.test.ts`,
which boots a real hub server in process and proves every route the tools call
still exists (so it needs `hub/node_modules`). Run with
`npm --prefix clients/mcp test`.
