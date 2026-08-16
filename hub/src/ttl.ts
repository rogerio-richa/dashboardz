import type { DB } from './db/index.js'
import type { DeviceRegistry } from './ws/registry.js'
import { sweepExpired } from './db/alerts.js'
import { audit } from './db/audit.js'
import { sweepRetention, type RetentionConfig, type RetentionResult } from './db/retention.js'
import { resolveRetentionConfig, type RetentionEnvConfig } from './db/retentionSettings.js'
import { emitRelayOutcome, type RelayReplySink } from './relay/handler.js'
import { pushTabStatus } from './ws/tabStatus.js'

/**
 * The retention pass's own "last ran at" clock, carried across ticks the same way
 * `feedStale.ts`'s `wasStale` map is: a value a caller holds in a closure and passes back in on
 * every call, rather than module-level state that would leak between an in-process hub and a
 * test file's unrelated `it()` blocks. `startTtlSweep` owns exactly one of these for the process's
 * whole lifetime; a test constructs its own to control the gate directly.
 */
export interface RetentionGate {
  lastRunAt: number
}

const RETENTION_GATE_MS = 60 * 60 * 1000

export interface RetentionSweepOpts extends RetentionConfig {
  gate: RetentionGate
  /** Bypasses the hourly gate — for tests that want to assert on a single pass's effect. */
  force?: boolean
}

export interface TtlSweepOpts {
  /**
   * Required, and required to be spelled out even when there is nothing to pass — write
   * `{ relay: undefined }` for a hub with no relay.
   *
   * This was an optional positional parameter, and that was a mistake worth recording: dropping
   * it at the call site in `boot.ts` compiled cleanly, type-checked cleanly, and left the whole
   * suite green, while in production relay timeouts silently stopped being delivered forever.
   * An optional argument cannot distinguish "deliberately none" from "forgot"; a required one
   * turns the same omission into a compile error. `boot.test.ts` pins the behaviour too, because
   * a caller can still pass `undefined` by accident — but this makes the accident deliberate.
   */
  relay: RelayReplySink | undefined
  intervalMs?: number
  /**
   * Same "spelled out on purpose" reasoning as `relay` — retention policy is config-driven, not a
   * knob to forget wiring. This is only the env/default FALLBACK layer (what `config.ts` resolved
   * at boot): `startTtlSweep` re-derives the actual effective value from the `settings` table on
   * every single pass (`resolveRetentionConfig`), so an admin UI edit takes effect on the very
   * next tick — no restart, and no caching of the resolved number across ticks the way this
   * fallback itself is cached for the process's lifetime.
   */
  retention: RetentionEnvConfig
}

export function startTtlSweep(db: DB, registry: DeviceRegistry, opts: TtlSweepOpts): () => void {
  const gate: RetentionGate = { lastRunAt: 0 }
  const timer = setInterval(() => {
    const resolved = resolveRetentionConfig(db, opts.retention)
    runSweep(db, registry, Date.now(), opts.relay, {
      alertsDays: resolved.alertsDays, auditDays: resolved.auditDays, gate,
    })
  }, opts.intervalMs ?? 15_000)
  timer.unref()
  return () => clearInterval(timer)
}

export function runSweep(
  db: DB, registry: DeviceRegistry, now = Date.now(), relay?: RelayReplySink,
  retention?: RetentionSweepOpts,
): void {
  const expiredAlerts = sweepExpired(db, now)
  for (const expired of expiredAlerts) {
    registry.sendMany(expired.target_devices, { type: 'ALERT_REMOVE', id: expired.id, reason: 'expired' })
    audit(db, 'system', null, 'alert_expired', { alert_id: expired.id })

    // Timeout is a first-class outcome, not an error — but only for
    // an alert that actually asked something and that nobody answered. An alert with no options
    // asked no question, so "nobody answered" is meaningless; and an alert some device already
    // answered has had its one outcome, so a timeout on top would be a second, contradictory
    // one. sweepExpired flips status off 'active' in the same transaction that selects these
    // rows, which is what makes this fire at most once per alert.
    if (expired.reply_to && expired.options?.length && !expired.answered) {
      emitRelayOutcome(db, relay, expired.id, { event: 'timeout', at: now })
    }
  }
  // Only re-derive and broadcast the dots when the sweep actually changed something — an empty
  // sweep (the common case, run every 15s) has nothing new to say.
  if (expiredAlerts.length > 0) pushTabStatus(db, registry)

  if (retention) maybeSweepRetention(db, now, retention)
}

/**
 * Retention is deliberately NOT part of the TTL sweep's own transaction or try/catch: it runs
 * after, and its own failure is contained here so it can never turn a routine 15s tick into a
 * missed alert expiry. "Never fatal" (house rule) — a retention failure is a warn, not a crash,
 * and not even a skipped TTL pass, since by the time this runs the TTL work above already
 * happened.
 *
 * The gate is checked in wall-clock terms against `now`, not against real elapsed time — the
 * same clock the sweep itself is driven by (`startTtlSweep` passes `Date.now()`; tests pass
 * whatever they like), so a test can fast-forward the gate exactly the way it fast-forwards TTL
 * expiry.
 */
function maybeSweepRetention(db: DB, now: number, retention: RetentionSweepOpts): void {
  if (!retention.force && now - retention.gate.lastRunAt < RETENTION_GATE_MS) return
  retention.gate.lastRunAt = now
  try {
    doRetentionSweep(db, now, retention)
  } catch (err) {
    console.warn('retention sweep failed', err)
  }
}

/** The actual delete pass plus its conditional summary audit row — shared by the gated periodic pass above and the ungated forced sweep below, so "only audit when something moved" can never drift between the two callers. */
function doRetentionSweep(db: DB, now: number, config: RetentionConfig): RetentionResult {
  const result = sweepRetention(db, now, config)
  if (result.alerts > 0 || result.audit > 0) {
    audit(db, 'system', null, 'retention_swept', result)
  }
  return result
}

/**
 * `POST /admin/api/retention/sweep`'s "Sweep now" — the hourly gate bypassed entirely (not just
 * forced-through-the-gate the way `RetentionSweepOpts.force` is for a periodic pass; there is no
 * gate object here at all, because this is a one-shot call with no `startTtlSweep` closure to
 * carry one). Not wrapped in the periodic pass's try/catch: a forced sweep is a direct admin
 * action with a response the operator is looking at, so a failure should reach them as a 500,
 * not a silent console.warn indistinguishable from success.
 */
export function forceRetentionSweep(db: DB, now: number, config: RetentionConfig): RetentionResult {
  return doRetentionSweep(db, now, config)
}
