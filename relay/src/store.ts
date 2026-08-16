import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Durable hub bindings close the documented TOFU race: persisting each hub_uid's secretHash
 * across relay restarts prevents the next HELLO_HUB claimant from re-fixing the secret. The
 * impostor window is limited to genuine first contact, which random 16-byte uids already defend.
 *
 * Bindings carry lastSeenAt and are pruned after PRUNE_AFTER_MS idle: persistence must not turn
 * the registration-flood weakness in socket.ts into permanent disk growth. A
 * living hub reconnects orders of magnitude more often than the window; a binding that has been
 * silent for 90 days is a dead hub or an attacker's litter, and either way the uid returns to
 * the same first-come pool a fresh uid lives in.
 *
 * One JSON file, written whole via tmp+rename (atomic on POSIX, same idiom as the meshtastic
 * integration's config store): registrations are rate-limited per address, so write volume is
 * bounded and a crash mid-write cannot truncate the previous state.
 */
export const PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000

export interface StoredBinding {
  secretHash: string
  lastSeenAt: number
}

export class RegistryStore {
  private bindings = new Map<string, StoredBinding>()

  constructor(private path: string, private now: () => number = Date.now) {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { hubs?: Record<string, StoredBinding> }
      for (const [uid, b] of Object.entries(raw.hubs ?? {})) {
        if (typeof b?.secretHash === 'string' && typeof b?.lastSeenAt === 'number') {
          this.bindings.set(uid, { secretHash: b.secretHash, lastSeenAt: b.lastSeenAt })
        }
      }
    } catch (err) {
      // Missing on first boot is normal; anything else must not stop the relay from serving —
      // degrading to "forgot everything" is exactly what every restart did before this store.
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error(`relay: state at ${this.path} unreadable (${err}); starting empty`)
      }
    }
    this.prune()
  }

  /** Live (non-pruned) bindings, for seeding a Registry at boot. */
  load(): ReadonlyMap<string, StoredBinding> {
    return this.bindings
  }

  /** Record a successful registration — new binding or a living hub's reconnect. */
  record(hubUid: string, secretHash: string): void {
    this.bindings.set(hubUid, { secretHash, lastSeenAt: this.now() })
    this.prune()
    this.save()
  }

  private prune(): void {
    const cutoff = this.now() - PRUNE_AFTER_MS
    for (const [uid, b] of this.bindings) {
      if (b.lastSeenAt < cutoff) this.bindings.delete(uid)
    }
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ hubs: Object.fromEntries(this.bindings) }))
    renameSync(tmp, this.path)
  }
}
