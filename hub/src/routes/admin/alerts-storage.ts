import type { FastifyInstance } from 'fastify'
import { audit } from '../../db/audit.js'
import { dismissAlertById, listActiveAlerts } from '../../db/alerts.js'
import { computeStorageStats } from '../../db/storageStats.js'
import { deleteSetting } from '../../db/settings.js'
import {
  MAX_RETENTION_DAYS, SETTINGS_KEY_ALERTS_DAYS, SETTINGS_KEY_AUDIT_DAYS,
  resolveRetentionConfig, validateRetentionDays, writeRetentionDays, type RetentionEnvConfig,
} from '../../db/retentionSettings.js'
import { forceRetentionSweep } from '../../ttl.js'
import { pushTabStatus, screensLitBySender } from '../../ws/tabStatus.js'
import { actorOf, requireHumanAdmin } from './shared.js'

/** Bypassing the retention sweep's hourly gate on demand is still cheap enough to hammer — SWEEP_COOLDOWN_MS below is what stops that, not this constant by itself. */
const SWEEP_COOLDOWN_MS = 60_000

export function createAlertsStorageRoutes(app: FastifyInstance): {
  registerReadRoutes: (admin: FastifyInstance) => void
  registerHumanRoutes: () => Promise<void>
} {
  // Declared at plugin scope (once per `buildServer` call, i.e. once per running hub or per test's
  // own app instance) rather than module scope, so two hubs — or two tests in the same process —
  // never share a clock. `retentionEnvConfig` is read by both the requireAdmin-guarded GET below
  // and the requireHumanAdmin-guarded PATCH/POST further down; `lastForcedSweepAt` only by the POST.
  const retentionEnvConfig = (): RetentionEnvConfig => ({
    alertsDays: app.appConfig.retentionAlertsDays,
    alertsSource: app.appConfig.retentionAlertsDaysSource ?? 'default',
    auditDays: app.appConfig.retentionAuditDays,
    auditSource: app.appConfig.retentionAuditDaysSource ?? 'default',
  })
  let lastForcedSweepAt = 0

  const registerReadRoutes = (admin: FastifyInstance): void => {
    admin.get<{ Querystring: { limit?: number } }>('/admin/api/alerts', async (req) =>
      app.db.prepare('SELECT * FROM alerts ORDER BY updated_at DESC LIMIT ?').all(req.query.limit ?? 50))

    /**
     * What is still holding a tab dot lit — and, via `screens`, which tabs.
     *
     * The row above answers "what has this hub been alerting about lately"; this one answers the
     * only question an operator staring at a coloured dot actually has. Attribution comes from
     * `screensLitBySender`, the same index `computeTabStatus` colours the dot with, so the
     * explanation cannot disagree with the thing it explains.
     */
    admin.get('/admin/api/alerts/active', async () => {
      // Memoised per request because active alerts cluster by sender — a flapping integration is
      // one sender and a dozen rows — and each lookup walks every screen's grid.
      const screensFor = new Map<string, { id: string; name: string }[]>()
      return listActiveAlerts(app.db).map((alert) => {
        let screens = screensFor.get(alert.sender.id)
        if (!screens) {
          screens = screensLitBySender(app.db, alert.sender.id)
          screensFor.set(alert.sender.id, screens)
        }
        return { ...alert, screens }
      })
    })
    // actor_type is optional: the (? IS NULL OR actor_type = ?) pair lets one prepared statement
    // serve both the unfiltered admin log view and a page (e.g. Agents) that wants only its slice.
    admin.get<{ Querystring: { limit?: number; before?: number; actor_type?: string } }>(
      '/admin/api/audit', async (req) =>
        app.db.prepare(
          'SELECT * FROM audit_log WHERE id < ? AND (? IS NULL OR actor_type = ?) ORDER BY id DESC LIMIT ?',
        ).all(req.query.before ?? Number.MAX_SAFE_INTEGER, req.query.actor_type ?? null,
          req.query.actor_type ?? null, req.query.limit ?? 100))

    // Storage & retention. `retentionEnvConfig` is the env/default
    // fallback layer alone — `config.ts`'s resolved numbers plus whether each came from an
    // explicit env var or the built-in default — the same shape `boot.ts` hands `startTtlSweep`.
    // `resolveRetentionConfig` adds the one remaining layer (a `settings` row) on top, fresh on
    // every call, so this route can never show a stale value even seconds after a PATCH.
    //
    // GET stays on the ordinary requireAdmin guard (Bearer-readable) — it exposes sizes and the
    // current policy, nothing an agent could turn into leverage. The write routes do not: see the
    // requireHumanAdmin block below.
    admin.get('/admin/api/storage', async () => {
      const stats = computeStorageStats(app.db, app.appConfig.dataDir)
      const resolved = resolveRetentionConfig(app.db, retentionEnvConfig())
      const lastSweepRow = app.db.prepare(
        "SELECT ts, details FROM audit_log WHERE event = 'retention_swept' ORDER BY id DESC LIMIT 1",
      ).get() as { ts: number; details: string } | undefined
      return {
        db_bytes: stats.db_bytes,
        images_bytes: stats.images_bytes,
        pools: stats.pools,
        retention: {
          alerts_days: resolved.alertsDays,
          audit_days: resolved.auditDays,
          source: { alerts_days: resolved.alertsSource, audit_days: resolved.auditSource },
        },
        last_sweep: lastSweepRow ? { ts: lastSweepRow.ts, ...JSON.parse(lastSweepRow.details) } : null,
      }
    })
  }

  const registerHumanRoutes = async (): Promise<void> => {
    /**
     * Clearing an alert is human-only, on the same reasoning as retention writes below: an agent
     * token that could dismiss alarms could bury the evidence of its own failure — it raises a
     * critical, nobody is home, and it clears it before anyone reads the glass. Listing them stays on
     * the ordinary guard; seeing what is ringing is not the leverage this line is about.
     *
     * The effects mirror the sender-side resolve in `notify.ts` exactly, because they are the same
     * conclusion reached from a third place: tell the target devices, re-derive the tab dots, leave a
     * trail. A dismissal that changed the row but not the panels would just move the stuck state.
     */
    await app.register(async (alertsHuman) => {
      alertsHuman.addHook('preHandler', requireHumanAdmin)

      alertsHuman.post<{ Params: { id: string } }>('/admin/api/alerts/:id/dismiss', async (req, reply) => {
        // 404 only for an id this hub has never held. An alert that a panel or its sender concluded
        // a moment ago is not an error — the operator wanted it gone and it is gone — so it returns
        // `dismissed: false` and sends nothing, the same shape a no-op sender resolve returns.
        const known = app.db.prepare('SELECT 1 FROM alerts WHERE id = ?').get(req.params.id)
        if (!known) return reply.code(404).send({ error: 'unknown alert' })

        const result = dismissAlertById(app.db, req.params.id, Date.now())
        if (!result.dismissed) return { dismissed: false }

        app.registry.sendMany(result.target_devices, {
          type: 'ALERT_REMOVE', id: result.id, reason: 'dismissed',
        })
        pushTabStatus(app.db, app.registry)
        audit(app.db, 'admin', null, 'alert_dismissed', { alert_id: result.id })
        return { dismissed: true }
      })
    })

    /**
     * Retention *writes* are human-only for the same reason as token minting and revocation:
     * mint/revoke (the shared requireHumanAdmin docstring): `audit_days` is what lets an operator
     * reconstruct what a compromised agent did, and `PATCH .../retention` can shrink that cutoff,
     * while `POST .../sweep` can make the shrink take effect immediately instead of waiting on the
     * hourly gate. A token that could do either could shorten its own trail — the exact
     * self-perpetuation class mint/revoke's human-only line exists to close. GET stays out of this
     * block: reading sizes and the current policy is not the leverage this line is about.
     */
    await app.register(async (retentionHuman) => {
      retentionHuman.addHook('preHandler', requireHumanAdmin)

      retentionHuman.patch<{ Body: { alerts_days?: number | null; audit_days?: number | null } }>('/admin/api/retention', {
        schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
          // null resets the key to inherit (deletes its settings row, falling back to env/default);
          // a number is validated below by `validateRetentionDays`, the one place the 0..MAX_RETENTION_DAYS
          // rule is written down — AJV is deliberately not asked to duplicate it.
          alerts_days: { type: ['integer', 'null'] },
          audit_days: { type: ['integer', 'null'] },
        } } },
      }, async (req, reply) => {
        for (const [key, value] of Object.entries(req.body)) {
          if (value !== null && validateRetentionDays(value) === null) {
            return reply.code(400).send({ error: `${key} must be an integer from 0 through ${MAX_RETENTION_DAYS}, or null to reset` })
          }
        }

        const envConfig = retentionEnvConfig()
        const before = resolveRetentionConfig(app.db, envConfig)
        const now = Date.now()
        if (req.body.alerts_days !== undefined) {
          if (req.body.alerts_days === null) deleteSetting(app.db, SETTINGS_KEY_ALERTS_DAYS)
          else writeRetentionDays(app.db, SETTINGS_KEY_ALERTS_DAYS, req.body.alerts_days, now)
        }
        if (req.body.audit_days !== undefined) {
          if (req.body.audit_days === null) deleteSetting(app.db, SETTINGS_KEY_AUDIT_DAYS)
          else writeRetentionDays(app.db, SETTINGS_KEY_AUDIT_DAYS, req.body.audit_days, now)
        }
        const after = resolveRetentionConfig(app.db, envConfig)

        const changes: Record<string, { old: number; new: number }> = {}
        if (req.body.alerts_days !== undefined) changes.alerts_days = { old: before.alertsDays, new: after.alertsDays }
        if (req.body.audit_days !== undefined) changes.audit_days = { old: before.auditDays, new: after.auditDays }
        const actor = actorOf(req)
        audit(app.db, actor.type, actor.id, 'retention_settings_changed', changes)
        return reply.code(204).send()
      })

      // "Sweep now" — bypasses the hourly gate entirely (ttl.ts's `forceRetentionSweep`, the same
      // delete-plus-conditional-audit pass the periodic sweep runs, just not gated or try/caught:
      // an admin action gets a real error back, not a silent console.warn). Reads the CURRENT
      // effective config the same way GET /admin/api/storage does, so a PATCH immediately followed
      // by a sweep uses the value just saved, not whatever was in force when the hub booted.
      //
      // Its own, much shorter cooldown on top of that: the hourly gate is what stops the PERIODIC
      // pass from running too often, but this route bypasses that gate on purpose, and nothing else
      // stood between an operator (or a script acting as one) and calling it in a tight loop —
      // cheap, but not free, and "not free repeated arbitrarily fast" is still worth a floor.
      retentionHuman.post('/admin/api/retention/sweep', async (_req, reply) => {
        const now = Date.now()
        const elapsed = now - lastForcedSweepAt
        if (elapsed < SWEEP_COOLDOWN_MS) {
          const retryAfterS = Math.ceil((SWEEP_COOLDOWN_MS - elapsed) / 1000)
          reply.header('retry-after', String(retryAfterS))
          return reply.code(429).send({ error: `retention sweep ran too recently; try again in ${retryAfterS}s` })
        }
        lastForcedSweepAt = now
        return forceRetentionSweep(app.db, now, resolveRetentionConfig(app.db, retentionEnvConfig()))
      })
    })
  }

  return { registerReadRoutes, registerHumanRoutes }
}
