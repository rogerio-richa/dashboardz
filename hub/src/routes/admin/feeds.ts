import type { FastifyInstance } from 'fastify'
import { unlinkSync } from 'node:fs'
import {
  createFeed, deleteFeed, getFeed, listFeeds, recentRows, updateFeed,
  type FeedMode, type FeedRow,
} from '../../db/feeds.js'
import { screensReferencingFeed } from '../../db/screens.js'
import { imagePath } from '../../feedImage.js'
import { WIDGET_FEED_MODES, outputForFeed } from '../../screens/save.js'
import { capabilitiesForFeed } from '../../data/feedCapabilities.js'
import { compatibleGeneric, compatibleOutput, widgetRequirement } from '../../widgets/requirements.js'
import { WIDGET_CONTRACT } from '../../screens/widgetContract.js'
import { actorOf } from './shared.js'

export function registerFeedRoutes(admin: FastifyInstance, app: FastifyInstance): void {
  /** Feeds CRUD (lifecycle). mode is immutable — absent from the PATCH schema. */
  const feedBody = (required: string[]) => ({
    type: 'object', additionalProperties: false, required,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      mode: { enum: ['value', 'stream', 'image'] },   // image-feed behavior unlocked 'image'
      cap: { type: 'integer', minimum: 1, maximum: 500 },
      stale_after_s: { type: ['integer', 'null'], minimum: 5 },
      alert_on_stale: { type: 'boolean' },
      allowed_senders: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 50 },
    },
  })
  // Same as feedBody but without `mode` — PATCH can never touch it (schema-level immutability:
  // a body containing `mode` is rejected by additionalProperties: false, not silently ignored).
  const feedPatchBody = (required: string[]) => ({
    type: 'object', additionalProperties: false, required,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      cap: { type: 'integer', minimum: 1, maximum: 500 },
      stale_after_s: { type: ['integer', 'null'], minimum: 5 },
      alert_on_stale: { type: 'boolean' },
      allowed_senders: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 50 },
    },
  })

  // Guarded JSON.parse for feed/row payloads — arbitrary sender-pushed JSON; bad data already
  // in the DB must never crash a read path (house rule). Display-only, degrades to null.
  const guardedParse = (s: string | null): unknown => {
    if (s === null) return null
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  // parseAllowed: guarded JSON.parse → string[] | null (corrupt → null; display-only here —
  // enforcement uses senderMayPush, which fails closed).
  const parseAllowed = (s: string | null): string[] | null => {
    if (s === null) return null
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  /**
   * A feed as the admin sees it. There is no "what fills this" field any more: a feed a provider
   * owns is one of a source's outputs, and `GET /admin/api/sources` reports that relationship with
   * the connection's health and usage attached. Answering the same question twice, in two
   * vocabularies, is what the v18 connector surface was doing.
   */
  const feedOut = (f: FeedRow) => ({
    id: f.id, name: f.name, mode: f.mode, cap: f.cap,
    stale_after_s: f.stale_after_s, alert_on_stale: f.alert_on_stale === 1,
    allowed_senders: parseAllowed(f.allowed_senders),
    pushed_at: f.pushed_at, pushed_by: f.pushed_by, image_rev: f.image_rev, created_at: f.created_at,
  })

  admin.get('/admin/api/feeds', async () => listFeeds(app.db).map(feedOut))

  /**
   * "Which of my feeds cannot satisfy this cell?" — answered HERE rather than in the picker.
   *
   * The admin cannot import `compatibleGeneric`: `hub/tsconfig.json` sets `rootDir: src`, so
   * admin code only ever reaches into `hub/static/**`. Moving the matcher to a pure `.mjs` would
   * let the picker import it, at the price of an unguardable duplicate of the LOGIC on this side
   * — and a duplicated data table has a test that compares both copies (WIDGET_FEED_MODES,
   * CHART_ICONS), while two copies of a function body have nothing of the kind. So the rule keeps
   * one home in `widgets/requirements.ts` and the picker holds none of it.
   *
   * The UNFIT set is what is reported, not the fit one, so a caller that cannot reach this
   * endpoint — or simply does not ask — shows every feed. Failing open is the same instinct as
   * the inconclusive rule: never hide a feed on the strength of a check that did not happen.
   */
  admin.get<{ Querystring: { widget?: string; config?: string } }>(
    '/admin/api/feed-fit', async (req, reply) => {
      const widget = req.query.widget
      if (typeof widget !== 'string' || widget === '') return reply.code(400).send({ error: 'widget is required' })
      let config: unknown
      try {
        config = JSON.parse(req.query.config ?? '{}')
      } catch {
        return reply.code(400).send({ error: 'config must be JSON' })
      }
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return reply.code(400).send({ error: 'config must be JSON' })
      }
      // Semantic widgets bind a source output, not a mode — mirroring validatePersistentBinding
      // (screens/save.ts) exactly, via the same outputForFeed + compatibleOutput, so the picker
      // never marks fit what the save path would refuse. Generic widgets keep the mode-prefilter
      // + compatibleGeneric path below, including its fail-open inconclusive rule.
      const requirement = widgetRequirement(widget)
      if (requirement) {
        const unfit: { id: string; why: string }[] = []
        for (const feed of listFeeds(app.db)) {
          const output = outputForFeed(app.db, feed.id)
          if (!output) { unfit.push({ id: feed.id, why: `${widget} requires a semantic source output` }); continue }
          const compatibility = compatibleOutput(widget, output.contract_id, output.capabilities, config as Record<string, unknown>)
          if (!compatibility.ok) unfit.push({ id: feed.id, why: compatibility.error })
        }
        return { unfit }
      }
      const unfit: { id: string; why: string }[] = []
      for (const feed of listFeeds(app.db)) {
        if (!(WIDGET_FEED_MODES[widget] ?? []).includes(feed.mode)) continue
        const compatibility = compatibleGeneric(
          widget, config as Record<string, unknown>, capabilitiesForFeed(app.db, feed), feed.mode,
        )
        if (!compatibility.ok) unfit.push({ id: feed.id, why: compatibility.error })
      }
      return { unfit }
    })

  // The static widget contract this hub builds (src/screens/widgetContract.ts), served so a
  // consumer like clients/mcp can shape its tool schemas from the ACTUAL running hub rather than
  // a copy baked in at its own release time. The real reason this route exists is deployment
  // skew: the MCP package and the hub version independently, so a schema built from a stale,
  // bundled contract would quietly drift from what the hub really accepts — fetching it live
  // (and re-checking `revision` on every schema-shaped write, see server.ts's skew guard) is what
  // keeps the two honest about each other across that independent versioning.
  admin.get('/admin/api/widget-contract', async () => WIDGET_CONTRACT)

  admin.get<{ Params: { id: string } }>('/admin/api/feeds/:id', async (req, reply) => {
    const f = getFeed(app.db, req.params.id)
    if (!f) return reply.code(404).send({ error: 'not found' })
    return {
      ...feedOut(f),
      payload: guardedParse(f.payload),
      rows: recentRows(app.db, f.id, 20).map((r) => ({ payload: guardedParse(r.payload), pushed_at: r.pushed_at })),
      references: screensReferencingFeed(app.db, f.id),
    }
  })

  admin.post<{ Body: {
    name: string; mode: FeedMode; cap?: number; stale_after_s?: number | null
    alert_on_stale?: boolean; allowed_senders?: string[] | null
  } }>('/admin/api/feeds', { schema: { body: feedBody(['name', 'mode']) } }, async (req, reply) => {
    try {
      const row = createFeed(app.db, req.body, Date.now(), actorOf(req))
      return feedOut(row)
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        return reply.code(400).send({ error: 'name already exists' })
      }
      throw err
    }
  })

  admin.patch<{ Params: { id: string }; Body: {
    name?: string; cap?: number; stale_after_s?: number | null
    alert_on_stale?: boolean; allowed_senders?: string[] | null
  } }>('/admin/api/feeds/:id', { schema: { body: feedPatchBody([]) } }, async (req, reply) => {
    try {
      if (!updateFeed(app.db, req.params.id, req.body, actorOf(req))) return reply.code(404).send({ error: 'not found' })
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        return reply.code(400).send({ error: 'name already exists' })
      }
      throw err
    }
    // Updated stale_after_s/name etc. must reach devices already rendering this feed.
    app.dataPusher.onFeedPush(req.params.id)
    return reply.code(204).send()
  })

  admin.delete<{ Params: { id: string } }>('/admin/api/feeds/:id', async (req, reply) => {
    // Fetched BEFORE delete: once the row is gone we can no longer tell whether it was an
    // image feed or whether anything was ever pushed to it.
    const feed = getFeed(app.db, req.params.id)
    if (!feed || !deleteFeed(app.db, req.params.id, actorOf(req))) return reply.code(404).send({ error: 'not found' })
    // Image bytes live on disk, not in the DB row deleteFeed just removed (the db layer stays
    // fs-free — image-feed behavior); the unlink happens here. image_rev === 0 means nothing was ever
    // pushed, so there's no file to remove.
    if (feed.mode === 'image' && feed.image_rev > 0) {
      try {
        unlinkSync(imagePath(app.appConfig.dataDir, feed.id))
      } catch (err) {
        // Best-effort: deleting the feed must still succeed even if this fails. ENOENT (already
        // gone, or never written despite image_rev — e.g. manual tampering) is the normal case
        // and stays silent; anything else (permissions, IO error) leaves stale bytes on disk
        // and is worth a log line so it isn't indistinguishable from the normal case.
        if ((err as { code?: string }).code !== 'ENOENT') {
          console.warn(`admin: failed to remove image bytes for feed ${feed.id}`, err)
        }
      }
    }
    // Safe to compute referencing devices AFTER the delete: a screen's grid is untouched by a
    // feed delete, so the reference set is unaffected by ordering here. Every connected device
    // that referenced this feed gets a fresh snapshot, which now correctly empties/omits it —
    // the renderer's "feed missing" placeholder.
    app.dataPusher.snapshotReferencing(req.params.id)
    return reply.code(204).send()
  })
}
