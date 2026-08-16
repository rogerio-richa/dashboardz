import { mkdirSync } from 'node:fs'
import type { Config } from './config.js'
import type { RuntimeConfig } from './runtime.js'

const SYSTEM_PROMPT =
  'You are the household Dashboardz assistant. You act on the hub through the ' +
  'dashboardz MCP tools (screens, feeds, devices). Alerts you raise follow the ' +
  'severity discipline: info is never audible, warn for questions, critical only ' +
  'when being unheard is worse than waking someone. Be brief; the wall is small.'

export function buildOptions(cfg: Config, rt: RuntimeConfig): Record<string, unknown> {
  return {
    model: rt.model,
    permissionMode: rt.permissionMode,
    maxTurns: 30,
    cwd: cfg.dataDir,
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: {
      dashboardz: {
        command: 'node',
        args: [cfg.mcpCli],
        env: { DASHBOARDZ_HUB_URL: cfg.hubUrl, DASHBOARDZ_TOKEN: cfg.agentToken },
      },
    },
    allowedTools: ['mcp__dashboardz__*'],
  }
}

export async function runSession(cfg: Config, rt: RuntimeConfig, prompt: string): Promise<string> {
  // The SDK's cwd must exist before it's invoked.
  mkdirSync(cfg.dataDir, { recursive: true })
  // Dynamic import keeps unit tests (and the reminder path) free of the SDK.
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  for await (const message of query({ prompt, options: buildOptions(cfg, rt) as never })) {
    if ((message as { type?: string }).type === 'result') {
      const m = message as { subtype?: string; result?: string }
      if (m.subtype === 'success') return m.result ?? ''
      throw new Error(`session failed: ${m.subtype}`)
    }
  }
  throw new Error('session produced no result message')
}
