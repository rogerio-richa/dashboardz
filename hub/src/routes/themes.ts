import type { FastifyInstance } from 'fastify'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findDeviceByToken } from '../db/devices.js'
import { audit } from '../db/audit.js'
import { getTheme, themeDocument, bumpBgRev } from '../db/themes.js'
import { sniffImage, themeBgPath, MAX_IMAGE_BYTES, MAX_IMAGE_DIM, type ImageInfo } from '../feedImage.js'
import { actorOf, pushDevicesForTheme, requireAdmin } from './admin/shared.js'

const IMAGE_CONTENT_TYPES: Record<ImageInfo['format'], string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
}
const BAD_IMAGE = { error: 'PNG, JPEG or static WebP only' }

/**
 * Device-authed theme delivery. `rev` is the ETag, exactly as `feeds.image_rev` is for images —
 * same monotonic-integer trick, so the client caching contract has a working precedent rather
 * than a new invention. The document inlines each widget's colorset so a device makes ONE
 * request rather than one per widget.
 */
export async function themesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/themes/:id', async (req, reply) => {
    // Bearer parse, 401 body and audit copied verbatim from the device-authed image route
    // (routes/feeds.ts:120) — every Bearer 401 in this codebase leaves a trail.
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const device = findDeviceByToken(app.db, token)
    if (!device) {
      audit(app.db, 'system', null, 'auth_rejected', { route: '/api/themes/:id' })
      return reply.code(401).send({ error: 'invalid token' })
    }

    const doc = themeDocument(app.db, req.params.id)
    if (!doc) return reply.code(404).send({ error: 'not found' })

    // Unquoted integer, matching feeds' image_rev etag convention exactly. Do NOT add quotes.
    const etag = String(doc.rev)
    if (req.headers['if-none-match'] === etag) return reply.header('etag', etag).code(304).send()
    return reply.header('etag', etag).send(doc)
  })

  /**
   * Background image upload/fetch (theming: background image). Reuses the feed-image machinery
   * (sniffImage/MAX_IMAGE_BYTES/MAX_IMAGE_DIM) rather than reinventing validation, and mirrors
   * routes/feeds.ts's image push + device-fetch shape closely — but each route below is its own
   * design choice for this actor, not a byte-for-byte copy: the admin upload 400s on a bad image
   * (an operator's direct mistake) where feeds.ts's device-authed push 415s (a sender declaring
   * one format while sending another). Storage is themeBgPath, a SIBLING of feeds' imagePath —
   * see feedImage.ts — so a theme id can never collide with a feed id on disk.
   *
   * Session-guarded by `requireAdmin` from routes/admin/shared.ts — the shared definition, imported
   * so hardening the guard applies to every route. It validates against `app.sessions`,
   * the SAME SessionStore admin.ts's login/logout use, decorated once on the ROOT app instance in
   * server.ts. A SessionStore created fresh here would never see any session admin.ts's login
   * minted (Fastify decorators/content-type-parsers only flow parent -> children, never across
   * sibling plugins), so every upload would 401 forever.
   *
   * The guard is attached PLUGIN-WIDE to this child instance, not per route, for the same reason
   * admin.ts does it that way: an admin route added inside this scope later is then guarded by
   * construction rather than by whoever adds it remembering the `preHandler`. Scope matters here —
   * the two DEVICE-token routes in this file (`GET /api/themes/:id` and `GET /api/themes/:id/bg`)
   * are registered on `app` itself, OUTSIDE this child, so they keep their Bearer-token auth and
   * never see this hook. Anything admin-authed goes inside; anything device-authed stays outside.
   */
  app.register(async (adminScope) => {
    adminScope.addHook('preHandler', requireAdmin)

    // Scoped content-type parser, same reasoning as feeds.ts: bodyLimit lives on the parser (not
    // a route-level bodyLimit) so it applies only to these image content types, and Fastify's own
    // "body too large" handling on that limit is what yields 413 — confirmed against feeds.ts's
    // own image-push route (feedsPush.test.ts's "413 above the 512 KB byte cap"), not assumed.
    adminScope.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
      (_req, body, done) => done(null, body),
    )

    adminScope.put<{ Params: { id: string }; Body: unknown }>(
      '/admin/api/themes/:id/bg',
      async (req, reply) => {
        const theme = getTheme(app.db, req.params.id)
        if (!theme) return reply.code(404).send({ error: 'not found' })

        if (!Buffer.isBuffer(req.body)) return reply.code(400).send(BAD_IMAGE)
        const info = sniffImage(req.body)
        const declaredType = (req.headers['content-type'] ?? '').split(';')[0].trim()
        if (!info || IMAGE_CONTENT_TYPES[info.format] !== declaredType) return reply.code(400).send(BAD_IMAGE)
        if (info.width > MAX_IMAGE_DIM || info.height > MAX_IMAGE_DIM) {
          return reply.code(400).send({ error: `image exceeds ${MAX_IMAGE_DIM}x${MAX_IMAGE_DIM}` })
        }

        // Atomic overwrite (same tmp + rename as feeds.ts) — a reader can never observe a
        // partially written file.
        const path = themeBgPath(app.appConfig.dataDir, theme.id)
        const tmp = `${path}.tmp`
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(tmp, req.body)
        renameSync(tmp, path)

        // bumpBgRev also bumps the theme's own `rev` — see db/themes.ts — so a device that
        // already cached the theme document learns the background changed too.
        const bg_rev = bumpBgRev(app.db, theme.id)
        const actor = actorOf(req)
        audit(app.db, actor.type, actor.id, 'theme_bg_uploaded', { theme_id: theme.id, bg_rev })
        // Every device rendering a screen that references this theme gets a fresh STATE after the
        // upload. Without it the upload would be invisible until a reconnect or an unrelated
        // screen edit: `bumpBgRev` moved the theme's `rev`, but a device only refetches the theme
        // document when the `{id, rev}` pair on its NEXT STATE differs from what it cached
        // (theme.mjs's noteThemeRef) — and nothing here was sending a next STATE. Exactly the
        // shape of the colorset-PATCH bug already fixed on this branch. `registerThemeRoutes` in
        // routes/admin/themes.ts states the contract: a theme write must reach devices already
        // rendering it.
        // Same helper as that fix, imported rather than re-rolled.
        pushDevicesForTheme(app, theme.id)
        return { ok: true, bg_rev }
      },
    )
  })

  /**
   * Device-token bg-bytes fetch (theming: background image) — the same Bearer/401/audit shape as
   * `/api/themes/:id` above and `/api/feeds/:id/image`. `bg_rev` doubles as the etag, same
   * monotonic-integer trick as image_rev/rev elsewhere. 404 when the theme has no image background
   * (`bg_kind !== 'image'`) — a `none`/`flat` theme simply has no bytes to serve.
   */
  app.get<{ Params: { id: string } }>('/api/themes/:id/bg', async (req, reply) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const device = findDeviceByToken(app.db, token)
    if (!device) {
      audit(app.db, 'system', null, 'auth_rejected', { route: '/api/themes/:id/bg' })
      return reply.code(401).send({ error: 'invalid token' })
    }

    const theme = getTheme(app.db, req.params.id)
    if (!theme || theme.bg_kind !== 'image') return reply.code(404).send({ error: 'not found' })

    const etag = String(theme.bg_rev)
    if (req.headers['if-none-match'] === etag) return reply.header('etag', etag).code(304).send()

    let bytes: Buffer
    try {
      bytes = readFileSync(themeBgPath(app.appConfig.dataDir, theme.id))
    } catch {
      // DB says image, file missing (shouldn't happen outside manual tampering) — a read path
      // must never crash on bad/missing data (house invariant); report it as absent, not 500.
      return reply.code(404).send({ error: 'not found' })
    }
    const info = sniffImage(bytes)
    reply.header('etag', etag)
    reply.type(info ? IMAGE_CONTENT_TYPES[info.format] : 'application/octet-stream')
    return reply.send(bytes)
  })
}
