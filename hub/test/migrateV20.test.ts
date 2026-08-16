import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db/index.js'
import { createSecretBox } from '../src/secrets/box.js'
import { migrate, LATEST_VERSION } from '../src/db/migrate.js'

/**
 * Dropping a table is not erasing it.
 *
 * v20 drops `connectors` because it held every migrated source's URL in plaintext beside the
 * encrypted copy. SQLite's DROP frees those pages and leaves their bytes in the file until
 * something happens to reuse them — so the migration alone would have moved the secret from "in a
 * table" to "in free space", which is not an improvement anybody should be told about in a release
 * note. `openDb` VACUUMs once on the way past v20; this is what proves it.
 */
describe('v20 upgrade erases the plaintext it drops', () => {
  it('leaves no readable copy of a migrated URL anywhere in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbz-vac-'))
    const path = join(dir, 'hub.db')
    const box = createSecretBox(new Uint8Array(32).fill(5))
    const SECRET = 'https://plaintext.example.invalid/private-feed.xml'

    // A v18 database with a connector whose URL is ordinary config, exactly as v18 stored it.
    const legacy = new Database(path)
    migrate(legacy as any, { secretBox: box, targetVersion: 18 })
    legacy.prepare(
      'INSERT INTO feeds (id,name,mode,cap,stale_after_s,alert_on_stale,payload,pushed_at,pushed_by,image_rev,created_at)' +
      " VALUES ('feed_x','News','stream',50,NULL,0,NULL,NULL,NULL,0,1)",
    ).run()
    legacy.prepare(
      'INSERT INTO connectors (id,type,name,config,feed_id,interval_s,enabled,last_run_at,last_status,created_at)' +
      " VALUES ('con_x','rss','News',?,'feed_x',900,1,NULL,NULL,1)",
    ).run(JSON.stringify({ url: SECRET, max_items: 20 }))
    legacy.close()

    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(true)

    const db = openDb(path, { secretBox: box })
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    db.close()

    // The credential survives, encrypted; the plaintext does not survive at all.
    const reopened = new Database(path)
    const stored = reopened.prepare('SELECT ciphertext FROM source_secrets').get() as { ciphertext: string }
    expect(box.open(stored.ciphertext)).toBe(SECRET)
    reopened.close()
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
