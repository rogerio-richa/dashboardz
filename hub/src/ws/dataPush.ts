import type { DB } from '../db/index.js'
import type { DeviceRegistry } from './registry.js'
import type { DataMsg, WireFeed } from './protocol.js'
import { getFeed, recentRows, type FeedRow } from '../db/feeds.js'
import { referencedFeedIds, getScreen } from '../db/screens.js'
import { listDeviceTabs } from '../db/devices.js'

/** Guarded parse: bad stored payloads degrade to null, never crash a read path (house rule). */
const parse = (s: string | null): unknown => {
  if (s === null) return null
  try { return JSON.parse(s) } catch { return null }
}

export function wireFeed(db: DB, feed: FeedRow): WireFeed {
  const base = { pushed_at: feed.pushed_at, stale_after_s: feed.stale_after_s }
  if (feed.mode === 'value') return { mode: 'value', payload: parse(feed.payload), ...base }
  if (feed.mode === 'stream')
    return {
      mode: 'stream',
      rows: recentRows(db, feed.id, feed.cap).map((r) => ({ payload: parse(r.payload), pushed_at: r.pushed_at })),
      ...base,
    }
  return { mode: 'image', image_rev: feed.image_rev, ...base }
}

/** Resolves each feed id to its wire form; an id with no live feed is simply absent from the result. */
function resolveFeeds(db: DB, feedIds: string[]): Record<string, WireFeed> {
  const feeds: Record<string, WireFeed> = {}
  for (const id of feedIds) {
    const feed = getFeed(db, id)
    if (feed) feeds[id] = wireFeed(db, feed)
  }
  return feeds
}

/** Deleted-but-still-referenced feeds are OMITTED — the renderer's "feed missing" state. */
export function buildData(db: DB, feedIds: string[], now: number): DataMsg | null {
  const feeds = resolveFeeds(db, feedIds)
  return Object.keys(feeds).length > 0 ? { type: 'DATA', server_time: now, feeds } : null
}

/**
 * DATA is fire-and-forget (delivery): no rev, no ack, no timers. A missed message is
 * corrected by the next push or the reconnect snapshot, so unlike StatePusher there is
 * nothing to track here.
 */
export class DataPusher {
  constructor(private db: DB, private registry: DeviceRegistry) {}

  /**
   * Deduped union of feed ids referenced across every tab (tab state) — a device shows DATA for
   * whatever any of its tabs binds to, not just the one currently on screen. Tabs are the single
   * truth (v25 dropped the legacy `screen_id` column), so this reads only `listDeviceTabs`.
   */
  private referenceSet(deviceId: string): string[] {
    const out: string[] = []
    for (const tab of listDeviceTabs(this.db, deviceId)) {
      const screen = getScreen(this.db, tab.screen_id)
      if (!screen) continue
      try {
        for (const id of referencedFeedIds(JSON.parse(screen.grid))) if (!out.includes(id)) out.push(id)
      } catch { /* unreadable grid contributes nothing — never crash a read path */ }
    }
    return out
  }

  /**
   * Full reference-set DATA for one device; silent no-op only when the set is empty (device has
   * no data widgets) — a device is offline is likewise a no-op, but that's `registry.send`'s
   * job, not this method's. Unlike `buildData`, this ALWAYS sends once there's a non-empty
   * reference set, even when every referenced feed has been deleted and `feeds` resolves to `{}`
   * — see the `snapshot` marker on DataMsg for why (feed delete ⇒ "feed
   * missing", not silence).
   */
  snapshot(deviceId: string): void {
    const ids = this.referenceSet(deviceId)
    if (ids.length === 0) return
    const feeds = resolveFeeds(this.db, ids)
    this.registry.send(deviceId, { type: 'DATA', server_time: Date.now(), snapshot: true, feeds })
  }

  /** Single-feed DATA to every currently connected device that references this feed. */
  onFeedPush(feedId: string): void {
    const msg = buildData(this.db, [feedId], Date.now())
    if (!msg) return
    for (const [deviceId] of this.registry.all())
      if (this.referenceSet(deviceId).includes(feedId)) this.registry.send(deviceId, msg)
  }

  /** Full snapshot to every currently connected device that references this feed (feed PATCH/DELETE). */
  snapshotReferencing(feedId: string): void {
    for (const [deviceId] of this.registry.all())
      if (this.referenceSet(deviceId).includes(feedId)) this.snapshot(deviceId)
  }
}
