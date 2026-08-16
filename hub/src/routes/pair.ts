import type { FastifyInstance } from 'fastify'
import { redeemPairingCode } from '../db/devices.js'
import { audit } from '../db/audit.js'
import { seedStarterScreen } from '../screens/starter.js'
import { BRAND } from '../brand.js'

const pairSchema = {
  body: {
    type: 'object', additionalProperties: false, required: ['code'],
    properties: { code: { type: 'string', minLength: 6, maxLength: 6 } },
  },
} as const

export async function pairRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { code: string } }>('/api/pair', { schema: pairSchema }, async (req, reply) => {
    const res = redeemPairingCode(app.db, req.body.code.toUpperCase(), Date.now())
    if (!res) return reply.code(400).send({ error: 'invalid or expired code' })
    seedStarterScreen(app.db, res.device.id, res.device.name, Date.now())
    audit(app.db, 'device', res.device.id, 'paired', { name: res.device.name })
    return { device_id: res.device.id, device_token: res.token, hub_name: BRAND.name }
  })
}
