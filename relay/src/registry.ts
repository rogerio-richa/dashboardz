import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RegistryStore } from './store.js'

/** The only thing the registry needs from a connection. Keeps it testable without sockets. */
export interface Sink {
  send(data: string): void
}

interface HubEntry {
  secretHash: string
  sink?: Sink
}

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

interface SenderEntry {
  hubUid: string
  sink: Sink
}

export class Registry {
  private hubs = new Map<string, HubEntry>()
  private senders = new Map<string, SenderEntry>()
  private accounts = new Map<string, string>()   // hubUid -> accountId

  /**
   * With a store, bindings survive the process: the documented restart race (a restart forgot
   * every secretHash, so the next claimant re-fixed the secret) is closed for every uid the
   * store still remembers. Without one, behavior is exactly as before — in-memory, per-process.
   */
  constructor(private store?: RegistryStore) {
    if (store) {
      for (const [uid, b] of store.load()) this.hubs.set(uid, { secretHash: b.secretHash })
    }
  }

  /**
   * Trust-on-first-use. The first hub to claim a uid fixes its secret; everyone after must
   * match. This is what lets the relay have no accounts and no admin — the price is that a
   * uid claimed by an attacker before the real hub connects stays claimed, which is why
   * hub_uid is 16 random bytes rather than anything guessable.
   */
  registerHub(hubUid: string, secret: string, sink: Sink): { ok: true } | { ok: false; reason: 'bad_secret' } {
    const existing = this.hubs.get(hubUid)
    if (!existing) {
      const secretHash = hash(secret)
      this.hubs.set(hubUid, { secretHash, sink })
      this.store?.record(hubUid, secretHash)
      return { ok: true }
    }
    if (!constantTimeEquals(existing.secretHash, hash(secret))) {
      return { ok: false, reason: 'bad_secret' }
    }
    existing.sink = sink
    // A reconnect is proof of life: refresh lastSeenAt so a living hub never ages out of the
    // store's prune window.
    this.store?.record(hubUid, existing.secretHash)
    return { ok: true }
  }

  attachSender(hubUid: string, sink: Sink): string {
    const connId = `conn_${randomBytes(9).toString('base64url')}`
    this.senders.set(connId, { hubUid, sink })
    return connId
  }

  hubSink(hubUid: string): Sink | undefined {
    return this.hubs.get(hubUid)?.sink
  }

  senderSink(connId: string): Sink | undefined {
    return this.senders.get(connId)?.sink
  }

  /** Attributes a hub uid to an account for as long as the binding lives; null clears it. */
  setHubAccount(hubUid: string, accountId: string | null): void {
    if (accountId === null) this.accounts.delete(hubUid)
    else this.accounts.set(hubUid, accountId)
  }

  hubAccount(hubUid: string): string | null {
    return this.accounts.get(hubUid) ?? null
  }

  /**
   * Snapshot of hubs/senders bucketed by account, everything unattributed (no token presented,
   * or requireToken off) under `anonymous`. The cap check in socket.ts reads `.senders` here for
   * the account owning the hub a HELLO_SENDER targets — counted across every hub that account
   * owns, not just the one hub_uid, which is what makes the cap per-account rather than per-hub.
   */
  counts(): {
    accounts: Record<string, { hubs: number; hubsOnline: number; senders: number }>
    anonymous: { hubs: number; hubsOnline: number; senders: number }
  } {
    const accounts: Record<string, { hubs: number; hubsOnline: number; senders: number }> = {}
    const anonymous = { hubs: 0, hubsOnline: 0, senders: 0 }
    const bucketFor = (accountId: string | null) => {
      if (accountId === null) return anonymous
      let b = accounts[accountId]
      if (!b) {
        b = { hubs: 0, hubsOnline: 0, senders: 0 }
        accounts[accountId] = b
      }
      return b
    }

    for (const [uid, entry] of this.hubs) {
      const b = bucketFor(this.hubAccount(uid))
      b.hubs += 1
      if (entry.sink !== undefined) b.hubsOnline += 1
    }
    for (const { hubUid } of this.senders.values()) {
      bucketFor(this.hubAccount(hubUid)).senders += 1
    }
    return { accounts, anonymous }
  }

  isHubOnline(hubUid: string): boolean {
    return this.hubs.get(hubUid)?.sink !== undefined
  }

  /**
   * Identity-scoped: only clears the slot if this exact socket still owns it. A reconnect
   * followed by the old socket's delayed close must not evict the healthy new connection.
   */
  detachHub(hubUid: string, sink: Sink): void {
    const entry = this.hubs.get(hubUid)
    if (entry && entry.sink === sink) entry.sink = undefined
  }

  detachSender(connId: string): void {
    this.senders.delete(connId)
  }
}
