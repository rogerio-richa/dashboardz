import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { open, seal } from './envelope.js'

/**
 * The narrow surface of a websocket this client needs, so tests can inject a fake and drive the
 * whole wire conversation deterministically (the same seam hub/src/relay/client.ts uses).
 */
export interface SenderSocket {
  send(data: string): void
  close(): void
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
}

export type Severity = 'info' | 'warn' | 'critical'

/**
 * Exactly the plaintext the hub accepts over the relay (hub/src/relay/handler.ts). There is
 * deliberately no sender_token field: the AEAD open IS the authentication (design rationale envelope authentication),
 * and a credential that is never in the payload can never be logged out of it.
 */
export interface NotifyOpts {
  /** Required for a create; not required (and not sent) for a `resolve`. */
  title?: string
  /** Required for a create; not required (and not sent) for a `resolve`. */
  severity?: Severity
  body?: string
  devices?: string[]
  sound?: boolean
  ttl_s?: number
  /** Required when `resolve` is true — it is the alert this retracts. */
  dedup_key?: string
  options?: { id: string; label: string }[]
  /**
   * Retract this sender's own active alert for `dedup_key` instead of creating one
   * (hub/src/relay/handler.ts's `resolve` branch — mirrors POST /api/notify's `resolve` field).
   * Needs `dedup_key`; needs neither `title` nor `severity`.
   */
  resolve?: boolean
  /** How long to wait for the hub's ack before rejecting. Defaults to `ackTimeoutMs` (15s). */
  timeoutMs?: number
}

/**
 * `alert_id` is absent for a `resolve` ack that found nothing to resolve — an unknown
 * `dedup_key` is not an error (see `resolve()`'s idempotent contract on the hub), so the ack
 * still resolves this promise, just with `resolved: false` and no alert to report.
 */
export interface Ack { req_id: string; alert_id?: string; resolved?: boolean }

/**
 * Exactly the plaintext the hub accepts for a data push (hub/src/relay/handler.ts's `data`
 * branch). Any JSON value is a valid payload — what to do with it is the widget binding's
 * concern, same as the HTTP push route (hub/src/routes/feeds.ts). Image feeds are rejected by
 * the hub over this path: sealed-JSON envelopes are the wrong vehicle for binary data.
 */
export interface DataOpts {
  feedId: string
  payload: unknown
}

export interface DataAck { req_id: string; pushed_at: number }

/**
 * An outcome the hub seals back long after the ack: a human tapped an option ('answer', from the
 * device socket) or the alert expired unanswered ('timeout', from the TTL sweep). A timeout is an
 * outcome, not an error — it arrives here, never as a rejection.
 */
export interface AnswerEvent {
  req_id: string
  event: 'answer' | 'timeout'
  option_id?: string
  device_id?: string
  at?: number
}

export interface SenderClientOpts {
  relayUrl: string
  hubUid: string
  senderToken: string
  ackTimeoutMs?: number
  connect?: (url: string) => SenderSocket
  /** Injectable timer that returns its own cancel, so tests never wait on real time. */
  schedule?: (ms: number, fn: () => void) => () => void
}

const defaultSchedule = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

function realSocket(url: string): SenderSocket {
  const ws = new WebSocket(url)
  const s: SenderSocket = {
    send: (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d) },
    close: () => ws.close(),
  }
  ws.on('open', () => s.onOpen?.())
  ws.on('message', (raw) => s.onMessage?.(raw.toString()))
  ws.on('close', (code) => s.onClose?.(code))
  ws.on('error', () => { /* close always follows; nothing to do here */ })
  return s
}

/**
 * `notify()` and `data()` share this map, the timer scheduling and the dead-connection handling,
 * but a successful ack means something different for each: `notify` reports back an `alert_id`,
 * `data` a `pushed_at`. `onOk` is each caller's own translation from the raw decrypted reply into
 * (or out of, on a malformed reply) its own promise — `handleMessage` only knows `ok` was `true`.
 */
interface PendingAck {
  onOk: (plain: Record<string, unknown>) => void
  reject: (err: Error) => void
  cancelTimer: () => void
}

