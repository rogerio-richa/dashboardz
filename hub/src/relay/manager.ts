import type { DB } from '../db/index.js'
import { deleteSetting, getSetting, setSetting } from '../db/settings.js'
import {
  CLOSE_BAD_SECRET, CLOSE_TOKEN_REQUIRED, realSocket,
  type RelayClient, type RelayLastError, type RelaySocket,
} from './client.js'
import type { RelayIdentity } from './identity.js'

/** The settings-table key. Absent = no relay; the env var is only ever an import source. */
export const RELAY_URL_SETTING = 'relay_url'

/**
 * The settings-table key for the hub's relay account token. Absent = no token, which is
 * indistinguishable from "this relay doesn't require one" — the hub never guesses. The token
 * itself is never returned by any route; only `token_set` (RelayStatus below) says whether one is stored.
 */
export const RELAY_TOKEN_SETTING = 'relay_token'

/** Exactly the shape GET /admin/api/relay returns, plus `token_set` to indicate a stored token. */
export interface RelayStatus {
  state: 'offline' | 'connecting' | 'ready'
  terminal: boolean
  url: string
  hub_uid: string
  connected_since: number | null
  last_error: RelayLastError | null
  /** Whether a relay account token is stored — never the token value itself. */
  token_set: boolean
  /**
   * False only in the defense-in-depth branch of status() below: no client is running (nothing
   * configured to connect to) but a token row still exists in settings anyway. That combination
   * should be unreachable through the app's own API — clear() deletes both rows together — but
   * status() must never silently hide a stored credential just because there's no live
   * connection to report next to it. `url`/`hub_uid` are empty and `state` is 'offline' in that
   * case; the admin UI treats it as "off, but a token is still stored" rather than a real
   * connection (a stale token could otherwise ride silently onto whatever
   * relay was configured next).
   */
  configured: boolean
}

/**
 * The closed set of test-dial failures. The admin UI keeps plain-words copy for every code
 * (RelayBadge.tsx TEST_ERROR_COPY); hub/test/relay-error-copy.test.ts pins all four lexically.
 */
export const RELAY_TEST_FAILURES = ['unreachable', 'bad_secret', 'timeout', 'token_required'] as const
export type RelayTestFailure = (typeof RELAY_TEST_FAILURES)[number]
export type RelayTestResult = { ok: true } | { ok: false; code: RelayTestFailure }

export interface RelayManagerOpts {
  db: DB
  /** config.relayUrl — already ws/wss-validated by config.ts, or null. */
  envUrl: string | null
  /**
   * Builds a fully-wired client (deliver handler, audit observer, test seams) for a URL. The
   * manager owns WHEN clients exist; bootstrap owns HOW one is wired — including identity,
   * which stays lazy behind this factory so an unconfigured hub never touches relay_identity.
   */
  makeClient: (url: string) => RelayClient
  now?: () => number
  /** Seams for test(); production uses the real socket and a real 5 s timer. */
  testConnect?: (url: string) => RelaySocket
  testSchedule?: (ms: number, fn: () => void) => void
  testTimeoutMs?: number
  /** Identity for test dials; defaults are provided by bootstrap. Unused until test() runs. */
  getIdentity?: () => RelayIdentity
}

/**
 * Owns the hub's one relay connection across runtime reconfiguration. Decorated on the Fastify
 * instance at boot unconditionally (the decoration must happen pre-listen; the URL can change
 * any time after), replacing the boot-only startRelay() null-or-client contract.
 */
export class RelayManager {
  private client: RelayClient | null = null

  constructor(private readonly opts: RelayManagerOpts) {
    const url = this.resolveInitialUrl()
    if (url !== null) {
      this.client = opts.makeClient(url)
      this.client.start()
    }
  }

