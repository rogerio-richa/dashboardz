/**
 * Config resolution for the MCP process: a hub URL and a bearer token, from the environment or a
 * token file. `resolveConfig` takes the file reader as a parameter rather than touching the
 * filesystem itself, so tests exercise the precedence deterministically with no real files; the
 * real reader (default `~/.config/dashboardz/token`, read in `cli.ts`) is wired up at the actual
 * process entrypoint, not here.
 *
 * The env-wins-over-file precedence matches `clients/openclaw/SKILL.md`'s shell idiom exactly —
 * `TOKEN="${DASHBOARDZ_TOKEN:-$(cat ~/.config/dashboardz/token)}"` — so an operator who already
 * knows that idiom from the sender/openclaw side gets the same mental model here for free.
 */
export function resolveConfig(
  env: Record<string, string | undefined>,
  readTokenFile: () => string | null,
): { hubUrl: string; token: string } {
  const hubUrl = env.DASHBOARDZ_HUB_URL
  if (!hubUrl) {
    throw new Error(
      'DASHBOARDZ_HUB_URL is not set — export it (e.g. DASHBOARDZ_HUB_URL=http://localhost:8484)',
    )
  }

  // Trim both sources: a CI-injected env var with a trailing newline is as common a failure mode
  // as a hand-edited token file, and would otherwise fail auth with no clue why (the file token
  // was already trimmed; the env one wasn't).
  const envToken = env.DASHBOARDZ_TOKEN?.trim()
  const token = envToken ?? readTokenFile()?.trim()
  if (!token) {
    throw new Error(
      'no token: set DASHBOARDZ_TOKEN or write one to ~/.config/dashboardz/token',
    )
  }

  return { hubUrl, token }
}
