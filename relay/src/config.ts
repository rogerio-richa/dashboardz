export interface RelayConfig {
  port: number
  trustProxy: boolean
  statePath: string | null
  tokensPath: string | null
  requireToken: boolean
  adminToken: string | null
}

const DEFAULT_PORT = 8790

function loadPort(raw: string | undefined): number {
  // Absent means "use the default." Present-but-unusable (empty, whitespace, or non-numeric)
  // means someone misconfigured this and must be told loudly — silently coercing an empty
  // string to 0 would make Fastify bind an ephemeral port nobody is looking at.
  if (raw === undefined) {
    return DEFAULT_PORT
  }

  // Plain non-negative integers only: no leading/trailing whitespace, no hex/exponential
  // notation, no sign. "0" is deliberately accepted here — tests bind ephemeral ports via an
  // explicit PORT=0 — but an empty string can never reach it, since it fails this pattern.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid PORT ${JSON.stringify(raw)}: must be a non-negative integer, or unset to use the default (${DEFAULT_PORT})`,
    )
  }

  return Number(raw)
}

function loadTrustProxy(raw: string | undefined): boolean {
  // Default false is the safe direction. request.ip (which keys the hub-registration rate
  // limiter in src/socket.ts) only identifies one address per connection if Fastify is told to
  // trust X-Forwarded-For — and it must only be told that when a real reverse proxy is actually
  // in front of this process. Set true without one, and any client can spoof its own
  // X-Forwarded-For to bypass that limiter outright. Leave it false without one in front, and
  // every connection through the real proxy collapses into one shared bucket — silently, since
  // the limiter still runs and still "works," just against the wrong address. Neither failure
  // mode is loud, which is why this is opt-in and strictly parsed rather than coerced.
  if (raw === undefined) {
    return false
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(
    `Invalid TRUST_PROXY ${JSON.stringify(raw)}: must be "true" or "false", or unset to default to false`,
  )
}

function loadStatePath(raw: string | undefined): string | null {
  // Unset means in-memory, the original behavior — fine for tests and casual runs, documented
  // as the TOFU reset limitation. Set means hub bindings persist across restarts (src/store.ts).
  // Set-but-empty is a misconfiguration told loudly, same strictness as PORT and TRUST_PROXY:
  // an operator who set the variable meant to persist, and silently not persisting would revive
  // the exact race they configured this to close.
  if (raw === undefined) return null
  if (raw.trim() === '') {
    throw new Error('Invalid STATE_PATH "": must be a writable file path, or unset for in-memory registration')
  }
  return raw
}

function loadTokensPath(raw: string | undefined): string | null {
  // Unset means no token file — self-hosters who never opt into REQUIRE_TOKEN never need this.
  // Set-but-empty is a misconfiguration told loudly, same idiom as STATE_PATH: an operator who
  // set the variable meant to point at a real file, and silently treating "" as "no token file"
  // would mask that typo instead of catching it at boot.
  if (raw === undefined) return null
  if (raw.trim() === '') {
    throw new Error('Invalid TOKENS_PATH "": must be a file path, or unset for no token file')
  }
  return raw
}

/**
 * REQUIRE_TOKEN without TOKENS_PATH would reject every hub on the service — an outage dressed up
 * as a config typo. Fail at boot instead, the same way PORT does.
 */
function loadRequireToken(raw: string | undefined, tokensPath: string | undefined): boolean {
  if (raw === undefined) return false
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Invalid REQUIRE_TOKEN ${JSON.stringify(raw)}: must be "true" or "false"`)
  }
  if (raw === 'true' && !tokensPath) {
    throw new Error('REQUIRE_TOKEN=true needs TOKENS_PATH — without a token file no hub could ever connect')
  }
  return raw === 'true'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    port: loadPort(env.PORT),
    trustProxy: loadTrustProxy(env.TRUST_PROXY),
    statePath: loadStatePath(env.STATE_PATH),
    tokensPath: loadTokensPath(env.TOKENS_PATH),
    requireToken: loadRequireToken(env.REQUIRE_TOKEN, env.TOKENS_PATH),
    adminToken: env.ADMIN_TOKEN ?? null,
  }
}
