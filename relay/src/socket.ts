import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { Registry, type Sink } from './registry.js'
import { RateLimiter } from './rateLimit.js'
import type { TokenStore } from './tokens.js'
import {
  isClientMsg,
  type ErrorCode,
  CLOSE_BAD_SECRET,
  CLOSE_RATE_LIMITED,
  CLOSE_SUPERSEDED,
  CLOSE_TOKEN_REQUIRED,
} from './protocol.js'

export function registerRelaySocket(
  app: FastifyInstance,
  opts: {
    registry?: Registry
    perMinute?: number
    hubRegistrationsPerMinute?: number
    tokens?: TokenStore
    requireToken?: boolean
  } = {},
): void {
  const registry = opts.registry ?? new Registry()
  const limiter = new RateLimiter({ perMinute: opts.perMinute ?? 120 })
  const tokens = opts.tokens
  const requireToken = opts.requireToken ?? false

  // SEND is rate-limited per hub_uid below, but that only
  // throttles hubs that are already registered. An attacker who never SENDs anything — just
  // opens a connection, claims a fresh random hub_uid via HELLO_HUB, and disconnects — grows
  // Registry's hub map by one entry per connection, forever; the map has no eviction and the
  // SEND limiter never sees this traffic. Per-connection limiting doesn't help either, since
  // registerHub only ever runs once per connection (role locks after the first HELLO). The
  // multiplier here is connection count, so registration attempts are rate limited per remote
  // address instead. This bounds how fast one source can grow the map; it does not cap the
  // map's eventual size (many source addresses can still grow it slowly) and old entries are
  // never evicted — a full fix needs a capacity bound or TTL on registrations, out of scope
  // here. Default is deliberately generous (legitimate hubs behind shared NAT/proxy reconnect
  // under the same address) — this is abuse control, not a capacity guarantee.
  const registrationLimiter = new RateLimiter({ perMinute: opts.hubRegistrationsPerMinute ?? 20 })

  // registerHub() silently replaces a still-live socket on
  // a matching reconnect. Registry only tracks Sink (send-only) so it can't close anything;
  // this map recovers the real WebSocket behind a Sink so the superseded connection can be
  // closed instead of left as an unroutable zombie.
  const socketBySink = new WeakMap<Sink, WebSocket>()

  app.get('/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const sink: Sink = { send: (d) => { if (socket.readyState === socket.OPEN) socket.send(d) } }
    socketBySink.set(sink, socket)
    let role: 'hub' | 'sender' | null = null
    let hubUid: string | null = null
    let connId: string | null = null

    const fail = (code: ErrorCode, message: string) =>
      sink.send(JSON.stringify({ type: 'ERROR', code, message }))

    socket.on('message', (raw) => {
      // Last-resort guarantee: nothing a client sends may crash the relay.
      try {
        const parsed: unknown = JSON.parse(raw.toString())
        if (!isClientMsg(parsed)) return
        const msg = parsed

        if (msg.type === 'HELLO_HUB') {
          if (role) return
          if (typeof msg.hub_uid !== 'string' || typeof msg.secret !== 'string') {
            return fail('malformed', 'hub_uid and secret are required')
          }
          // request.ip is only a real per-address key if the deployment's reverse-proxy
          // topology matches config.ts's trustProxy setting (see comments there and in
          // server.ts). Get that wrong and this either does nothing (every connection behind
          // an untrusted proxy collapses into one bucket) or is trivially bypassed (trusting
          // X-Forwarded-For with no real proxy in front lets any client spoof it).
          if (!registrationLimiter.allow(request.ip)) {
            socket.close(CLOSE_RATE_LIMITED, 'rate limited')
            return
          }
          // Ordering matters twice over: after the rate limiter, so token guessing is throttled
          // like any other registration attempt; before registerHub, so a rejected connection
          // never claims the uid (TOFU would then hold it for someone with no token at all).
          let accountId: string | null = null
          const accountToken = msg.account_token
          if (typeof accountToken === 'string' && accountToken !== '') {
            if (!tokens) {
              // Distinct from "unknown token" below: nothing is misconfigured on the client's
              // side here, this relay simply has no store to check it against.
              socket.close(CLOSE_TOKEN_REQUIRED, 'this relay has no account-token store')
              return
            }
            const valid = tokens.validate(accountToken)
            if (!valid) {
              socket.close(CLOSE_TOKEN_REQUIRED, 'unknown or revoked account token')
              return
            }
            accountId = valid.accountId
          } else if (accountToken !== undefined && typeof accountToken !== 'string') {
            // Present but not a string (a number, object, etc.) is a malformed credential, not
            // an absent one — reject it explicitly in both modes so rule's "validated when
            // presented" stays honest even for garbage input, instead of silently falling
            // through to the absent-token branch below.
            socket.close(CLOSE_TOKEN_REQUIRED, 'account_token must be a string')
            return
          } else if (requireToken) {
            socket.close(CLOSE_TOKEN_REQUIRED, 'an account token is required on this relay')
            return
          }
          // Capture the incumbent before registerHub() overwrites it.
          const priorSink = registry.hubSink(msg.hub_uid)
          const res = registry.registerHub(msg.hub_uid, msg.secret, sink)
          if (!res.ok) {
            socket.close(CLOSE_BAD_SECRET, 'bad secret')
            return
          }
          if (priorSink && priorSink !== sink) {
            socketBySink.get(priorSink)?.close(CLOSE_SUPERSEDED, 'superseded by a new connection')
          }
          // Note: in optional mode (requireToken=false) a hub can drop its own attribution by
          // simply reconnecting without presenting its token — setHubAccount(uid, null) below
          // clears it, same as if it had never been attributed. The cap is therefore not real
          // enforcement until REQUIRE_TOKEN=true forces every hub to keep proving its token.
          registry.setHubAccount(msg.hub_uid, accountId)
          role = 'hub'; hubUid = msg.hub_uid
          sink.send(JSON.stringify({ type: 'READY' }))
          return
        }

        if (msg.type === 'HELLO_SENDER') {
          if (role) return
          if (typeof msg.hub_uid !== 'string') return fail('malformed', 'hub_uid is required')
          // The cap is the ACCOUNT's, counted across every hub it owns — otherwise minting a
          // second token (or pairing a second hub) would silently double the allowance.
          const senderAccountId = registry.hubAccount(msg.hub_uid)
          if (senderAccountId !== null) {
            const account = tokens?.account(senderAccountId) ?? null
            // Fail closed: a hub attributed to an account that no longer exists (deleted by an
            // operator — the natural response to abuse — while the hub's attribution persists
            // until it reconnects) must NOT collapse back to "no cap" just because the lookup
            // came up empty. Treat it the same as maxClients: 0 — refuse, never admit. An
            // unattributed (anonymous) hub is the only case that stays genuinely uncapped.
            const max = account ? account.maxClients : 0
            if (max !== null && (registry.counts().accounts[senderAccountId]?.senders ?? 0) >= max) {
              socket.close(CLOSE_RATE_LIMITED, 'account client limit reached')
              return
            }
          }
          role = 'sender'; hubUid = msg.hub_uid
          connId = registry.attachSender(msg.hub_uid, sink)
          sink.send(JSON.stringify({ type: 'READY', conn_id: connId }))
          return
        }

        if (!role) return fail('not_authenticated', 'send HELLO_HUB or HELLO_SENDER first')

        if (msg.type === 'SEND') {
          if (role !== 'sender' || !hubUid || !connId) return
          if (typeof msg.payload !== 'string') return fail('malformed', 'payload must be a string')
          if (!limiter.allow(hubUid)) return fail('rate_limited', 'too many messages for this hub')
          const hub = registry.hubSink(hubUid)
          if (!hub) return fail('hub_offline', 'the target hub is not connected')
          // payload is opaque: forwarded verbatim, never parsed, never logged.
          hub.send(JSON.stringify({ type: 'DELIVER', conn_id: connId, payload: msg.payload }))
          return
        }

        if (msg.type === 'REPLY') {
          if (role !== 'hub') return
          if (typeof msg.conn_id !== 'string' || typeof msg.payload !== 'string') return
          // A sender that has gone away is normal, not an error — drop it. The answer is
          // still stored hub-side, so nothing is lost.
          registry.senderSink(msg.conn_id)?.send(
            JSON.stringify({ type: 'REPLY', payload: msg.payload }),
          )
          return
        }
      } catch {
        // swallow: a malformed frame must never take down the relay
      }
    })

    socket.on('close', () => {
      if (role === 'hub' && hubUid) registry.detachHub(hubUid, sink)
      if (role === 'sender' && connId) registry.detachSender(connId)
    })
  })
}
