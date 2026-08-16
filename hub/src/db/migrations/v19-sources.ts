import type { ContractId, SourceResult } from '../../data/contracts.js'
import { validateContractOutput } from '../../data/contracts.js'
import type { SecretBox } from '../../secrets/box.js'
import type { DB } from '../index.js'
import { SCHEMA_V19 } from '../schema.js'

const PACKAGE_ID = 'dashboardz.builtin'
const PACKAGE_VERSION = '1.0.0'

interface LegacyConnector {
  id: string
  type: string
  name: string
  config: string
  feed_id: string
  interval_s: number
  enabled: number
  last_run_at: number | null
  last_status: string | null
  created_at: number
}

interface LegacyFeed {
  id: string
  mode: 'value' | 'stream' | 'image'
  payload: string | null
  pushed_at: number | null
  image_rev: number
  created_at: number
}

interface LegacyFeedRow {
  id: number
  payload: string
}

interface ProviderMapping {
  providerId: string
  contractId: ContractId
  secretName: 'url' | null
}

const PROVIDERS: Readonly<Record<string, Omit<ProviderMapping, 'secretName'> & { secretName: 'url' | null }>> = {
  weather: { providerId: 'dashboardz.open-meteo', contractId: 'dashboardz.weather.current/v1', secretName: null },
  rss: { providerId: 'dashboardz.rss', contractId: 'dashboardz.news.items/v1', secretName: 'url' },
  ical: { providerId: 'dashboardz.ical', contractId: 'dashboardz.calendar.events/v1', secretName: 'url' },
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

function legacyContract(mode: LegacyFeed['mode']): ContractId {
  if (mode === 'stream') return 'dashboardz.legacy.stream/v1'
  if (mode === 'image') return 'dashboardz.legacy.image/v1'
  return 'dashboardz.legacy.value/v1'
}

function providerMapping(connector: LegacyConnector, feed: LegacyFeed): ProviderMapping {
  return Object.hasOwn(PROVIDERS, connector.type) ? PROVIDERS[connector.type]! : {
    providerId: `legacy.${connector.type}`,
    contractId: legacyContract(feed.mode),
    secretName: null,
  }
}

function copiedConfig(connector: LegacyConnector, mapping: ProviderMapping): {
  config: string
  secret: string | null
} {
  if (mapping.secretName === null) return { config: connector.config, secret: null }
  const parsed = asRecord(parseJson(connector.config))
  if (!parsed) return { config: '{}', secret: null }
  const secret = typeof parsed[mapping.secretName] === 'string' ? parsed[mapping.secretName] as string : null
  delete parsed[mapping.secretName]
  return { config: JSON.stringify(parsed), secret }
}

function stateOf(connector: LegacyConnector): string {
  if (connector.enabled === 0) return 'paused'
  if (connector.last_status !== null && connector.last_status !== 'ok') return 'degraded'
  return 'healthy'
}

function weatherCondition(value: unknown): { code: string; label: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { code: 'unknown', label: 'Unknown' }
  if (value === 0) return { code: 'clear', label: 'Clear' }
  if (value === 1) return { code: 'mostly_clear', label: 'Mostly clear' }
  if (value === 2) return { code: 'partly_cloudy', label: 'Partly cloudy' }
  if (value === 3) return { code: 'cloudy', label: 'Cloudy' }
  if (value === 45 || value === 48) return { code: 'fog', label: 'Fog' }
  if ([51, 53, 55, 56, 57].includes(value)) return { code: 'drizzle', label: 'Drizzle' }
  if ([61, 63, 65, 66, 67].includes(value)) return { code: 'rain', label: 'Rain' }
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { code: 'snow', label: 'Snow' }
  if ([80, 81, 82].includes(value)) return { code: 'showers', label: 'Rain showers' }
  if ([95, 96, 99].includes(value)) return { code: 'thunderstorm', label: 'Thunderstorm' }
  return { code: 'unknown', label: 'Unknown' }
}

function normalizeWeather(
  db: DB,
  connector: LegacyConnector,
  feed: LegacyFeed,
  migrationAt: number,
): SourceResult | null {
  if (feed.payload === null) return null
  const payload = asRecord(parseJson(feed.payload))
  if (!payload) return null
  const config = asRecord(parseJson(connector.config))
  const city = typeof config?.city === 'string' && config.city.trim() !== '' ? config.city.trim() : connector.name
  if (!Object.hasOwn(payload, 'location')) payload.location = { name: city, timezone: null }
  if (!Object.hasOwn(payload, 'observed_at')) {
    payload.observed_at = feed.pushed_at ?? connector.last_run_at ?? migrationAt
  }
  const current = asRecord(payload.current)
  if (current && !Object.hasOwn(current, 'condition')) current.condition = weatherCondition(current.code)
  const normalized = JSON.stringify(payload)
  db.prepare('UPDATE feeds SET payload = ? WHERE id = ?').run(normalized, feed.id)
  return { mode: 'value', payload }
}

function normalizeRss(db: DB, feed: LegacyFeed): SourceResult {
  const rows = db.prepare('SELECT id, payload FROM feed_rows WHERE feed_id = ? ORDER BY id')
    .all(feed.id) as LegacyFeedRow[]
  const normalized: Record<string, unknown>[] = []
  const update = db.prepare('UPDATE feed_rows SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const parsed = asRecord(parseJson(row.payload))
    if (!parsed) {
      normalized.push({})
      continue
    }
    if (typeof parsed.link === 'string' && parsed.link.trim() !== '') {
      if (typeof parsed.id !== 'string' || parsed.id.trim() === '') parsed.id = parsed.link
      if (typeof parsed.url !== 'string' || parsed.url.trim() === '') parsed.url = parsed.link
    }
    update.run(JSON.stringify(parsed), row.id)
    normalized.push(parsed)
  }
  return { mode: 'stream', rows: normalized, dedupe_by: 'id' }
}

function valueResult(feed: LegacyFeed): SourceResult | null {
  if (feed.payload === null) return null
  const payload = parseJson(feed.payload)
  return payload === undefined ? null : { mode: 'value', payload }
}

function streamResult(db: DB, feed: LegacyFeed): SourceResult | null {
  const rows = db.prepare('SELECT payload FROM feed_rows WHERE feed_id = ? ORDER BY id')
    .all(feed.id) as { payload: string }[]
  const parsed: unknown[] = []
  for (const row of rows) {
    const value = parseJson(row.payload)
    if (value === undefined) return null
    parsed.push(value)
  }
  return {
    mode: 'stream',
    rows: parsed as Record<string, unknown>[],
    dedupe_by: 'id',
  }
}

function resultFor(
  db: DB,
  connector: LegacyConnector | null,
  feed: LegacyFeed,
  contractId: ContractId,
  migrationAt: number,
): SourceResult | null {
  if (connector?.type === 'weather') return normalizeWeather(db, connector, feed, migrationAt)
  if (connector?.type === 'rss') return normalizeRss(db, feed)
  if (feed.mode === 'image') return { mode: 'image', image_rev: feed.image_rev }
  if (feed.mode === 'stream') return streamResult(db, feed)
  void contractId
  return valueResult(feed)
}

function validationMetadata(
  contractId: ContractId,
  result: SourceResult | null,
  pushedAt: number | null,
): { capabilities: string; lastValidAt: number | null } {
  if (result === null || pushedAt === null) return { capabilities: '[]', lastValidAt: null }
  const checked = validateContractOutput(contractId, result)
  return checked.ok
    ? { capabilities: JSON.stringify(checked.capabilities), lastValidAt: pushedAt }
    : { capabilities: '[]', lastValidAt: null }
}

/**
 * Copies v18 rows into v19 while leaving connectors, feed identities, bindings and payload wire
 * storage in place. The outer migration runner supplies the transaction; a sealing failure rolls
 * back this DDL and every normalization update together.
 */
export function migrateV19(db: DB, secretBox: SecretBox): void {
  db.exec(SCHEMA_V19)
  const migrationAt = Date.now()
  const connectors = db.prepare('SELECT * FROM connectors ORDER BY id').all() as LegacyConnector[]
  const getFeed = db.prepare('SELECT id, mode, payload, pushed_at, image_rev, created_at FROM feeds WHERE id = ?')
  const insertSource = db.prepare(`
    INSERT INTO source_instances
      (id, provider_id, package_id, package_version, name, config, strategy, interval_s, enabled,
       state, next_run_at, failure_count, last_run_at, last_success_at, last_status,
       legacy_connector_id, last_used_at, rev, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, 1, ?, ?)
  `)
  const insertSecret = db.prepare(`
    INSERT INTO source_secrets (id, source_id, name, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertOutput = db.prepare(`
    INSERT INTO source_outputs
      (id, source_id, contract_id, feed_id, capabilities, content_hash, last_valid_at, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `)

  for (const connector of connectors) {
    const feed = getFeed.get(connector.feed_id) as LegacyFeed
    const mapping = providerMapping(connector, feed)
    const copied = copiedConfig(connector, mapping)
    const lastSuccessAt = connector.last_status === 'ok' ? connector.last_run_at : null
    const nextRunAt = connector.last_run_at === null
      ? migrationAt
      : connector.last_run_at + connector.interval_s * 1000
    insertSource.run(
      connector.id, mapping.providerId, PACKAGE_ID, PACKAGE_VERSION, connector.name, copied.config,
      connector.interval_s, connector.enabled, stateOf(connector), nextRunAt, connector.last_run_at,
      lastSuccessAt, connector.last_status, connector.id, connector.created_at, migrationAt,
    )
    if (mapping.secretName !== null && copied.secret !== null) {
      let ciphertext: string
      try {
        ciphertext = secretBox.seal(copied.secret)
      } catch {
        // A SecretBox implementation is an injected boundary. Never trust its diagnostic not to
        // echo the plaintext it was given, and do not retain the unsafe error as a cause.
        throw new Error('Could not protect migrated source secret')
      }
      insertSecret.run(
        `sec_${connector.id}_${mapping.secretName}`, connector.id, mapping.secretName,
        ciphertext, connector.created_at, migrationAt,
      )
    }
    const result = resultFor(db, connector, feed, mapping.contractId, migrationAt)
    const metadata = validationMetadata(mapping.contractId, result, feed.pushed_at)
    insertOutput.run(
      `out_${feed.id}`, connector.id, mapping.contractId, feed.id,
      metadata.capabilities, metadata.lastValidAt, feed.created_at,
    )
  }

  const unclaimed = db.prepare(`
    SELECT id, mode, payload, pushed_at, image_rev, created_at
      FROM feeds
     WHERE NOT EXISTS (SELECT 1 FROM source_outputs WHERE source_outputs.feed_id = feeds.id)
     ORDER BY id
  `).all() as LegacyFeed[]
  for (const feed of unclaimed) {
    const contractId = legacyContract(feed.mode)
    const metadata = validationMetadata(contractId, resultFor(db, null, feed, contractId, migrationAt), feed.pushed_at)
    insertOutput.run(
      `out_${feed.id}`, null, contractId, feed.id,
      metadata.capabilities, metadata.lastValidAt, feed.created_at,
    )
  }
}
