import { capabilitiesForPayload } from './needs.js'
import { recentRows, type FeedRow } from '../db/feeds.js'
import type { DB } from '../db/index.js'
import type { SourceResult } from './contracts.js'

/**
 * What a feed — or a source's preview of one — DEMONSTRABLY produces, in the generic vocabulary.
 *
 * Both functions here end at `capabilitiesForPayload`, and that is the point: an operator gets the
 * same answer about the same data whether they are binding a source they are creating right now
 * (its draft preview) or one that has been running for a year (its stored rows). Three callers
 * depend on that agreeing — the pending-binding check, the advisory warning on save, and the
 * picker's "which feeds fit this cell" — and if they could disagree, the picker would offer a feed
 * the save then complains about.
 *
 * Neither reads the stored `capabilities` column. Those are the SEMANTIC capabilities a contract
 * validator named (`news.item.title`), and for a legacy contract there are none at all; neither
 * says whether `current.temp` is a number, which is the only question a generic widget asks.
 */

/** Enough rows to union a ragged stream's fields without walking a hundred of them on every save. */
const MAX_ROWS_SAMPLED = 20

const parsed = (json: string | null): unknown => {
  if (json === null) return undefined
  try {
    return JSON.parse(json)
  } catch {
    // A feed whose stored payload will not parse says nothing about what it produces, which is
    // exactly the inconclusive case. The renderer already copes with it; a save must not fail here.
    return undefined
  }
}

/** A live feed, read from what has already been pushed to it. Never pushed yields nothing. */
export function capabilitiesForFeed(db: DB, feed: FeedRow): string[] {
  if (feed.mode === 'value') return capabilitiesForPayload(parsed(feed.payload))
  if (feed.mode !== 'stream') return []
  const found = new Set<string>()
  for (const row of recentRows(db, feed.id, MAX_ROWS_SAMPLED)) {
    for (const capability of capabilitiesForPayload(parsed(row.payload))) found.add(capability)
  }
  return [...found]
}

/** A source draft's stored preview — real data the provider really returned, before any feed. */
export function capabilitiesForResult(result: SourceResult | { mode: 'invalid' }): string[] {
  if (result.mode === 'value') return capabilitiesForPayload(result.payload)
  if (result.mode !== 'stream') return []
  // A SourceResult's rows ARE the payloads — the `{payload, pushed_at}` wrapper is added by
  // `streamPreview` when building the wire feed, and reading `row.payload` here inferred nothing
  // at all, which reads as "inconclusive" and waved every stream binding through.
  //
  // Rows are unioned, for the reason `capabilitiesForPayload` unions an array's elements: a field
  // that only the second row carries is still a field the operator can bind.
  const found = new Set<string>()
  for (const row of result.rows.slice(0, MAX_ROWS_SAMPLED)) {
    for (const capability of capabilitiesForPayload(row)) found.add(capability)
  }
  return [...found]
}