  /** DB wins; a set env var is imported exactly once (no DB row yet) and ignored ever after. */
  private resolveInitialUrl(): string | null {
    const stored = getSetting(this.opts.db, RELAY_URL_SETTING)
    if (stored !== null) {
      if (this.opts.envUrl !== null) {
        console.warn(
          'relay: RELAY_URL is set but ignored — the relay is configured in the admin UI ' +
          '(remove the env var to silence this)',
        )
      }
      return stored
    }
    if (this.opts.envUrl !== null) {
      setSetting(this.opts.db, RELAY_URL_SETTING, this.opts.envUrl, (this.opts.now ?? Date.now)())
      // Any token row present here is stale by construction: there was no URL row yet, so this
      // token — if one somehow exists (a manual DB edit, a leftover from before the URL row was
      // cleared some other way) — was minted for whatever relay it last pointed at, not this
      // freshly-imported one. Same rule setUrl() enforces on a normal address change: a token
      // never rides onto a different relay than the one it was issued for.
      deleteSetting(this.opts.db, RELAY_TOKEN_SETTING)
      console.log('relay: imported RELAY_URL into settings; the env var is now ignored')
      return this.opts.envUrl
    }
    return null
  }

  status(): RelayStatus | null {
    const c = this.client
    const tokenSet = getSetting(this.opts.db, RELAY_TOKEN_SETTING) !== null
    if (!c) {
      // Genuinely unconfigured (no client, no leftover token) stays bare null — the contract
      // relayStatusApi.test.ts pins for a fresh install. A token surviving with no client is the
      // defense-in-depth case documented on RelayStatus.configured above.
      if (!tokenSet) return null
      return {
        state: 'offline', terminal: false, url: '', hub_uid: '', connected_since: null,
        last_error: null, token_set: true, configured: false,
      }
    }
    return {
      state: c.state, terminal: c.terminal, url: c.url, hub_uid: c.hubUid,
      connected_since: c.connectedSince, last_error: c.lastError,
      token_set: tokenSet, configured: true,
    }
  }

  /**
   * Also the operator's "try again": same-URL saves still tear down and redial, which is what
   * clears a terminal bad_secret or token_required state after the conflict is
   * resolved relay-side.
   *
   * `token` is undefined-means-unchanged, but only when `url` is unchanged too. A token is minted
   * for one specific relay, so an operator who edits the address
   * from relay A to relay B — without ever touching Disconnect — must not have relay A's token
   * silently ride onto relay B's HELLO_HUB. `''` still clears explicitly and always wins; an
   * explicitly supplied non-empty token always wins too. Only a same-url, token-omitted save
   * (re-saving the relay you're already pointed at, e.g. to retry after a transient error)
   * leaves a stored token alone. The factory (`opts.makeClient`) is what actually reads the
   * setting back out and hands it to the fresh client — this method only owns persisting it
   * (or clearing it) before that happens.
   */
  setUrl(url: string, token?: string): void {
    this.client?.stop()
    const now = (this.opts.now ?? Date.now)()
    const urlChanged = getSetting(this.opts.db, RELAY_URL_SETTING) !== url
    setSetting(this.opts.db, RELAY_URL_SETTING, url, now)
    if (token !== undefined) {
      if (token === '') deleteSetting(this.opts.db, RELAY_TOKEN_SETTING)
      else setSetting(this.opts.db, RELAY_TOKEN_SETTING, token, now)
    } else if (urlChanged) {
      // A token with no explicit instruction, pointed at a DIFFERENT relay than it was last
      // saved against: it was minted for the OLD relay and must not carry over.
      deleteSetting(this.opts.db, RELAY_TOKEN_SETTING)
    }
    this.client = this.opts.makeClient(url)
    this.client.start()
  }

  /**
   * Deletes BOTH settings, not just the URL: a token left behind
   * after disconnecting would otherwise ride silently onto whatever relay gets configured next —
   * setUrl(url) with no token argument means "leave the stored token alone", so a stale row here
   * would get read by makeClient() and sent, in plaintext, to a relay host it was never issued
   * for. Disconnecting is the one moment a token MUST NOT survive without the operator saying so.
   */
  clear(): void {
    this.client?.stop()
    this.client = null
    deleteSetting(this.opts.db, RELAY_URL_SETTING)
    deleteSetting(this.opts.db, RELAY_TOKEN_SETTING)
  }

