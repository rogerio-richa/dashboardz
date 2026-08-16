import { validateContractOutput, type ContractId, type SourceResult } from '../data/contracts.js'
import { SourceError } from './errors.js'

export interface ProviderRunContext {
  fetch: typeof fetch
  now: number
  signal: AbortSignal
}

export interface ProviderRunInput {
  config: Record<string, unknown>
  secrets: Readonly<Record<string, string>>
}

export interface ProducedOutput {
  contract_id: ContractId
  result: SourceResult
}

export type SetupField = {
  name: string
  label: string
  type: 'text' | 'number' | 'url' | 'select'
  required: boolean
  secret: boolean
  min?: number
  max?: number
  options?: readonly { value: string; label: string }[]
}

export type SetupCheck =
  | { ok: true; config: Record<string, unknown>; secrets: Readonly<Record<string, string>> }
  | { ok: false; error: string }

export interface ProviderDefinition {
  id: string
  package_id: 'dashboardz.builtin'
  package_version: '1.0.0'
  strategy: 'scheduled'
  label: string
  /** Discovery grouping only; semantic compatibility is contract + capability based. */
  category: string
  recommended: boolean
  default_interval_s: number
  min_interval_s: number
  potential_outputs: readonly {
    contract_id: ContractId
    capabilities: readonly string[]
  }[]
  setup: readonly SetupField[]
  validateSetup(config: unknown, secrets: unknown): SetupCheck
  run(input: ProviderRunInput, ctx: ProviderRunContext): Promise<ProducedOutput[]>
}

function freezeMetadata<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeMetadata(child)
    Object.freeze(value)
  }
  return value
}

/** A provider descriptor is public discovery metadata, not mutable runtime state. */
export function defineProvider(definition: ProviderDefinition): ProviderDefinition {
  return freezeMetadata(definition)
}

/** Provider runs never expose a payload that the canonical contract registry rejects. */
export function validateProducedOutputs(outputs: ProducedOutput[]): ProducedOutput[] {
  for (const output of outputs) {
    const checked = validateContractOutput(output.contract_id, output.result)
    if (!checked.ok) {
      throw new SourceError(
        'invalid_response',
        `The provider returned invalid ${output.contract_id} data: ${checked.error}`,
      )
    }
  }
  return outputs
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

export const setupText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

export const setupNumber = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

export const setupInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = setupNumber(value)
  return number === null ? fallback : Math.min(max, Math.max(min, Math.round(number)))
}

export const setupHttpUrl = (value: unknown): string | null => {
  const text = setupText(value)
  if (text === null) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
