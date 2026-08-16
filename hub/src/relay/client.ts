import WebSocket from 'ws'
import type { RelayIdentity } from './identity.js'

export interface RelaySocket {
  send(data: string): void
  close(): void
  ping?(): void
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
}

export interface RelayClientOpts {
  url: string
  identity: RelayIdentity
  /** This hub's relay account token, read from settings by the caller and sent in HELLO_HUB; never persisted here. */
  accountToken?: string
  onDeliver: (connId: string, payload: string) => void
  random?: () => number
  schedule?: (ms: number, fn: () => void) => void
  connect?: (url: string) => RelaySocket
  /** How often to ping once ready. Defaults to 30s, matching ws/deviceSocket.ts. */
  pingIntervalMs?: number
  /**
   * Injected the same way `schedule` is, so the heartbeat is testable without real timers — but
   * kept as its own seam rather than reusing `schedule` itself: reconnect-backoff tests assert
   * exact recorded delay sequences, and a ping tick interleaving into that same recording would
   * make those assertions depend on incidental timing instead of the backoff curve.
   */
  schedulePing?: (ms: number, fn: () => void) => void
  /** Clock seam so tests can pin connected_since / last_error timestamps. */
  now?: () => number
  /**
   * Observer for the transitions worth telling a human about: becoming ready, and stopping
   * for good. Deliberately NOT fired on ordinary drops — reconnect churn is the client's
   * job to absorb, not the operator's job to read about (no audit spam).
   */
  onEvent?: (ev: RelayEvent) => void
}

/**
 * WebSocket close codes the relay uses for protocol/abuse enforcement (relay/src/protocol.ts,
 * private-use range 4000-4999). Duplicated here rather than imported: hub and relay are
 * independently deployed services (separate package.json, separate Docker image) that share
 * only a wire contract, not a source tree.
 *
 * CLOSE_BAD_SECRET (4401): this hub_uid is registered to a different secret. Retrying cannot
 * fix it — treat it as terminal, don't hammer the relay.
 *
 * CLOSE_SUPERSEDED (4409): the relay closes a superseded zombie socket with this when a newer
 * connection claims the same hub_uid. Explicitly NOT an auth failure (see the comment on the
 * constant in relay/src/protocol.ts) — a client seeing it must reconnect normally, the same as
 * any other clean disconnect. It falls through to the default backoff path below precisely by
 * NOT appearing in the fatal check.
 *
 * CLOSE_RATE_LIMITED (4429) and the reserved CLOSE_MALFORMED (4400, never currently emitted)
 * likewise need no special handling: the default backoff-and-retry path is already correct for
 * both.
 *
 * CLOSE_TOKEN_REQUIRED (4403): the relay requires an account token and this connection had none,
 * or one that is unknown/revoked. Terminal for the same reason CLOSE_BAD_SECRET is —
 * retrying the same credentials cannot succeed — but distinct from it so the hub can say WHICH
 * credential is wrong.
 */
export const CLOSE_BAD_SECRET = 4401
export const CLOSE_TOKEN_REQUIRED = 4403

/**
 * The closed set of last_error codes. The admin UI keeps a plain-words explanation for every
 * code (RelayBadge.tsx ERROR_COPY); hub/test/relay-error-copy.test.ts pins the two lexically
 * so a code added here without copy there fails the build.
 */
export const RELAY_ERROR_CODES = ['bad_secret', 'closed', 'token_required'] as const
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]
export type RelayEvent = { type: 'ready' } | { type: 'terminal'; code: RelayErrorCode; message: string }
export interface RelayLastError { code: RelayErrorCode; message: string; at: number }

const BAD_SECRET_MESSAGE =
  "the relay rejected this hub's identity with a bad-secret close (4401); relay delivery has " +
  'stopped until the identity conflict is resolved'

const TOKEN_REQUIRED_MESSAGE =
  "the relay rejected this hub's account token (4403): it is missing, unknown or revoked. " +
  'Paste a valid token into the relay badge — relay delivery stays stopped until you do.'

const defaultSchedule = (ms: number, fn: () => void): void => { setTimeout(fn, ms).unref?.() }

