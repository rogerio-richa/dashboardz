import { CONTRACTS, validateContractOutput, type ContractId, type SourceResult } from '../data/contracts.js'
import type { AdminActor } from '../db/audit.js'
import type { DB } from '../db/index.js'
import {
  createDraft, deleteDraft, expireDraft, getDraft, type SourceDraft, type SourceDraftOutputRow,
} from '../db/sourceDrafts.js'
import {
  createSource, getSource, listOutputs, putSourceSecret, recordRun, type SourceOutputRow, type SourceRow,
} from '../db/sources.js'
import type { SecretBox } from '../secrets/box.js'
import type { WireFeed } from '../ws/protocol.js'
import { WIDGET_REQUIREMENTS } from '../widgets/requirements.js'
import { SourceError } from './errors.js'
import type { ProviderDefinition } from './provider.js'
import { builtInProvider } from './registry.js'
import {
  checkProducedOutputs, InvalidSourceOutputError, sourceResultHash, writeOutputs, type CheckedOutput,
} from './writeOutputs.js'

const DRAFT_LIFETIME_MS = 60 * 60 * 1_000
const DEFAULT_SWEEP_INTERVAL_MS = 60_000
const MAX_SOURCE_INTERVAL_S = 86_400

interface ConfigFieldManifest {
  name: string
  type: 'text' | 'number' | 'url' | 'select'
  required: boolean
  min?: number
  max?: number
  options?: readonly string[]
}

interface ProviderManifest {
  id: string
  package_id: ProviderDefinition['package_id']
  package_version: ProviderDefinition['package_version']
  strategy: ProviderDefinition['strategy']
  label: string
  default_interval_s: number
  min_interval_s: number
  configFields: ConfigFieldManifest[]
  secretNames: string[]
  outputs: Array<{ contract_id: ContractId; capabilities: readonly string[] }>
}

export interface DraftInput {
  provider_id: string
  name: string
  config: unknown
  secrets: unknown
  interval_s?: number
  supersedes?: string
}

export interface DraftDeps {
  db: DB
  fetch: typeof fetch
  secretBox: SecretBox
  now: number
  providerFor?: (providerId: string) => ProviderDefinition | undefined
}

export interface DraftOutputView {
  contract_id: ContractId
  capabilities: string[]
  missing_optional: string[]
  preview: WireFeed
}

export interface DraftView {
  id: string
  provider_id: string
  provider: string
  name: string
  expires_at: number
  outputs: DraftOutputView[]
}

export interface PromotedDraft {
  source: SourceRow
  outputs: SourceOutputRow[]
  /** Announce these only after the caller's transaction commits. */
  changed_feed_ids: string[]
}

function sourceDraftUnavailable(): Error {
  return new Error('Source draft is unavailable')
}

function sourceDraftPreviewInvalid(): Error {
  return new Error('Source draft preview is invalid')
}

function safeProviderFailure(error: unknown): Error {
  if (error instanceof InvalidSourceOutputError) return error
  if (error instanceof SourceError) {
    return new SourceError(error.code, 'Could not test source data', error.retryAt)
  }
  return new Error('Could not test source data')
}

function normalizedName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '') throw new Error('Source name is required')
  return name
}

function normalizedInterval(
  value: number | undefined,
  provider: Pick<ProviderManifest, 'default_interval_s' | 'min_interval_s'>,
): number {
  if (value === undefined) return provider.default_interval_s
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_SOURCE_INTERVAL_S) {
    throw new Error('Source interval is invalid')
  }
  return Math.max(provider.min_interval_s, value)
}

function providerManifest(provider: ProviderDefinition): ProviderManifest {
  return {
    id: provider.id,
    package_id: provider.package_id,
    package_version: provider.package_version,
    strategy: provider.strategy,
    label: provider.label,
    default_interval_s: provider.default_interval_s,
    min_interval_s: provider.min_interval_s,
    configFields: provider.setup
      .filter((field) => !field.secret)
      .map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.options === undefined ? {} : { options: field.options.map((option) => option.value) }),
      })),
    secretNames: provider.setup.filter((field) => field.secret).map((field) => field.name),
    outputs: provider.potential_outputs.map((output) => ({
      contract_id: output.contract_id,
      capabilities: [...output.capabilities],
    })),
  }
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false
  const sortedActual = [...actual].sort()
  const sortedExpected = [...expected].sort()
  return sortedActual.every((value, index) => value === sortedExpected[index])
}

