import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { ingestNotify } from '../src/db/alerts.js'
import { runSweep, startTtlSweep, type RetentionGate } from '../src/ttl.js'
import { DeviceRegistry } from '../src/ws/registry.js'
import { writeRetentionDays, SETTINGS_KEY_ALERTS_DAYS } from '../src/db/retentionSettings.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** A fresh fixture: one device, one sender, a registry, and a helper to raise an alert. */
function setup() {
  const db = openDb(':memory:')
  const dev = redeemPairingCode(db, createPairingCode(db, 'panel', 0).code, 1)!.device.id
  const snd = createSender(db, 's', []).sender.id
  const registry = new DeviceRegistry()
  const raise = (title: string, now: number) =>
    ingestNotify(db, { senderId: snd, title, severity: 'info', targetDevices: [dev] }, now).alert
  return { db, dev, snd, registry, raise }
}

function freshGate(): RetentionGate {
  return { lastRunAt: 0 }
}

describe('runSweep retention pass', () => {
  it('deletes a concluded alert and its deliveries once older than the alerts cutoff', () => {
    const { db, registry, raise } = setup()
    const alert = raise('old, concluded', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert.id)

    const now = 1000 + 91 * DAY_MS // past the 90-day default
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeUndefined()
    expect(db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(alert.id)).toBeUndefined()
  })

  it('never deletes an active alert, however old', () => {
    const { db, registry, raise } = setup()
    const alert = raise('old, still active', 1000)
    // status stays 'active' — ingestNotify's default.

    const now = 1000 + 91 * DAY_MS
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare('SELECT status FROM alerts WHERE id = ?').get(alert.id)).toEqual({ status: 'active' })
    expect(db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').get(alert.id)).toBeDefined()
  })

  it('keeps a concluded alert younger than the alerts cutoff', () => {
    const { db, registry, raise } = setup()
    const alert = raise('young, concluded', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert.id)

    const now = 1000 + 10 * DAY_MS // well inside the 90-day default
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeDefined()
  })

  it('prunes audit_log rows by their own cutoff', () => {
    const { db, registry } = setup()
    db.prepare('INSERT INTO audit_log (ts, actor_type, actor_id, event, details) VALUES (?, ?, ?, ?, ?)')
      .run(1000, 'system', null, 'old_event', '{}')

    const now = 1000 + 181 * DAY_MS // past the 180-day default
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare("SELECT * FROM audit_log WHERE event = 'old_event'").get()).toBeUndefined()
  })

  it('keeps audit_log rows younger than the audit cutoff', () => {
    const { db, registry } = setup()
    db.prepare('INSERT INTO audit_log (ts, actor_type, actor_id, event, details) VALUES (?, ?, ?, ?, ?)')
      .run(1000, 'system', null, 'recent_event', '{}')

    const now = 1000 + 10 * DAY_MS
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare("SELECT * FROM audit_log WHERE event = 'recent_event'").get()).toBeDefined()
  })

  it('alertsDays: 0 keeps concluded alerts forever', () => {
    const { db, registry, raise } = setup()
    const alert = raise('ancient, concluded', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert.id)

    const now = 1000 + 10 * 365 * DAY_MS
    runSweep(db, registry, now, undefined, {
      alertsDays: 0, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeDefined()
  })

  it('auditDays: 0 keeps audit_log rows forever', () => {
    const { db, registry } = setup()
    db.prepare('INSERT INTO audit_log (ts, actor_type, actor_id, event, details) VALUES (?, ?, ?, ?, ?)')
      .run(1000, 'system', null, 'ancient_event', '{}')

    const now = 1000 + 10 * 365 * DAY_MS
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 0, gate: freshGate(), force: true,
    })

    expect(db.prepare("SELECT * FROM audit_log WHERE event = 'ancient_event'").get()).toBeDefined()
  })

  it('audits one retention_swept summary row when a pass deletes something', () => {
    const { db, registry, raise } = setup()
    const alert = raise('old, concluded', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert.id)

    const now = 1000 + 91 * DAY_MS
    runSweep(db, registry, now, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    const row = db.prepare("SELECT details FROM audit_log WHERE event = 'retention_swept'").get() as { details: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row!.details)).toEqual({ alerts: 1, audit: 0 })
  })

  it('writes no retention_swept row when a forced pass deletes nothing', () => {
    const { db, registry, raise } = setup()
    raise('young, still active', 1000)

    runSweep(db, registry, 5000, undefined, {
      alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
    })

    expect(db.prepare("SELECT * FROM audit_log WHERE event = 'retention_swept'").get()).toBeUndefined()
  })

  it('does not run retention on every tick — only once per hour', () => {
    const { db, registry, raise } = setup()
    const alert1 = raise('old, concluded #1', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert1.id)

    const gate = freshGate()
    const base = 1000 + 91 * DAY_MS
    const retention = { alertsDays: 90, auditDays: 180, gate }

    // First sweep: gate is fresh (lastRunAt: 0), realistic `now` is far past an hour since epoch,
    // so the gate lets it through — one alert gets pruned.
    runSweep(db, registry, base, undefined, retention)
    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert1.id)).toBeUndefined()

    // A second concluded alert appears, then a second sweep 30 minutes later — inside the same
    // hourly window as the first pass. The gate must block it: this alert survives the sweep.
    const alert2 = raise('old, concluded #2', base)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert2.id)
    runSweep(db, registry, base + 30 * 60 * 1000, undefined, retention)
    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert2.id)).toBeDefined()

    // Only one retention_swept audit row, from the first pass.
    const rows = db.prepare("SELECT * FROM audit_log WHERE event = 'retention_swept'").all()
    expect(rows).toHaveLength(1)
  })

  it('runs again once the hourly gate has elapsed', () => {
    const { db, registry, raise } = setup()
    const gate = freshGate()
    const base = 1000 + 91 * DAY_MS
    const retention = { alertsDays: 90, auditDays: 180, gate }

    runSweep(db, registry, base, undefined, retention)

    // Old enough to already be past the alerts cutoff by the time the second sweep runs.
    const alert2 = raise('old, concluded, also old enough', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert2.id)
    runSweep(db, registry, base + HOUR_MS + 1, undefined, retention)

    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert2.id)).toBeUndefined()
  })

  it('a failed retention pass logs a warn and never throws, and the TTL sweep proper still runs', () => {
    const { db, registry, snd, dev } = setup()
    const { alert } = ingestNotify(db, {
      senderId: snd, title: 'expires soon', severity: 'info', ttl_s: 10, targetDevices: [dev],
    }, 1000)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const originalPrepare = db.prepare.bind(db)
    const boom = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM deliveries WHERE alert_id IN')) throw new Error('boom')
      return originalPrepare(sql)
    })
    try {
      expect(() => runSweep(db, registry, 1000 + 11_000, undefined, {
        alertsDays: 90, auditDays: 180, gate: freshGate(), force: true,
      })).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      boom.mockRestore()
      warn.mockRestore()
    }

    // The ordinary TTL expiry for the alert (unrelated to retention) still happened, proving the
    // retention failure was contained rather than aborting the sweep as a whole.
    expect(db.prepare('SELECT status FROM alerts WHERE id = ?').get(alert.id)).toEqual({ status: 'expired' })
  })

  it('skips retention entirely when no retention options are passed (existing TTL-only callers)', () => {
    const { db, registry, raise } = setup()
    const alert = raise('old, concluded', 1000)
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert.id)

    runSweep(db, registry, 1000 + 365 * DAY_MS)

    expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeDefined()
  })
})

