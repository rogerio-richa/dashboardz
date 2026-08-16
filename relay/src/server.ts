import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { RelayConfig } from './config.js'
import { registerRelaySocket } from './socket.js'
import { Registry, constantTimeEquals } from './registry.js'
import { RegistryStore } from './store.js'
import { TokenStore } from './tokens.js'

declare module 'fastify' {
  interface FastifyInstance {
    relayConfig: RelayConfig
  }
}

// Hard cap on a single WebSocket frame. Without it, ws defaults maxPayload to 100 MiB, and a
// frame is buffered in full and JSON.parsed (socket.ts) BEFORE any rate limiter runs — the SEND
// limiter counts messages, not bytes, and registration limiting only touches HELLO_HUB — so an
// anonymous client could drive multi-GB transient allocations and OOM the process. Legitimate
// sealed envelopes are ~3 KB; 64 KiB is huge headroom. ws enforces this before our handler ever
// sees the frame: the offending connection is closed with 1009, nothing is parsed or routed.
const MAX_FRAME_BYTES = 65536

export async function buildRelay(opts: { config: RelayConfig }): Promise<FastifyInstance> {
  // logger:false is deliberate and load-bearing: this service must never emit payload
  // content to logs (documented contract). Structured logging can be added later, but only with an
  // explicit allowlist of fields — never the whole message.
  //
  // trustProxy defaults false (config.ts) and must only be set true when a real reverse proxy
  // sits in front of this process — it governs whether request.ip (which keys the hub
  // registration rate limiter in socket.ts) reads the real client address or a spoofable
  // X-Forwarded-For header.
  const app = Fastify({ logger: false, trustProxy: opts.config.trustProxy })
  app.decorate('relayConfig', opts.config)
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } })

  app.get('/health', async () => ({ ok: true, service: 'dashboardz-relay' }))

  // With STATE_PATH, hub bindings survive restarts and the documented TOFU reset race is closed
  // for every remembered uid; without it, behavior is the original in-memory registry. One log
  // line either way, so an operator can see which mode they are actually in.
  const registry = opts.config.statePath
    ? new Registry(new RegistryStore(opts.config.statePath))
    : new Registry()
  console.log(opts.config.statePath
    ? `relay: hub registrations persisted at ${opts.config.statePath}`
    : 'relay: in-memory registration (STATE_PATH unset) — hub bindings reset on restart')
  // With TOKENS_PATH, hub registrations can be attributed to an account and capped
  // (src/tokens.ts); REQUIRE_TOKEN decides whether an absent/unknown token is refused outright
  // or merely validated-when-present (loud during a gradual rollout, see socket.ts rule).
  const tokens = opts.config.tokensPath ? new TokenStore(opts.config.tokensPath) : undefined
  console.log(opts.config.requireToken
    ? 'relay: account tokens REQUIRED for hub registration'
    : `relay: account tokens ${tokens ? 'optional (validated when presented)' : 'not configured'}`)
  registerRelaySocket(app, { registry, tokens, requireToken: opts.config.requireToken })

  // Registered only when an admin token exists: an unprotected connection census on a public
  // service is a gift to whoever is deciding whether to abuse it. 404 rather than 401 when
  // unconfigured, so the endpoint's existence is not advertised either.
  if (opts.config.adminToken) {
    const expected = `Bearer ${opts.config.adminToken}`
    app.get('/admin/stats', async (req, reply) => {
      // Constant-time, same idiom as registry.ts's hub-secret check: a naive !== leaks timing
      // information proportional to how many leading bytes of the bearer match, which is exactly
      // the kind of side channel an admin token — the highest-privilege credential this service
      // has — should not have. Guard the type first: authorization is `string | undefined`, and
      // constantTimeEquals(undefined, ...) would throw inside Buffer.from before ever comparing.
      const provided = req.headers.authorization
      if (typeof provided !== 'string' || !constantTimeEquals(provided, expected)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      const counts = registry.counts()
      const zero = { hubs: 0, hubsOnline: 0, senders: 0 }
      const known = tokens?.accounts() ?? []
      const knownIds = new Set(known.map(a => a.id))
      // A connection can be attributed to an accountId that no longer exists in the store: the
      // hub was validated against a token whose account was later deleted, and the binding
      // (registry.setHubAccount) stays live until that hub next reconnects and gets re-validated
      // (or refused). Without this, those connections are in neither the known-accounts list nor
      // `anonymous` — invisible in the census exactly during the abuse response this endpoint
      // exists for. maxClients: 0 matches the cap those connections are already subject to: an
      // orphaned token fails validate() closed (tokens.ts), so nothing new can join that account.
      const deleted = Object.entries(counts.accounts)
        .filter(([accountId]) => !knownIds.has(accountId))
        .map(([accountId, c]) => ({ accountId, label: '(deleted)', maxClients: 0, ...c }))
      return {
        accounts: [
          ...known.map(a => ({
            accountId: a.id, label: a.label, maxClients: a.maxClients, ...(counts.accounts[a.id] ?? zero),
          })),
          ...deleted,
        ],
        anonymous: counts.anonymous,
      }
    })
  }

  return app
}
