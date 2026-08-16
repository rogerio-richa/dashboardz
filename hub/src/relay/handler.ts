import type { FastifyInstance } from 'fastify'
import type { DB } from '../db/index.js'
import { openWithKey, sealWithKey } from './envelope.js'
import { listRelaySenders, relayKeyForAlert, touchSender, type RelaySenderRow } from '../db/senders.js'
import { deviceExists } from '../db/devices.js'
import {
  getReplyTo, getWireAlert, ingestNotify, resolveAlertByDedupKey, type AlertOption, type Severity,
} from '../db/alerts.js'
import { getFeed, senderMayPush, pushValue, pushStreamRow } from '../db/feeds.js'
import { audit } from '../db/audit.js'
import { pushTabStatus } from '../ws/tabStatus.js'

/**
 * Everything this module needs from a relay client. Narrower than `RelayClient` on purpose: the
 * TTL sweep and the device socket both emit outcomes, and neither should have to know about
 * connection state, backoff or heartbeats to do it.
 *
 * `sendReply` is a no-op unless the client is 'ready', so a reply to a dead relay link is
 * dropped. That is correct and deliberate: the answer is already committed to `deliveries`, so
 * nothing is lost — it just does not reach a sender that has gone away.
 */
export interface RelayReplySink {
  sendReply(connId: string, payload: string): void
}

/**
 * Mirrors the `notifySchema` AJV rules on POST /api/notify. A relayed sender is an authenticated
 * sender, but it reaches ingest without passing through Fastify's schema validation — so the
 * same sender would otherwise face different limits depending only on which transport it used,
 * and could write unbounded strings straight into `alerts` and out to every device.
 */
const SEVERITIES: readonly string[] = ['info', 'warn', 'critical']
const MAX_OPTIONS = 4
const MAX_TITLE = 200
const MAX_BODY = 1500
const MAX_DEDUP_KEY = 100
const MAX_OPTION_ID = 32
const MAX_OPTION_LABEL = 24
const OPTION_ID_RE = /^[a-z0-9_-]+$/
/**
 * `req_id` and `conn_id` have no equivalent on the HTTP route, so they get their own bounds.
 * Both are persisted together in `alerts.reply_to` and echoed on every reply, so without a cap
 * either one writes an arbitrarily large string into the database once per alert. Typical request
 * ids are short, but the bound also protects the database from oversized values.
 *
 * They come from *different* attackers, which is why both need the guard and why `conn_id` is
 * checked first, before anything else touches it. `req_id` is chosen by a sender holding a valid
 * token. `conn_id` is chosen by the **relay** — the one party this design explicitly does not
 * trust — and needs no key at all: replaying a single captured ciphertext with an attacker-chosen
 * conn_id is enough. It is also interpolated into the drop log below, so an unbounded value is a
 * log-flooding vector as well as a storage one.
 */
const MAX_REQ_ID = 128
const MAX_CONN_ID = 128
/** Mirrors POST /api/feeds/:id's own bounds: `newId('feed')` shape on one side, the route's
 *  16 KB `bodyLimit` on the other (hub/src/routes/feeds.ts) — a relayed sender must not get a
 *  bigger allowance than an on-LAN one just because it skipped Fastify's body-size enforcement. */
const MAX_FEED_ID = 64
const MAX_DATA_PAYLOAD = 16384

interface RelayNotify {
  req_id?: unknown; op?: unknown
  title?: unknown; body?: unknown; severity?: unknown
  devices?: unknown; sound?: unknown; ttl_s?: unknown
  dedup_key?: unknown; options?: unknown
  // Sender-side resolve (netdata CLEAR etc), mirroring POST /api/notify's `resolve` field.
  resolve?: unknown
  // op: 'data' fields — same envelope shape, different op (see the `data` branch below).
  feed_id?: unknown; payload?: unknown
}

