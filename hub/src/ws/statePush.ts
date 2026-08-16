import type { DB } from '../db/index.js'
import type { DeviceRegistry } from './registry.js'
import { buildState } from './stateBuilder.js'
import { getDevice, listDevices } from '../db/devices.js'
import { audit } from '../db/audit.js'
import { getWireAlert, ingestNotify } from '../db/alerts.js'

interface Entry {
  rev: number
  pushedScreenIds: string[]        // what the STATE actually carried, in order
  ackedRev: number
  ackedScreenIds: string[]
  activeScreenId: string | null    // last TAB receipt; in-memory like acks
  warned: boolean
  timer?: NodeJS.Timeout
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000

/**
 * Owns the STATE push path (STATE acknowledgment). Per-device rev + ack state live in
 * memory only — a reconnect always gets a fresh STATE and re-acks, so persistence would be
 * wrong, not just unnecessary. Never fatal, never blocks the push path (house invariant).
 */
export class StatePusher {
  private entries = new Map<string, Entry>()
  private readonly ackTimeoutMs: number

  constructor(
    private db: DB,
    private registry: DeviceRegistry,
    opts: { ackTimeoutMs?: number } = {},
  ) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
  }

  push(deviceId: string): void {
    if (!this.registry.isOnline(deviceId)) return
    const device = getDevice(this.db, deviceId)
    if (!device) return
    const prev = this.entries.get(deviceId)
    if (prev?.timer) clearTimeout(prev.timer)
    const rev = (prev?.rev ?? 0) + 1
    const built = buildState(this.db, device, Date.now(), rev)
    const entry: Entry = {
      rev,
      // What the STATE message actually carried, not the device's assigned tabs: buildState omits
      // a screen when the stored grid is unparseable (house rule: bad data never crashes a read),
      // so an assigned-but-corrupt screen must not be "what was pushed" for ack comparison.
      // `screens` (tab state+) carries the full ordered tab set when present; a pre-tabs STATE (or
      // one degraded to a single screen) falls back to the lone `screen`.
      pushedScreenIds: built.screens?.map((s) => s.id) ?? (built.screen ? [built.screen.id] : []),
      ackedRev: prev?.ackedRev ?? 0,
      ackedScreenIds: prev?.ackedScreenIds ?? [],
      // Client-local tab switches are independent of STATE pushes/acks — a device that already
      // reported it's on tab B keeps reporting that through a fresh push, same as an ack survives.
      activeScreenId: prev?.activeScreenId ?? null,
      warned: false,
    }
    this.registry.send(deviceId, built)
    entry.timer = setTimeout(() => {
      if (entry.ackedRev < rev && !entry.warned) {
        entry.warned = true
        // The house invariant is "never fatal, never blocks the push path" — this callback runs
        // outside deviceSocket's swallowing try/catch, so a self-alert failure here (e.g. a
        // corrupted senders table) must not crash the process. `warned` above already stands, so
        // rendering() still reports 'warning' even if the notification itself is lost.
        try {
          audit(this.db, 'system', null, 'state_ack_timeout', { device_id: deviceId, rev })
          this.raiseWarn(deviceId, `Device "${device.name}" did not confirm its screen`)
        } catch (err) {
          console.warn(`state-ack warn path failed for ${deviceId}:`, err)
        }
      }
    }, this.ackTimeoutMs)
    entry.timer.unref?.()
    this.entries.set(deviceId, entry)
  }

  /**
   * `legacy` distinguishes a pre-tabs client (single `screen_id`, ⇒ `screenIds` is that id or
   * `[]`) from a tab-aware one sending the full set it now renders. Load-bearing compat rule: a
   * legacy ack against a multi-tab push is compared against tab 0 ONLY — a shipped Android build
   * that has no concept of "the other tabs" must never start warning just because the hub started
   * pushing more than one screen.
   */
  onAck(deviceId: string, rev: number, screenIds: string[], legacy: boolean): void {
    const entry = this.entries.get(deviceId)
    if (!entry || rev < entry.ackedRev) return
    entry.ackedRev = rev
    entry.ackedScreenIds = screenIds
    if (rev >= entry.rev) {
      if (entry.timer) clearTimeout(entry.timer)
      // Compare against what was actually pushed (entry.pushedScreenIds), not the device's
      // current tab list: a corrupt-grid degrade means the STATE the client honestly acked
      // never carried the assigned screen(s) in the first place — that is not a mismatch.
      const expected = entry.pushedScreenIds
      const matches = legacy
        ? screenIds[0] === (expected[0] ?? null) || (screenIds.length === 0 && expected.length === 0)
        : screenIds.length === expected.length && expected.every((id) => screenIds.includes(id))
      if (!matches) {
        if (!entry.warned) {
          entry.warned = true
          // Same guard as the timeout path above: onAck is called straight out of
          // deviceSocket's message handler, but only that handler's own try/catch protects
          // it — a throw here must not escape onAck and crash the process.
          try {
            audit(this.db, 'system', null, 'state_ack_mismatch', {
              device_id: deviceId, rev, acked_screen_ids: screenIds, expected_screen_ids: expected,
            })
            const name = getDevice(this.db, deviceId)?.name ?? deviceId
            this.raiseWarn(deviceId, `Device "${name}" is rendering the wrong screen`)
          } catch (err) {
            console.warn(`state-ack warn path failed for ${deviceId}:`, err)
          }
        }
      } else {
        entry.warned = false
      }
    }
  }

  /** Client-local tab switch receipt (screen state) — no ack/warn semantics, just the latest report. */
  onTab(deviceId: string, screenId: string): void {
    const entry = this.entries.get(deviceId)
    if (entry) entry.activeScreenId = screenId
  }

  rendering(deviceId: string): {
    state: 'ok' | 'pending' | 'warning'
    acked_screen_id: string | null
    active_screen_id: string | null
  } | null {
    const entry = this.entries.get(deviceId)
    if (!entry) return null
    const state = entry.warned ? 'warning' : entry.ackedRev >= entry.rev ? 'ok' : 'pending'
    // acked_screen_id is ackedScreenIds[0] (tab 0), not "whatever the client says its active tab
    // is" — both known set-ackers (this file's legacy branch, static/device/device.js) put tab 0
    // first in the screen_ids they send, so this is a stable, meaningful compat value rather than
    // an arbitrary pick.
    return { state, acked_screen_id: entry.ackedScreenIds[0] ?? null, active_screen_id: entry.activeScreenId }
  }

  drop(deviceId: string): void {
    const entry = this.entries.get(deviceId)
    if (entry?.timer) clearTimeout(entry.timer)
    this.entries.delete(deviceId)
  }

  /**
   * Self-alert via the reserved snd_hub sender (schema v4), deduped per device so a flapping
   * device can't spam (the active-plugin source-loss pattern). Targets every OTHER
   * device — alerting the device that isn't applying state on that same device is useless. With
   * no other device to tell, the admin chip + audit row are the record.
   */
  private raiseWarn(deviceId: string, title: string): void {
    const targets = listDevices(this.db).map((d) => d.id).filter((id) => id !== deviceId)
    if (targets.length === 0) return
    const { alert } = ingestNotify(this.db, {
      senderId: 'snd_hub', title, severity: 'warn', sound: false, ttl_s: 3600,
      dedup_key: `state_ack:${deviceId}`, targetDevices: targets,
    }, Date.now())
    const wire = getWireAlert(this.db, alert.id)
    if (wire) this.registry.sendMany(targets, { type: 'ALERT_ADD', alert: wire })
  }
}
