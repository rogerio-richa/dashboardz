import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findSenderByToken, touchSender, type SenderRow } from '../db/senders.js'
import { findDeviceByToken } from '../db/devices.js'
import {
  getFeed, senderMayPush, pushValue, pushStreamRow, bumpImageRev, recordFeedRejection, type FeedRow,
} from '../db/feeds.js'
import { audit } from '../db/audit.js'
import { sniffImage, imagePath, MAX_IMAGE_BYTES, MAX_IMAGE_DIM, type ImageInfo } from '../feedImage.js'
import type { RejectReason } from '../feedRejections.js'

const IMAGE_CONTENT_TYPES: Record<ImageInfo['format'], string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
}
const BAD_IMAGE = 'PNG, JPEG or static WebP only'
const MAX_JSON_BYTES = 16384
const NO_BODY = 'no body: send the JSON payload with content-type: application/json'

/**
 * Who is pushing to which feed, settled in `onRequest` before any body is read, so the handler
 * and the error handler below both know it. A WeakMap rather than a request decoration: nothing
 * outside this plugin should ever see it.
 */
const pushContext = new WeakMap<FastifyRequest, { sender: SenderRow; feed: FeedRow }>()

/** A parser or route error carrying the rejection code to record on the feed. */
const rejection = (statusCode: number, reason: RejectReason, message: string) =>
  Object.assign(new Error(message), { statusCode, reason })

/**
 * Push-only ingest (Push API). The body is either the raw JSON payload (value/stream
 * feeds — ANY JSON value; what to read out of it is the widget binding's concern) or raw image
 * bytes (image feeds, image-feed behavior). Individual pushes are deliberately NOT audited (a 5s tick would
 * bury the log); the feed row carries pushed_at/pushed_by instead, and, since v28, the last
 * rejected push (`recordFeedRejection`), so a sender stuck sending bad payloads shows up in the
 * admin instead of only in its own logs.
 *
 * Every error from this plugin is `{"error": "..."}`, including the ones Fastify's body parsers
 * raise, which would otherwise come back in Fastify's own `{statusCode, code, error, message}`
 * shape with the useful part under `message`.
 */
