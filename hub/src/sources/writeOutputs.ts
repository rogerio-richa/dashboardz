import { createHash } from 'node:crypto'
import { CONTRACTS, validateContractOutput, type ContractId, type SourceResult } from '../data/contracts.js'
import type { AdminActor } from '../db/audit.js'
import type { DB } from '../db/index.js'
import {
  bumpImageRev, createFeed, getFeed, listFeeds, pushStreamRow, pushValue, recentRows, touchFeed,
} from '../db/feeds.js'
import { createOutput, listOutputs, updateOutput, type SourceOutputRow, type SourceRow } from '../db/sources.js'
import type { ProducedOutput, ProviderDefinition } from './provider.js'

export interface CheckedOutput extends ProducedOutput {
  capabilities: string[]
  content_hash: string
}

export class InvalidSourceOutputError extends Error {
  constructor() {
    super('The provider returned an invalid output set')
    this.name = 'InvalidSourceOutputError'
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalValue(record[key])
    return sorted
  }
  return value
}

export function sourceResultHash(result: SourceResult): string {
  const hashed = result.mode === 'value'
    ? result.payload
    : result.mode === 'stream' ? result.rows : { image_rev: result.image_rev }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalValue(hashed))).digest('hex')}`
}

/** Checks the provider's complete output set without touching SQLite. */
export function checkProducedOutputs(
  provider: ProviderDefinition,
  produced: unknown,
): CheckedOutput[] {
  if (!Array.isArray(produced)) throw new InvalidSourceOutputError()
  const byContract = new Map<ContractId, ProducedOutput>()
  for (const candidate of produced) {
    if (candidate === null || typeof candidate !== 'object') throw new InvalidSourceOutputError()
    const value = candidate as Partial<ProducedOutput>
    if (typeof value.contract_id !== 'string' || byContract.has(value.contract_id as ContractId)) {
      throw new InvalidSourceOutputError()
    }
    byContract.set(value.contract_id as ContractId, value as ProducedOutput)
  }

  const declared = provider.potential_outputs.map((entry) => entry.contract_id)
  if (byContract.size !== declared.length || declared.some((contractId) => !byContract.has(contractId))) {
    throw new InvalidSourceOutputError()
  }

  return declared.map((contractId) => {
    const value = byContract.get(contractId)!
    const checked = validateContractOutput(contractId, value.result)
    if (!checked.ok) throw new InvalidSourceOutputError()
    return {
      contract_id: contractId,
      result: value.result,
      capabilities: checked.capabilities,
      content_hash: sourceResultHash(value.result),
    }
  })
}

const CONTRACT_LABELS: Readonly<Record<ContractId, string>> = {
  'dashboardz.weather.current/v1': 'Current weather',
  'dashboardz.weather.daily-forecast/v1': 'Daily forecast',
  'dashboardz.news.items/v1': 'News',
  'dashboardz.calendar.events/v1': 'Calendar',
  'dashboardz.legacy.value/v1': 'Value',
  'dashboardz.legacy.stream/v1': 'Stream',
  'dashboardz.legacy.image/v1': 'Image',
}

function uniqueFeedName(db: DB, base: string): string {
  const taken = new Set(listFeeds(db).map((feed) => feed.name))
  const clipped = base.slice(0, 64)
  if (!taken.has(clipped)) return clipped
  for (let index = 2; index < 1_000; index++) {
    const suffix = ` ${index}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('Could not allocate an output feed name')
}

function ensureOutput(
  db: DB, source: SourceRow, checked: CheckedOutput, now: number, actor: AdminActor,
): SourceOutputRow {
  const existing = listOutputs(db, source.id).find((output) => output.contract_id === checked.contract_id)
  if (existing) return existing
  const contract = CONTRACTS[checked.contract_id]
  const feed = createFeed(db, {
    name: uniqueFeedName(db, `${source.name} — ${CONTRACT_LABELS[checked.contract_id]}`),
    mode: contract.mode,
    cap: 'collection_limit' in contract ? contract.collection_limit : 50,
    stale_after_s: source.interval_s * 3,
    alert_on_stale: true,
    allowed_senders: [],
  }, now, actor)
  return createOutput(db, {
    source_id: source.id,
    contract_id: checked.contract_id,
    feed_id: feed.id,
  }, now)
}

function applyStream(db: DB, output: SourceOutputRow, result: Extract<SourceResult, { mode: 'stream' }>, sourceId: string, now: number): boolean {
  const feed = getFeed(db, output.feed_id)
  if (!feed || feed.mode !== 'stream') throw new Error('Source output feed is missing or has the wrong mode')
  const seen = new Set(
    recentRows(db, feed.id, feed.cap).map((row) => {
      try { return (JSON.parse(row.payload) as Record<string, unknown>)[result.dedupe_by] } catch { return undefined }
    }).filter((value) => value !== undefined && value !== null),
  )
  let appended = 0
  for (const row of result.rows) {
    const key = row[result.dedupe_by]
    if (key === undefined || key === null || key === '' || seen.has(key)) continue
    seen.add(key)
    pushStreamRow(db, feed.id, row, sourceId, now)
    appended++
  }
  if (appended === 0) touchFeed(db, feed.id, sourceId, now)
  return appended > 0
}

function applyOutput(db: DB, output: SourceOutputRow, checked: CheckedOutput, sourceId: string, now: number): boolean {
  const feed = getFeed(db, output.feed_id)
  if (!feed || feed.mode !== checked.result.mode) throw new Error('Source output feed is missing or has the wrong mode')
  if (checked.result.mode === 'value') {
    const changed = output.content_hash !== checked.content_hash
    pushValue(db, feed.id, checked.result.payload, sourceId, now)
    return changed
  }
  if (checked.result.mode === 'stream') return applyStream(db, output, checked.result, sourceId, now)
  const changed = output.content_hash !== checked.content_hash
  if (changed) bumpImageRev(db, feed.id, sourceId, now)
  else touchFeed(db, feed.id, sourceId, now)
  return changed
}

/** Transaction-composable writer. The caller owns the source-health update and commit boundary. */
export function writeOutputs(
  db: DB, source: SourceRow, checkedOutputs: readonly CheckedOutput[], now: number,
  actor: AdminActor = { type: 'admin', id: null },
): string[] {
  const changedFeedIds: string[] = []
  for (const checked of checkedOutputs) {
    const output = ensureOutput(db, source, checked, now, actor)
    if (applyOutput(db, output, checked, source.id, now)) changedFeedIds.push(output.feed_id)
    updateOutput(db, output.id, {
      capabilities: checked.capabilities,
      content_hash: checked.content_hash,
      last_valid_at: now,
    })
  }
  return changedFeedIds
}
