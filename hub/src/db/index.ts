import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { migrate } from './migrate.js'
import type { SecretBox } from '../secrets/box.js'

export type DB = Database.Database

const unavailableSecretBox: SecretBox = {
  seal() { throw new Error('Secret box is unavailable for protected database') },
  open() { throw new Error('Secret box is unavailable for protected database') },
}

export function databaseHasProtectedSecrets(path: string): boolean {
  if (!existsSync(path)) return false
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const version = db.pragma('user_version', { simple: true }) as number
    if (version < 19) return false
    const row = db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM source_secrets
        UNION ALL
        SELECT 1 FROM source_draft_secrets
      ) AS present
    `).get() as { present: number }
    return row.present === 1
  } finally {
    db.close()
  }
}

/** Opens every stored ciphertext before runtime work starts; plaintext is discarded immediately. */
export function verifySecretStore(db: DB, secretBox: SecretBox): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 19) return
  const rows = db.prepare(`
    SELECT ciphertext FROM source_secrets
    UNION ALL
    SELECT ciphertext FROM source_draft_secrets
  `).all() as { ciphertext: string }[]
  for (const row of rows) secretBox.open(row.ciphertext)
}

/**
 * The version at which the retired connector table — and the plaintext credentials it carried —
 * is dropped. Crossing it has to be followed by a VACUUM, for the reason below.
 */
const CONNECTORS_DROPPED_AT = 20

export function openDb(path: string, opts: { secretBox?: SecretBox } = {}): DB {
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    /**
     * Deleted rows leave their bytes behind. SQLite frees the pages a dropped table occupied and
     * reuses them later; until something overwrites them the old content is still sitting in the
     * file, readable by anyone with a hex editor. For an ordinary table that is a curiosity — for
     * one that held every migrated source's URL in plaintext it is the whole point of dropping it,
     * so `secure_delete` makes future frees zero their pages and the VACUUM below rewrites the file
     * once to clear what was freed on the way past v20.
     *
     * VACUUM cannot run inside a transaction, so it deliberately sits outside `migrate` rather than
     * inside the v20 step.
     */
    db.pragma('secure_delete = ON')
    const before = db.pragma('user_version', { simple: true }) as number
    migrate(db, { secretBox: opts.secretBox })
    const after = db.pragma('user_version', { simple: true }) as number
    if (before < CONNECTORS_DROPPED_AT && after >= CONNECTORS_DROPPED_AT) db.exec('VACUUM')
    if (opts.secretBox === undefined) verifySecretStore(db, unavailableSecretBox)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