function sealedSecrets(
  secretNames: readonly string[],
  normalized: Readonly<Record<string, string>>,
  secretBox: SecretBox,
): Array<{ name: string; ciphertext: string }> {
  const sealed: Array<{ name: string; ciphertext: string }> = []
  try {
    for (const name of secretNames) {
      if (!Object.hasOwn(normalized, name)) continue
      const plaintext = normalized[name]
      if (typeof plaintext !== 'string') throw new Error('invalid normalized secret')
      sealed.push({ name, ciphertext: secretBox.seal(plaintext) })
    }
  } catch {
    // SecretBox is an injected boundary. Its error may echo the plaintext it was handed.
    throw new Error('Could not protect source credentials')
  }
  return sealed
}

function safeConfig(
  fields: readonly ConfigFieldManifest[],
  normalized: Record<string, unknown>,
): Record<string, unknown> {
  const projected = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    if (!Object.hasOwn(normalized, field.name)) {
      if (field.required) throw new Error('missing normalized config')
      continue
    }
    const value = normalized[field.name]
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid normalized config')
      if (field.min !== undefined && value < field.min) throw new Error('invalid normalized config')
      if (field.max !== undefined && value > field.max) throw new Error('invalid normalized config')
    } else {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('invalid normalized config')
      if (field.type === 'select' && !field.options?.includes(value)) throw new Error('invalid normalized config')
      if (field.type === 'url') {
        let parsed: URL
        try { parsed = new URL(value) } catch { throw new Error('invalid normalized config') }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid normalized config')
      }
    }
    projected[field.name] = value
  }
  return projected
}

function frozenCopy<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze({ ...value }) as Readonly<T>
}

function safeSecrets(
  names: readonly string[],
  normalized: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const projected = Object.create(null) as Record<string, string>
  for (const name of names) {
    if (!Object.hasOwn(normalized, name)) continue
    const value = normalized[name]
    if (typeof value !== 'string') throw new Error('invalid normalized secret')
    projected[name] = value
  }
  return frozenCopy(projected)
}

function missingOptional(contractId: ContractId, capabilities: readonly string[]): string[] {
  const available = new Set(capabilities)
  const missing = new Set<string>()
  for (const requirement of Object.values(WIDGET_REQUIREMENTS)) {
    if (requirement.contract_id !== contractId) continue
    for (const capability of requirement.optional_capabilities) {
      if (!available.has(capability)) missing.add(capability)
    }
  }
  return [...missing]
}

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>
const has = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)

function copyFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const projected = Object.create(null) as Record<string, unknown>
  for (const key of required) projected[key] = value[key]
  for (const key of optional) if (has(value, key)) projected[key] = value[key]
  return projected
}

function canonicalLocation(value: unknown): Record<string, unknown> {
  return copyFields(record(value), ['name', 'timezone'])
}

function canonicalAttribution(value: unknown): Record<string, unknown> {
  return copyFields(record(value), ['label', 'url'])
}

function canonicalCondition(value: unknown): Record<string, unknown> {
  return copyFields(record(value), ['code', 'label'])
}

function canonicalCurrentPayload(value: unknown): Record<string, unknown> {
  const source = record(value)
  const current = copyFields(
    record(source.current),
    ['temp'],
    ['feels_like', 'humidity', 'wind', 'code', 'is_day'],
  )
  current.condition = canonicalCondition(record(source.current).condition)
  const projected = Object.create(null) as Record<string, unknown>
  projected.location = canonicalLocation(source.location)
  projected.observed_at = source.observed_at
  projected.current = current
  if (has(source, 'today')) {
    projected.today = copyFields(record(source.today), [], ['min', 'max', 'precip_prob'])
  }
  projected.units = copyFields(record(source.units), ['temp', 'wind'])
  if (has(source, 'attribution')) projected.attribution = canonicalAttribution(source.attribution)
  return projected
}

function canonicalPollen(value: unknown): Record<string, unknown> {
  return copyFields(record(value), ['level'], ['index', 'scale', 'dominant'])
}

