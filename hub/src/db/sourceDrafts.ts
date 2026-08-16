import type { SourceResult } from '../data/contracts.js'
import { newId } from '../ids.js'
import type { DB } from './index.js'

export interface SourceDraftSecretRow {
  id: string
  draft_id: string
  name: string
  /** Opaque encrypted storage; callers must supply and consume ciphertext only. */
  ciphertext: string
  created_at: number
}

export interface SourceDraftOutputRow {
  id: string
  draft_id: string
  contract_id: string
  mode: 'value' | 'stream'
  result: DraftPreviewResult
  capabilities: string[]
  content_hash: string
  created_at: number
}

/** A corrupt persisted preview is visible as invalid, never fabricated into usable-looking data. */
export type DraftPreviewResult = SourceResult | { mode: 'invalid'; reason: 'malformed_preview' }

export interface SourceDraftRow {
  id: string
  provider_id: string
  package_id: string
  package_version: string
  name: string
  config: Record<string, unknown>
  strategy: string
  interval_s: number
  expires_at: number
  created_at: number
}

export interface SourceDraft extends SourceDraftRow {
  secrets: SourceDraftSecretRow[]
  outputs: SourceDraftOutputRow[]
}

interface StoredDraft extends Omit<SourceDraftRow, 'config'> { config: string }
interface StoredDraftOutput extends Omit<SourceDraftOutputRow, 'result' | 'capabilities'> { result: string; capabilities: string }

const DRAFT_COLS = 'id, provider_id, package_id, package_version, name, config, strategy, interval_s, expires_at, created_at'
const SECRET_COLS = 'id, draft_id, name, ciphertext, created_at'
const OUTPUT_COLS = 'id, draft_id, contract_id, mode, result, capabilities, content_hash, created_at'

function warnMalformed(column: string): void {
  console.warn(`Malformed ${column} in source draft repository; using safe fallback`)
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* guarded below */ }
  warnMalformed('draft config')
  return {}
}

function parseCapabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed
  } catch { /* guarded below */ }
  warnMalformed('draft output capabilities')
  return []
}

const invalidPreview = (): DraftPreviewResult => ({ mode: 'invalid', reason: 'malformed_preview' })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function parseResult(value: string, storedMode: string): DraftPreviewResult {
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed) && (storedMode === 'value' || storedMode === 'stream')) {
      if (parsed.mode === 'value' && storedMode === 'value' && Object.hasOwn(parsed, 'payload')) {
        return { mode: 'value', payload: parsed.payload }
      }
      if (
        parsed.mode === 'stream' && storedMode === 'stream' && Array.isArray(parsed.rows) &&
        parsed.rows.every(isRecord) && typeof parsed.dedupe_by === 'string' && parsed.dedupe_by !== ''
      ) {
        return { mode: 'stream', rows: parsed.rows, dedupe_by: parsed.dedupe_by }
      }
    }
  } catch { /* guarded below */ }
  warnMalformed('draft output result')
  return invalidPreview()
}

function hydrateDraft(row: StoredDraft): SourceDraftRow {
  return { ...row, config: parseConfig(row.config) }
}

function hydrateOutput(row: StoredDraftOutput): SourceDraftOutputRow {
  return {
    ...row,
    mode: row.mode === 'stream' ? 'stream' : 'value',
    result: parseResult(row.result, row.mode),
    capabilities: parseCapabilities(row.capabilities),
  }
}

export function createDraft(
  db: DB,
  input: {
    provider_id: string
    package_id: string
    package_version: string
    name: string
    config: Record<string, unknown>
    strategy?: string
    interval_s: number
    expires_at: number
    secrets: Array<{ name: string; ciphertext: string }>
    outputs: Array<{
      contract_id: string
      mode: 'value' | 'stream'
      result: SourceResult
      capabilities: string[]
      content_hash: string
    }>
  },
  now: number,
): SourceDraftRow {
  const row: SourceDraftRow = {
    id: newId('drf'), provider_id: input.provider_id, package_id: input.package_id,
    package_version: input.package_version, name: input.name, config: input.config,
    strategy: input.strategy ?? 'scheduled', interval_s: input.interval_s, expires_at: input.expires_at, created_at: now,
  }
  return db.transaction(() => {
    db.prepare(`INSERT INTO source_drafts (${DRAFT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.provider_id, row.package_id, row.package_version, row.name, JSON.stringify(row.config), row.strategy, row.interval_s, row.expires_at, row.created_at)
    const putSecret = db.prepare(`INSERT INTO source_draft_secrets (${SECRET_COLS}) VALUES (?, ?, ?, ?, ?)`)
    for (const secret of input.secrets) {
      putSecret.run(newId('dsec'), row.id, secret.name, secret.ciphertext, now)
    }
    const putOutput = db.prepare(`INSERT INTO source_draft_outputs (${OUTPUT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const output of input.outputs) {
      putOutput.run(newId('dout'), row.id, output.contract_id, output.mode, JSON.stringify(output.result), JSON.stringify(output.capabilities), output.content_hash, now)
    }
    return row
  })()
}

export function getDraft(db: DB, id: string): SourceDraft | undefined {
  const stored = db.prepare(`SELECT ${DRAFT_COLS} FROM source_drafts WHERE id = ?`).get(id) as StoredDraft | undefined
  if (!stored) return undefined
  const row = hydrateDraft(stored)
  const secrets = db.prepare(`SELECT ${SECRET_COLS} FROM source_draft_secrets WHERE draft_id = ? ORDER BY name, id`)
    .all(id) as SourceDraftSecretRow[]
  const outputs = (db.prepare(`SELECT ${OUTPUT_COLS} FROM source_draft_outputs WHERE draft_id = ? ORDER BY created_at, id`)
    .all(id) as StoredDraftOutput[]).map(hydrateOutput)
  return { ...row, secrets, outputs }
}

export function deleteDraft(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM source_drafts WHERE id = ?').run(id).changes > 0
}

/** Returns the exact draft ids removed; child rows are removed by their real foreign keys. */
export function expireDraft(db: DB, now: number): string[] {
  return db.transaction(() => {
    const ids = (db.prepare('SELECT id FROM source_drafts WHERE expires_at <= ? ORDER BY expires_at, id').all(now) as { id: string }[])
      .map((row) => row.id)
    const remove = db.prepare('DELETE FROM source_drafts WHERE id = ?')
    for (const id of ids) remove.run(id)
    return ids
  })()
}
