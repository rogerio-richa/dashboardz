import { CONTRACTS, type ContractId } from '../data/contracts.js'
import type { ProviderDefinition } from './provider.js'
import { icalProvider } from './providers/ical.js'
import { openMeteoProvider } from './providers/openMeteo.js'
import { rssProvider } from './providers/rss.js'

const KNOWN_CAPABILITIES: Readonly<Record<ContractId, ReadonlySet<string>>> = {
  'dashboardz.weather.current/v1': new Set(['attribution', 'weather.current']),
  'dashboardz.weather.daily-forecast/v1': new Set([
    'attribution', 'weather.current', 'weather.daily.condition', 'weather.daily.date',
    'weather.daily.entries.5', 'weather.daily.entries.6', 'weather.daily.entries.7',
    'weather.daily.humidity', 'weather.daily.pollen', 'weather.daily.precipitation_probability',
    'weather.daily.temperature.high', 'weather.daily.temperature.low', 'weather.daily.wind',
  ]),
  'dashboardz.news.items/v1': new Set([
    'attribution', 'news.item.id', 'news.item.published_at', 'news.item.source',
    'news.item.summary', 'news.item.title', 'news.item.url',
  ]),
  'dashboardz.calendar.events/v1': new Set([
    'calendar.event.all_day', 'calendar.event.location', 'calendar.event.times',
    'calendar.event.title',
  ]),
  'dashboardz.legacy.value/v1': new Set(),
  'dashboardz.legacy.stream/v1': new Set(),
  'dashboardz.legacy.image/v1': new Set(),
}

const REQUIRED_CAPABILITIES: Readonly<Record<ContractId, readonly string[]>> = {
  'dashboardz.weather.current/v1': ['weather.current'],
  'dashboardz.weather.daily-forecast/v1': [
    'weather.daily.condition', 'weather.daily.date', 'weather.daily.entries.5',
    'weather.daily.temperature.high', 'weather.daily.temperature.low',
  ],
  'dashboardz.news.items/v1': ['news.item.id', 'news.item.title'],
  // No `location`: it is per-event and most events in a real calendar have none, so a provider
  // that cannot promise it up front is still a usable calendar provider.
  'dashboardz.calendar.events/v1': [
    'calendar.event.all_day', 'calendar.event.times', 'calendar.event.title',
  ],
  'dashboardz.legacy.value/v1': [],
  'dashboardz.legacy.stream/v1': [],
  'dashboardz.legacy.image/v1': [],
}

const RESERVED_NAMES = new Set([
  '__proto__', 'constructor', 'hasownproperty', 'prototype', 'tostring', 'valueof',
])
const PROVIDER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const SETUP_NAME = /^[a-z][a-z0-9_]*$/
const SETUP_TYPES = new Set(['text', 'number', 'url', 'select'])
const nonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const reservedName = (value: string): boolean =>
  value.split(/[._-]/).some((part) => RESERVED_NAMES.has(part.toLowerCase()))
const descriptorError = (id: unknown, detail: string): Error =>
  new Error(`Invalid provider descriptor ${typeof id === 'string' && id !== '' ? id : '(unnamed)'}: ${detail}`)

function validateRequiredCapabilities(
  providerId: string,
  contractId: ContractId,
  capabilities: ReadonlySet<string>,
): void {
  for (const required of REQUIRED_CAPABILITIES[contractId]) {
    if (!capabilities.has(required)) {
      throw descriptorError(providerId, `${contractId} is missing required capability ${required}`)
    }
  }
  if (contractId !== 'dashboardz.weather.daily-forecast/v1') return
  for (const maximum of [6, 7]) {
    if (!capabilities.has(`weather.daily.entries.${maximum}`)) continue
    for (let day = 5; day < maximum; day++) {
      const required = `weather.daily.entries.${day}`
      if (!capabilities.has(required)) {
        throw descriptorError(providerId, `${contractId} is missing required capability ${required}`)
      }
    }
  }
}

