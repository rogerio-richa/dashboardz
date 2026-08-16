import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export interface AccountRecord {
  id: string
  label: string
  /**
   * Concurrent non-hub clients (senders today, devices once they cross the relay) this ACCOUNT
   * may hold across every token it owns. null = unlimited. It lives on the account, not the
   * token, because a user may mint one token per hub — a per-token cap would multiply their
   * allowance every time they minted another.
   */
  maxClients: number | null
  createdAt: number
}

export interface TokenRecord {
  id: string
  accountId: string
  createdAt: number
  note?: string
  revokedAt?: number
}

export interface ValidToken { accountId: string; label: string; maxClients: number | null }

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * `maxClients` is the entire enforcement mechanism, so a malformed value must not silently mean
 * "unlimited" (a `typeof === 'number'` check alone would let a NaN or a stray string through —
 * `typeof NaN === 'number'` is true, and every later `count >= NaN` comparison is false, i.e. no
 * cap at all). Returns `null` for explicit-unlimited (absent or JSON `null`), the parsed value for
 * a valid non-negative safe integer (0 included — a real, meaningful "no clients allowed"), or
 * `undefined` as a malformed sentinel so the caller can drop the whole account, same as a bad
 * label or createdAt.
 */
function parseMaxClients(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v
  return undefined
}

/**
 * Accounts and their hashed tokens in one JSON file, minted out-of-band (scripts/token.mjs today,
 * the portal later). The relay only ever answers "is this token good, whose is it, and what may
 * that account do" — who the account belongs to, and whether they paid, is the portal's business
 * and must never reach this process.
 *
 * Reloaded whenever the file's mtime moves, because the alternative is restarting the relay to
 * add one user, and a restart drops every live socket on the service.
 */
export class TokenStore {
  private accountsById = new Map<string, AccountRecord>()
  private tokensByHash = new Map<string, TokenRecord>()
  private mtimeMs = -1
  private warnedCodes = new Set<string>()

  constructor(private readonly path: string) {
    this.refresh()
  }

  validate(token: string): ValidToken | null {
    this.refresh()
    const tok = this.tokensByHash.get(hashToken(token))
    if (!tok || tok.revokedAt !== undefined) return null
    const acc = this.accountsById.get(tok.accountId)
    // An orphaned token (its account deleted) must fail closed: the cap lives on the account, so
    // honouring it would mean granting an unlimited allowance to a holder nobody can account for.
    if (!acc) return null
    return { accountId: acc.id, label: acc.label, maxClients: acc.maxClients }
  }

  accounts(): AccountRecord[] {
    this.refresh()
    return [...this.accountsById.values()].sort((a, b) => a.label.localeCompare(b.label))
  }

  account(accountId: string): AccountRecord | null {
    this.refresh()
    return this.accountsById.get(accountId) ?? null
  }

  private refresh(): void {
    let mtimeMs: number
    try {
      mtimeMs = statSync(this.path).mtimeMs
    } catch (err) {
      // Missing file means nothing issued yet — normal before the first mint, and never a reason
      // to stop serving. REQUIRE_TOKEN is what decides whether that locks everyone out. Anything
      // other than "missing" (e.g. EACCES) is indistinguishable from that at a glance, so it gets
      // one warning per distinct error code — otherwise REQUIRE_TOKEN=true turns into a silent
      // total outage with nothing in the logs to point at.
      this.warnUnreadable(err)
      this.accountsById.clear()
      this.tokensByHash.clear()
      this.mtimeMs = -1
      return
    }
    if (mtimeMs === this.mtimeMs) return
    this.mtimeMs = mtimeMs
    this.accountsById.clear()
    this.tokensByHash.clear()
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        accounts?: Record<string, Omit<AccountRecord, 'id'>>
        tokens?: Record<string, TokenRecord>
      }
      for (const [id, a] of Object.entries(raw.accounts ?? {})) {
        if (typeof a?.label !== 'string' || typeof a?.createdAt !== 'number') continue
        const maxClients = parseMaxClients(a.maxClients)
        // Malformed cap => drop the whole account, same as a bad label/createdAt. Its tokens then
        // fail closed through the existing orphaned-account path in validate().
        if (maxClients === undefined) continue
        this.accountsById.set(id, { id, label: a.label, maxClients, createdAt: a.createdAt })
      }
      for (const [hash, t] of Object.entries(raw.tokens ?? {})) {
        if (typeof t?.accountId === 'string' && typeof t?.id === 'string' && typeof t?.createdAt === 'number') {
          this.tokensByHash.set(hash, {
            id: t.id,
            accountId: t.accountId,
            createdAt: t.createdAt,
            ...(typeof t.note === 'string' ? { note: t.note } : {}),
            ...(typeof t.revokedAt === 'number' ? { revokedAt: t.revokedAt } : {}),
          })
        }
      }
    } catch (err) {
      // A half-written or hand-mangled file must not take the relay down. Empty means every token
      // fails validation, which REQUIRE_TOKEN turns into a loud, obvious outage rather than a
      // silent open door. A read failure here (as opposed to a JSON.parse SyntaxError, which has
      // no .code) gets the same one-warning-per-code treatment as the stat failure above.
      this.warnUnreadable(err)
    }
  }

  /**
   * Logs path + errno only — never file contents, never a token, hashed or otherwise. Deduped per
   * distinct error code so a relay running with a permanently-broken TOKENS_PATH logs once, not
   * once per validate() call. ENOENT is excluded: a missing file is a normal condition,
   * not a signal something is wrong.
   */
  private warnUnreadable(err: unknown): void {
    const code = (err as NodeJS.ErrnoException)?.code
    if (!code || code === 'ENOENT' || this.warnedCodes.has(code)) return
    this.warnedCodes.add(code)
    console.warn(`[TokenStore] cannot read ${this.path} (${code}) — treating as no accounts/tokens`)
  }
}