  /** RelayReplySink for the TTL sweep — forwards to the current client, whichever that is. */
  sendReply(connId: string, payload: string): void {
    this.client?.sendReply(connId, payload)
  }

  /** `token` lets the test exercise exactly what Save would store; it is never persisted. */
  test(url: string, token?: string): Promise<RelayTestResult> {
    return testRelayUrl({
      url,
      token,
      identity: (this.opts.getIdentity ?? (() => { throw new Error('no identity provider') }))(),
      connect: this.opts.testConnect,
      schedule: this.opts.testSchedule,
      timeoutMs: this.opts.testTimeoutMs,
    })
  }
}

/**
 * One-shot dial: HELLO_HUB, then the first of READY / close / timer wins. Not a RelayClient —
 * the client's job is to retry forever; a test's job is to give up and say why. Always tears
 * the socket down and always resolves exactly once (never rejects).
 *
 * Known side effect: dialing a fresh relay with the real identity claims
 * this hub's uid there via trust-on-first-use. Harmless when the operator then adopts that
 * relay; cleared by a relay restart otherwise.
 */
export function testRelayUrl(opts: {
  url: string
  identity: RelayIdentity
  /** Same optional account token HELLO_HUB carries in production (client.ts). */
  token?: string
  connect?: (url: string) => RelaySocket
  schedule?: (ms: number, fn: () => void) => void
  timeoutMs?: number
}): Promise<RelayTestResult> {
  const connect = opts.connect ?? realSocket
  const schedule = opts.schedule ?? ((ms: number, fn: () => void) => { setTimeout(fn, ms).unref?.() })
  return new Promise((resolve) => {
    let settled = false
    let s: RelaySocket
    try {
      s = connect(opts.url)
    } catch {
      // `ws` throws SYNCHRONOUSLY out of its WebSocket constructor for some invalid URLs (e.g. a
      // `#fragment`). test() must NEVER throw to the route — this contract means a synchronous
      // dial failure here is reported the same as any other unreachable relay.
      resolve({ ok: false, code: 'unreachable' })
      return
    }
    const settle = (r: RelayTestResult) => {
      if (settled) return
      settled = true
      s.close()   // close() re-fires onClose; the settled flag above makes that a no-op
      resolve(r)
    }
    s.onOpen = () => {
      s.send(JSON.stringify({
        type: 'HELLO_HUB', hub_uid: opts.identity.hubUid, secret: opts.identity.hubSecret,
        ...(opts.token ? { account_token: opts.token } : {}),
      }))
    }
    s.onMessage = (raw) => {
      try {
        if ((JSON.parse(raw) as { type?: unknown }).type === 'READY') settle({ ok: true })
      } catch { /* hostile input; keep waiting for the timer */ }
    }
    s.onClose = (code) => {
      // token_required (4403) must be told apart from a generic unreachable close: it is the
      // feature's own primary failure mode ("your token is missing/wrong/revoked"), and reporting
      // it as "unreachable" would send the operator chasing network problems instead of the
      // token field — worse, Save is gated on a passing Test, so a mislabeled result would leave
      // them stuck with no way forward. This uses ONLY the token the caller supplied for this
      // dial (opts.token above) — never a fallback to the stored setting, which would recreate
      // the exact leak shape this file's clear()/status() fixes exist to close, just against
      // whatever arbitrary URL is currently typed in the Test field.
      const code_ = code === CLOSE_BAD_SECRET ? 'bad_secret'
        : code === CLOSE_TOKEN_REQUIRED ? 'token_required' : 'unreachable'
      settle({ ok: false, code: code_ })
    }
    schedule(opts.timeoutMs ?? 5000, () => settle({ ok: false, code: 'timeout' }))
  })
}
