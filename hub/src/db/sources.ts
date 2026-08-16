import { CONTRACTS, type ContractId } from '../data/contracts.js'
import { newId } from '../ids.js'
import { audit, type AdminActor } from './audit.js'
import type { DB } from './index.js'
import { deleteFeedForSource } from './feeds.js'
import { screensReferencingFeed } from './screens.js'

export interface SourceRow {
  id: string
  provider_id: string
  package_id: string
  package_version: string
  name: string
  config: Record<string, unknown>
  strategy: string
  interval_s: number
  enabled: number
  state: string
  next_run_at: number | null
  failure_count: number
  last_run_at: number | null
  last_success_at: number | null
  last_status: string | null
  legacy_connector_id: string | null
  last_used_at: number | null
  rev: number
  created_at: number
  updated_at: number
}

export interface SourceSecretRow {
  id: string
  source_id: string
  name: string
  /** Opaque encrypted storage; decryption belongs exclusively to the source service. */
  ciphertext: string
  created_at: number
  updated_at: number
}

export interface SourceOutputRow {
  id: string
  source_id: string | null
  contract_id: ContractId
  feed_id: string
  capabilities: string[]
  content_hash: string | null
  last_valid_at: number | null
  created_at: number
}

export type DeleteSourceResult = { deleted: boolean; screenNames: string[] }

export interface SourceRunOutcome {
  status: string
  /** Built-ins use states such as authentication_failed, rate_limited, and invalid_output. */
  state?: string
  /** A provider-directed retry time; absent means the regular source interval. */
  next_run_at?: number | null
}

interface StoredSource extends Omit<SourceRow, 'config'> { config: string }
interface StoredSourceOutput extends Omit<SourceOutputRow, 'capabilities'> { capabilities: string }

const SOURCE_COLS = `id, provider_id, package_id, package_version, name, config, strategy, interval_s,
  enabled, state, next_run_at, failure_count, last_run_at, last_success_at, last_status,
  legacy_connector_id, last_used_at, rev, created_at, updated_at`
const OUTPUT_COLS = 'id, source_id, contract_id, feed_id, capabilities, content_hash, last_valid_at, created_at'
const SECRET_COLS = 'id, source_id, name, ciphertext, created_at, updated_at'

function warnMalformed(column: string): void {
  // Intentionally exclude persisted content from diagnostics: config can be operator data and a
  // repository warning must never become an accidental secret/logging boundary.
  console.warn(`Malformed ${column} in source repository; using safe fallback`)
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* guarded below */ }
  warnMalformed('source config')
  return {}
}

function parseCapabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed
  } catch { /* guarded below */ }
  warnMalformed('source output capabilities')
  return []
}

function hydrateSource(row: StoredSource): SourceRow {
  return { ...row, config: parseConfig(row.config) }
}

function hydrateOutput(row: StoredSourceOutput): SourceOutputRow {
  return { ...row, contract_id: row.contract_id as ContractId, capabilities: parseCapabilities(row.capabilities) }
}

