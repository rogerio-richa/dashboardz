import type { DB } from './db/index.js'

/**
 * Close the database so that what is committed is actually in `hub.db`.
 *
 * `docker stop` / `docker compose up -d` send SIGTERM. Node's default action is to exit
 * immediately, which left the SQLite connection open and unchecked-pointed: everything since the
 * last automatic checkpoint lived only in `hub.db-wal`. SQLite replays a WAL on the next open, so
 * in isolation that is merely untidy.
 *
 * It stops being untidy when the WAL has been unlinked out from under the process — which happens
 * whenever someone runs `sqlite3` against the live database from the macOS HOST while the container
 * holds it open. File locks do not cross Docker Desktop's virtiofs boundary, so that host process
 * sees no other connection, checkpoints on exit, and deletes `hub.db-wal`/`hub.db-shm`. The hub is
 * then writing into a deleted inode (visible as `/data/hub.db-wal (deleted)` in its fd table).
 * Exiting without a close frees that inode and every write since the deletion is gone, including
 * a device's screen assignment.
 *
 * TRUNCATE rather than PASSIVE: a passive checkpoint copies what it can and leaves the WAL file in
 * place, which is precisely the state we are trying not to exit in.
 */
export function closeDatabaseCleanly(db: DB): void {
  if (!db.open) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // A checkpoint can fail for the very reason we are shutting down (a deleted WAL, a locked
    // file). Closing is still strictly better than not closing — it flushes and releases the main
    // database handle — so the failure must not propagate and skip the close below.
  }
  try {
    db.close()
  } catch {
    // Already closed, or closing raced another handler. Nothing left to do and nothing worth
    // crashing the exit path over.
  }
}

interface ShutdownOptions {
  /** Injected so tests can observe the exit instead of taking the process down. */
  onExit?: (code: number) => void
  signals?: NodeJS.Signals[]
}

/**
 * Register SIGTERM/SIGINT handlers that close the database before exiting.
 *
 * Guarded against re-entry: a container being stopped can receive a second signal (an impatient
 * `docker stop` escalates), and closing a database twice — or exiting twice — turns an orderly
 * shutdown into a crash on the way out.
 */
export function installShutdownHandlers(db: DB, options: ShutdownOptions = {}): void {
  const onExit = options.onExit ?? ((code: number) => process.exit(code))
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])
  let shuttingDown = false

  for (const signal of signals) {
    const handler = () => {
      if (shuttingDown) return
      shuttingDown = true
      closeDatabaseCleanly(db)
      onExit(0)
    }
    // Tagged so the test suite can find and remove exactly these listeners rather than clearing
    // every handler the runner itself installed.
    ;(handler as { __hubShutdown?: boolean }).__hubShutdown = true
    process.on(signal, handler)
  }
}