/**
 * The sender's half of the relay conversation (relay/src/socket.ts): dial, HELLO_SENDER with the
 * hub_uid, wait for READY, then SEND sealed payloads and match sealed REPLY frames back to their
 * `req_id`. Everything that crosses the relay is ciphertext under HKDF(senderToken); the relay
 * sees routing metadata only. Anything inbound that fails to parse or authenticate is ignored —
 * never fatal, never answered.
 */
export class SenderClient {
  private socket?: SenderSocket
  private state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle'
  private readonly pending = new Map<string, PendingAck>()
  private readonly answerCbs: ((evt: AnswerEvent) => void)[] = []
  private readonly ackTimeoutMs: number
  private readonly doConnect: (url: string) => SenderSocket
  private readonly schedule: (ms: number, fn: () => void) => () => void

  constructor(private readonly opts: SenderClientOpts) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 15_000
    this.doConnect = opts.connect ?? realSocket
    this.schedule = opts.schedule ?? defaultSchedule
  }

  /** Dial once and resolve on READY. One shot: a closed client is done, not restartable. */
  connect(): Promise<void> {
    if (this.state !== 'idle') return Promise.reject(new Error('connect() may only be called once'))
    this.state = 'connecting'
    return new Promise((resolve, reject) => {
      const s = this.doConnect(this.opts.relayUrl)
      this.socket = s
      s.onOpen = () => s.send(JSON.stringify({ type: 'HELLO_SENDER', hub_uid: this.opts.hubUid }))
      s.onMessage = (raw) => this.handleMessage(raw, resolve)
      s.onClose = (code) => {
        this.state = 'closed'
        this.socket = undefined
        const err = new Error(`connection closed${code !== undefined ? ` (${code})` : ''}`)
        reject(err) // no-op if READY already resolved this promise
        this.failAll(err)
      }
    })
  }

  /**
   * Seal one notify to the hub and resolve its ack. An `ok:false` ack, a relay ERROR frame, the
   * ack timer and a dead connection all reject; the eventual human answer does NOT arrive here —
   * it can be minutes or hours later, long after this promise settled, so it goes to onAnswer.
   */
  notify(opts: NotifyOpts): Promise<Ack> {
    if (this.state !== 'ready') return Promise.reject(new Error('not connected: call connect() first'))
    // 6 random bytes = 12 hex chars — unique enough per connection and far under the hub's
    // 128-char cap, which it enforces by silently dropping the frame (hub/src/relay/handler.ts):
    // a client must never manufacture a req_id it would lose answers to.
    const reqId = `r_${randomBytes(6).toString('hex')}`
    // JSON.stringify drops undefined members, so unset optionals never reach the wire.
    const payload = seal(this.opts.senderToken, {
      req_id: reqId, op: 'notify',
      title: opts.title, severity: opts.severity, body: opts.body, devices: opts.devices,
      sound: opts.sound, ttl_s: opts.ttl_s, dedup_key: opts.dedup_key, options: opts.options,
      resolve: opts.resolve,
    })
    return new Promise<Ack>((resolve, reject) => {
      const ms = opts.timeoutMs ?? this.ackTimeoutMs
      const cancelTimer = this.schedule(ms, () => {
        if (this.pending.delete(reqId)) reject(new Error(`no ack from the hub within ${ms}ms`))
      })
      this.pending.set(reqId, {
        onOk: (plain) => {
          const alertId = typeof plain.alert_id === 'string' ? plain.alert_id : undefined
          const resolved = typeof plain.resolved === 'boolean' ? plain.resolved : undefined
          // A create ack always carries alert_id. A resolve ack carries `resolved` instead —
          // true with an alert_id, or false with none (the idempotent unknown-dedup_key case,
          // which is a legitimate outcome here, not a rejection).
          if (alertId !== undefined) resolve({ req_id: reqId, alert_id: alertId, ...(resolved !== undefined ? { resolved } : {}) })
          else if (resolved !== undefined) resolve({ req_id: reqId, resolved })
          else reject(new Error('rejected by the hub'))
        },
        reject,
        cancelTimer,
      })
      this.socket?.send(JSON.stringify({ type: 'SEND', payload }))
    })
  }

  /**
   * Seal one data-feed push to the hub and resolve once it acks — the exact same wire mechanics
   * as `notify()` (req_id, pending-ack map, ack timer, dead-connection handling), just a
   * different op and a different success shape: a push has no `alert_id` to report, only when it
   * landed.
   */
  data(opts: DataOpts): Promise<DataAck> {
    if (this.state !== 'ready') return Promise.reject(new Error('not connected: call connect() first'))
    const reqId = `r_${randomBytes(6).toString('hex')}`
    const payload = seal(this.opts.senderToken, {
      req_id: reqId, op: 'data', feed_id: opts.feedId, payload: opts.payload,
    })
    return new Promise<DataAck>((resolve, reject) => {
      const cancelTimer = this.schedule(this.ackTimeoutMs, () => {
        if (this.pending.delete(reqId)) reject(new Error(`no ack from the hub within ${this.ackTimeoutMs}ms`))
      })
      this.pending.set(reqId, {
        onOk: (plain) => {
          if (typeof plain.pushed_at === 'number') resolve({ req_id: reqId, pushed_at: plain.pushed_at })
          else reject(new Error('rejected by the hub'))
        },
        reject,
        cancelTimer,
      })
      this.socket?.send(JSON.stringify({ type: 'SEND', payload }))
    })
  }

  onAnswer(cb: (evt: AnswerEvent) => void): void {
    this.answerCbs.push(cb)
  }

  /** Idempotent. Rejects anything still pending via the socket's close handler. */
  close(): void {
    const s = this.socket
    this.socket = undefined
    if (this.state !== 'closed' && s) s.close()
    this.state = 'closed'
    this.failAll(new Error('connection closed'))
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      p.cancelTimer()
      p.reject(err)
    }
    this.pending.clear()
  }

  private handleMessage(raw: string, onReady: () => void): void {
    // Everything inbound crossed a public relay: hostile by default, and none of it may throw.
    try {
      const msg = JSON.parse(raw) as { type?: unknown; payload?: unknown; code?: unknown } | null
      if (!msg || typeof msg.type !== 'string') return

      if (msg.type === 'READY') {
        if (this.state === 'connecting') { this.state = 'ready'; onReady() }
        return
      }

      if (msg.type === 'ERROR') {
        // ERROR frames carry no req_id (relay/src/socket.ts), so a SEND failure like hub_offline
        // cannot be pinned to one request. Failing every pending send is the honest reading:
        // hub_offline invalidates them all, and the others are rare enough that over-rejecting
        // beats leaving a doomed promise to hit its timeout.
        const code = typeof msg.code === 'string' ? msg.code : 'unknown'
        this.failAll(new Error(`relay error: ${code}`))
        return
      }

      if (msg.type !== 'REPLY' || typeof msg.payload !== 'string') return
      const plain = open<Record<string, unknown>>(this.opts.senderToken, msg.payload)
      // Undecryptable or non-object: not from our hub (or tampered) — ignore, never answer.
      if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return
      if (typeof plain.req_id !== 'string') return
      const reqId = plain.req_id

      if (typeof plain.ok === 'boolean') {
        const p = this.pending.get(reqId)
        if (!p) return
        this.pending.delete(reqId)
        p.cancelTimer()
        if (plain.ok) p.onOk(plain)
        else p.reject(new Error(typeof plain.error === 'string' ? plain.error : 'rejected by the hub'))
        return
      }

      if (plain.event === 'answer' || plain.event === 'timeout') {
        const evt: AnswerEvent = { req_id: reqId, event: plain.event }
        if (typeof plain.option_id === 'string') evt.option_id = plain.option_id
        if (typeof plain.device_id === 'string') evt.device_id = plain.device_id
        if (typeof plain.at === 'number') evt.at = plain.at
        for (const cb of this.answerCbs) cb(evt)
      }
    } catch {
      // a malformed frame must never take the sender down
    }
  }
}
