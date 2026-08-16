/**
 * Which address a device should type to reach this hub, and where that answer came from.
 *
 * PUBLIC_URL wins when it names a real network address. Without it the hub only knows
 * `localhost`, which works on the hub's own computer and nowhere else, so the admin falls back to
 * the address the browser used to open it (when that isn't localhost either), then to the
 * computer's own network adapters (reported by the hub when it runs outside a container).
 */
export interface HubAddress {
  /** The URL to give devices, or null when nothing better than localhost is known. */
  url: string | null
  /** More LAN addresses the computer has, for a machine on several networks. */
  others: string[]
  source: 'public_url' | 'browser' | 'lan' | null
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h.startsWith('127.') || h === '::1' || h === '0.0.0.0'
}

const hostOf = (url: string): string | null => {
  try { return new URL(url).hostname } catch { return null }
}

const isReachable = (url: string | null | undefined): url is string => {
  if (!url) return false
  const host = hostOf(url)
  return host !== null && !isLoopbackHost(host)
}

export function resolveHubAddress(publicUrl: string, browserOrigin: string, lanUrls: string[] = []): HubAddress {
  const lan = lanUrls.filter(isReachable)
  if (isReachable(publicUrl)) return { url: publicUrl.replace(/\/+$/, ''), others: [], source: 'public_url' }
  if (isReachable(browserOrigin)) return { url: browserOrigin.replace(/\/+$/, ''), others: [], source: 'browser' }
  if (lan.length > 0) return { url: lan[0], others: lan.slice(1), source: 'lan' }
  return { url: null, others: [], source: null }
}

/** An address the way people read and type it: no `http://`, no trailing slash. */
export function displayAddress(url: string): string {
  return url.replace(/^http:\/\//i, '').replace(/\/+$/, '')
}

/** The port a device must include, for the firewall advice. */
export function portOf(url: string | null): string {
  if (!url) return '8484'
  try {
    const u = new URL(url)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch { return '8484' }
}
