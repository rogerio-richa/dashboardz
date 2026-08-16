#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveConfig } from './config.js'
import { HubClient, HubError } from './hub.js'
import { fetchContractWithRetry } from './contract.js'
import { buildServer } from './server.js'

const TOKEN_FILE = join(homedir(), '.config', 'dashboardz', 'token')

// The real filesystem reader `resolveConfig` (config.ts) takes as a parameter — guarded because a
// fresh install has no token file yet, and "no token file" must read as "fall through to the
// env-only / no-token error path", not as an uncaught ENOENT crashing the process before it can
// print anything actionable.
function readTokenFile(): string | null {
  try {
    return readFileSync(TOKEN_FILE, 'utf8')
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const { hubUrl, token } = resolveConfig(process.env, readTokenFile)
  const hub = new HubClient(hubUrl, token)
  const contract = await fetchContractWithRetry(hub)
  await buildServer(hub, contract).connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  // Every failure here happens before the stdio transport is up, so nothing has gone to stdout
  // yet (MCP framing lives there) — stderr plus a non-zero exit is the whole contract an MCP
  // client can observe for "this server did not start". A 401 gets its own actionable line: an
  // agent hitting this for the first time has no way to know the fix lives on the hub's own UI.
  const message = error instanceof HubError && error.status === 401
    ? "unauthorized — mint an agent token on the hub's Agents tab, then set DASHBOARDZ_TOKEN or write it to ~/.config/dashboardz/token"
    : error instanceof Error ? error.message : String(error)
  process.stderr.write(`dashboardz-mcp: ${message}\n`)
  process.exit(1)
})
