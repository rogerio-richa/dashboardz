import type { AdminActor } from '../db/audit.js'
import type { DB } from '../db/index.js'
import { getSource, listSourceSecrets, recordRun, type SourceRow } from '../db/sources.js'
import type { SecretBox } from '../secrets/box.js'
import { SourceError } from './errors.js'
import type { ProviderDefinition } from './provider.js'
import { builtInProvider } from './registry.js'
import { checkProducedOutputs, InvalidSourceOutputError, writeOutputs } from './writeOutputs.js'

const MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000

export interface SourceRunDeps {
  fetch: typeof fetch
  secretBox: SecretBox
  onFeedPush: (feedId: string) => void
  providerFor?: (providerId: string) => ProviderDefinition | undefined
  /** Returns a deterministic value in [-1, 1]; zero disables the +/-10% retry jitter. */
  jitter?: () => number
}

type Failure = {
  state: 'authentication_required' | 'rate_limited' | 'invalid_output' | 'degraded'
  status: string
  retryAt?: number
}

function backoffAt(source: SourceRow, now: number, jitter: () => number): number {
  const exponent = Math.min(source.failure_count, 30)
  const uncapped = source.interval_s * 1_000 * 2 ** exponent
  const capped = Math.min(MAX_BACKOFF_MS, uncapped)
  const sample = Math.max(-1, Math.min(1, jitter()))
  return now + Math.max(1, Math.min(MAX_BACKOFF_MS, Math.round(capped * (1 + sample * 0.1))))
}

function failureFor(error: unknown): Failure {
  if (error instanceof InvalidSourceOutputError) {
    return {
      state: 'invalid_output',
      status: 'The provider returned invalid data; check this connection.',
    }
  }
  if (error instanceof SourceError) {
    if (error.code === 'authentication_required') {
      return {
        state: 'authentication_required',
        status: "Authentication is required; update this connection's credentials.",
      }
    }
    if (error.code === 'rate_limited') {
      return {
        state: 'rate_limited',
        status: 'The provider is rate limiting this connection; retry is scheduled.',
        retryAt: error.retryAt,
      }
    }
    if (error.code === 'unreachable') {
      return {
        state: 'degraded',
        status: 'The provider could not be reached; retry is scheduled.',
      }
    }
    return {
      state: 'degraded',
      status: 'The provider returned an unusable response; retry is scheduled.',
    }
  }
  return {
    state: 'degraded',
    status: 'The provider failed to return usable data; retry is scheduled.',
  }
}

function currentRevision(db: DB, sourceId: string, rev: number): SourceRow | undefined {
  const current = getSource(db, sourceId)
  return current?.rev === rev && current.enabled === 1 ? current : undefined
}

function recordFailure(db: DB, captured: SourceRow, failure: Failure, deps: SourceRunDeps, now: number): void {
  db.transaction(() => {
    const current = currentRevision(db, captured.id, captured.rev)
    if (!current) return
    const retryAt = failure.retryAt === undefined
      ? backoffAt(current, now, deps.jitter ?? (() => Math.random() * 2 - 1))
      : Math.max(now, failure.retryAt)
    recordRun(db, current.id, now, {
      state: failure.state,
      status: failure.status,
      next_run_at: retryAt,
    })
  })()
}

function openSecrets(db: DB, source: SourceRow, secretBox: SecretBox): Readonly<Record<string, string>> {
  const secrets: Record<string, string> = Object.create(null) as Record<string, string>
  try {
    for (const stored of listSourceSecrets(db, source.id)) secrets[stored.name] = secretBox.open(stored.ciphertext)
  } catch {
    throw new SourceError('authentication_required', 'Stored credentials could not be opened')
  }
  return Object.freeze(secrets)
}

/** Runs one source immediately; due-time filtering belongs to the loop and manual refresh may call this directly. */
export async function runSourceOnce(
  db: DB, sourceId: string, deps: SourceRunDeps, now: number,
  actor: AdminActor = { type: 'admin', id: null },
): Promise<void> {
  const captured = getSource(db, sourceId)
  if (!captured || captured.enabled === 0) return

  let checked
  try {
    const secrets = openSecrets(db, captured, deps.secretBox)
    const provider = (deps.providerFor ?? builtInProvider)(captured.provider_id)
    if (!provider || provider.package_id !== captured.package_id || provider.package_version !== captured.package_version) {
      throw new Error('Provider is unavailable')
    }
    const controller = new AbortController()
    const produced = await provider.run(
      { config: captured.config, secrets },
      { fetch: deps.fetch, now, signal: controller.signal },
    )
    checked = checkProducedOutputs(provider, produced)
  } catch (error) {
    recordFailure(db, captured, failureFor(error), deps, now)
    return
  }

  const changed = db.transaction(() => {
    const current = currentRevision(db, captured.id, captured.rev)
    if (!current) return undefined
    const changedFeedIds = writeOutputs(db, current, checked, now, actor)
    recordRun(db, current.id, now, {
      state: 'healthy',
      status: 'Connection refreshed successfully.',
      next_run_at: now + current.interval_s * 1_000,
    })
    return changedFeedIds
  })()

  if (!changed) return
  for (const feedId of changed) deps.onFeedPush(feedId)
}
