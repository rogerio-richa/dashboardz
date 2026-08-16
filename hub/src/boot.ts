import type { FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import type { DB } from './db/index.js'
import { buildServer } from './server.js'
import { startTtlSweep } from './ttl.js'
import { startFeedStaleSweep } from './ws/feedStale.js'
import { startRelay, type StartRelayOpts } from './relay/bootstrap.js'
import type { SecretBox } from './secrets/box.js'
import { startSourceLoop } from './sources/loop.js'
import type { ProviderDefinition } from './sources/provider.js'
import { startDraftSweep } from './sources/drafts.js'

/**
 * The hub's actual boot sequence — extracted out of index.ts (a top-level script that runs its
 * side effects the instant it's imported, so it can never be exercised by a test directly) so
 * the real call order can be pinned by a fast, in-process test instead of only documented in
 * comments. `seams` exists purely so a test can inject a fake socket/scheduler for `startRelay`
 * and a short TTL interval, without index.ts itself knowing or caring — production never passes
 * it.
 *
 * Order matters and is exactly what shipped once broken: `startRelay` decorates the Fastify
 * instance, and Fastify forbids decorating one that has already started listening. It must run
 * before `app.listen(...)`, not after.
 */
export interface BootSeams extends Pick<StartRelayOpts, 'schedule' | 'connect'> {
  ttlIntervalMs?: number
  sourceIntervalMs?: number
  sourceClock?: () => number
  sourceProviderFor?: (providerId: string) => ProviderDefinition | undefined
  sourceJitter?: () => number
  draftIntervalMs?: number
}

export async function boot(
  config: Config,
  db: DB,
  secretBox: SecretBox,
  seams?: BootSeams,
): Promise<FastifyInstance> {
  const app = await buildServer({ config, db, secretBox })
  const relayManager = startRelay({ config, db, app, schedule: seams?.schedule, connect: seams?.connect })
  const stops: Array<() => void> = []
  app.addHook('onClose', async () => {
    for (const stop of [...stops].reverse()) stop()
  })
  await app.listen({ port: config.port, host: '0.0.0.0' })
  const draftSweep = startDraftSweep(db, { intervalMs: seams?.draftIntervalMs })
  stops.push(draftSweep.stop)
  // The sweep needs the relay manager so an expired *answerable* alert can report a timeout back
  // to whoever asked. The manager IS the sink now — with no relay configured (or no client dialed
  // yet) its sendReply() no-ops, identical behaviour to passing `undefined` before this existed.
  // `relay` is a required property precisely so dropping it here becomes a compile error rather
  // than a silent production-only failure (see TtlSweepOpts).
  stops.push(startTtlSweep(db, app.registry, {
    relay: relayManager,
    intervalMs: seams?.ttlIntervalMs,
    retention: {
      alertsDays: config.retentionAlertsDays, alertsSource: config.retentionAlertsDaysSource ?? 'default',
      auditDays: config.retentionAuditDays, auditSource: config.retentionAuditDaysSource ?? 'default',
    },
  }))
  // Stale-feed sweep (staleness) — a dead cron only shows up as an aging feed, so the hub
  // has to notice on its own. No seam needed here: unlike the TTL sweep it isn't exercised
  // against a driven fake clock in boot.test.ts, only startFeedStaleSweep's own unit tests via
  // its exposed run(now).
  const staleSweep = startFeedStaleSweep(db, app.registry, {})
  stops.push(staleSweep.stop)
  // The one collection runtime (hub collection): the hub filling feeds for itself on a timer. `onFeedPush` is
  // not optional decoration — it is how a board learns there is new data, exactly as the sender
  // HTTP route calls it after every push. Without it sources would fill the database on schedule
  // while every screen sat frozen on whatever it was showing when it connected.
  //
  // The immediate pass is intentionally fire-and-forget; startSourceLoop's in-flight guard owns
  // later ticks. There is no second loop beside it any more — the v18 connector runtime this used
  // to run in parallel with is gone, and its rows were migrated into `source_instances` at v19.
  const sourceLoop = startSourceLoop(db, {
    fetch: app.sourceFetch,
    secretBox: app.secretBox,
    onFeedPush: (feedId) => app.dataPusher.onFeedPush(feedId),
    providerFor: seams?.sourceProviderFor,
    jitter: seams?.sourceJitter,
    clock: seams?.sourceClock,
    onError: (sourceId) => console.warn('source scheduler run failed', sourceId ?? 'due query'),
  }, { intervalMs: seams?.sourceIntervalMs })
  stops.push(sourceLoop.stop)
  return app
}
