import type { FastifyInstance } from 'fastify'
import { findSenderByToken, touchSender } from '../db/senders.js'
import { deviceExists } from '../db/devices.js'
import { alertAnswerForSender, getWireAlert, ingestNotify, resolveAlertByDedupKey, type Severity } from '../db/alerts.js'
import { audit } from '../db/audit.js'
import { pushTabStatus } from '../ws/tabStatus.js'

const notifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', maxLength: 1500 },
      severity: { enum: ['info', 'warn', 'critical'] },
      devices: { type: 'array', items: { type: 'string' }, minItems: 1 },
      sound: { type: 'boolean' },
      ttl_s: { type: 'integer', minimum: 1 },
      dedup_key: { type: 'string', minLength: 1, maxLength: 100 },
      // Sender-side resolve (netdata CLEAR etc): additive, so the create path below is untouched.
      // `title`/`severity` stay required for a create; a resolve needs neither, but does need
      // `dedup_key` — see if/then/else.
      resolve: { type: 'boolean' },
      options: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'label'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z0-9_-]+$' },
            label: { type: 'string', minLength: 1, maxLength: 24 },
          },
        },
      },
    },
    if: { required: ['resolve'], properties: { resolve: { const: true } } },
    then: { required: ['dedup_key'] },
    else: { required: ['title', 'severity'] },
  },
} as const

interface NotifyBody {
  title?: string; body?: string; severity?: Severity
  devices?: string[]; sound?: boolean; ttl_s?: number; dedup_key?: string
  resolve?: boolean
  options?: { id: string; label: string }[]
}

export async function notifyRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: NotifyBody }>('/api/notify', { schema: notifySchema }, async (req, reply) => {

    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const sender = token ? findSenderByToken(app.db, token) : undefined
    if (!sender) {
      audit(app.db, 'system', null, 'auth_rejected', { route: '/api/notify' })
      return reply.code(401).send({ error: 'invalid token' })
    }

    const now = Date.now()

    if (req.body.resolve) {
      // Schema requires dedup_key when resolve is true; this check is defensive, not load-bearing
      // (see house rule: bad data must never crash a read path, even data ajv should have caught).
      const dedupKey = req.body.dedup_key
      if (!dedupKey) return reply.code(400).send({ error: 'dedup_key required' })

      const result = resolveAlertByDedupKey(app.db, sender.id, dedupKey)
      if (!result.resolved) {
        touchSender(app.db, sender.id, now)
        return { ok: true, resolved: false }
      }

      app.registry.sendMany(result.target_devices, { type: 'ALERT_REMOVE', id: result.id, reason: 'resolved' })
      pushTabStatus(app.db, app.registry)
      audit(app.db, 'sender', sender.id, 'notify_resolved', { alert_id: result.id, dedup_key: dedupKey })
      touchSender(app.db, sender.id, now)
      return { ok: true, resolved: true, alert_id: result.id }
    }

    // Schema's else-branch requires title/severity outside a resolve; defensive narrowing only.
    const { title, severity } = req.body
    if (!title || !severity) return reply.code(400).send({ error: 'title and severity required' })

    const targets = req.body.devices ?? (JSON.parse(sender.default_devices) as string[])
    if (targets.length === 0) return reply.code(400).send({ error: 'no target devices' })
    const unknown = targets.filter((id) => !deviceExists(app.db, id))
    if (unknown.length > 0) return reply.code(400).send({ error: `unknown devices: ${unknown.join(', ')}` })
    if (req.body.options) {
      const ids = req.body.options.map((o) => o.id)
      if (new Set(ids).size !== ids.length) {
        return reply.code(400).send({ error: 'option ids must be unique' })
      }
    }

    const { alert, updated } = ingestNotify(app.db, {
      senderId: sender.id, title, body: req.body.body,
      severity, sound: req.body.sound, ttl_s: req.body.ttl_s,
      dedup_key: req.body.dedup_key, targetDevices: targets, options: req.body.options,
    }, now)
    touchSender(app.db, sender.id, now)

    const alertTargets = JSON.parse(alert.target_devices) as string[]
    const wire = getWireAlert(app.db, alert.id)
    if (wire) app.registry.sendMany(alertTargets, { type: 'ALERT_ADD', alert: wire })
    pushTabStatus(app.db, app.registry)

    audit(app.db, 'sender', sender.id, 'notify', {
      alert_id: alert.id, severity: alert.severity, updated, targets: alertTargets,
    })
    return { id: alert.id }
  })

  // The read half of ask/answer for LOCAL senders. Relay senders get the answer pushed to
  // the socket they asked on; a LAN sender got `{id}` from POST /api/notify and then silence —
  // this is where that id becomes an answer. Same Bearer credential that asked; an alert
  // belonging to another sender 404s identically to one that never existed, so a token cannot
  // probe which alert ids are real. Deliberately not audited: this is a poll target, and one
  // audit row per poll would bury the events the log exists for.
  app.get<{ Params: { id: string } }>('/api/alerts/:id/answer', async (req, reply) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const sender = token ? findSenderByToken(app.db, token) : undefined
    if (!sender) {
      audit(app.db, 'system', null, 'auth_rejected', { route: '/api/alerts/:id/answer' })
      return reply.code(401).send({ error: 'invalid token' })
    }
    const view = alertAnswerForSender(app.db, req.params.id, sender.id)
    if (!view) return reply.code(404).send({ error: 'unknown alert' })
    return view
  })
}
