import Fastify, { type FastifyInstance, type FastifyError } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.js'
import type { DB } from './db/index.js'
import { BRAND } from './brand.js'
import { landingPage } from './landingPage.js'
import { DeviceRegistry } from './ws/registry.js'
import { StatePusher } from './ws/statePush.js'
import { readableValidationError } from './validationMessage.js'
import { DataPusher } from './ws/dataPush.js'
import { SessionStore } from './auth/sessions.js'
import { notifyRoutes } from './routes/notify.js'
import { feedsRoutes } from './routes/feeds.js'
import { pairRoutes } from './routes/pair.js'
import { adminRoutes } from './routes/admin.js'
import { agentsRoutes } from './routes/agents.js'
import { themesRoutes } from './routes/themes.js'
import { registerDeviceSocket } from './ws/deviceSocket.js'
import type { SecretBox } from './secrets/box.js'
import type { AdminActor } from './db/audit.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Stamped by requireAdmin/requireHumanAdmin on success; absent on unauthenticated routes. */
    actor?: AdminActor
  }
  interface FastifyInstance {
    db: DB
    appConfig: Config
    registry: DeviceRegistry
    statePusher: StatePusher
    dataPusher: DataPusher
    sessions: SessionStore
    /**
     * The fetch data sources reach the outside world through — decorated rather than reached for
     * globally so a test can hand the routes a canned response. Every provider test in this
     * codebase runs off fixtures; none of them may touch the network, and a global `fetch` inside
     * a route handler is how that rule gets broken by accident.
     */
    sourceFetch: typeof fetch
    secretBox: SecretBox
    /** Manual source refreshes share one in-flight guard across the authenticated route plugin. */
    sourceRefreshes: Set<string>
  }
}

const unavailableSecretBox: SecretBox = {
  seal() { throw new Error('SecretBox is unavailable') },
  open() { throw new Error('SecretBox is unavailable') },
}

export async function buildServer(
  opts: { config: Config; db: DB; secretBox?: SecretBox; ackTimeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: { removeAdditional: false },
    },
  })
  app.decorate('db', opts.db)
  app.decorate('appConfig', opts.config)
  app.decorate('registry', new DeviceRegistry())
  app.decorate('statePusher', new StatePusher(opts.db, app.registry, { ackTimeoutMs: opts.ackTimeoutMs }))
  app.decorate('dataPusher', new DataPusher(opts.db, app.registry))
  app.decorate('sourceFetch', opts.fetchImpl ?? globalThis.fetch)
  app.decorate('secretBox', opts.secretBox ?? unavailableSecretBox)
  app.decorate('sourceRefreshes', new Set<string>())
  // Decorated on the ROOT instance (not created inside admin.ts) so that any sibling plugin
  // registered on this same `app` — themesRoutes' admin bg-upload route, currently the only
  // other one — can session-guard against the SAME store admin.ts's login/logout use. A
  // SessionStore instantiated inside a plugin's own encapsulation context would be invisible to
  // siblings (Fastify decorators only flow parent -> children), so a second admin-guarded route
  // file would silently validate against an always-empty store and 401 forever.
  app.decorate('sessions', new SessionStore())
  await app.register(cookie)
  await app.register(websocket)

  app.get('/api/health', async () => ({ ok: true, name: BRAND.name }))

  app.get('/', (_req, reply) => reply.type('text/html; charset=utf-8').send(landingPage()))

  // Only browsers get the page; anything else keeps the JSON 404 that senders, agents and the
  // device app parse. Swapping that for HTML wholesale would turn a clean "unknown route" into a
  // parse error at the client.
  app.setNotFoundHandler((req, reply) => {
    if (req.headers.accept?.includes('text/html')) {
      return reply.code(404).type('text/html; charset=utf-8').send(landingPage({ notFound: true }))
    }
    reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 })
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation || err.code === 'FST_ERR_VALIDATION') {
      // AJV's raw message is a oneOf wall for widget configs — see validationMessage.ts.
      return reply.code(400).send({ error: readableValidationError(err.validation, req.body) ?? err.message })
    }
    reply.send(err)
  })

  await app.register(notifyRoutes)
  await app.register(feedsRoutes)
  await app.register(pairRoutes)
  await app.register(adminRoutes)
  await app.register(agentsRoutes)
  await app.register(themesRoutes)
  registerDeviceSocket(app)

  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'static')
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      /**
       * `no-cache` means REVALIDATE, not "never store" — the client keeps the file and asks whether
       * it changed, so a 304 costs one round trip and an unchanged board still loads from disk.
       *
       * Load-bearing for a kiosk. An Android WebView caches aggressively, and a panel that has run
       * for weeks was serving a device.js from before the last hub update — code shipped to the hub
       * simply never reached the glass, silently and with no way to tell from either end. The
       * hashed admin bundle is immune (its filename changes), but /device/* is stable paths whose
       * CONTENT changes, which is exactly the case a plain ETag without revalidation gets wrong.
       *
       * SCRIPTS GET `no-store` INSTEAD, because that WebView does not honour `no-cache` for ES
       * MODULES. Measured on a Galaxy A05 over CDP: after `location.reload()` the page re-executed
       * a cached `widgets/index.mjs` and kept a four-design catalogue, while `fetch()` of the same
       * URL in the same page returned the five-design file; `Page.reload({ignoreCache: true})`
       * registered all five. The headers were correct the whole time — `no-cache` with both an
       * ETag and a Last-Modified — and the client simply did not revalidate.
       *
       * That silently broke the mechanism, whose entire purpose is "notice a design you cannot draw, then
       * reload to pick it up": the reload was guaranteed to bring back the same stale modules, so
       * the feature could never have worked on the device class it was built for.
       *
       * Scripts only. Artwork keeps `no-cache` — revalidation demonstrably works for it, and
       * refetching a 370KB sprite sheet on every board load is a real cost on a panel that reloads
       * precisely in order to pick up new artwork.
       */
      cacheControl: true,
      maxAge: 0,
      setHeaders: (res, path) => {
        res.header('cache-control', /\.m?js$/.test(path) ? 'no-store' : 'no-cache')
      },
    })
    app.get('/admin', (_req, reply) => reply.sendFile('admin/index.html'))
    app.get('/device', (_req, reply) => reply.sendFile('device/index.html'))
  }

  return app
}