export async function feedsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Fastify's built-in `text/plain` parser would otherwise happily accept a plain-text body and
   * hand it to the route as a string — pushes are JSON or one of the three image types:
   * Push API / image-feed behavior), so any other content type must 415, scoped to this plugin via
   * encapsulation.
   */
  app.removeContentTypeParser('text/plain')

  /**
   * The JSON push cap (16 KB) is set HERE, on the parser, rather than as `{ bodyLimit }` on the
   * route below. Fastify keeps exactly one bodyLimit per (method, path) route entry, applied to
   * EVERY content type that hits it — so a route-level bodyLimit here would also clamp image
   * pushes on this same path down to 16 KB. Overriding the content-type parser instead keeps
   * each type's cap independent while both still share the one POST route.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: MAX_JSON_BYTES }, (_req, body: string, done) => {
    if (body.length === 0) {
      done(rejection(400, 'empty_body', NO_BODY), undefined)
      return
    }
    try {
      done(null, JSON.parse(body))
    } catch {
      done(rejection(400, 'invalid_json', 'body is not valid JSON'), undefined)
    }
  })

  /**
   * Image pushes are raw bytes (image-feed behavior), each type capped at MAX_IMAGE_BYTES independently of
   * the JSON parser above, same reasoning. Content type here is only a ROUTING hint — the bytes
   * are re-verified against their magic numbers below; a lying header (e.g. JPEG bytes declared
   * as image/png) is caught by comparing sniffImage's result to the declared type, not trusted
   * outright.
   */
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp'],
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (_req, body, done) => done(null, body),
  )

  /**
   * Scoped to this plugin. Turns Fastify's parser errors (413 too large, 415 unsupported type)
   * into plain sentences that say what this particular feed takes, records the rejection on the
   * feed when the pusher is known, and keeps internal errors from leaking (a stream push with no
   * body once came back as a raw SQLITE_CONSTRAINT message).
   */
  app.setErrorHandler((err: FastifyError & { reason?: RejectReason }, req, reply) => {
    const ctx = pushContext.get(req)
    const status = err.statusCode ?? 500
    if (status >= 500) {
      req.log.error(err)
      return reply.code(500).send({ error: 'internal error' })
    }
    const isImageType = (req.headers['content-type'] ?? '').startsWith('image/')
    let reason = err.reason
    let message = err.message
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reason = 'too_large'
      message = isImageType
        ? `image is larger than the ${MAX_IMAGE_BYTES / 1024} KB limit`
        : `body is larger than the ${MAX_JSON_BYTES / 1024} KB limit for JSON pushes`
    } else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      reason = 'unsupported_media_type'
      message = ctx?.feed.mode === 'image'
        ? 'this is an image feed: send PNG, JPEG or static WebP bytes with a matching content-type'
        : 'this feed takes JSON: send it with content-type: application/json'
    }
    if (ctx && reason) {
      recordFeedRejection(app.db, ctx.feed.id, { status, reason, by: ctx.sender.id, via: 'http' }, Date.now())
    }
    return reply.code(status).send({ error: message })
  })

  /**
   * Token, feed and allowlist, in that order, before the body is read. An anonymous caller gets a
   * 401 whatever it sends: it cannot make the hub buffer a body first, and it never reaches the
   * code that records rejections on a feed.
   */
  const authorizePush = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const sender = findSenderByToken(app.db, token)
    if (!sender) {
      audit(app.db, 'system', null, 'auth_rejected', { route: '/api/feeds' })
      return reply.code(401).send({ error: 'invalid token' })
    }
    const feed = getFeed(app.db, req.params.id)
    if (!feed) return reply.code(404).send({ error: 'unknown feed' })
    if (!senderMayPush(feed, sender.id)) {
      audit(app.db, 'system', sender.id, 'feed_push_denied', { feed_id: feed.id })
      recordFeedRejection(app.db, feed.id, { status: 403, reason: 'not_allowed', by: sender.id, via: 'http' }, Date.now())
      return reply.code(403).send({ error: 'sender not allowed' })
    }
    pushContext.set(req, { sender, feed })
  }

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/feeds/:id',
    { onRequest: authorizePush },
    async (req) => {
      const { sender, feed } = pushContext.get(req)!

      if (Buffer.isBuffer(req.body)) {
        if (feed.mode !== 'image') throw rejection(415, 'wrong_mode', `this is a ${feed.mode} feed: it takes JSON, not an image`)

        const info = sniffImage(req.body)
        const declaredType = (req.headers['content-type'] ?? '').split(';')[0].trim()
        if (!info || IMAGE_CONTENT_TYPES[info.format] !== declaredType) throw rejection(415, 'bad_image', BAD_IMAGE)
        if (info.width > MAX_IMAGE_DIM || info.height > MAX_IMAGE_DIM) {
          throw rejection(400, 'image_too_large', `image exceeds ${MAX_IMAGE_DIM}x${MAX_IMAGE_DIM}`)
        }

        // Atomic overwrite (storage) — a reader can never observe a partially written file.
        const path = imagePath(app.appConfig.dataDir, feed.id)
        const tmp = `${path}.tmp`
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(tmp, req.body)
        renameSync(tmp, path)

        const now = Date.now()
        const image_rev = bumpImageRev(app.db, feed.id, sender.id, now)
        touchSender(app.db, sender.id, now)
        app.dataPusher.onFeedPush(feed.id)
        return { ok: true, pushed_at: now, image_rev }
      }

      // No content-type and no body skips every parser and arrives here as undefined. Accepting it
      // used to blank a value feed (payload null, pushed_at refreshed, so the dead-man switch was
      // reset too) and 500 a stream feed.
      if (req.body === undefined) throw rejection(400, 'empty_body', NO_BODY)
      if (feed.mode === 'image') {
        throw rejection(400, 'wrong_mode', 'this is an image feed: push PNG, JPEG or static WebP bytes, not JSON')
      }
      const now = Date.now()
      if (feed.mode === 'value') pushValue(app.db, feed.id, req.body, sender.id, now)
      else pushStreamRow(app.db, feed.id, req.body, sender.id, now)
      touchSender(app.db, sender.id, now)
      app.dataPusher.onFeedPush(feed.id)
      return { ok: true, pushed_at: now }
    },
  )

  /**
   * Device-token image fetch (image-feed behavior) — the FIRST HTTP endpoint gated by device auth rather
   * than sender auth; the Bearer parse mirrors notify.ts's sender version exactly, just against
   * `findDeviceByToken`. image_rev doubles as the etag: cheap, monotonic, and already tracked
   * per feed, so a device can cache aggressively and only re-fetch after a real push.
   */
  app.get<{ Params: { id: string } }>('/api/feeds/:id/image', async (req, reply) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const device = findDeviceByToken(app.db, token)
    if (!device) {
      // Every Bearer 401 in this codebase leaves a trail (see POST /api/feeds/:id above and
      // notify.ts) — this is the first device-token HTTP endpoint, i.e. new attack surface for
      // token guessing/enumeration, so it gets the same treatment, not a silent drop.
      audit(app.db, 'system', null, 'auth_rejected', { route: '/api/feeds/:id/image' })
      return reply.code(401).send({ error: 'invalid token' })
    }

    const feed = getFeed(app.db, req.params.id)
    if (!feed || feed.mode !== 'image' || feed.image_rev === 0) {
      return reply.code(404).send({ error: 'not found' })
    }

    const etag = String(feed.image_rev)
    if (req.headers['if-none-match'] === etag) return reply.header('etag', etag).code(304).send()

    let bytes: Buffer
    try {
      bytes = readFileSync(imagePath(app.appConfig.dataDir, feed.id))
    } catch {
      // DB says pushed, file missing (shouldn't happen outside manual tampering) — a read path
      // must never crash on bad/missing data (house invariant); report it as absent, not 500.
      return reply.code(404).send({ error: 'not found' })
    }
    const info = sniffImage(bytes)
    reply.header('etag', etag)
    reply.type(info ? IMAGE_CONTENT_TYPES[info.format] : 'application/octet-stream')
    return reply.send(bytes)
  })
}