/**
 * The envelope key derives from the sender token and the token travels *inside* the ciphertext,
 * so the hub cannot know who a message is from until it decrypts it — it tries each sender's
 * stored `relay_key` until one authenticates.
 *
 * The successful AEAD open **is** the authentication, and it identifies the sender at the same
 * time: only the holder of that sender's token can derive that key and produce a frame that
 * verifies under it. That is why there is no `findSenderByToken` round trip here, and why the
 * plaintext carries no `sender_token` at all (design rationale envelope authentication): a self-declared identity inside
 * a payload we have already cryptographically attributed adds nothing, and shipping a working
 * bearer credential in every payload is a liability the first time someone debugs this path by
 * logging decrypted plaintext.
 *
 * Cost: O(senders) trial decryptions per relayed message, which is fine at this scale. The
 * escape hatch, if it ever isn't, is an unencrypted sender-id hint in the outer frame — at the
 * price of leaking that hint to the relay.
 */
function tryDecrypt(db: DB, payload: string): { sender: RelaySenderRow; msg: RelayNotify } | null {
  for (const sender of listRelaySenders(db)) {
    const msg = openWithKey<unknown>(sender.relay_key, payload)
    // A sealed `5`, `"x"`, `null` or `[...]` decrypts fine and is still not a message.
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) return { sender, msg: msg as RelayNotify }
  }
  return null
}

/** Mirrors the /api/notify JSON schema's option rules — relayed senders bypass that schema. */
function validateOptions(raw: unknown): { ok: true; options?: AlertOption[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'options must be a non-empty array' }
  if (raw.length > MAX_OPTIONS) return { ok: false, error: `at most ${MAX_OPTIONS} options are allowed` }
  const options: AlertOption[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'each option must be an object' }
    const { id, label } = item as { id?: unknown; label?: unknown }
    if (typeof id !== 'string' || id.length === 0 || typeof label !== 'string' || label.length === 0) {
      return { ok: false, error: 'each option needs a non-empty id and label' }
    }
    if (id.length > MAX_OPTION_ID || !OPTION_ID_RE.test(id)) {
      return { ok: false, error: `option id must match ${OPTION_ID_RE.source} and be at most ${MAX_OPTION_ID} chars` }
    }
    if (label.length > MAX_OPTION_LABEL) {
      return { ok: false, error: `option label must be at most ${MAX_OPTION_LABEL} chars` }
    }
    options.push({ id, label })
  }
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    return { ok: false, error: 'option ids must be unique' }
  }
  return { ok: true, options }
}

/**
 * Ingests one relayed DELIVER frame and answers the sender that asked.
 *
 * Two silences are deliberate and different from each other:
 *  - **Undecryptable** — we cannot even tell who this claims to be from, and we hold no key that
 *    would let us seal a reply anyway. Answering would also turn the hub into an oracle telling a
 *    stranger which ciphertexts are valid for it.
 *  - **No usable `req_id`** — we could seal a reply, but the sender gave us nothing (or nothing
 *    we are willing to store and echo) to correlate it with, so there is no reply to send.
 *
 * Everything else that goes wrong gets an explicit `ok:false` with a reason, per the project's
 * "fails loudly, never silently" rule. And nothing in here may throw: the frame crossed a public
 * relay, so it is hostile input by default.
 */
