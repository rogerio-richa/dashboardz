import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Config {
  hubUrl: string
  senderToken: string
  agentToken: string
  dataDir: string
  tickMs: number
  devices: string[]
  adherenceFeed: string | null
  mcpCli: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim()
  if (!v) throw new Error(`${key} is not set — see example.env`)
  return v
}

function tickMs(env: NodeJS.ProcessEnv): number {
  const raw = env.ASSISTANT_TICK_MS
  if (!raw) return 30_000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`ASSISTANT_TICK_MS must be a finite number > 0, got: ${raw}`)
  }
  return n
}

// dist/config.js lives at integrations/claude/assistant/dist/, so the repo
// root is four levels up. Overridable for installs outside the repo.
const DEFAULT_MCP_CLI = fileURLToPath(new URL('../../../../clients/mcp/dist/cli.js', import.meta.url))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    hubUrl: required(env, 'DASHBOARDZ_HUB_URL').replace(/\/$/, ''),
    senderToken: required(env, 'DASHBOARDZ_SENDER_TOKEN'),
    agentToken: required(env, 'DASHBOARDZ_AGENT_TOKEN'),
    dataDir: env.ASSISTANT_DATA_DIR ?? join(homedir(), '.config', 'dashboardz-assistant'),
    tickMs: tickMs(env),
    devices: (env.ASSISTANT_DEVICES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    adherenceFeed: env.ASSISTANT_ADHERENCE_FEED?.trim() || null,
    mcpCli: env.DASHBOARDZ_MCP ?? DEFAULT_MCP_CLI,
  }
}
