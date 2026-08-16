import type { FastifyInstance } from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import { audit } from '../db/audit.js'
import { sourceAdminRoutes } from './sourceAdmin.js'
import { WIDGET_FEED_MODES } from '../screens/save.js'
import {
  ADMIN_COOKIE, adminCookieOptions, createSoundsBodySchema, requireAdmin, requireHumanAdmin,
} from './admin/shared.js'
import { registerSendersDevicesRoutes } from './admin/senders-devices.js'
import { registerScreenRoutes } from './admin/screens.js'
import { registerThemeRoutes } from './admin/themes.js'
import { registerFeedRoutes } from './admin/feeds.js'
import { createAlertsStorageRoutes } from './admin/alerts-storage.js'
import { registerRelayHumanRoutes, registerRelayReadRoutes } from './admin/relay.js'

export { WIDGET_FEED_MODES }
export {
  ADMIN_COOKIE, actorOf, pushDevicesForScreens, pushDevicesForTheme, pushDevicesForThemes,
  requireAdmin, requireHumanAdmin,
} from './admin/shared.js'

/**
 * WIDGET_FEED_MODES is implemented by screens/save.ts and re-exported here because the browser
 * agreement test historically imports this route module. Importing `../static` is still impossible
 * under the hub's TypeScript root, so `hub/test/widget-bindings.test.ts` compares both copies.
 *
 * The save service decides generic widget compatibility from this map alone. Semantic widgets use
 * their contract/capability requirements instead of joining this mode-only declaration.
 */
function passwordMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const cookieOptions = adminCookieOptions(app.appConfig.publicUrl)
  const alertsStorageRoutes = createAlertsStorageRoutes(app)
  const soundsBodySchema = createSoundsBodySchema()

  app.post<{ Body: { password: string } }>('/admin/api/login', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string' } } } },
  }, async (req, reply) => {
    if (!passwordMatches(req.body.password, app.appConfig.adminPassword)) {
      audit(app.db, 'system', null, 'admin_login_rejected', {})
      return reply.code(401).send({ error: 'wrong password' })
    }
    reply.setCookie(ADMIN_COOKIE, app.sessions.create(), cookieOptions)
    audit(app.db, 'admin', null, 'admin_login', {})
    return reply.code(204).send()
  })

  // Logout is meaningless without a cookie session — there is nothing for a Bearer request to
  // destroy, only a cookie it does not have — so it lives in its own requireHumanAdmin-guarded
  // scope rather than the ordinary requireAdmin one below. Under requireAdmin a live agent token
  // could reach this route, hit `req.cookies[ADMIN_COOKIE]!` (a lie: the cookie is never there for
  // a Bearer request) and mint an `admin_logout` audit row stamped `'admin'` for an action no
  // human took.
  app.register(async (humanOnly) => {
    humanOnly.addHook('preHandler', requireHumanAdmin)

    humanOnly.post('/admin/api/logout', async (req, reply) => {
      app.sessions.destroy(req.cookies[ADMIN_COOKIE]!)
      reply.clearCookie(ADMIN_COOKIE, cookieOptions)
      audit(app.db, 'admin', null, 'admin_logout', {})
      return reply.code(204).send()
    })
  })

  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin)

    await admin.register(sourceAdminRoutes)

    registerRelayReadRoutes(admin, app)

    registerSendersDevicesRoutes(admin, app)

    registerScreenRoutes(admin, app, soundsBodySchema)

    registerThemeRoutes(admin, app, soundsBodySchema)

    registerFeedRoutes(admin, app)

    alertsStorageRoutes.registerReadRoutes(admin)
  })

  await alertsStorageRoutes.registerHumanRoutes()

  await registerRelayHumanRoutes(app)
}
