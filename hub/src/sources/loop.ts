import type { DB } from '../db/index.js'
import { dueSources } from '../db/sources.js'
import { runSourceOnce, type SourceRunDeps } from './run.js'

const DEFAULT_INTERVAL_MS = 60_000

export interface SourceLoopDeps extends SourceRunDeps {
  clock?: () => number
  /** Receives only a source id: thrown provider/SQLite details are deliberately not logged here. */
  onError?: (sourceId: string | undefined) => void
}

export function startSourceLoop(
  db: DB,
  deps: SourceLoopDeps,
  opts: { intervalMs?: number } = {},
): { run(now: number): Promise<void>; stop(): void } {
  let inFlight = false
  let stopped = false

  const run = async (now: number): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      let due
      try {
        due = dueSources(db, now)
      } catch {
        deps.onError?.(undefined)
        return
      }
      for (const source of due) {
        try {
          // No human or agent is behind this run — it's the unattended scheduler — so any feed it
          // creates must audit as 'system', not fall through to runSourceOnce's 'admin' default.
          await runSourceOnce(db, source.id, deps, now, { type: 'system', id: null })
        } catch {
          deps.onError?.(source.id)
        }
      }
    } finally {
      inFlight = false
    }
  }

  void run((deps.clock ?? Date.now)())
  const timer = setInterval(() => { void run((deps.clock ?? Date.now)()) }, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()

  return {
    run,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}
