import type { FastifyInstance } from 'fastify'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findSenderByToken, touchSender } from '../db/senders.js'
import { findDeviceByToken } from '../db/devices.js'
import { getFeed, senderMayPush, pushValue, pushStreamRow, bumpImageRev } from '../db/feeds.js'
import { audit } from '../db/audit.js'
import { sniffImage, imagePath, MAX_IMAGE_BYTES, MAX_IMAGE_DIM, type ImageInfo } from '../feedImage.js'

const IMAGE_CONTENT_TYPES: Record<ImageInfo['format'], string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
}
const BAD_IMAGE = { error: 'PNG, JPEG or static WebP only' }

/**
 * Push-only ingest (Push API). The body is either the raw JSON payload (value/stream
 * feeds — ANY JSON value; what to read out of it is the widget binding's concern) or raw image
 * bytes (image feeds, image-feed behavior). Individual pushes are deliberately NOT audited (a 5s tick would
 * bury the log); the feed row carries pushed_at/pushed_by instead.
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
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16384 }, (_req, body: string, done) => {
    if (body.length === 0) {
      done(Object.assign(new Error('body cannot be empty'), { statusCode: 400 }), undefined)
      return
    }
    try {
      done(null, JSON.parse(body))
    } catch {
      done(Object.assign(new Error('body is not valid JSON'), { statusCode: 400 }), undefined)
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

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/feeds/:id',
    async (req, reply) => {
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
        return reply.code(403).send({ error: 'sender not allowed' })
      }

      if (Buffer.isBuffer(req.body)) {
        if (feed.mode !== 'image') return reply.code(415).send(BAD_IMAGE)

        const info = sniffImage(req.body)
        const declaredType = (req.headers['content-type'] ?? '').split(';')[0].trim()
        if (!info || IMAGE_CONTENT_TYPES[info.format] !== declaredType) return reply.code(415).send(BAD_IMAGE)
        if (info.width > MAX_IMAGE_DIM || info.height > MAX_IMAGE_DIM) {
          return reply.code(400).send({ error: `image exceeds ${MAX_IMAGE_DIM}x${MAX_IMAGE_DIM}` })
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

      if (feed.mode === 'image') return reply.code(400).send({ error: 'image feeds take an image push' })
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