function canonicalDailyPayload(value: unknown): Record<string, unknown> {
  const source = record(value)
  const projected = Object.create(null) as Record<string, unknown>
  projected.location = canonicalLocation(source.location)
  projected.units = copyFields(record(source.units), ['temperature', 'wind_speed'])
  if (has(source, 'current')) projected.current = canonicalCurrentPayload(source.current)
  projected.days = (source.days as unknown[]).map((value) => {
    const day = record(value)
    const canonical = copyFields(
      day,
      ['date', 'high', 'low'],
      ['humidity_mean_pct', 'precipitation_probability_pct', 'wind_speed_max'],
    )
    canonical.condition = canonicalCondition(day.condition)
    if (has(day, 'pollen')) canonical.pollen = canonicalPollen(day.pollen)
    return canonical
  })
  if (has(source, 'attribution')) projected.attribution = canonicalAttribution(source.attribution)
  return projected
}

function canonicalNewsRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const canonical = copyFields(
      row,
      ['id', 'title'],
      ['summary', 'url', 'link', 'published_at', 'source'],
    )
    if (has(row, 'attribution')) canonical.attribution = canonicalAttribution(row.attribution)
    return canonical
  })
}

function canonicalCalendarPayload(value: unknown): Record<string, unknown> {
  const source = record(value)
  return {
    events: (source.events as unknown[]).map((event) =>
      copyFields(record(event), ['title', 'start', 'end', 'all_day', 'location'])),
  }
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Contract validators establish types; projection establishes the only persisted/public fields. */
function canonicalResult(contractId: ContractId, result: SourceResult): SourceResult {
  switch (contractId) {
    case 'dashboardz.weather.current/v1':
      return { mode: 'value', payload: canonicalCurrentPayload((result as Extract<SourceResult, { mode: 'value' }>).payload) }
    case 'dashboardz.weather.daily-forecast/v1':
      return { mode: 'value', payload: canonicalDailyPayload((result as Extract<SourceResult, { mode: 'value' }>).payload) }
    case 'dashboardz.news.items/v1': {
      const stream = result as Extract<SourceResult, { mode: 'stream' }>
      return { mode: 'stream', rows: canonicalNewsRows(stream.rows), dedupe_by: stream.dedupe_by }
    }
    case 'dashboardz.calendar.events/v1':
      return { mode: 'value', payload: canonicalCalendarPayload((result as Extract<SourceResult, { mode: 'value' }>).payload) }
    case 'dashboardz.legacy.value/v1':
      return { mode: 'value', payload: jsonCopy((result as Extract<SourceResult, { mode: 'value' }>).payload) }
    case 'dashboardz.legacy.stream/v1': {
      const stream = result as Extract<SourceResult, { mode: 'stream' }>
      return { mode: 'stream', rows: jsonCopy(stream.rows), dedupe_by: stream.dedupe_by }
    }
    case 'dashboardz.legacy.image/v1':
      return { mode: 'image', image_rev: (result as Extract<SourceResult, { mode: 'image' }>).image_rev }
  }
}

function streamPreview(
  result: Extract<SourceResult, { mode: 'stream' }>,
  cap: number,
  now: number,
  staleAfter: number,
): WireFeed {
  const seen = new Set<unknown>()
  const rows: Record<string, unknown>[] = []
  for (const row of result.rows) {
    const key = row[result.dedupe_by]
    if (key === undefined || key === null || key === '' || seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  return {
    mode: 'stream',
    rows: rows.slice(-cap).reverse().map((payload) => ({ payload, pushed_at: now })),
    pushed_at: now,
    stale_after_s: staleAfter,
  }
}

function previewFor(output: SourceDraftOutputRow, intervalS: number, now: number): WireFeed {
  if (output.result.mode === 'invalid' || !Object.hasOwn(CONTRACTS, output.contract_id)) {
    throw sourceDraftPreviewInvalid()
  }
  const contract = CONTRACTS[output.contract_id as ContractId]
  const staleAfter = intervalS * 3
  if (output.result.mode === 'value') {
    return { mode: 'value', payload: output.result.payload, pushed_at: now, stale_after_s: staleAfter }
  }
  if (output.result.mode === 'stream') {
    return streamPreview(output.result, 'collection_limit' in contract ? contract.collection_limit : 50, now, staleAfter)
  }
  throw sourceDraftPreviewInvalid()
}

function draftView(draft: SourceDraft, providerLabel: string): DraftView {
  return {
    id: draft.id,
    provider_id: draft.provider_id,
    provider: providerLabel,
    name: draft.name,
    expires_at: draft.expires_at,
    outputs: draft.outputs.map((output) => {
      if (!Object.hasOwn(CONTRACTS, output.contract_id)) throw sourceDraftPreviewInvalid()
      const contractId = output.contract_id as ContractId
      return {
        contract_id: contractId,
        capabilities: output.capabilities,
        missing_optional: missingOptional(contractId, output.capabilities),
        preview: previewFor(output, draft.interval_s, draft.created_at),
      }
    }),
  }
}

export async function testSourceDraft(input: DraftInput, deps: DraftDeps): Promise<DraftView> {
  const provider = (deps.providerFor ?? builtInProvider)(input.provider_id)
  if (!provider) throw new Error('Source provider is unavailable')
  const manifest = providerManifest(provider)
  const checkingProvider: ProviderDefinition = { ...provider, potential_outputs: manifest.outputs }
  const name = normalizedName(input.name)
  const intervalS = normalizedInterval(input.interval_s, manifest)

  let setup
  try {
    setup = provider.validateSetup(input.config, input.secrets)
  } catch {
    throw new Error('Source setup is invalid')
  }
  if (!setup.ok) throw new Error('Source setup is invalid')
  let configSnapshot: Readonly<Record<string, unknown>>
  let runtimeSecrets: Readonly<Record<string, string>>
  let secrets: Array<{ name: string; ciphertext: string }>
  try {
    configSnapshot = frozenCopy(safeConfig(manifest.configFields, setup.config))
    runtimeSecrets = safeSecrets(manifest.secretNames, setup.secrets)
    secrets = sealedSecrets(manifest.secretNames, runtimeSecrets, deps.secretBox)
  } catch (error) {
    if (error instanceof Error && error.message === 'Could not protect source credentials') throw error
    throw new Error('Source setup is invalid')
  }

  let checked: CheckedOutput[]
  try {
    let fetchAttempts = 0
    const fetchOnce = (async (...args: Parameters<typeof fetch>) => {
      fetchAttempts++
      if (fetchAttempts > 1) throw new SourceError('invalid_response', 'A source test may fetch only once')
      return deps.fetch(...args)
    }) as typeof fetch
    const produced = await provider.run(
      { config: frozenCopy(configSnapshot), secrets: frozenCopy(runtimeSecrets) },
      { fetch: fetchOnce, now: deps.now, signal: new AbortController().signal },
    )
    if (fetchAttempts !== 1) throw new Error('provider did not fetch exactly once')
    const structurallyChecked = checkProducedOutputs(checkingProvider, produced)
    checked = checkProducedOutputs(checkingProvider, structurallyChecked.map((candidate) => ({
      contract_id: candidate.contract_id,
      result: canonicalResult(candidate.contract_id, candidate.result),
    })))
    // Draft persistence intentionally excludes image bodies/revisions.
    if (checked.some((candidate) => candidate.result.mode === 'image')) throw new InvalidSourceOutputError()
  } catch (error) {
    throw safeProviderFailure(error)
  }

  const created = deps.db.transaction(() => {
    // Re-project the isolated snapshot at the persistence boundary. Provider runtime references
    // never become repository input, even if an injected provider attempted mutation.
    const config = safeConfig(manifest.configFields, configSnapshot as Record<string, unknown>)
    const row = createDraft(deps.db, {
      provider_id: manifest.id,
      package_id: manifest.package_id,
      package_version: manifest.package_version,
      name,
      config,
      strategy: manifest.strategy,
      interval_s: intervalS,
      expires_at: deps.now + DRAFT_LIFETIME_MS,
      secrets,
      outputs: checked.map((candidate) => ({
        contract_id: candidate.contract_id,
        mode: candidate.result.mode as 'value' | 'stream',
        result: candidate.result,
        capabilities: candidate.capabilities,
        content_hash: candidate.content_hash,
      })),
    }, deps.now)
    if (input.supersedes && input.supersedes !== row.id) deleteDraft(deps.db, input.supersedes)
    return getDraft(deps.db, row.id)!
  })()

  return draftView(created, manifest.label)
}

export function removeSourceDraft(db: DB, id: string): boolean {
  return deleteDraft(db, id)
}

export function expireSourceDrafts(db: DB, now: number): number {
  return expireDraft(db, now).length
}

export function startDraftSweep(
  db: DB,
  opts: { intervalMs?: number } = {},
): { run(now: number): number; stop(): void } {
  let stopped = false
  const run = (now: number): number => stopped ? 0 : expireSourceDrafts(db, now)
  const timer = setInterval(() => run(Date.now()), opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
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

function checkedDraftOutputs(draft: SourceDraft): CheckedOutput[] {
  return draft.outputs.map((output) => {
    if (output.result.mode === 'invalid' || output.result.mode === 'image' ||
      !Object.hasOwn(CONTRACTS, output.contract_id)) throw sourceDraftPreviewInvalid()
    const contractId = output.contract_id as ContractId
    const contract = CONTRACTS[contractId]
    let canonical: SourceResult
    try {
      canonical = canonicalResult(contractId, output.result)
    } catch {
      throw sourceDraftPreviewInvalid()
    }
    const validation = validateContractOutput(contractId, canonical)
    if (!validation.ok || contract.mode !== output.mode ||
      JSON.stringify(validation.capabilities) !== JSON.stringify(output.capabilities) ||
      sourceResultHash(canonical) !== output.content_hash) {
      throw sourceDraftPreviewInvalid()
    }
    return {
      contract_id: contractId,
      result: canonical,
      capabilities: output.capabilities,
      content_hash: output.content_hash,
    }
  })
}

function verifyDraftManifest(draft: SourceDraft): void {
  const provider = builtInProvider(draft.provider_id)
  if (!provider) throw sourceDraftPreviewInvalid()
  const manifest = providerManifest(provider)
  if (draft.package_id !== manifest.package_id || draft.package_version !== manifest.package_version ||
    draft.strategy !== manifest.strategy ||
    !sameNames(draft.outputs.map((output) => output.contract_id), manifest.outputs.map((output) => output.contract_id)) ||
    !sameNames(draft.secrets.map((secret) => secret.name), manifest.secretNames)) {
    throw sourceDraftPreviewInvalid()
  }
  let projected: Record<string, unknown>
  let interval: number
  try {
    projected = safeConfig(manifest.configFields, draft.config)
    interval = normalizedInterval(draft.interval_s, manifest)
  } catch {
    throw sourceDraftPreviewInvalid()
  }
  const actualKeys = Object.keys(draft.config).sort()
  const projectedKeys = Object.keys(projected).sort()
  if (interval !== draft.interval_s || !sameNames(actualKeys, projectedKeys) ||
    projectedKeys.some((key) => draft.config[key] !== projected[key])) throw sourceDraftPreviewInvalid()
}

/** Caller owns the transaction so screen save can compose promotion with its own writes. */
export function materializeSourceDraft(
  db: DB, id: string, now: number, actor: AdminActor = { type: 'admin', id: null },
): PromotedDraft {
  const draft = getDraft(db, id)
  if (!draft || draft.expires_at <= now) throw sourceDraftUnavailable()
  verifyDraftManifest(draft)
  const checked = checkedDraftOutputs(draft)
  const source = createSource(db, {
    provider_id: draft.provider_id,
    package_id: draft.package_id,
    package_version: draft.package_version,
    name: draft.name,
    config: draft.config,
    strategy: draft.strategy,
    interval_s: draft.interval_s,
  }, now, actor)
  for (const secret of draft.secrets) {
    // Promotion copies the opaque envelope. Decryption is exclusively a later source-run concern.
    putSourceSecret(db, source.id, secret.name, secret.ciphertext, now)
  }
  const changedFeedIds = writeOutputs(db, source, checked, now, actor)
  recordRun(db, source.id, now, {
    state: 'healthy',
    status: 'Connection refreshed successfully.',
    next_run_at: now + source.interval_s * 1_000,
  })
  if (!deleteDraft(db, draft.id)) throw sourceDraftUnavailable()
  const promotedSource = getSource(db, source.id)
  if (!promotedSource) throw new Error('Promoted source is unavailable')
  return {
    source: promotedSource,
    outputs: listOutputs(db, source.id),
    changed_feed_ids: changedFeedIds,
  }
}

/** Standalone Advanced flow. Screen save calls materializeSourceDraft inside its larger transaction. */
export function promoteSourceDraft(
  db: DB, id: string, now: number, actor: AdminActor = { type: 'admin', id: null },
): PromotedDraft {
  return db.transaction(() => materializeSourceDraft(db, id, now, actor))()
}
