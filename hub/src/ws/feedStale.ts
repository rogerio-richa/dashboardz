import type { DB } from '../db/index.js'
import type { DeviceRegistry } from './registry.js'
import { staleCandidates } from '../db/feeds.js'
import { listDevices } from '../db/devices.js'
import { ingestNotify, getWireAlert } from '../db/alerts.js'
import { audit } from '../db/audit.js'

const DEFAULT_INTERVAL_MS = 60_000

/**
 * "Fails loudly, never silently" (staleness): a dead cron is only discoverable through feed
 * age, so the hub raises the alarm itself. Same warn machinery as StatePusher.raiseWarn
 * (statePush.ts), but targeting ALL devices — there is no offending device to exclude here, only
 * a feed everyone renders. Recovery is silent (fresh->stale is the event; stale->fresh is not);
 * the in-memory flag map means one warn per crossing, and dedup_key makes even a hub restart
 * (which loses the flag map) update the existing alert row rather than duplicate it.
 */
export function startFeedStaleSweep(
  db: DB,
  registry: DeviceRegistry,
  opts: { intervalMs?: number } = {},
): { stop(): void; run(now: number): void } {
  const wasStale = new Map<string, boolean>()

  const run = (now: number): void => {
    try {
      const candidates = staleCandidates(db)
      const liveIds = new Set(candidates.map((feed) => feed.id))
      // Nothing else ever removes a flag-map entry once a feed drops out of staleCandidates
      // (deleted, or alert_on_stale toggled off) — the sweep prunes on every pass so a deleted
      // feed's id doesn't linger forever.
      for (const id of wasStale.keys()) {
        if (!liveIds.has(id)) wasStale.delete(id)
      }

      for (const feed of candidates) {
        // staleCandidates' WHERE clause already guarantees pushed_at/stale_after_s are non-null
        // (verified against db/feeds.ts's actual SQL, not assumed) — but the row type is still
        // `number | null`, so this is a checked guard, not a non-null assertion.
        if (feed.pushed_at === null || feed.stale_after_s === null) continue
        const isStale = now - feed.pushed_at > feed.stale_after_s * 1000
        const wasStaleBefore = wasStale.get(feed.id) ?? false

        if (isStale && !wasStaleBefore) {
          audit(db, 'system', null, 'feed_stale', { feed_id: feed.id })
          const targets = listDevices(db).map((d) => d.id)
          if (targets.length > 0) {
            const { alert } = ingestNotify(db, {
              senderId: 'snd_hub',
              title: `Feed "${feed.name}" has gone stale`,
              severity: 'warn',
              sound: false,
              ttl_s: 3600,
              dedup_key: `feed_stale:${feed.id}`,
              targetDevices: targets,
            }, now)
            const wire = getWireAlert(db, alert.id)
            if (wire) registry.sendMany(targets, { type: 'ALERT_ADD', alert: wire })
          }
        }
        wasStale.set(feed.id, isStale)
      }
    } catch (err) {
      console.warn('feed stale sweep failed', err)
    }
  }

  const timer = setInterval(() => run(Date.now()), opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()
  return { stop: () => clearInterval(timer), run }
}
