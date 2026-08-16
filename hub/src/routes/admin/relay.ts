import type { FastifyInstance, FastifyReply } from 'fastify'
import { audit } from '../../db/audit.js'
import { BRAND } from '../../brand.js'
import { isRelayUrl } from '../../config.js'
import type { RelayManager } from '../../relay/manager.js'
import { actorOf, requireHumanAdmin } from './shared.js'

export function registerRelayReadRoutes(admin: FastifyInstance, app: FastifyInstance): void {
  // relay is null when no relay is configured (or no manager was started — buildServer-only
  // tests). The fuller picture — identity, last error, terminal flag — lives on GET
  // /admin/api/relay below; this field stays for compatibility with clients that only need
  // the state word.
  admin.get('/admin/api/config', async () => {
    const st = app.relayManager?.status() ?? null
    return {
      public_url: app.appConfig.publicUrl,
      brand: BRAND.name,
      relay: st ? { state: st.state } : null,
    }
  })

  // Relay status for the admin header badge. JSON null (not 404) when no relay is configured —
  // or when no manager was started (buildServer-only tests). "no relay configured" is a normal
  // state the badge renders, not an error. The hub_secret must never appear here —
  // relayStatusApi.test.ts pins its absence.
  admin.get('/admin/api/relay', async () => app.relayManager?.status() ?? null)
}
export async function registerRelayHumanRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Relay *writes* are human-only for the same reason retention writes are: the relay URL is
   * where the hub dials out, and a leaked agent token repointing it means silent loss of remote
   * delivery plus traffic metadata handed to a stranger's relay. Reading status (GET above)
   * stays Bearer-reachable — it grants no comparable leverage.
   */
  await app.register(async (relayHuman) => {
    relayHuman.addHook('preHandler', requireHumanAdmin)

    // Production boot always decorates the manager; a buildServer-only test app reaching a
    // write route without one is a test-harness mistake worth a loud, specific 500.
    const managerOr500 = (reply: FastifyReply): RelayManager | null => {
      if (app.relayManager) return app.relayManager
      reply.code(500).send({ error: 'relay manager not started' })
      return null
    }

    const urlBody = {
      schema: { body: { type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', minLength: 1, maxLength: 500 },
        // Optional relay account token. '' clears a previously stored token; an absent field leaves
        // the stored value alone. No minLength — '' is a valid, meaningful value.
        token: { type: 'string', maxLength: 500 },
      } } },
    }

    relayHuman.put<{ Body: { url: string; token?: string } }>('/admin/api/relay', urlBody, async (req, reply) => {
      const mgr = managerOr500(reply)
      if (!mgr) return
      if (!isRelayUrl(req.body.url)) {
        return reply.code(400).send({ error: 'url must be a ws:// or wss:// URL' })
      }
      mgr.setUrl(req.body.url, req.body.token)
      const actor = actorOf(req)
      // Never the token itself — token_set is the only thing an audit reader may learn about it.
      audit(app.db, actor.type, actor.id, 'relay_configured',
        { url: req.body.url, token_set: mgr.status()?.token_set ?? false })
      return mgr.status()
    })

    // Idempotent like SQL DELETE: removing an unconfigured relay is a 204, not an error.
    relayHuman.delete('/admin/api/relay', async (req, reply) => {
      const mgr = managerOr500(reply)
      if (!mgr) return
      mgr.clear()
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'relay_removed', {})
      return reply.code(204).send()
    })

    // Dry run: dials with the hub's real identity, reports, saves nothing. Audited because a
    // test dial is still an outbound connection an operator may later ask about.
    relayHuman.post<{ Body: { url: string; token?: string } }>('/admin/api/relay/test', urlBody, async (req, reply) => {
      const mgr = managerOr500(reply)
      if (!mgr) return
      if (!isRelayUrl(req.body.url)) {
        return reply.code(400).send({ error: 'url must be a ws:// or wss:// URL' })
      }
      const result = await mgr.test(req.body.url, req.body.token)
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'relay_test', { url: req.body.url, ok: result.ok })
      return result
    })
  })
}
