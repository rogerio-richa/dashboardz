import { randomBytes } from 'node:crypto'
import type { DB } from '../db/index.js'

export interface RelayIdentity { hubUid: string; hubSecret: string }

/**
 * The hub's own address on the relay. hub_uid is deliberately unguessable: the relay does no
 * sender authentication, so the uid is what stops strangers pushing at your slot (documented contract).
 */
export function getOrCreateIdentity(db: DB): RelayIdentity {
  const row = db.prepare('SELECT hub_uid, hub_secret FROM relay_identity WHERE id = 1')
    .get() as { hub_uid: string; hub_secret: string } | undefined
  if (row) return { hubUid: row.hub_uid, hubSecret: row.hub_secret }

  const identity: RelayIdentity = {
    hubUid: `hub_${randomBytes(16).toString('base64url')}`,
    hubSecret: randomBytes(32).toString('base64url'),
  }
  db.prepare('INSERT INTO relay_identity (id, hub_uid, hub_secret, created_at) VALUES (1, ?, ?, ?)')
    .run(identity.hubUid, identity.hubSecret, Date.now())
  return identity
}