describe('startTtlSweep resolves retention from the settings table live', () => {
  it('a settings-row edit written mid-run takes effect on the very next tick, with no restart', () => {
    vi.useFakeTimers()
    try {
      const { db, registry, raise } = setup()
      const alert = raise('old, concluded', Date.now())
      db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alert.id)

      // A coarse interval (one tick per week) keeps this test to two fires of the timer instead
      // of thousands — the gate is satisfied trivially either way since a week is far past an
      // hour, and only the *sequence* of ticks (with an edit between them) matters here.
      const WEEK_MS = 7 * DAY_MS
      const stop = startTtlSweep(db, registry, {
        relay: undefined,
        intervalMs: WEEK_MS,
        retention: { alertsDays: 90, alertsSource: 'default', auditDays: 180, auditSource: 'default' },
      })
      try {
        // First tick: the hourly gate is fresh (lastRunAt starts at 0) and `now` is huge, so it
        // runs — but under the 90-day env/default policy the alert (7 days old) survives.
        vi.advanceTimersByTime(WEEK_MS)
        expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeDefined()

        // An admin edit lands mid-run — no restart, no re-wiring of startTtlSweep.
        writeRetentionDays(db, SETTINGS_KEY_ALERTS_DAYS, 5, Date.now())

        // Second tick, one week later (alert now 14 days old): past the new 5-day cutoff, nowhere
        // near the stale 90-day one. If the sweep were still using the value captured at boot,
        // the alert would survive for another ~76 days. It does not.
        vi.advanceTimersByTime(WEEK_MS)
        expect(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id)).toBeUndefined()
      } finally {
        stop()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
