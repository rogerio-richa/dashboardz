import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { DB } from '../db/index.js'
import { audit } from '../db/audit.js'
import { getSetting } from '../db/settings.js'
import { getOrCreateIdentity } from './identity.js'
import { RelayClient, type RelayClientOpts, type RelaySocket } from './client.js'
import { handleRelayDeliver } from './handler.js'
import { RELAY_TOKEN_SETTING, RelayManager } from './manager.js'

declare module 'fastify' {
  interface FastifyInstance {
    // Optional on the TYPE only: production boot always decorates it, but tests that build the
    // server without startRelay() (admin.test.ts hits /admin/api/config that way) must not 500.
    relayManager?: RelayManager
  }
}

export interface StartRelayOpts {
  config: Pick<Config, 'relayUrl'>
  db: DB
  app: FastifyInstance
  schedule?: RelayClientOpts['schedule']
  connect?: RelayClientOpts['connect']
  now?: RelayClientOpts['now']
  testConnect?: (url: string) => RelaySocket
  testSchedule?: (ms: number, fn: () => void) => void
  testTimeoutMs?: number
}

/**
 * Decorates the hub's relay manager — ALWAYS, configured or not, because runtime configuration
 * means the decoration can no longer wait for a URL to exist. What stays conditional is
 * everything with a side effect: with no stored URL and no RELAY_URL to import, constructing
 * the manager touches no socket and no relay_identity row (identity is lazy behind makeClient).
 *
 * MUST be called before `app.listen(...)`. [pre-listen guard comment from the old file survives
 * verbatim here — decoration post-listen is FST_ERR_DEC_AFTER_START.]
 */
export function startRelay(opts: StartRelayOpts): RelayManager {
  if (opts.app.server.listening) {
    throw new Error(
      'startRelay() must be called before app.listen() — it decorates the Fastify instance, ' +
      'and Fastify forbids decorating one that has already started listening.',
    )
  }

  const makeClient = (url: string): RelayClient => {
    const identity = getOrCreateIdentity(opts.db)
    // Read fresh on every client build (initial connect, or a setUrl()-triggered redial) so a
    // just-saved token rides on the very next dial rather than waiting for a process restart.
    const accountToken = getSetting(opts.db, RELAY_TOKEN_SETTING) ?? undefined
    // `client` is referenced inside onDeliver, which cannot run until start() has connected
    // and the relay has sent READY — long after this const is bound.
    const client: RelayClient = new RelayClient({
      url,
      identity,
      accountToken,
      onDeliver: (connId, payload) => handleRelayDeliver(opts.app, client, connId, payload),
      schedule: opts.schedule,
      connect: opts.connect,
      now: opts.now,
      // 'system'/'relay': the unattended transport acting as itself (see AdminActor).
      onEvent: (ev) => audit(opts.db, 'system', 'relay',
        ev.type === 'ready' ? 'relay_ready' : 'relay_terminal',
        ev.type === 'ready' ? { hub_uid: identity.hubUid } : { hub_uid: identity.hubUid, code: ev.code }),
    })
    return client
  }

  const manager = new RelayManager({
    db: opts.db,
    envUrl: opts.config.relayUrl ?? null,
    makeClient,
    getIdentity: () => getOrCreateIdentity(opts.db),
    testConnect: opts.testConnect,
    testSchedule: opts.testSchedule,
    testTimeoutMs: opts.testTimeoutMs,
  })
  opts.app.decorate('relayManager', manager)
  const st = manager.status()
  // `st.configured` guards this: status() can now return non-null with no client
  // at all in the defense-in-depth stale-token case (RelayStatus.configured), which must not be
  // announced as "connecting" — there is no dial happening and hub_uid would print empty.
  if (st?.configured) console.log(`relay: connecting as ${st.hub_uid}`)
  return manager
}
