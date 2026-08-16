import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ContractId, SourceResult } from '../data/contracts.js'
import { audit } from '../db/audit.js'
import { actorOf } from './admin/shared.js'
import { deleteDraft, getDraft } from '../db/sourceDrafts.js'
import {
  deleteSource, deleteSourceSecret, getSource, listOutputs, listSourceSecrets, listSources,
  putSourceSecret, recordRun, updateSource, type SourceOutputRow, type SourceRow,
} from '../db/sources.js'
import { screensReferencingFeed } from '../db/screens.js'
import { getFeed, updateFeed } from '../db/feeds.js'
import { SourceError } from '../sources/errors.js'
import { geocodePlaces } from '../sources/providers/openMeteo.js'
import {
  promoteSourceDraft, removeSourceDraft, testSourceDraft, type DraftInput,
} from '../sources/drafts.js'
import type { ProviderDefinition, SetupField } from '../sources/provider.js'
import { BUILTIN_PROVIDERS, builtInProvider } from '../sources/registry.js'
import { runSourceOnce } from '../sources/run.js'
import { writeOutputs, type CheckedOutput } from '../sources/writeOutputs.js'
import { compatibleOutput, widgetRequirement } from '../widgets/requirements.js'

const SOURCE_ID = '^src_[A-Za-z0-9_-]{1,80}$'
const DRAFT_ID = '^drf_[A-Za-z0-9_-]{1,80}$'

const idParams = (pattern: string) => ({
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', pattern, maxLength: 84 } },
})

const recordSchema = { type: 'object', additionalProperties: true, maxProperties: 64 }
const emptyObjectSchema = { type: 'object', additionalProperties: false, maxProperties: 0 }

function hasUnexpectedBody(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0
}

function announceOutputs(app: FastifyInstance, feedIds: readonly string[]): void {
  for (const feedId of feedIds) {
    try {
      app.dataPusher.onFeedPush(feedId)
    } catch {
      console.warn('source admin: output notification failed')
    }
  }
}

interface OutputSnapshot {
  feedId: string
  contentHash: string | null
  content: string | null
}

function outputSnapshots(app: FastifyInstance, sourceId: string): Map<ContractId, OutputSnapshot> {
  const snapshots = new Map<ContractId, OutputSnapshot>()
  for (const output of listOutputs(app.db, sourceId)) {
    const feed = getFeed(app.db, output.feed_id)
    let content: string | null = null
    if (feed?.mode === 'value') content = feed.payload
    if (feed?.mode === 'image') content = String(feed.image_rev)
    if (feed?.mode === 'stream') {
      const rows = app.db.prepare('SELECT payload FROM feed_rows WHERE feed_id = ? ORDER BY id')
        .all(feed.id) as Array<{ payload: string }>
      content = JSON.stringify(rows.map((row) => row.payload))
    }
    snapshots.set(output.contract_id, {
      feedId: output.feed_id,
      contentHash: output.content_hash,
      content,
    })
  }
  return snapshots
}

function replacementChangedFeedIds(
  before: ReadonlyMap<ContractId, OutputSnapshot>,
  after: ReadonlyMap<ContractId, OutputSnapshot>,
): string[] {
  const changed = new Set<string>()
  for (const [contractId, current] of after) {
    const previous = before.get(contractId)
    if (!previous || previous.feedId !== current.feedId ||
      previous.contentHash !== current.contentHash || previous.content !== current.content) {
      changed.add(current.feedId)
    }
  }
  return [...changed]
}

const PROVIDER_COPY: Readonly<Record<string, {
  recommendation: string
  account: string
  attribution: string
}>> = Object.freeze({
  'dashboardz.open-meteo': {
    recommendation: 'Recommended for weather.',
    account: 'No account or API key needed.',
    attribution: 'Weather data includes Open-Meteo attribution.',
  },
  'dashboardz.rss': {
    recommendation: 'Recommended for news feeds.',
    account: 'No account is needed; enter the publisher feed URL.',
    attribution: 'Article attribution comes from the configured publisher.',
  },
  'dashboardz.ical': {
    recommendation: 'Use a published iCalendar URL.',
    account: 'No account is needed; a calendar URL is required.',
    attribution: 'Calendar details come from the configured publisher.',
  },
})

