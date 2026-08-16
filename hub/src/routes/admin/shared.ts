import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../../config.js'
import { findAgentByToken, touchAgentToken } from '../../db/agents.js'
import { audit, type AdminActor } from '../../db/audit.js'
import { assignedDeviceIds, listScreens, type ScreenRow } from '../../db/screens.js'
import { SOUND_EVENTS } from '../../sounds.js'

// Exported so other route files (currently just themes.ts's admin bg-upload route) can
// session-guard against the SAME cookie name / SAME app.sessions store this file uses — see the
// comment on `app.decorate('sessions', ...)` in server.ts for why the store itself must be
// shared rather than each file minting its own.
export const ADMIN_COOKIE = 'dbz_admin'

export const adminCookieOptions = (publicUrl: Config['publicUrl']) => ({
  httpOnly: true,
  path: '/',
  sameSite: 'strict' as const,
  secure: new URL(publicUrl).protocol === 'https:',
})

/**
 * "Is this request an authenticated admin?" — one shared predicate for every route file. The guard
 * centralizes the implemented session-cookie and agent-Bearer checks, giving future hardening one
 * location instead of route-specific copies.
 *
 * Reads the session store off `req.server` rather than closing over a captured `app`, so it is a
 * plain hook any plugin can `addHook('preHandler', requireAdmin)` with, at any nesting depth:
 * `sessions` is decorated on the ROOT instance (server.ts) and Fastify decorators flow parent ->
 * children, so every encapsulation context that can reach a route can reach the same store.
 * Attach it plugin-wide, not per route — a route added later is then guarded by construction
 * rather than by whoever adds it remembering to.
 *
 * Bearer is checked here and nowhere else, for the same reason the cookie check lives in exactly
 * one place: hardening the token path (rate limiting, a stricter comparison, whatever comes next)
 * must not require finding and updating a second copy. `requireHumanAdmin` below is this SAME
 * session check with the Bearer branch removed, not a parallel guard that could drift from it.
 */
export const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (req.server.sessions.valid(req.cookies[ADMIN_COOKIE])) {
    req.actor = { type: 'admin', id: null }
    return
  }
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  if (token) {
    const row = findAgentByToken(req.server.db, token)
    if (row && row.revoked_at === null) {
      touchAgentToken(req.server.db, row.id, Date.now())
      req.actor = { type: 'agent', id: row.id }
      return
    }
    // A revoked token being TRIED is the one signal an operator wants after revoking a leaked
    // credential; an unknown token is just noise and gets the silent 401.
    if (row) audit(req.server.db, 'system', null, 'agent_auth_rejected', { agent_id: row.id })
  }
  await reply.code(401).send({ error: 'unauthorized' })
}

/**
 * requireAdmin accepts an admin session cookie or an agent Bearer token. Routes that mint or revoke
 * agent tokens use requireHumanAdmin, which accepts only the admin session cookie, so an agent
 * cannot replace a credential after an operator revokes it.
 */
export const requireHumanAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (req.server.sessions.valid(req.cookies[ADMIN_COOKIE])) {
    req.actor = { type: 'admin', id: null }
    return
  }
  await reply.code(401).send({ error: 'unauthorized' })
}

/** The actor requireAdmin stamped, for audit attribution at call sites that predate agents. */
export const actorOf = (req: FastifyRequest): AdminActor => req.actor ?? { type: 'admin', id: null }

/** Every screen currently pointing at this theme (mirrors screensReferencingFeed's shape). */
const screensForTheme = (app: FastifyInstance, themeId: string): ScreenRow[] =>
  listScreens(app.db).filter((s) => s.theme_id === themeId)

/**
 * Dedupe first, THEN push once per device: a device could otherwise be reached by two screens in
 * the same fan-out (not possible today — one screen per device — but this keeps the push call
 * count correct even if that ever changes) and StatePusher.push increments an internal rev on
 * every call, so a duplicate call is not a no-op.
 *
 * These three live at module scope, exported, because the theme fan-out has a caller outside this
 * file: themes.ts's background upload bumps the theme's `rev` and must reach the same devices.
 * Keeping one fan-out prevents the route plugins from drifting.
 */
export const pushDevicesForScreens = (app: FastifyInstance, screenIds: string[]): void => {
  const deviceIds = new Set<string>()
  for (const screenId of screenIds) for (const id of assignedDeviceIds(app.db, screenId)) deviceIds.add(id)
  for (const deviceId of deviceIds) app.statePusher.push(deviceId)
}

export const pushDevicesForTheme = (app: FastifyInstance, themeId: string): void =>
  pushDevicesForScreens(app, screensForTheme(app, themeId).map((s) => s.id))

// Fan-out for a theme write: every screen on it, then every device on those screens.
export const pushDevicesForThemes = (app: FastifyInstance, themeIds: string[]): void => {
  const screenIds = listScreens(app.db).filter((s) => s.theme_id && themeIds.includes(s.theme_id)).map((s) => s.id)
  pushDevicesForScreens(app, screenIds)
}

/** The tab-bar edge a stored screen declares — absent or unreadable reads as 'bottom' (bad data never crashes a read path). */
export const screenTabBar = (screen: ScreenRow): string => {
  try {
    const tabBar = (JSON.parse(screen.grid) as { tab_bar?: unknown }).tab_bar
    return typeof tabBar === 'string' ? tabBar : 'bottom'
  } catch { return 'bottom' }
}

/**
 * Sparse event->family map schema (schema v27, alert-sound contract), shared by `screenBody` and `themeBody`
 * (tab state both carry the identical block, so this is the one copy). Keys are derived from
 * `SOUND_EVENTS` (hub/src/sounds.ts) rather than hardcoded —
 * `additionalProperties: false` rejects anything else, the same discipline as chromeSchema.
 * Values are bare family ids, not enumerated (a theme/screen must be able to store a family a
 * client older than it does not yet ship — same "unknown degrades to classic" rule design ids
 * and backdrop already follow), but constrained to the manifest's naming shape so a garbage
 * string can't be stored. A SCREEN override is additionally checked against the RUNNING hub's
 * `getSoundManifest().families` by `registerScreenRoutes`' PATCH handler in
 * routes/admin/screens.ts — this schema alone only rejects shapes, not families the manifest
 * doesn't (yet) know.
 */
export const createSoundsBodySchema = () => ({
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(SOUND_EVENTS.map((event) => [
    event, { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9_]+$' },
  ])),
})

export type SoundsBodySchema = ReturnType<typeof createSoundsBodySchema>
