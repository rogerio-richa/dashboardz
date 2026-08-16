export interface Config {
  port: number
  dataDir: string
  adminPassword: string
  publicUrl: string
  relayUrl: string | null
  masterKey: string | null
  /** Days a concluded (non-active) alert and its deliveries survive before the retention sweep prunes them. 0 keeps them forever. */
  retentionAlertsDays: number
  /** Days an audit_log row survives before the retention sweep prunes it. 0 keeps it forever. */
  retentionAuditDays: number
  /**
   * Whether `retentionAlertsDays`/`retentionAuditDays` came from an explicit, valid env var or
   * fell back to the built-in default — surfaced (storage & retention) so the admin UI's
   * "from env" / "default" label can be honest before an operator ever saves a settings-row
   * override. `'setting'` is never a value here: that third precedence layer lives above `Config`,
   * in `db/retentionSettings.ts`, since `Config` has no `db` to check against. Optional because
   * the many hand-built `Config` fixtures across the test suite predate this field and have no
   * reason to care about it — only `loadConfig` (the real constructor) always sets it.
   */
  retentionAlertsDaysSource?: 'env' | 'default'
  retentionAuditDaysSource?: 'env' | 'default'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminPassword = env.ADMIN_PASSWORD
  if (!adminPassword) throw new Error('ADMIN_PASSWORD is required')

  let port = 8484
  if ('PORT' in env) {
    const portValue = env.PORT
    if (!portValue) {
      throw new Error('PORT must be an integer between 1 and 65535')
    }
    const parsed = Number(portValue)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error('PORT must be an integer between 1 and 65535')
    }
    port = parsed
  }

  return {
    port,
    dataDir: env.DATA_DIR ?? './data',
    adminPassword,
    publicUrl: parsePublicUrl(env.PUBLIC_URL, port),
    relayUrl: parseRelayUrl(env.RELAY_URL),
    masterKey: env.DASHBOARDZ_MASTER_KEY ?? null,
    retentionAlertsDays: parseRetentionDays(env.RETENTION_ALERTS_DAYS, DEFAULT_RETENTION_ALERTS_DAYS).value,
    retentionAlertsDaysSource: parseRetentionDays(env.RETENTION_ALERTS_DAYS, DEFAULT_RETENTION_ALERTS_DAYS).source,
    retentionAuditDays: parseRetentionDays(env.RETENTION_AUDIT_DAYS, DEFAULT_RETENTION_AUDIT_DAYS).value,
    retentionAuditDaysSource: parseRetentionDays(env.RETENTION_AUDIT_DAYS, DEFAULT_RETENTION_AUDIT_DAYS).source,
  }
}

const DEFAULT_RETENTION_ALERTS_DAYS = 90
const DEFAULT_RETENTION_AUDIT_DAYS = 180

interface RetentionParse {
  value: number
  source: 'env' | 'default'
}

/**
 * Unlike PORT, a bad retention value must never crash boot — retention is a housekeeping knob,
 * not a listener address, and a hub that refuses to start over a typo'd env var here would be a
 * worse outcome than the sweep just running on its default schedule. So invalid input (not a
 * number, not an integer, or negative) silently falls back to the default rather than throwing.
 * `0` is a real, meaningful value (the documented "keep forever" escape hatch) and is accepted
 * as-is, not treated as falsy-therefore-missing.
 *
 * The returned `source` distinguishes "env var absent" and "env var present but invalid" from an
 * operator's point of view they are the same thing (the default applies) — but the admin UI
 * (storage & retention page) needs to say "from env" only when an env var is genuinely why the
 * value is what it is, not when a typo'd env var happened to be silently ignored.
 */
function parseRetentionDays(value: string | undefined, fallback: number): RetentionParse {
  if (value === undefined) return { value: fallback, source: 'default' }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return { value: fallback, source: 'default' }
  return { value: parsed, source: 'env' }
}

/**
 * ws:// or wss://, parseable, no fragment. The one URL rule, shared by boot parsing and the
 * admin routes.
 *
 * The fragment exclusion exists because `ws` (the client library actually dialing this URL)
 * throws SYNCHRONOUSLY out of its WebSocket constructor for a URL with a `#fragment` — a
 * fragment is meaningless in a dial target. Without this check here, a fragment URL would sail
 * through validation and only blow up deep inside the connect path.
 */
export function isRelayUrl(value: string): boolean {
  let parsed: URL
  try { parsed = new URL(value) } catch { return false }
  return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && parsed.hash === ''
}

/**
 * PUBLIC_URL feeds the pairing QR and the admin-session cookie's `Secure` flag. Validate it at
 * boot so malformed values cannot reach either consumer. A bare `host:port` is the likely typo
 * (URL requires the scheme), which is why the message spells the protocols out.
 */
function parsePublicUrl(value: string | undefined, port: number): string {
  if (value === undefined) return `http://localhost:${port}`
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('PUBLIC_URL must be a valid http:// or https:// URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must be a valid http:// or https:// URL')
  }
  return value
}

/**
 * Unset means "no relay" (the hub behaves exactly as it does today — a global constraint). A
 * value that IS set but malformed fails loudly at boot instead of producing a client that
 * retries a garbage URL forever, matching this project's "fails loudly, never silently" promise
 * and the strict validation PORT already gets above.
 */
function parseRelayUrl(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!isRelayUrl(value)) throw new Error('RELAY_URL must be a valid ws:// or wss:// URL')
  return value
}