const WIDGET_COPY: Readonly<Record<string, { title: string; description: string }>> = Object.freeze({
  weather_forecast: {
    title: 'Choose weather data',
    description: 'Reuse a compatible connection or connect a weather provider.',
  },
  news_list: {
    title: 'Choose news data',
    description: 'Reuse a compatible connection or connect a news provider.',
  },
  calendar_events: {
    title: 'Choose calendar data',
    description: 'Reuse a compatible connection or connect a calendar provider.',
  },
})

function setupFieldOut(field: SetupField) {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    secret: field.secret,
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.options === undefined ? {} : {
      options: field.options.map((option) => ({ value: option.value, label: option.label })),
    }),
  }
}

function providerOut(provider: ProviderDefinition) {
  const copy = PROVIDER_COPY[provider.id] ?? {
    recommendation: 'Available under Advanced.', account: 'Provider setup is required.', attribution: 'Provider attribution varies.',
  }
  return {
    id: provider.id,
    label: provider.label,
    recommended: provider.recommended,
    default_interval_s: provider.default_interval_s,
    min_interval_s: provider.min_interval_s,
    setup: provider.setup.map(setupFieldOut),
    outputs: provider.potential_outputs.map((output) => ({
      contract_id: output.contract_id,
      capabilities: [...output.capabilities],
    })),
    ...copy,
  }
}

function safeConfig(source: SourceRow, provider: ProviderDefinition | undefined): Record<string, unknown> | null {
  if (!provider || provider.package_id !== source.package_id || provider.package_version !== source.package_version) return null
  const config = Object.create(null) as Record<string, unknown>
  for (const field of provider.setup) {
    if (!field.secret && Object.hasOwn(source.config, field.name)) config[field.name] = source.config[field.name]
  }
  return config
}

const HEALTH_STATES = new Set([
  'healthy', 'paused', 'authentication_required', 'rate_limited', 'invalid_output', 'degraded',
])

function safeState(value: string): string {
  return HEALTH_STATES.has(value) ? value : 'degraded'
}

function healthMessage(state: string): string {
  switch (state) {
    case 'healthy': return 'Connection is healthy.'
    case 'paused': return 'Connection is paused.'
    case 'authentication_required': return 'Authentication is required; update this connection\'s credentials.'
    case 'rate_limited': return 'The provider is rate limiting this connection; retry is scheduled.'
    case 'invalid_output': return 'The provider returned invalid data; check this connection.'
    default: return 'The connection could not refresh; retry is scheduled.'
  }
}

function healthOut(source: SourceRow) {
  const state = safeState(source.state)
  const nextRefresh = source.enabled === 1 ? source.next_run_at : null
  return {
    state,
    status: healthMessage(state),
    last_run_at: source.last_run_at,
    last_success_at: source.last_success_at,
    next_refresh_at: nextRefresh,
    failure_count: source.failure_count,
    rate_limited_until: state === 'rate_limited' ? nextRefresh : null,
  }
}

function outputOut(app: FastifyInstance, output: SourceOutputRow) {
  return {
    id: output.id,
    contract_id: output.contract_id,
    feed_id: output.feed_id,
    capabilities: [...output.capabilities],
    last_valid_at: output.last_valid_at,
    usages: screensReferencingFeed(app.db, output.feed_id).map((screen) => ({
      screen_id: screen.id, screen_name: screen.name,
    })),
  }
}

function sourceOut(app: FastifyInstance, source: SourceRow) {
  const provider = builtInProvider(source.provider_id)
  const outputs = listOutputs(app.db, source.id).map((output) => outputOut(app, output))
  const usages = new Map<string, { screen_id: string; screen_name: string }>()
  for (const output of outputs) for (const usage of output.usages) usages.set(usage.screen_id, usage)
  return {
    id: source.id,
    name: source.name,
    provider: {
      id: source.provider_id,
      label: provider?.label ?? 'Unavailable provider',
      available: provider !== undefined && provider.package_id === source.package_id && provider.package_version === source.package_version,
    },
    config: safeConfig(source, provider),
    interval_s: source.interval_s,
    enabled: source.enabled === 1,
    health: healthOut(source),
    outputs,
    usages: [...usages.values()],
  }
}