export function handleRelayDeliver(
  app: FastifyInstance, client: RelayReplySink, connId: string, payload: string,
): void {
  try {
    // First, before the log line interpolates it, before O(senders) trial decryptions, and long
    // before it reaches `alerts.reply_to`. Rejected outright rather than truncated: a truncated
    // conn_id routes a reply to the wrong connection, or to none, which is worse than no reply.
    if (typeof connId !== 'string' || connId.length === 0 || connId.length > MAX_CONN_ID) return

    const attempt = tryDecrypt(app.db, payload)
    if (!attempt) {
      // conn_id is routing metadata the relay already has; no payload, no token, no content.
      console.warn(`relay: dropped an undecryptable DELIVER from ${connId}`)
      return
    }

    const { sender, msg } = attempt
    // Silent, like a missing req_id: a correlator we refuse to store and echo is no more usable
    // than one that was never sent, and answering would mean echoing the oversized value back.
    if (typeof msg.req_id !== 'string' || msg.req_id.length === 0 || msg.req_id.length > MAX_REQ_ID) return
    const reqId = msg.req_id
    const reply = (obj: object) => client.sendReply(connId, sealWithKey(sender.relay_key, obj))
    const reject = (error: string) => reply({ req_id: reqId, ok: false, error })

    if (msg.op === 'data') {
      // Same field limits as POST /api/feeds/:id (hub/src/routes/feeds.ts) — a relayed sender
      // reaches ingest without Fastify's bodyLimit or route-param validation, so this hand-mirrors
      // both rather than letting the relay path write bigger feed ids or payloads than the LAN one.
      if (typeof msg.feed_id !== 'string' || msg.feed_id.length === 0) return reject('feed_id is required')
      if (msg.feed_id.length > MAX_FEED_ID) return reject(`feed_id must be at most ${MAX_FEED_ID} chars`)
      if (!('payload' in msg)) return reject('payload is required')
      if (JSON.stringify(msg.payload).length > MAX_DATA_PAYLOAD) return reject('payload too large')

      const feed = getFeed(app.db, msg.feed_id)
      if (!feed) return reject('unknown feed')
      if (!senderMayPush(feed, sender.id)) {
        // Same audit choice as POST /api/feeds/:id: a push itself is deliberately unaudited, but
        // a denial is an authenticated-but-unauthorized sender doing a real thing — it must leave
        // the same trail over the relay as it does over LAN HTTP.
        audit(app.db, 'system', sender.id, 'feed_push_denied', { feed_id: feed.id })
        return reject('sender not allowed')
      }
      // Sealed-JSON envelopes are the wrong vehicle for binary data — LAN HTTP (POST
      // /api/feeds/:id with an image content type) is the only image push path (image-feed behavior); relay
      // stays JSON-only by design, not because image feeds happen to not exist yet.
      if (feed.mode === 'image') return reject('image push not supported over relay')

      const now = Date.now()
      if (feed.mode === 'value') pushValue(app.db, feed.id, msg.payload, sender.id, now)
      else pushStreamRow(app.db, feed.id, msg.payload, sender.id, now)
      touchSender(app.db, sender.id, now)
      // Same choice POST /api/feeds/:id makes: individual pushes are deliberately NOT audited (a
      // 5s tick would bury the log); the feed row's pushed_at/pushed_by carries that instead.
      app.dataPusher.onFeedPush(feed.id)
      return reply({ req_id: reqId, ok: true, pushed_at: now })
    }

    if (msg.op !== 'notify') return reject('unsupported op')

    if (msg.resolve !== undefined && typeof msg.resolve !== 'boolean') return reject('resolve must be a boolean')
    // Mirrors POST /api/notify's if/then/else schema: `resolve: true` needs a `dedup_key` and
    // needs neither `title` nor `severity`, so this must be checked and returned before those
    // become required below. Everything else (targets, options, ttl_s...) is meaningless for a
    // resolve and is deliberately never reached on this branch.
    if (msg.resolve === true) {
      if (typeof msg.dedup_key !== 'string' || msg.dedup_key.length === 0) {
        return reject('dedup_key is required to resolve')
      }
      if (msg.dedup_key.length > MAX_DEDUP_KEY) {
        return reject(`dedup_key must be a non-empty string of at most ${MAX_DEDUP_KEY} chars`)
      }
      const dedupKey = msg.dedup_key
      const now = Date.now()
      const result = resolveAlertByDedupKey(app.db, sender.id, dedupKey)
      if (!result.resolved) {
        touchSender(app.db, sender.id, now)
        return reply({ req_id: reqId, ok: true, resolved: false })
      }
      app.registry.sendMany(result.target_devices, { type: 'ALERT_REMOVE', id: result.id, reason: 'resolved' })
      pushTabStatus(app.db, app.registry)
      audit(app.db, 'sender', sender.id, 'notify_resolved', { alert_id: result.id, dedup_key: dedupKey, via: 'relay' })
      touchSender(app.db, sender.id, now)
      return reply({ req_id: reqId, ok: true, resolved: true, alert_id: result.id })
    }

    if (typeof msg.title !== 'string' || msg.title.length === 0) return reject('title is required')
    if (msg.title.length > MAX_TITLE) return reject(`title must be at most ${MAX_TITLE} chars`)
    if (typeof msg.severity !== 'string' || !SEVERITIES.includes(msg.severity)) {
      return reject('severity must be one of info, warn, critical')
    }
    if (msg.body !== undefined && (typeof msg.body !== 'string' || msg.body.length > MAX_BODY)) {
      return reject(`body must be a string of at most ${MAX_BODY} chars`)
    }
    if (msg.dedup_key !== undefined
      && (typeof msg.dedup_key !== 'string' || msg.dedup_key.length === 0 || msg.dedup_key.length > MAX_DEDUP_KEY)) {
      return reject(`dedup_key must be a non-empty string of at most ${MAX_DEDUP_KEY} chars`)
    }
    if (msg.sound !== undefined && typeof msg.sound !== 'boolean') return reject('sound must be a boolean')
    if (msg.ttl_s !== undefined && (!Number.isInteger(msg.ttl_s) || (msg.ttl_s as number) < 1)) {
      return reject('ttl_s must be a positive integer')
    }
    const opts = validateOptions(msg.options)
    if (!opts.ok) return reject(opts.error)

    let targets: string[]
    if (msg.devices === undefined) {
      targets = JSON.parse(sender.default_devices) as string[]
    } else if (Array.isArray(msg.devices) && msg.devices.every((s) => typeof s === 'string')) {
      targets = msg.devices as string[]
    } else {
      return reject('devices must be an array of device ids')
    }
    if (targets.length === 0) return reject('no target devices')
    const unknown = targets.filter((id) => !deviceExists(app.db, id))
    if (unknown.length > 0) return reject(`unknown devices: ${unknown.join(', ')}`)

    const now = Date.now()
    const { alert, updated } = ingestNotify(app.db, {
      senderId: sender.id,
      title: msg.title,
      body: typeof msg.body === 'string' ? msg.body : undefined,
      severity: msg.severity as Severity,
      sound: typeof msg.sound === 'boolean' ? msg.sound : undefined,
      ttl_s: typeof msg.ttl_s === 'number' ? msg.ttl_s : undefined,
      dedup_key: typeof msg.dedup_key === 'string' ? msg.dedup_key : undefined,
      options: opts.options,
      targetDevices: targets,
      // Only honoured on insert — a dedup update leaves the original owner of the reply channel
      // in place (see ingestNotify).
      replyTo: { conn_id: connId, req_id: reqId },
    }, now)

    touchSender(app.db, sender.id, now)
    // Same shape the local /api/notify route audits, plus how it arrived. No title, no body,
    // no option labels — the audit log records what happened, not what was said.
    audit(app.db, 'sender', sender.id, 'notify', {
      alert_id: alert.id, severity: alert.severity, updated, targets, via: 'relay',
    })

    const alertTargets = JSON.parse(alert.target_devices) as string[]
    const wire = getWireAlert(app.db, alert.id)
    if (wire) app.registry.sendMany(alertTargets, { type: 'ALERT_ADD', alert: wire })
    // Same hook the HTTP notify route fires after ALERT_ADD (tabs, status dots) — a relayed
    // alert must light dots too, or a relay-only sender's alerts are invisible on background tabs.
    pushTabStatus(app.db, app.registry)
    reply({ req_id: reqId, ok: true, alert_id: alert.id })
  } catch {
    // A relayed frame must never crash the hub. Nothing is logged here on purpose: the only
    // thing available to log would be derived from the frame itself.
  }
}

/**
 * Seals an outcome — the human's answer, or a timeout — back to whoever raised `alertId` over
 * the relay. A no-op for locally-posted alerts (no `reply_to`), for hubs with no relay client
 * (no relay configured), and for senders without a `relay_key`, so both
 * callers can invoke it unconditionally.
 *
 * `req_id` is applied last so a caller cannot accidentally address the reply to the wrong
 * request by putting one in `event`.
 */
export function emitRelayOutcome(
  db: DB, client: RelayReplySink | undefined, alertId: string, event: object,
): void {
  if (!client) return
  try {
    const replyTo = getReplyTo(db, alertId)
    if (!replyTo) return
    const key = relayKeyForAlert(db, alertId)
    if (!key) return
    client.sendReply(replyTo.conn_id, sealWithKey(key, { ...event, req_id: replyTo.req_id }))
  } catch {
    // Reporting an outcome is best-effort: the answer is already committed to `deliveries`, and
    // a failure here must never take down the socket handler or the TTL sweep that called it.
  }
}