function validateSetupFields(provider: ProviderDefinition): void {
  if (!Array.isArray(provider.setup)) throw descriptorError(provider.id, 'setup fields must be an array')
  const names = new Set<string>()
  for (const field of provider.setup) {
    if (!field || typeof field !== 'object') throw descriptorError(provider.id, 'setup field must be an object')
    if (!nonEmptyText(field.name) || !SETUP_NAME.test(field.name) || reservedName(field.name)) {
      throw descriptorError(provider.id, 'setup field has an invalid name')
    }
    if (names.has(field.name)) throw descriptorError(provider.id, `setup field ${field.name} is duplicated`)
    names.add(field.name)
    if (!nonEmptyText(field.label) || !SETUP_TYPES.has(field.type) ||
      typeof field.required !== 'boolean' || typeof field.secret !== 'boolean') {
      throw descriptorError(provider.id, `setup field ${field.name} has invalid metadata`)
    }
    for (const bound of ['min', 'max'] as const) {
      const value = field[bound]
      if (value !== undefined && (field.type !== 'number' || typeof value !== 'number' || !Number.isFinite(value))) {
        throw descriptorError(provider.id, `setup field ${field.name} has an invalid ${bound}`)
      }
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      throw descriptorError(provider.id, `setup field ${field.name} has a contradictory range`)
    }
    if (field.type !== 'select') {
      if (field.options !== undefined) throw descriptorError(provider.id, `setup field ${field.name} has unexpected options`)
      continue
    }
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw descriptorError(provider.id, `setup field ${field.name} needs select options`)
    }
    const values = new Set<string>()
    for (const option of field.options) {
      if (!option || typeof option !== 'object' || !nonEmptyText(option.value) || !nonEmptyText(option.label) || values.has(option.value)) {
        throw descriptorError(provider.id, `setup field ${field.name} has invalid select options`)
      }
      values.add(option.value)
    }
  }
}

export function validateProviderDefinitions(providers: readonly ProviderDefinition[]): void {
  if (!Array.isArray(providers)) throw new Error('Provider definitions must be an array')
  const ids = new Set<string>()
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') throw descriptorError(undefined, 'definition must be an object')
    if (!nonEmptyText(provider.id) || !PROVIDER_ID.test(provider.id) || reservedName(provider.id)) {
      throw new Error(`Invalid provider id ${typeof provider.id === 'string' ? provider.id : '(missing)'}`)
    }
    if (ids.has(provider.id)) throw new Error(`Duplicate provider id ${provider.id}`)
    ids.add(provider.id)
    if (provider.package_id !== 'dashboardz.builtin' || provider.package_version !== '1.0.0' ||
      provider.strategy !== 'scheduled' || !nonEmptyText(provider.label) || !nonEmptyText(provider.category) ||
      typeof provider.recommended !== 'boolean' || typeof provider.validateSetup !== 'function' ||
      typeof provider.run !== 'function') {
      throw descriptorError(provider.id, 'core provider descriptor metadata is invalid')
    }
    if (!Number.isInteger(provider.min_interval_s) || provider.min_interval_s <= 0 ||
      !Number.isInteger(provider.default_interval_s) || provider.default_interval_s < provider.min_interval_s) {
      throw descriptorError(provider.id, 'interval values are invalid or contradictory')
    }
    if (!Array.isArray(provider.potential_outputs) || provider.potential_outputs.length === 0) {
      throw descriptorError(provider.id, 'at least one potential output is required')
    }
    const outputs = new Set<string>()
    for (const output of provider.potential_outputs) {
      const contractId = output && typeof output === 'object' ? (output as { contract_id?: unknown }).contract_id : undefined
      if (typeof contractId !== 'string' || !Object.hasOwn(CONTRACTS, contractId)) {
        throw new Error(`Provider ${provider.id} declares unknown contract ${String(contractId)}`)
      }
      if (outputs.has(contractId)) {
        throw new Error(`Provider ${provider.id} declares ${contractId} more than once`)
      }
      outputs.add(contractId)
      if (!Array.isArray(output.capabilities)) {
        throw descriptorError(provider.id, `capabilities for ${contractId} must be an array`)
      }
      const capabilities = new Set<string>()
      for (const capability of output.capabilities) {
        if (!nonEmptyText(capability) || capabilities.has(capability)) {
          throw descriptorError(provider.id, `capability for ${contractId} is invalid or duplicated`)
        }
        capabilities.add(capability)
        if (!KNOWN_CAPABILITIES[contractId as ContractId].has(capability)) {
          throw new Error(`Capability ${capability} is unknown to ${contractId}`)
        }
      }
      validateRequiredCapabilities(provider.id, contractId as ContractId, capabilities)
    }
    validateSetupFields(provider)
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const definitions = [icalProvider, openMeteoProvider, rssProvider]
  .sort((left, right) => left.id.localeCompare(right.id))
validateProviderDefinitions(definitions)

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = deepFreeze(definitions)

const registry = Object.create(null) as Record<string, ProviderDefinition>
for (const provider of BUILTIN_PROVIDERS) registry[provider.id] = provider
Object.freeze(registry)

export function builtInProvider(id: string): ProviderDefinition | undefined {
  return Object.hasOwn(registry, id) ? registry[id] : undefined
}