function draftError(error: unknown, reply: FastifyReply) {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Source provider is unavailable') {
    return reply.code(400).send({ error: 'provider_unavailable', message: 'Source provider is unavailable.' })
  }
  if (message === 'Source setup is invalid' || message === 'Source name is required' || message === 'Source interval is invalid') {
    return reply.code(400).send({ error: 'setup_invalid', message: 'Source setup is invalid.' })
  }
  if (message === 'Could not protect source credentials') {
    return reply.code(500).send({ error: 'credential_storage_failed', message: 'Could not protect source credentials.' })
  }
  return reply.code(422).send({ error: 'test_failed', message: 'Could not test source data.' })
}

function checkedDraftOutputs(draft: NonNullable<ReturnType<typeof getDraft>>): CheckedOutput[] {
  const checked: CheckedOutput[] = []
  for (const output of draft.outputs) {
    if (output.result.mode === 'invalid' || output.result.mode === 'image') throw new Error('invalid draft output')
    checked.push({
      contract_id: output.contract_id as ContractId,
      result: output.result as SourceResult,
      capabilities: [...output.capabilities],
      content_hash: output.content_hash,
    })
  }
  return checked
}

function existingSecrets(app: FastifyInstance, source: SourceRow): Record<string, string> {
  const provider = builtInProvider(source.provider_id)
  if (!provider) throw new Error('provider unavailable')
  const declared = new Set(provider.setup.filter((field) => field.secret).map((field) => field.name))
  const values = Object.create(null) as Record<string, string>
  try {
    for (const secret of listSourceSecrets(app.db, source.id)) {
      if (declared.has(secret.name)) values[secret.name] = app.secretBox.open(secret.ciphertext)
    }
  } catch {
    throw new Error('credentials unavailable')
  }
  return values
}

