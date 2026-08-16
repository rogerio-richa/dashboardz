import type { DB } from './index.js'
import { newId } from '../ids.js'

export type Severity = 'info' | 'warn' | 'critical'

export interface AlertOption { id: string; label: string }

/** Where an answer or timeout for a relayed alert has to be sent back to. */
export interface ReplyTo { conn_id: string; req_id: string }

export interface AlertRow {
  id: string; sender_id: string; title: string; body: string | null
  severity: Severity; sound: number; ttl_s: number | null; dedup_key: string | null
  created_at: number; updated_at: number; expires_at: number | null
  update_count: number; status: string; target_devices: string; options: string | null
  reply_to: string | null
}

export interface WireAlert {
  id: string; title: string; body: string | null; severity: Severity
  sender: { id: string; name: string }; sound: boolean
  created_at: number; updated_at: number; update_count: number; expires_at: number | null
  silenced?: boolean; options: AlertOption[] | null
}

export interface NotifyInput {
  senderId: string; title: string; body?: string; severity: Severity
  sound?: boolean; ttl_s?: number; dedup_key?: string; targetDevices: string[]
  options?: AlertOption[]
  /** Set only for alerts that arrived over the relay; local senders leave it undefined. */
  replyTo?: ReplyTo
}

/**
 * Whether the SENDER is asking for audio. `warn` and `critical` ask by default and may opt out;
 * `info` cannot ask at all.
 *
 * Info alerts ignore `sound: true`; routine audibility is the receiving end's call, expressed as
 * `sound_info` on the alert_feed widget and off by default. The room decides whether it wants to
 * hear routine traffic rather than the sender deciding for it.
 */
function resolveSound(severity: Severity, override: boolean | undefined): number {
  if (severity === 'info') return 0
  return (override ?? true) ? 1 : 0
}

/**
 * A critical has no expiry. It is an alarm: it stays on screen and keeps sounding until a person
 * dismisses it, which is the whole difference between an alarm and a notification. Storing NULL
 * rather than special-casing the sweep keeps the intent visible in the row itself — nothing is
 * "due" that was never given a deadline.
 *
 * The consequence is deliberate and worth stating: an answerable critical never emits a timeout
 * outcome, so a sender waiting on a reply waits until a human acts.
 */
function resolveExpiry(severity: Severity, ttlS: number | undefined, now: number): number | null {
  if (severity === 'critical') return null
  return ttlS ? now + ttlS * 1000 : null
}

