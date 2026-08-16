import type { FastifyInstance } from 'fastify'
import { audit } from '../db/audit.js'
import { createAgentToken, listAgentTokens, revokeAgentToken } from '../db/agents.js'
import { requireAdmin, requireHumanAdmin, actorOf } from './admin/shared.js'

/**
 * Agent tokens: a credential as powerful as the admin password, minted for an operator's AI
 * assistant. Two scopes on purpose — human-only requests require the stricter scope at
 * revocation integrity: a token that could mint or revoke tokens would make revoking a leaked one
 * meaningless. Listing stays on the ordinary guard; it exposes metadata only.
 */
export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (ordinary) => {
    ordinary.addHook('preHandler', requireAdmin)
    ordinary.get('/admin/api/agent-tokens', async () => listAgentTokens(app.db))
  })

  await app.register(async (human) => {
    human.addHook('preHandler', requireHumanAdmin)

    human.post<{ Body: { name: string } }>('/admin/api/agent-tokens', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } },
    }, async (req, reply) => {
      const { agent, token } = createAgentToken(app.db, req.body.name)
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'agent_token_created', { agent_id: agent.id, name: agent.name })
      // The raw token exists in this response and nowhere else — the row keeps only the hash.
      return reply.code(201).send({ ...agent, token })
    })

    human.delete<{ Params: { id: string } }>('/admin/api/agent-tokens/:id', async (req, reply) => {
      if (!revokeAgentToken(app.db, req.params.id, Date.now())) {
        return reply.code(404).send({ error: 'not found' })
      }
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'agent_token_revoked', { agent_id: req.params.id })
      return reply.code(204).send()
    })
  })
}