export function createSource(
  db: DB,
  input: {
    provider_id: string
    package_id: string
    package_version: string
    name: string
    config: Record<string, unknown>
    strategy?: string
    interval_s: number
    enabled?: boolean
  },
  now: number,
  actor: AdminActor = { type: 'admin', id: null },
): SourceRow {
  const enabled = input.enabled === false ? 0 : 1
  const row: SourceRow = {
    id: newId('src'), provider_id: input.provider_id, package_id: input.package_id,
    package_version: input.package_version, name: input.name, config: input.config,
    strategy: input.strategy ?? 'scheduled', interval_s: input.interval_s, enabled,
    state: enabled ? 'healthy' : 'paused', next_run_at: enabled ? now : null, failure_count: 0,
    last_run_at: null, last_success_at: null, last_status: null, legacy_connector_id: null,
    last_used_at: null, rev: 1, created_at: now, updated_at: now,
  }
  db.prepare(`INSERT INTO source_instances (${SOURCE_COLS}) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    row.id, row.provider_id, row.package_id, row.package_version, row.name, JSON.stringify(row.config),
    row.strategy, row.interval_s, row.enabled, row.state, row.next_run_at, row.failure_count,
    row.last_run_at, row.last_success_at, row.last_status, row.legacy_connector_id, row.last_used_at,
    row.rev, row.created_at, row.updated_at,
  )
  audit(db, actor.type, actor.id, 'source_created', { source_id: row.id, provider_id: row.provider_id })
  return row
}

export function listSources(db: DB): SourceRow[] {
  return (db.prepare(`SELECT ${SOURCE_COLS} FROM source_instances ORDER BY created_at, id`).all() as StoredSource[])
    .map(hydrateSource)
}

export function getSource(db: DB, id: string): SourceRow | undefined {
  const row = db.prepare(`SELECT ${SOURCE_COLS} FROM source_instances WHERE id = ?`).get(id) as StoredSource | undefined
  return row ? hydrateSource(row) : undefined
}

/** The scheduler sees only enabled rows that have an explicit, elapsed next-run timestamp. */
export function dueSources(db: DB, now: number): SourceRow[] {
  return (db.prepare(`SELECT ${SOURCE_COLS} FROM source_instances
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at, created_at, id`).all(now) as StoredSource[]).map(hydrateSource)
}

export function updateSource(
  db: DB,
  id: string,
  patch: {
    provider_id?: string
    package_id?: string
    package_version?: string
    name?: string
    config?: Record<string, unknown>
    strategy?: string
    interval_s?: number
    enabled?: boolean
    state?: string
    next_run_at?: number | null
    last_used_at?: number | null
  },
  now: number,
  actor: AdminActor = { type: 'admin', id: null },
): SourceRow | undefined {
  const existing = getSource(db, id)
  if (!existing) return undefined
  const enabled = patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0)
  const resuming = existing.enabled === 0 && enabled === 1
  const state = enabled === 0
    ? 'paused'
    : patch.state ?? (resuming ? (existing.last_status === null || existing.last_status === 'ok' ? 'healthy' : 'degraded') : existing.state)
  const nextRunAt = enabled === 0
    ? null
    : patch.next_run_at !== undefined ? patch.next_run_at : (resuming ? now : existing.next_run_at)
  db.prepare(`UPDATE source_instances SET provider_id = ?, package_id = ?, package_version = ?, name = ?,
    config = ?, strategy = ?, interval_s = ?, enabled = ?, state = ?, next_run_at = ?, last_used_at = ?,
    rev = rev + 1, updated_at = ? WHERE id = ?`).run(
    patch.provider_id ?? existing.provider_id, patch.package_id ?? existing.package_id,
    patch.package_version ?? existing.package_version, patch.name ?? existing.name,
    JSON.stringify(patch.config ?? existing.config), patch.strategy ?? existing.strategy,
    patch.interval_s ?? existing.interval_s, enabled, state, nextRunAt,
    patch.last_used_at !== undefined ? patch.last_used_at : existing.last_used_at, now, id,
  )
  audit(db, actor.type, actor.id, 'source_updated', {
    source_id: id,
    provider_id: patch.provider_id ?? existing.provider_id,
    state,
  })
  return getSource(db, id)
}

/** A run changes scheduler state, never source revision/configuration. */
export function recordRun(
  db: DB,
  id: string,
  now: number,
  outcome: string | SourceRunOutcome,
): SourceRow | undefined {
  const existing = getSource(db, id)
  if (!existing) return undefined
  const details: SourceRunOutcome = typeof outcome === 'string' ? { status: outcome } : outcome
  const requestedState = details.state ?? (details.status === 'ok' ? 'healthy' : 'degraded')
  const success = requestedState === 'healthy'
  const state = existing.enabled === 0 ? 'paused' : requestedState
  const nextRunAt = existing.enabled === 0
    ? null
    : details.next_run_at !== undefined ? details.next_run_at : now + existing.interval_s * 1000
  db.prepare(`UPDATE source_instances SET state = ?, failure_count = ?, last_run_at = ?, last_success_at = ?,
    last_status = ?, next_run_at = ? WHERE id = ?`).run(
    state, success ? 0 : existing.failure_count + 1, now,
    success ? now : existing.last_success_at, details.status, nextRunAt, id,
  )
  if (!success) audit(db, 'system', id, 'source_failed', { source_id: id, status: details.status, state: requestedState })
  return getSource(db, id)
}

export function putSourceSecret(db: DB, sourceId: string, name: string, ciphertext: string, now: number): SourceSecretRow {
  const existing = db.prepare(`SELECT ${SECRET_COLS} FROM source_secrets WHERE source_id = ? AND name = ?`)
    .get(sourceId, name) as SourceSecretRow | undefined
  if (existing) {
    db.prepare('UPDATE source_secrets SET ciphertext = ?, updated_at = ? WHERE id = ?').run(ciphertext, now, existing.id)
    return { ...existing, ciphertext, updated_at: now }
  }
  const row: SourceSecretRow = {
    id: newId('sec'), source_id: sourceId, name, ciphertext, created_at: now, updated_at: now,
  }
  db.prepare(`INSERT INTO source_secrets (${SECRET_COLS}) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.source_id, row.name, row.ciphertext, row.created_at, row.updated_at)
  return row
}

export function listSourceSecrets(db: DB, sourceId: string): SourceSecretRow[] {
  return db.prepare(`SELECT ${SECRET_COLS} FROM source_secrets WHERE source_id = ? ORDER BY name, id`)
    .all(sourceId) as SourceSecretRow[]
}