export function ingestNotify(db: DB, input: NotifyInput, now: number): { alert: AlertRow; updated: boolean } {
  const expires_at = resolveExpiry(input.severity, input.ttl_s, now)
  const sound = resolveSound(input.severity, input.sound)
  const optionsJson = input.options ? JSON.stringify(input.options) : null

  if (input.dedup_key) {
    const existing = db.prepare(
      "SELECT * FROM alerts WHERE sender_id = ? AND dedup_key = ? AND status = 'active'",
    ).get(input.senderId, input.dedup_key) as AlertRow | undefined
    if (existing) {
      // A dedup update is new information from the sender's point of view, so it must
      // re-surface on every target device the same way a live ALERT_ADD push does — including
      // devices that had already silenced or dismissed the previous occurrence.
      //
      // `reply_to` is pointedly NOT in the UPDATE below. The first requester owns the reply
      // channel: a later duplicate — possibly from a different sender connection entirely —
      // must not redirect the answer the original asker is still waiting on. The duplicate does
      // get its own synchronous ok/alert_id ack; what it does not get is the outcome event.
      const applyUpdate = db.transaction(() => {
        db.prepare(`UPDATE alerts SET title = ?, body = ?, severity = ?, sound = ?, ttl_s = ?,
                    expires_at = ?, updated_at = ?, update_count = update_count + 1, options = ? WHERE id = ?`)
          .run(input.title, input.body ?? null, input.severity, sound, input.ttl_s ?? null,
            expires_at, now, optionsJson, existing.id)
        db.prepare('UPDATE deliveries SET dismissed_at = NULL, silenced_at = NULL WHERE alert_id = ?')
          .run(existing.id)
      })
      applyUpdate()
      const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(existing.id) as AlertRow
      return { alert, updated: true }
    }
  }

  const alert: AlertRow = {
    id: newId('alr'), sender_id: input.senderId, title: input.title, body: input.body ?? null,
    severity: input.severity, sound, ttl_s: input.ttl_s ?? null, dedup_key: input.dedup_key ?? null,
    created_at: now, updated_at: now, expires_at, update_count: 0, status: 'active',
    target_devices: JSON.stringify(input.targetDevices), options: optionsJson,
    reply_to: input.replyTo ? JSON.stringify(input.replyTo) : null,
  }
  const insertAll = db.transaction(() => {
    db.prepare(`INSERT INTO alerts (id, sender_id, title, body, severity, sound, ttl_s, dedup_key,
                created_at, updated_at, expires_at, update_count, status, target_devices, options,
                reply_to)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(alert.id, alert.sender_id, alert.title, alert.body, alert.severity, alert.sound,
        alert.ttl_s, alert.dedup_key, alert.created_at, alert.updated_at, alert.expires_at,
        alert.update_count, alert.status, alert.target_devices, alert.options, alert.reply_to)
    const ins = db.prepare('INSERT INTO deliveries (alert_id, device_id) VALUES (?, ?)')
    for (const deviceId of input.targetDevices) ins.run(alert.id, deviceId)
  })
  insertAll()
  return { alert, updated: false }
}

// Same standing rule as elsewhere in the hub (see ws/deviceSocket.ts): bad data already in the
// database — malformed JSON, or valid JSON of the wrong shape — must never crash a read path.
// It shouldn't be possible for `options` to end up that way given how ingestNotify writes it,
// but toWireAlert is not the place to bet on that.
function parseOptions(raw: string | null): AlertOption[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as AlertOption[]) : null
  } catch {
    return null
  }
}

/**
 * Same standing rule as `parseOptions`: bad data already in the database must never crash a read
 * path, and a `reply_to` that is not a well-formed `{conn_id, req_id}` pair is unusable anyway —
 * routing an answer at a garbage conn_id is strictly worse than not routing it.
 */
function parseReplyTo(raw: string | null): ReplyTo | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { conn_id, req_id } = parsed as { conn_id?: unknown; req_id?: unknown }
    return typeof conn_id === 'string' && typeof req_id === 'string' ? { conn_id, req_id } : null
  } catch {
    return null
  }
}

export function getReplyTo(db: DB, alertId: string): ReplyTo | null {
  const r = db.prepare('SELECT reply_to FROM alerts WHERE id = ?')
    .get(alertId) as { reply_to: string | null } | undefined
  return parseReplyTo(r?.reply_to ?? null)
}

export function toWireAlert(row: AlertRow, senderName: string, silenced = false): WireAlert {
  return {
    id: row.id, title: row.title, body: row.body, severity: row.severity,
    sender: { id: row.sender_id, name: senderName }, sound: row.sound === 1,
    created_at: row.created_at, updated_at: row.updated_at,
    update_count: row.update_count, expires_at: row.expires_at,
    silenced, options: parseOptions(row.options),
  }
}

const ACTIVE_JOIN = `
  SELECT a.*, s.name AS sender_name FROM alerts a
  JOIN senders s ON s.id = a.sender_id`

export function activeWireAlertsForDevice(db: DB, deviceId: string, now: number): WireAlert[] {
  // Deliberately not built on ACTIVE_JOIN: this is the only query that needs the per-device
  // delivery's silenced_at, since a silenced-but-not-dismissed alert must be re-surfaced as
  // silenced on reconnect (STATE) rather than dropped or resetting to unsilenced.
  const rows = db.prepare(`
    SELECT a.*, s.name AS sender_name, d.silenced_at FROM alerts a
    JOIN senders s ON s.id = a.sender_id
    JOIN deliveries d ON d.alert_id = a.id AND d.device_id = ?
    WHERE a.status = 'active' AND d.dismissed_at IS NULL
      AND (a.expires_at IS NULL OR a.expires_at > ?)
    ORDER BY a.updated_at DESC`).all(deviceId, now) as (AlertRow & { sender_name: string; silenced_at: number | null })[]
  return rows.map((r) => toWireAlert(r, r.sender_name, r.silenced_at != null))
}

export function getWireAlert(db: DB, alertId: string): WireAlert | undefined {
  const r = db.prepare(`${ACTIVE_JOIN} WHERE a.id = ? AND a.status = 'active'`)
    .get(alertId) as (AlertRow & { sender_name: string }) | undefined
  return r ? toWireAlert(r, r.sender_name) : undefined
}

export function recordAck(db: DB, alertId: string, deviceId: string, stage: 'delivered' | 'displayed', now: number): void {
  const col = stage === 'delivered' ? 'delivered_at' : 'displayed_at'
  db.prepare(`UPDATE deliveries SET ${col} = COALESCE(${col}, ?) WHERE alert_id = ? AND device_id = ?`)
    .run(now, alertId, deviceId)
}

// Shared by recordTap's dismiss branch and a successful recordAnswer: once every target device
// has concluded this alert — explicitly dismissed, or answered, which recordAnswer also stamps
// as a dismissal for that device — the alert as a whole transitions from 'active' to 'dismissed'.
function concludeIfAllDevicesDone(db: DB, alertId: string): { fullyDismissed: boolean } {
  const conclude = db.transaction(() => {
    const remaining = db.prepare(
      'SELECT COUNT(*) AS n FROM deliveries WHERE alert_id = ? AND dismissed_at IS NULL',
    ).get(alertId) as { n: number }
    if (remaining.n === 0) {
      db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alertId)
      return { fullyDismissed: true }
    }
    return { fullyDismissed: false }
  })
  return conclude()
}

export function recordTap(db: DB, alertId: string, deviceId: string, action: 'silence' | 'dismiss', now: number): { fullyDismissed: boolean } {
  const col = action === 'silence' ? 'silenced_at' : 'dismissed_at'
  db.prepare(`UPDATE deliveries SET ${col} = COALESCE(${col}, ?) WHERE alert_id = ? AND device_id = ?`)
    .run(now, alertId, deviceId)
  if (action === 'silence') return { fullyDismissed: false }
  return concludeIfAllDevicesDone(db, alertId)
}

export function recordAnswer(
  db: DB, alertId: string, deviceId: string, optionId: string, now: number,
): { ok: true } | { ok: false; reason: 'unknown_option' | 'already_answered' | 'not_delivered' } {
  const row = db.prepare('SELECT options FROM alerts WHERE id = ?')
    .get(alertId) as { options: string | null } | undefined
  // Validate against what this alert actually offers: a device must not be able to submit an
  // option that was never presented, including one removed by a later dedup update. Reuses the
  // same malformed-JSON-safe parser toWireAlert uses, since this now also runs from contexts
  // other than the socket handler's outer try/catch.
  const options = parseOptions(row?.options ?? null) ?? []
  if (!options.some((o) => o.id === optionId)) return { ok: false, reason: 'unknown_option' }

  // Recording an answer also concludes this alert for this device, the same as an explicit
  // dismiss (COALESCE so an earlier explicit dismiss's timestamp is preserved, not overwritten).
  // Without this, a reconnect's STATE rebuild — which filters on dismissed_at, not answered_at —
  // would resurrect an alert this device already answered, and re-answering it would only be
  // refused as already_answered, leaving the device with no way to clear it.
  const changed = db.prepare(
    `UPDATE deliveries SET answer = ?, answered_at = ?, dismissed_at = COALESCE(dismissed_at, ?)
     WHERE alert_id = ? AND device_id = ? AND answered_at IS NULL`,
  ).run(optionId, now, now, alertId, deviceId).changes
  // The WHERE clause makes first-answer-wins atomic rather than a read-then-write race.
  if (changed === 0) {
    // Zero rows changed for one of two different reasons, and the caller needs to
    // tell them apart: either this device already answered, or this alert was never delivered
    // to it at all (e.g. a forged/stale device id) — the latter was never "already answered".
    const delivered = db.prepare('SELECT 1 FROM deliveries WHERE alert_id = ? AND device_id = ?')
      .get(alertId, deviceId)
    return { ok: false, reason: delivered ? 'already_answered' : 'not_delivered' }
  }
  concludeIfAllDevicesDone(db, alertId)
  return { ok: true }
}

/**
 * What a sender may learn about its own question: "an agent that asks a question needs the
 * answer back on the same credential it asked with"). Scoped hard to the asking sender — a caller
 * holding a different sender's token gets `null`, indistinguishable from an id that never existed.
 */
export interface AlertAnswerView {
  state: 'pending' | 'answered' | 'dismissed' | 'expired'
  option_id?: string
  option_label?: string
  answered_at?: number
  device_id?: string
}

export function alertAnswerForSender(db: DB, alertId: string, senderId: string): AlertAnswerView | null {
  const alert = db.prepare('SELECT sender_id, status, options FROM alerts WHERE id = ?')
    .get(alertId) as { sender_id: string; status: string; options: string | null } | undefined
  if (!alert || alert.sender_id !== senderId) return null

  // Earliest answer wins for reporting, mirroring recordAnswer's per-device first-answer-wins:
  // on a multi-device alert two devices can each record an answer, and the sender should hear
  // the one that actually happened first, not whichever row the query walks last.
  const ans = db.prepare(
    `SELECT device_id, answer, answered_at FROM deliveries
     WHERE alert_id = ? AND answered_at IS NOT NULL ORDER BY answered_at LIMIT 1`,
  ).get(alertId) as { device_id: string; answer: string; answered_at: number } | undefined

  if (ans) {
    // The answered check runs BEFORE the status check on purpose: recordAnswer concludes the
    // alert (status 'dismissed'), and an answered-then-concluded question is still "answered".
    const label = (parseOptions(alert.options) ?? []).find((o) => o.id === ans.answer)?.label
    return {
      state: 'answered', option_id: ans.answer, option_label: label,
      answered_at: ans.answered_at, device_id: ans.device_id,
    }
  }
  if (alert.status === 'active') return { state: 'pending' }
  // 'dismissed' with no answer is a real outcome, distinct from a timeout: a human saw the
  // question and cleared it without choosing. Senders get to know that rather than polling a
  // pending state forever.
  return { state: alert.status === 'expired' ? 'expired' : 'dismissed' }
}

/**
 * Sender-initiated resolve-by-dedup-key (netdata integration: a CLEAR notification "resolves
 * via dedup_key `netdata:$ND_HOST:$ND_ALARM`"). Lands on the same terminal status
 * `concludeIfAllDevicesDone` gives a fully-dismissed alert — `alerts.status` has a fixed CHECK
 * (`'active' | 'expired' | 'dismissed'`), and a sender resolving its own alert is conceptually the
 * same conclusion a device dismissing it reaches, just triggered from the other end. It is
 * caller-triggered rather than time-triggered like `sweepExpired`, and only ever touches at most
 * one row: the sender's own active alert for this dedup_key, if it has one right now.
 *
 * Absence is not an error: a CLEAR for a dedup_key the hub isn't holding active (never seen,
 * already resolved, expired, or already dismissed) is expected traffic from a dispatcher that
 * doesn't track hub-side state, so the caller gets `resolved: false` back rather than a 404.
 */
export function resolveAlertByDedupKey(
  db: DB, senderId: string, dedupKey: string,
): { resolved: false } | { resolved: true; id: string; target_devices: string[] } {
  const resolve = db.transaction(() => {
    const row = db.prepare(
      "SELECT id, target_devices FROM alerts WHERE sender_id = ? AND dedup_key = ? AND status = 'active'",
    ).get(senderId, dedupKey) as { id: string; target_devices: string } | undefined
    if (!row) return { resolved: false as const }
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(row.id)
    return { resolved: true as const, id: row.id, target_devices: JSON.parse(row.target_devices) as string[] }
  })
  return resolve()
}

/**
 * Same standing rule as `parseOptions` and `parseReplyTo`: `target_devices` is written as a JSON
 * array of ids, and a row that somehow isn't one must degrade to "no targets" rather than throw on
 * a read path. "No targets" is also a real state — see the stranded alerts `sweepExpired` documents
 * — so the empty array is a truthful answer here, not a swallowed error.
 */
function parseTargetDevices(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** One target device's state for an alert, as an operator needs to read it. */
export interface ActiveAlertDevice {
  id: string
  name: string
  delivered: boolean
  /** Sound stopped, alert still standing — the half-action that strands an alert. */
  silenced: boolean
  dismissed: boolean
}

/**
 * An active alert as the admin console shows it: what it says, who raised it, and where it stands
 * on each device it was aimed at.
 *
 * Deliberately NOT `WireAlert`. That shape answers "what should this panel display right now" and
 * is scoped to one device's delivery; this one answers "what is still holding a tab lit, and why
 * has nobody concluded it" — a question only an operator asks, across every device at once.
 */
export interface ActiveAlertView {
  id: string
  title: string
  body: string | null
  severity: Severity
  sender: { id: string; name: string }
  created_at: number
  updated_at: number
  update_count: number
  expires_at: number | null
  dedup_key: string | null
  /**
   * In the order the alert was aimed at them, and only devices that still exist. An empty array on
   * an active alert means STRANDED: nothing on any panel can ever conclude it (see `sweepExpired`).
   */
  devices: ActiveAlertDevice[]
}

/**
 * Every alert still holding a tab dot lit, newest first.
 *
 * This is the read half of the operator's escape hatch. Before it existed, an active alert was
 * visible only as a coloured dot on a panel with no way to ask what it was — a critical can remain
 * active after being silenced without a hold-to-dismiss, and an untouched info with no `ttl_s`
 * remains active on its own.
 */
export function listActiveAlerts(db: DB): ActiveAlertView[] {
  const rows = db.prepare(`${ACTIVE_JOIN} WHERE a.status = 'active' ORDER BY a.updated_at DESC, a.id DESC`)
    .all() as (AlertRow & { sender_name: string })[]
  // One statement, re-run per alert: the console holds a handful of active alerts at a time (that
  // is the whole point of the page), so a per-row query is cheaper to read than a join to unpack.
  const deliveriesFor = db.prepare(`
    SELECT d.device_id, v.name, d.delivered_at, d.silenced_at, d.dismissed_at
    FROM deliveries d JOIN devices v ON v.id = d.device_id
    WHERE d.alert_id = ?`)
  return rows.map((r) => {
    const byDevice = new Map((deliveriesFor.all(r.id) as {
      device_id: string; name: string
      delivered_at: number | null; silenced_at: number | null; dismissed_at: number | null
    }[]).map((d) => [d.device_id, d]))
    return {
      id: r.id, title: r.title, body: r.body, severity: r.severity,
      sender: { id: r.sender_id, name: r.sender_name },
      created_at: r.created_at, updated_at: r.updated_at, update_count: r.update_count,
      expires_at: r.expires_at, dedup_key: r.dedup_key,
      // Driven by target_devices rather than by the delivery rows, so the order an operator sees
      // is the order the alert was actually aimed at, and a deleted device simply drops out.
      devices: parseTargetDevices(r.target_devices).flatMap((id) => {
        const d = byDevice.get(id)
        return d ? [{
          id, name: d.name,
          delivered: d.delivered_at !== null,
          silenced: d.silenced_at !== null,
          dismissed: d.dismissed_at !== null,
        }] : []
      }),
    }
  })
}

/**
 * Operator-initiated dismissal: the one lever that clears an alert without a panel or a sender's
 * token. Lands on the same terminal status a fully-dismissed or sender-resolved alert reaches.
 *
 * Unlike `resolveAlertByDedupKey`, this also stamps every delivery. It has to: a device rebuilds
 * its alerts on reconnect from `status = 'active' AND dismissed_at IS NULL`, and an operator saying
 * "this is over" is a statement about every device at once, not about one sender's dedup key.
 * COALESCE preserves the moment a device concluded it on its own — that timestamp is evidence of
 * what a person did at the panel, and overwriting it would erase the incident's own record.
 *
 * Absence is not an error, for the same reason it isn't in `resolveAlertByDedupKey`: an operator
 * clearing a row a panel concluded a second earlier is expected, not a failure.
 */
export function dismissAlertById(
  db: DB, alertId: string, now: number,
): { dismissed: false } | { dismissed: true; id: string; target_devices: string[] } {
  const dismiss = db.transaction(() => {
    const row = db.prepare(
      "SELECT id, target_devices FROM alerts WHERE id = ? AND status = 'active'",
    ).get(alertId) as { id: string; target_devices: string } | undefined
    if (!row) return { dismissed: false as const }
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(row.id)
    db.prepare('UPDATE deliveries SET dismissed_at = COALESCE(dismissed_at, ?) WHERE alert_id = ?')
      .run(now, row.id)
    return { dismissed: true as const, id: row.id, target_devices: parseTargetDevices(row.target_devices) }
  })
  return dismiss()
}

export interface ExpiredAlert {
  id: string
  target_devices: string[]
  /** Non-null only for relayed alerts — where a timeout outcome has somewhere to go. */
  reply_to: ReplyTo | null
  /** Null or empty means the alert asked nothing, so "nobody answered" is not an outcome. */
  options: AlertOption[] | null
  /** True if some device already answered. Then the outcome was the answer, not a timeout. */
  answered: boolean
}

export function sweepExpired(db: DB, now: number): ExpiredAlert[] {
  const sweep = db.transaction(() => {
    // reply_to / options / answered ride along on the same pass rather than being re-queried per
    // expired alert: this is the only moment an alert is guaranteed to be swept exactly once
    // (the UPDATE below moves it off 'active'), so it is also the only safe place to decide
    // whether a timeout outcome is owed.
    /*
     * Two ways an active alert is done: its TTL elapsed, or every device it was aimed at is gone.
     *
     * The second is not a new policy — it is the existing one carried to its end. A NULL
     * `expires_at` means "lives until a device concludes it", a promise that only holds while some
     * device exists to do the concluding. Once the last target is deleted the alert is not
     * long-lived, it is STRANDED: invisible to the TTL clause below (NULL never satisfies
     * `expires_at <= ?`), undeliverable, and impossible to ack or dismiss.
     *
     * A device rename can leave an active alert aimed at a stale `scr_`-prefixed id when no
     * migration rewrites `alerts.target_devices`. Nothing surfaces such an alert and nothing can
     * conclude it, so the query treats an alert with no live target as STRANDED.
     *
     * `json_each` over `target_devices` rather than a string match: the column is a JSON array, and
     * "no element of it resolves to a live device" is exactly the question. An alert keeps living
     * while even ONE target survives — a partial fan-out is still deliverable.
     */
    const due = db.prepare(`
      SELECT a.id, a.target_devices, a.reply_to, a.options,
             EXISTS (SELECT 1 FROM deliveries d WHERE d.alert_id = a.id AND d.answered_at IS NOT NULL) AS answered
      FROM alerts a
      WHERE a.status = 'active' AND (
        (a.expires_at IS NOT NULL AND a.expires_at <= ?)
        OR NOT EXISTS (
          SELECT 1 FROM json_each(a.target_devices) t
          JOIN devices d ON d.id = t.value
        )
      )`)
      .all(now) as { id: string; target_devices: string; reply_to: string | null; options: string | null; answered: number }[]
    const mark = db.prepare("UPDATE alerts SET status = 'expired' WHERE id = ?")
    for (const a of due) mark.run(a.id)
    return due.map((a) => ({
      id: a.id,
      target_devices: JSON.parse(a.target_devices) as string[],
      reply_to: parseReplyTo(a.reply_to),
      options: parseOptions(a.options),
      answered: a.answered === 1,
    }))
  })
  return sweep()
}
