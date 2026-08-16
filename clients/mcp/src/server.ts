import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fetchContract, type WidgetContract } from './contract.js'
import type { HubClient } from './hub.js'
import { HubError } from './hub.js'
import { TOOLS } from './tools.js'

/**
 * SKILL.md, served through MCP initialize's `instructions` field so every connected client gets
 * the working loop automatically — nobody has to be told to "read this repo file first" (the gap
 * that made the skill invisible to any agent not driven from this repo). The file sits at the
 * package root; dist/server.js resolves it one level up. A missing/unreadable file degrades to
 * undefined rather than throwing: a broken package layout must not take the tools down with it.
 */
export function loadSkillInstructions(
  path = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md'),
): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Wires the tool table (tools.ts) into the SDK's low-level Server: plain JSON Schema on the wire,
 * no zod on this side (the tool table already speaks JSON Schema — reaching for zod here would be
 * a second schema language for the same shapes). `contract` is the one fetched at process startup
 * (cli.ts); every ListTools response and every schema-shaped call is built from it.
 */
export function buildServer(hub: HubClient, contract: WidgetContract): Server {
  // The contract is LIVE, not a startup constant. A hub rebuild is an ordinary part of working on
  // your own hub, and the first version of this guard turned every one of them into "every
  // schema-shaped write fails until a human restarts the MCP process" — a weakness dressed as
  // caution. See the skew handler below for what replaced it.
  let live = contract
  const server = new Server(
    { name: 'dashboardz-mcp', version: '0.1.0' },
    // `listChanged` is the promise that makes adoption legible to the client: it says this server
    // may change its tool list and will say so, which is what licenses re-reading the schemas.
    { capabilities: { tools: { listChanged: true } }, instructions: loadSkillInstructions() },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      // ToolDef.inputSchema returns `object` (tools.ts's interface — deliberately loose, since it
      // is shaped per-tool from a contract the SDK's Tool type knows nothing about); the SDK's own
      // Tool.inputSchema type is a specific `{type: 'object', properties?, required?}` shape. The
      // cast is a type-level admission of that gap, not a runtime one: every schema tools.ts
      // builds already satisfies it (`type: 'object'` is the first key of every entry).
      inputSchema: t.inputSchema(live) as Tool['inputSchema'],
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name)
    if (!tool) return err(`unknown tool ${req.params.name}`)
    // Skew guard (integration boundary): the tool schemas are shaped from a contract, and a hub upgrade
    // mid-session makes them a confident, wrong description of the hub. Detecting that is right;
    // REFUSING it — which is what this did first — made a human restart the process after every
    // hub rebuild, and the writes it blocked were ones the hub itself would have validated anyway.
    //
    // So: adopt the new contract, tell the client its tools changed (MCP's own mechanism for
    // exactly this), and let the call through against the FRESH schema. The hub is the source of
    // truth for what it accepts, so a stale argument earns a clear 400 rather than a silent wrong
    // write — strictly better than a dead tool and a manual reconnect.
    try {
      if (SCHEMA_SHAPED.has(tool.name)) {
        // Moved inside the try (minor edge case): fetchContract talks to the same hub every other
        // call in this handler does, and can fail the same transient ways (network blip, 5xx). Left
        // outside the try, that failure would escape as an uncaught protocol-level error instead of
        // the tool-level isError every other failure in this handler produces.
        const now = await fetchContract(hub)
        if (now.revision !== live.revision) {
          live = now
          // Fire-and-forget on purpose: a client that never asked for notifications must not make
          // this call fail, and the adoption above has already happened either way.
          void server.sendToolListChanged().catch(() => {})
        }
      }
      const result = await tool.call(hub, live, (req.params.arguments ?? {}) as Record<string, unknown>)
      // `result` is `undefined` only for the hub's 204 No Content responses (HubClient.request's own
      // doc comment) — that's the ONE case `{ok:true}` stands in for. `null` is a real value (or, as
      // of get_screen's not-found fix, never returned at all) and must round-trip as `null`, not be
      // coalesced into a success shape that hides a miss.
      return { content: [{ type: 'text', text: JSON.stringify(result === undefined ? { ok: true } : result) }] }
    } catch (error) {
      if (error instanceof HubError) return err(error.message)
      // A network-level failure (hub unreachable, DNS hiccup) is not a HubError — HubError only
      // wraps a response the hub actually sent. Left as a rethrow, this became an uncaught
      // protocol-level error (the SDK's generic "Internal error"/-32603) instead of a tool-level
      // isError result. Return the tool-level error so one failed call does not look like the whole
      // MCP connection dropped.
      if (error instanceof Error) return err(`hub request failed: ${error.message}`)
      throw error
    }
  })
  return server
}
const SCHEMA_SHAPED = new Set(['create_screen', 'update_screen', 'check_fit'])
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