export function realSocket(url: string): RelaySocket {
  const ws = new WebSocket(url)
  const s: RelaySocket = {
    send: (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) },
    // terminate(), not close(): a half-open connection (the exact failure the heartbeat below
    // exists to catch) may never complete a graceful close handshake, because the peer isn't
    // actually there to answer it. terminate() tears down the local socket unconditionally and
    // always emits 'close', which is what both a voluntary stop() and a failed heartbeat need.
    close: () => ws.terminate(),
    ping: () => { if (ws.readyState === WebSocket.OPEN) ws.ping() },
  }
  ws.on('open', () => s.onOpen?.())
  ws.on('message', (raw) => s.onMessage?.(raw.toString()))
  ws.on('close', (code) => s.onClose?.(code))
  ws.on('pong', () => s.onPong?.())
  ws.on('error', () => { /* close always follows; nothing to do here */ })
  return s
}

export class RelayClient {
  private socket?: RelaySocket
  private attempt = 0
  private running = false
  // Bumped on every start()/stop(). A reconnect timer captures the generation it was scheduled
  // under; if stop() and then start() run again before it fires, the generation no longer
  // matches and the stale timer becomes a no-op instead of dialling a second, orphaning socket
  // over the freshly-started one.
  private generation = 0
  private _state: 'offline' | 'connecting' | 'ready' = 'offline'
  private readonly random: () => number
  private readonly schedule: (ms: number, fn: () => void) => void
  private readonly schedulePing: (ms: number, fn: () => void) => void
  private readonly connect: (url: string) => RelaySocket
  private readonly pingIntervalMs: number
  private _connectedSince: number | null = null
  private _lastError: RelayLastError | null = null
  private _terminal = false
  private readonly now: () => number

