import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { closeDatabaseCleanly, installShutdownHandlers } from '../src/shutdown.js'
import type { DB } from '../src/db/index.js'

/**
 * Graceful shutdown, and why it is not a nicety.
 *
 * The hub had NO signal handler at all: `docker compose up -d` / `docker stop` sends SIGTERM, node
 * took the default action and exited, and the SQLite connection was never closed — so no checkpoint
 * ran and whatever sat in the WAL rode on the WAL file alone.
 *
 * That is survivable on its own (SQLite replays a WAL on next open). It stopped being survivable in
 * combination with the trigger of running `sqlite3` against the live database FROM THE macOS HOST
 * while the container has it open. File locks do not cross Docker
 * Desktop's virtiofs boundary, so the host process believes it is the only connection, and on exit
 * it checkpoints and UNLINKS `hub.db-wal`/`hub.db-shm`. The running hub then holds deleted inodes
 * (confirmed: `/data/hub.db-wal (deleted)` in its fd table) and every subsequent write goes
 * somewhere no other reader can see. Kill it without a clean close and those writes are freed with
 * the inode — which is how a screen assignment was lost.
 *
 * This file pins the half that is ours to fix. The other half is operational and belongs in
 * `scripts/hub-sql.sh` plus the runbook: never point host `sqlite3` at a live database.
 */
let dir: string
let db: DB

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-shutdown-'))
  db = openDb(join(dir, 'hub.db'))
})

afterEach(() => {
  try { db.close() } catch { /* already closed by the test — that is the point of several of them */ }
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('closeDatabaseCleanly', () => {
  it('folds the WAL back into the main file, leaving no -wal behind', () => {
    db.prepare('CREATE TABLE t(v TEXT)').run()
    db.prepare("INSERT INTO t VALUES('durable')").run()
    expect(existsSync(join(dir, 'hub.db-wal'))).toBe(true)

    closeDatabaseCleanly(db)

    expect(existsSync(join(dir, 'hub.db-wal'))).toBe(false)
    // Re-open and confirm the row is in the main file, not merely recoverable from a journal.
    const reopened = openDb(join(dir, 'hub.db'))
    expect(reopened.prepare('SELECT v FROM t').get()).toEqual({ v: 'durable' })
    reopened.close()
  })

  it('still closes when the checkpoint itself fails', () => {
    // The orphaned-WAL case: the checkpoint can fail precisely when we most need the close to
    // happen anyway. A throw here would take the process down before `close()` ran.
    const broken = {
      pragma: vi.fn(() => { throw new Error('database is locked') }),
      close: vi.fn(),
      open: true,
    } as unknown as DB
    expect(() => closeDatabaseCleanly(broken)).not.toThrow()
    expect((broken as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1)
  })

  it('is safe to call twice — a second signal must not throw', () => {
    closeDatabaseCleanly(db)
    expect(() => closeDatabaseCleanly(db)).not.toThrow()
  })
})

describe('installShutdownHandlers', () => {
  const handlersFor = (signal: string) =>
    process.listeners(signal as NodeJS.Signals).filter((l) => (l as { __hubShutdown?: boolean }).__hubShutdown)

  afterEach(() => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      for (const l of handlersFor(signal)) process.off(signal as NodeJS.Signals, l as () => void)
    }
  })

  it('registers for SIGTERM and SIGINT — the two docker actually sends', () => {
    installShutdownHandlers(db, { onExit: () => {} })
    expect(handlersFor('SIGTERM')).toHaveLength(1)
    expect(handlersFor('SIGINT')).toHaveLength(1)
  })

  it('closes the database and exits 0 when SIGTERM arrives', () => {
    const onExit = vi.fn()
    db.prepare('CREATE TABLE t(v TEXT)').run()
    db.prepare("INSERT INTO t VALUES('durable')").run()

    installShutdownHandlers(db, { onExit })
    process.emit('SIGTERM')

    expect(onExit).toHaveBeenCalledWith(0)
    expect(db.open).toBe(false)
    expect(existsSync(join(dir, 'hub.db-wal'))).toBe(false)
  })

  it('a second signal does not close twice or exit twice', () => {
    const onExit = vi.fn()
    installShutdownHandlers(db, { onExit })
    process.emit('SIGTERM')
    process.emit('SIGTERM')
    process.emit('SIGINT')
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})