export function deleteSourceSecret(db: DB, sourceId: string, name: string): boolean {
  return db.prepare('DELETE FROM source_secrets WHERE source_id = ? AND name = ?').run(sourceId, name).changes > 0
}

export function createOutput(
  db: DB,
  input: {
    source_id: string | null
    contract_id: ContractId
    feed_id: string
    capabilities?: string[]
    content_hash?: string | null
    last_valid_at?: number | null
  },
  now: number,
): SourceOutputRow {
  if (input.source_id === null && !input.contract_id.startsWith('dashboardz.legacy.')) {
    throw new Error('nullable source outputs must use a legacy contract')
  }
  const feed = db.prepare('SELECT mode FROM feeds WHERE id = ?').get(input.feed_id) as { mode: string } | undefined
  if (!feed) throw new Error('output feed is missing')
  const expectedMode = CONTRACTS[input.contract_id].mode
  if (feed.mode !== expectedMode) {
    throw new Error(`contract mode ${expectedMode} does not match feed mode ${feed.mode}`)
  }
  const row: SourceOutputRow = {
    id: newId('out'), source_id: input.source_id, contract_id: input.contract_id, feed_id: input.feed_id,
    capabilities: input.capabilities ?? [], content_hash: input.content_hash ?? null,
    last_valid_at: input.last_valid_at ?? null, created_at: now,
  }
  db.prepare(`INSERT INTO source_outputs (${OUTPUT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.source_id, row.contract_id, row.feed_id, JSON.stringify(row.capabilities), row.content_hash, row.last_valid_at, row.created_at)
  return row
}

export function listOutputs(db: DB, sourceId: string | null): SourceOutputRow[] {
  const query = sourceId === null
    ? `SELECT ${OUTPUT_COLS} FROM source_outputs WHERE source_id IS NULL ORDER BY created_at, id`
    : `SELECT ${OUTPUT_COLS} FROM source_outputs WHERE source_id = ? ORDER BY created_at, id`
  const rows = (sourceId === null ? db.prepare(query).all() : db.prepare(query).all(sourceId)) as StoredSourceOutput[]
  return rows.map(hydrateOutput)
}

export function updateOutput(
  db: DB,
  id: string,
  patch: { capabilities?: string[]; content_hash?: string | null; last_valid_at?: number | null },
): SourceOutputRow | undefined {
  const stored = db.prepare(`SELECT ${OUTPUT_COLS} FROM source_outputs WHERE id = ?`).get(id) as StoredSourceOutput | undefined
  if (!stored) return undefined
  const existing = hydrateOutput(stored)
  db.prepare('UPDATE source_outputs SET capabilities = ?, content_hash = ?, last_valid_at = ? WHERE id = ?').run(
    JSON.stringify(patch.capabilities ?? existing.capabilities),
    patch.content_hash !== undefined ? patch.content_hash : existing.content_hash,
    patch.last_valid_at !== undefined ? patch.last_valid_at : existing.last_valid_at, id,
  )
  const updated = db.prepare(`SELECT ${OUTPUT_COLS} FROM source_outputs WHERE id = ?`).get(id) as StoredSourceOutput
  return hydrateOutput(updated)
}

/**
 * Deleting a source is deliberately the only route that can remove provider-owned feeds. The
 * screen-reference check happens before any mutation, then the source cascade and feed cleanup
 * happen inside one outer transaction.
 */
export function deleteSource(
  db: DB, id: string, actor: AdminActor = { type: 'admin', id: null },
): DeleteSourceResult {
  return db.transaction(() => {
    const source = getSource(db, id)
    if (!source) return { deleted: false, screenNames: [] }
    const outputFeeds = db.prepare('SELECT feed_id FROM source_outputs WHERE source_id = ? ORDER BY created_at, id')
      .all(id) as { feed_id: string }[]
    const screenNames = [...new Set(outputFeeds.flatMap((output) => screensReferencingFeed(db, output.feed_id).map((screen) => screen.name)))]
    if (screenNames.length > 0) return { deleted: false, screenNames }
    db.prepare('DELETE FROM source_instances WHERE id = ?').run(id)
    // The cascade inherits the deleting actor: a source delete taking its output feeds with it is
    // one write from the caller's point of view, so the feed_deleted rows it produces attribute to
    // whoever deleted the source, not to a separate anonymous admin.
    for (const output of outputFeeds) deleteFeedForSource(db, output.feed_id, actor)
    audit(db, actor.type, actor.id, 'source_deleted', {
      source_id: id,
      provider_id: source.provider_id,
      state: source.state,
    })
    return { deleted: true, screenNames: [] }
  })()
}