  constructor(private readonly opts: RelayClientOpts) {
    this.random = opts.random ?? Math.random
    this.schedule = opts.schedule ?? defaultSchedule
    this.schedulePing = opts.schedulePing ?? defaultSchedule
    this.connect = opts.connect ?? realSocket
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  get state() { return this._state }
  get connectedSince() { return this._connectedSince }
  get lastError() { return this._lastError }
  get terminal() { return this._terminal }
  get hubUid() { return this.opts.identity.hubUid }
  get url() { return this.opts.url }

  /** A buggy observer (audit write during shutdown, say) must never break transport. */
  private emit(ev: RelayEvent): void {
    try { this.opts.onEvent?.(ev) } catch { /* observer error is the observer's problem */ }
  }

  start(): void {
    this.running = true
    this._terminal = false
    this.attempt = 0
    this.generation++
    this.dial()
  }

  /** Idempotent: safe to call more than once, and cancels any pending reconnect timer. */
  stop(): void {
    this.running = false
    this.generation++
    this._state = 'offline'
    this.socket?.close()
    this.socket = undefined
    this._connectedSince = null
  }

  sendReply(connId: string, payload: string): void {
    if (this._state !== 'ready') return   // answer is still stored hub-side; nothing is lost
    this.socket?.send(JSON.stringify({ type: 'REPLY', conn_id: connId, payload }))
  }

  private dial(): void {
    if (!this.running) return
    const gen = this.generation
    this._state = 'connecting'
    let s: RelaySocket
    try {
      s = this.connect(this.opts.url)
    } catch {
      // `ws` throws SYNCHRONOUSLY out of its WebSocket constructor for some invalid URLs (e.g. a
      // `#fragment` — see isRelayUrl in config.ts). isRelayUrl is meant to catch that before a URL
      // is ever stored, but a hand-edited settings row or a future validation gap must not turn
      // into a boot crash-loop — nothing may escape dial(). Treat it exactly like an immediate
      // connection failure: offline, record the error, let the normal backoff retry.
      this._state = 'offline'
      this.socket = undefined
      this._connectedSince = null
      this._lastError = { code: 'closed', message: 'connection to the relay closed', at: this.now() }
      const ceiling = Math.min(1000 * 2 ** this.attempt, 60_000)
      if (this.attempt < 30) this.attempt++
      this.schedule(Math.max(1, Math.floor(ceiling * (0.5 + 0.5 * this.random()))), () => {
        if (gen !== this.generation) return
        this.dial()
      })
      return
    }
    this.socket = s
    let missedPongs = 0

    // Ticks only while `s` is still the live socket (checked by identity, not generation: a
    // normal relay-initiated close-and-reconnect doesn't bump generation, but it does replace
    // `this.socket` — without this check a stale tick from the socket that just closed could
    // still fire later, ping an already-dead `ws` (which throws), or double up with the new
    // connection's own heartbeat loop).
    const pingTick = () => {
      if (this.socket !== s) return
      missedPongs++
      if (missedPongs > 2) {
        // Half-open detection: an idle NAT or load-balancer can drop the TCP connection without
        // a FIN. The socket then looks alive with no local signal anything is wrong — the state
        // machine would sit at 'ready' forever, silently swallowing every DELIVER. Forcing a
        // close here is what lets the existing backoff-and-reconnect path notice and take over.
        s.close()
        return
      }
      s.ping?.()
      this.schedulePing(this.pingIntervalMs, pingTick)
    }

    s.onOpen = () => {
      s.send(JSON.stringify({
        type: 'HELLO_HUB',
        hub_uid: this.opts.identity.hubUid,
        secret: this.opts.identity.hubSecret,
        ...(this.opts.accountToken ? { account_token: this.opts.accountToken } : {}),
      }))
    }

    s.onPong = () => { if (this.socket === s) missedPongs = 0 }

    s.onMessage = (raw) => {
      try {
        const msg = JSON.parse(raw) as { type?: unknown; conn_id?: unknown; payload?: unknown }
        if (!msg || typeof msg.type !== 'string') return
        if (msg.type === 'READY') {
          if (this._state !== 'ready') {
            this._connectedSince = this.now()
            this.emit({ type: 'ready' })
          }
          this._state = 'ready'
          this.attempt = 0
          missedPongs = 0
          this.schedulePing(this.pingIntervalMs, pingTick)
          return
        }
        if (msg.type === 'DELIVER' && typeof msg.conn_id === 'string' && typeof msg.payload === 'string') {
          this.opts.onDeliver(msg.conn_id, msg.payload)
        }
      } catch {
        // a malformed frame must never crash the hub
      }
    }

    // `stop()` sets `this.socket = undefined` and calls `s.close()`, which synchronously
    // invokes this same handler (see FakeSocket / most real ws implementations' close semantics
    // via the 'close' event). Re-reading `this.running` (already false) below is what makes
    // stop() actually cancel outstanding reconnects rather than racing them.
    s.onClose = (code) => {
      if (gen !== this.generation) return   // a stop()/start() pair superseded this dial cycle
      this._state = 'offline'
      this.socket = undefined
      this._connectedSince = null
      if (!this.running || code === CLOSE_BAD_SECRET || code === CLOSE_TOKEN_REQUIRED) {
        if (code === CLOSE_BAD_SECRET) {
          // Loud on purpose (relay/README.md promises it): the real-world trigger is two hubs
          // booted from one cloned DB image, and the loser would otherwise lose relay delivery
          // forever with zero trace. hub_uid is routing metadata the relay already knows; the
          // secret must never appear here.
          console.error(
            `relay: the relay rejected this hub's identity (${this.opts.identity.hubUid}) with a ` +
            'bad-secret close (4401) — delivery via relay has stopped permanently until the ' +
            'identity conflict is resolved',
          )
          this._lastError = { code: 'bad_secret', message: BAD_SECRET_MESSAGE, at: this.now() }
          this._terminal = true
          this.emit({ type: 'terminal', code: 'bad_secret', message: BAD_SECRET_MESSAGE })
        }
        if (code === CLOSE_TOKEN_REQUIRED) {
          // Loud for the same reason the bad-secret stop is: a silently-stopped relay connection
          // is invisible until someone notices deliveries aren't arriving. hub_uid is routing
          // metadata the relay already knows; the account token must never appear here.
          console.error(
            `relay: the relay rejected this hub's account token (${this.opts.identity.hubUid}) ` +
            'with a token-required close (4403) — delivery via relay has stopped permanently ' +
            'until a valid account token is configured',
          )
          this._lastError = { code: 'token_required', message: TOKEN_REQUIRED_MESSAGE, at: this.now() }
          this._terminal = true
          this.emit({ type: 'terminal', code: 'token_required', message: TOKEN_REQUIRED_MESSAGE })
        }
        this.running = false
        return
      }
      this._lastError = { code: 'closed', message: 'connection to the relay closed', at: this.now() }
      const ceiling = Math.min(1000 * 2 ** this.attempt, 60_000)
      if (this.attempt < 30) this.attempt++
      // 50–100% jitter: without it every hub reconnects in lockstep when the relay returns.
      this.schedule(Math.max(1, Math.floor(ceiling * (0.5 + 0.5 * this.random()))), () => {
        if (gen !== this.generation) return
        this.dial()
      })
    }
  }
}
