import type { DB } from './index.js'
import { newId } from '../ids.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import { deriveKey } from '../relay/envelope.js'

/**
 * Deliberately excludes `relay_key`. Every query below that produces a `SenderRow` names its
 * columns explicitly, so the derived key never rides out through `listSenders()` into the admin
 * API response. Only `listRelaySenders` reads it, and only trial decryption calls that.
 */
export interface SenderRow {
  id: string
  name: string
  default_devices: string
  created_at: number
  last_used_at: number | null
}

/** A sender that can take part in relay ingest when it has a stored relay key. */
export interface RelaySenderRow {
  id: string
  name: string
  default_devices: string
  relay_key: Buffer
}

export function createSender(db: DB, name: string, defaultDevices: string[]): { sender: SenderRow; token: string } {
  const token = generateToken('sender')
  const sender: SenderRow = {
    id: newId('snd'), name, default_devices: JSON.stringify(defaultDevices),
    created_at: Date.now(), last_used_at: null,
  }
  // The relay key is stored, the token is not: the hub must be able to decrypt
  // relayed envelopes, and it cannot derive the key from `token_hash`. Storing the derived key
  // rather than the token means a database reader can forge relayed traffic for this sender but
  // still cannot use `Authorization: Bearer` against /api/notify — the route hashes the token,
  // and the hash is not recoverable from the key.
  db.prepare('INSERT INTO senders (id, name, token_hash, default_devices, created_at, relay_key) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sender.id, sender.name, hashToken(token), sender.default_devices, sender.created_at, deriveKey(token))
  return { sender, token }
}

export function findSenderByToken(db: DB, token: string): SenderRow | undefined {
  return db.prepare(
    'SELECT id, name, default_devices, created_at, last_used_at FROM senders WHERE token_hash = ?',
  ).get(hashToken(token)) as SenderRow | undefined
}

export function listSenders(db: DB): SenderRow[] {
  return db.prepare('SELECT id, name, default_devices, created_at, last_used_at FROM senders ORDER BY created_at').all() as SenderRow[]
}

/**
 * Trial-decryption candidates, oldest first. Senders without a relay key have a NULL
 * `relay_key` and are filtered out here rather than at the call site — there is nothing to try
 * for them, and a NULL reaching the cipher would be a crash, not a skip.
 */
export function listRelaySenders(db: DB): RelaySenderRow[] {
  return db.prepare(
    'SELECT id, name, default_devices, relay_key FROM senders WHERE relay_key IS NOT NULL ORDER BY created_at',
  ).all() as RelaySenderRow[]
}

/**
 * The relay key of the sender that raised `alertId`, for sealing an outcome (answer/timeout)
 * back to it. Null when the alert is local-only, the sender has been deleted, or the sender
 * has no relay key.
 */
export function relayKeyForAlert(db: DB, alertId: string): Buffer | null {
  const row = db.prepare(
    'SELECT s.relay_key AS relay_key FROM alerts a JOIN senders s ON s.id = a.sender_id WHERE a.id = ?',
  ).get(alertId) as { relay_key: Buffer | null } | undefined
  return row?.relay_key ?? null
}

export interface DeletedSender {
  deleted: boolean
  /** Alerts that were live on a device when the sender went, so the caller can retract them. */
  retracted: { id: string; target_devices: string[] }[]
}

/**
 * Deleting a sender deletes what it sent.
 *
 * `alerts.sender_id` is `NOT NULL REFERENCES senders(id)`, so sender deletion must account for
 * the alert rows attached to the credential. Cascading removes that object graph instead of
 * surfacing a foreign-key error.
 *
 * Cascading rather than refusing, because a sender is not a thing you retire, it is a credential
 * you revoke — and leaving its alerts behind would leave rows attributed to a sender the admin can
 * no longer see or reason about. The audit log records that the deletion happened and is not part
 * of this graph, so the trail survives the data.
 *
 * Live alerts are returned rather than retracted here: the database layer stays free of the
 * device registry, and the route pushes ALERT_REMOVE for them.
 */
export function deleteSender(db: DB, id: string): DeletedSender {
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM senders WHERE id = ?').get(id)
    if (!exists) return { deleted: false, retracted: [] }

    const live = db.prepare(
      "SELECT id, target_devices FROM alerts WHERE sender_id = ? AND status = 'active'",
    ).all(id) as { id: string; target_devices: string }[]

    db.prepare('DELETE FROM deliveries WHERE alert_id IN (SELECT id FROM alerts WHERE sender_id = ?)').run(id)
    db.prepare('DELETE FROM alerts WHERE sender_id = ?').run(id)
    db.prepare('DELETE FROM senders WHERE id = ?').run(id)

    return {
      deleted: true,
      retracted: live.map((row) => ({
        id: row.id,
        // Same guarded parse the rest of this codebase uses on stored JSON: a corrupt column must
        // not take a delete down, it just means nobody gets told about that one.
        target_devices: parseDevices(row.target_devices),
      })),
    }
  })()
}

function parseDevices(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function touchSender(db: DB, id: string, now: number): void {
  db.prepare('UPDATE senders SET last_used_at = ? WHERE id = ?').run(now, id)
}
