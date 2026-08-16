import type { DB } from './index.js'

/**
 * Who an authenticated admin-surface request is acting AS — a human session, an agent token, or
 * the unattended source scheduler, which flows through these same attributed helpers and must be
 * able to say truthfully that it, not an admin, made the write.
 */
export type AdminActor = { type: 'admin' | 'agent' | 'system'; id: string | null }

export function audit(
  db: DB,
  actorType: 'sender' | 'device' | 'admin' | 'system' | 'agent',
  actorId: string | null,
  event: string,
  details: object = {},
): void {
  db.prepare('INSERT INTO audit_log (ts, actor_type, actor_id, event, details) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), actorType, actorId, event, JSON.stringify(details))
}