export async function sourceAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { widget?: string } }>('/admin/api/source-choices', {
    schema: { querystring: {
      type: 'object', additionalProperties: false, required: ['widget'],
      properties: { widget: { type: 'string', minLength: 1, maxLength: 64 } },
    } },
  }, async (req, reply) => {
    const requirement = widgetRequirement(req.query.widget ?? '')
    const copy = WIDGET_COPY[req.query.widget ?? '']
    if (!requirement || !copy) return reply.code(400).send({ error: 'unsupported_widget', message: 'This widget has no source choices.' })

    const existing = []
    for (const source of listSources(app.db)) {
      const provider = builtInProvider(source.provider_id)
      for (const output of listOutputs(app.db, source.id)) {
        const compatibility = compatibleOutput(req.query.widget!, output.contract_id, output.capabilities)
        if (!compatibility.ok) continue
        existing.push({
          source_id: source.id,
          source_name: source.name,
          provider_id: source.provider_id,
          provider: provider?.label ?? 'Unavailable provider',
          output_id: output.id,
          feed_id: output.feed_id,
          contract_id: output.contract_id,
          capabilities: [...output.capabilities],
          missing_optional: compatibility.missing_optional,
          last_success_at: source.last_success_at,
        })
      }
    }

    const providers = BUILTIN_PROVIDERS.flatMap((provider) => {
      const compatible = provider.potential_outputs.flatMap((output) => {
        const result = compatibleOutput(req.query.widget!, output.contract_id, output.capabilities)
        return result.ok ? [{
          contract_id: output.contract_id,
          capabilities: [...output.capabilities],
          missing_optional: result.missing_optional,
        }] : []
      })
      return compatible.length === 0 ? [] : [{ ...providerOut(provider), compatible_outputs: compatible }]
    }).sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.label.localeCompare(right.label))

    return { widget: req.query.widget, ...copy, existing, providers }
  })

  app.get('/admin/api/providers', {
    schema: { querystring: emptyObjectSchema },
  }, async () => BUILTIN_PROVIDERS.map(providerOut))

  app.post<{ Body: DraftInput }>('/admin/api/source-drafts', {
    schema: { querystring: emptyObjectSchema, body: {
      type: 'object', additionalProperties: false,
      required: ['provider_id', 'name', 'config', 'secrets'],
      properties: {
        provider_id: { type: 'string', minLength: 1, maxLength: 100 },
        name: { type: 'string', minLength: 1, maxLength: 64 },
        config: recordSchema,
        secrets: recordSchema,
        interval_s: { type: 'integer', minimum: 1, maximum: 86_400 },
        supersedes: { type: 'string', pattern: DRAFT_ID, maxLength: 84 },
      },
    } },
  }, async (req, reply) => {
    try {
      return await testSourceDraft(req.body, {
        db: app.db, fetch: app.sourceFetch, secretBox: app.secretBox, now: Date.now(),
      })
    } catch (error) {
      return draftError(error, reply)
    }
  })

  app.delete<{ Params: { id: string } }>('/admin/api/source-drafts/:id', {
    schema: { params: idParams(DRAFT_ID), querystring: emptyObjectSchema },
  }, async (req, reply) => {
    if (hasUnexpectedBody(req.body)) return reply.code(400).send({ error: 'invalid_body', message: 'This action does not accept a body.' })
    if (!removeSourceDraft(app.db, req.params.id)) return reply.code(404).send({ error: 'not_found', message: 'Source draft was not found.' })
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/admin/api/source-drafts/:id/promote', {
    schema: { params: idParams(DRAFT_ID), querystring: emptyObjectSchema },
  }, async (req, reply) => {
    if (hasUnexpectedBody(req.body)) return reply.code(400).send({ error: 'invalid_body', message: 'This action does not accept a body.' })
    const draft = getDraft(app.db, req.params.id)
    if (!draft) return reply.code(404).send({ error: 'not_found', message: 'Source draft was not found.' })
    if (draft.expires_at <= Date.now()) {
      return reply.code(410).send({ error: 'draft_expired', message: 'Source draft expired.' })
    }
    let promoted
    try {
      promoted = promoteSourceDraft(app.db, draft.id, Date.now(), actorOf(req))
    } catch {
      return reply.code(409).send({ error: 'draft_invalid', message: 'Source draft could not be promoted.' })
    }
    announceOutputs(app, promoted.changed_feed_ids)
    return {
      source: sourceOut(app, promoted.source),
      outputs: promoted.outputs.map((output) => outputOut(app, output)),
    }
  })

  app.get('/admin/api/sources', {
    schema: { querystring: emptyObjectSchema },
  }, async () => listSources(app.db).map((source) => sourceOut(app, source)))

  app.patch<{ Params: { id: string }; Body: { name?: string; interval_s?: number; enabled?: boolean } }>(
    '/admin/api/sources/:id', {
      schema: {
        params: idParams(SOURCE_ID),
        querystring: emptyObjectSchema,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            interval_s: { type: 'integer', minimum: 1, maximum: 86_400 },
            enabled: { type: 'boolean' },
          },
        },
      },
    }, async (req, reply) => {
      let existing
      try {
        existing = getSource(app.db, req.params.id)
      } catch {
        return reply.code(500).send({ error: 'source_update_failed', message: 'Source update could not be completed.' })
      }
      if (!existing) return reply.code(404).send({ error: 'not_found', message: 'Source was not found.' })
      const provider = builtInProvider(existing.provider_id)
      if (req.body.interval_s !== undefined && provider && req.body.interval_s < provider.min_interval_s) {
        return reply.code(400).send({ error: 'interval_invalid', message: `Refresh interval must be at least ${provider.min_interval_s} seconds.` })
      }
      const patch: typeof req.body = {}
      if (req.body.name !== undefined && req.body.name !== existing.name) patch.name = req.body.name
      if (req.body.interval_s !== undefined && req.body.interval_s !== existing.interval_s) patch.interval_s = req.body.interval_s
      if (req.body.enabled !== undefined && Number(req.body.enabled) !== existing.enabled) patch.enabled = req.body.enabled
      if (Object.keys(patch).length === 0) return sourceOut(app, existing)

      let updated: SourceRow
      try {
        const actor = actorOf(req)
        updated = app.db.transaction(() => {
          const row = updateSource(app.db, existing.id, patch, Date.now(), actor)!
          if (patch.interval_s !== undefined) {
            for (const output of listOutputs(app.db, row.id)) {
              updateFeed(app.db, output.feed_id, { stale_after_s: row.interval_s * 3 }, actor)
            }
          }
          if (patch.enabled === false) {
            audit(app.db, actor.type, actor.id, 'source_paused', { source_id: row.id, provider_id: row.provider_id, state: row.state })
          } else if (patch.enabled === true) {
            audit(app.db, actor.type, actor.id, 'source_resumed', { source_id: row.id, provider_id: row.provider_id, state: row.state })
          }
          return row
        })()
      } catch {
        return reply.code(500).send({ error: 'source_update_failed', message: 'Source update could not be completed.' })
      }
      return sourceOut(app, updated)
    },
  )

  app.put<{ Params: { id: string }; Body: { config: Record<string, unknown>; secrets?: Record<string, unknown> } }>(
    '/admin/api/sources/:id/setup', {
      schema: {
        params: idParams(SOURCE_ID),
        querystring: emptyObjectSchema,
        body: {
          type: 'object', additionalProperties: false, required: ['config'],
          properties: { config: recordSchema, secrets: recordSchema },
        },
      },
    }, async (req, reply) => {
      const captured = getSource(app.db, req.params.id)
      if (!captured) return reply.code(404).send({ error: 'not_found', message: 'Source was not found.' })
      const provider = builtInProvider(captured.provider_id)
      if (!provider || provider.package_id !== captured.package_id || provider.package_version !== captured.package_version) {
        return reply.code(409).send({ error: 'provider_unavailable', message: 'Source provider is unavailable.' })
      }

      let secrets: Record<string, unknown>
      try {
        secrets = existingSecrets(app, captured)
      } catch {
        return reply.code(409).send({ error: 'credentials_unavailable', message: 'Stored source credentials could not be opened.' })
      }
      for (const [name, value] of Object.entries(req.body.secrets ?? {})) secrets[name] = value

      let view
      try {
        view = await testSourceDraft({
          provider_id: captured.provider_id,
          name: captured.name,
          config: req.body.config,
          secrets,
          interval_s: captured.interval_s,
        }, { db: app.db, fetch: app.sourceFetch, secretBox: app.secretBox, now: Date.now() })
      } catch (error) {
        return draftError(error, reply)
      }

      const draft = getDraft(app.db, view.id)
      if (!draft) return reply.code(409).send({ error: 'setup_conflict', message: 'Source setup changed while it was being tested.' })
      const actor = actorOf(req)
      let committed: { updated: SourceRow; changedFeedIds: string[] }
      try {
        committed = app.db.transaction(() => {
          const current = getSource(app.db, captured.id)
          if (!current || current.rev !== captured.rev) throw new Error('setup conflict')
          const checked = checkedDraftOutputs(draft)
          const beforeOutputs = outputSnapshots(app, current.id)
          const row = updateSource(app.db, current.id, { config: draft.config }, Date.now(), actor)!
          for (const stored of listSourceSecrets(app.db, row.id)) deleteSourceSecret(app.db, row.id, stored.name)
          for (const secret of draft.secrets) putSourceSecret(app.db, row.id, secret.name, secret.ciphertext, Date.now())
          for (const output of listOutputs(app.db, row.id)) {
            app.db.prepare('DELETE FROM feed_rows WHERE feed_id = ?').run(output.feed_id)
          }
          writeOutputs(app.db, row, checked, Date.now(), actor)
          const changedFeedIds = replacementChangedFeedIds(
            beforeOutputs,
            outputSnapshots(app, row.id),
          )
          recordRun(app.db, row.id, Date.now(), {
            state: 'healthy', status: 'Connection refreshed successfully.',
            next_run_at: row.enabled === 1 ? Date.now() + row.interval_s * 1_000 : null,
          })
          if (!deleteDraft(app.db, draft.id)) throw new Error('setup conflict')
          return { updated: getSource(app.db, row.id)!, changedFeedIds }
        })()
      } catch {
        removeSourceDraft(app.db, draft.id)
        return reply.code(409).send({ error: 'setup_conflict', message: 'Source setup changed while it was being tested.' })
      }
      announceOutputs(app, committed.changedFeedIds)
      return sourceOut(app, committed.updated)
    },
  )

  app.post<{ Params: { id: string } }>('/admin/api/sources/:id/refresh', {
    schema: { params: idParams(SOURCE_ID), querystring: emptyObjectSchema },
  }, async (req, reply) => {
    if (hasUnexpectedBody(req.body)) return reply.code(400).send({ error: 'invalid_body', message: 'This action does not accept a body.' })
    const source = getSource(app.db, req.params.id)
    if (!source) return reply.code(404).send({ error: 'not_found', message: 'Source was not found.' })
    if (source.enabled === 0) return reply.code(409).send({ error: 'source_paused', message: 'Resume this source before refreshing it.' })
    if (app.sourceRefreshes.has(source.id)) return reply.code(409).send({ error: 'refresh_in_flight', message: 'This source is already refreshing.' })
    app.sourceRefreshes.add(source.id)
    const actor = actorOf(req)
    try {
      try {
        await runSourceOnce(app.db, source.id, {
          fetch: app.sourceFetch,
          secretBox: app.secretBox,
          onFeedPush: (feedId) => app.dataPusher.onFeedPush(feedId),
        }, Date.now(), actor)
      } catch {
        return reply.code(500).send({ error: 'refresh_failed', message: 'Source refresh could not be completed.' })
      }
    } finally {
      app.sourceRefreshes.delete(source.id)
    }
    const refreshed = getSource(app.db, source.id)
    if (!refreshed) return reply.code(404).send({ error: 'not_found', message: 'Source was not found.' })
    audit(app.db, actor.type, actor.id, 'source_refreshed', {
      source_id: refreshed.id, provider_id: refreshed.provider_id, state: safeState(refreshed.state),
    })
    return sourceOut(app, refreshed)
  })

  app.delete<{ Params: { id: string } }>('/admin/api/sources/:id', {
    schema: { params: idParams(SOURCE_ID), querystring: emptyObjectSchema },
  }, async (req, reply) => {
    if (hasUnexpectedBody(req.body)) return reply.code(400).send({ error: 'invalid_body', message: 'This action does not accept a body.' })
    let result
    try {
      if (!getSource(app.db, req.params.id)) return reply.code(404).send({ error: 'not_found', message: 'Source was not found.' })
      result = deleteSource(app.db, req.params.id, actorOf(req))
    } catch {
      return reply.code(500).send({ error: 'source_delete_failed', message: 'Source deletion could not be completed.' })
    }
    if (!result.deleted) return reply.code(409).send({ error: 'source_in_use', screen_names: result.screenNames })
    return reply.code(204).send()
  })

  app.get<{ Querystring: { q?: string } }>('/admin/api/geocode', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: { q: { type: 'string', maxLength: 100 } },
    } },
  }, async (req, reply) => {
    const q = (req.query.q ?? '').trim()
    if (!q) return []
    try {
      return await geocodePlaces(q, {
        fetch: app.sourceFetch,
        now: Date.now(),
        // The provider boundary owns the deadline; this signal is the caller's, and nothing here
        // cancels it. It exists because a run context always carries one, not because the route
        // has a second timeout of its own to impose.
        signal: new AbortController().signal,
      })
    } catch (error) {
      // Whatever the geocoder said is not forwarded. A `SourceError` message is provider-safe
      // wording the boundary produced; anything else is unknown, and unknown does not get relayed
      // to a browser.
      return reply.code(502).send({
        error: error instanceof SourceError ? error.message : 'The place lookup could not be completed.',
      })
    }
  })
}
