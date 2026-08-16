/**
 * Thrown for any non-2xx response from the hub's admin API. `status` and `message` are pulled
 * straight off the hub's `{error}` body (hub/src/routes/*.ts's error shape) so a caller — the MCP
 * tool handlers, eventually — can surface the hub's own words to the model instead of a generic
 * "request failed".
 */
export class HubError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HubError'
    this.status = status
  }
}

/**
 * A thin wrapper over `fetch` for the hub's admin HTTP API: bearer auth, JSON in, JSON out. The
 * `fetchImpl` constructor param is the same injected-fake seam `clients/sender`'s `SenderSocket`
 * uses for its websocket — tests drive the whole request/response cycle with a fake `fetch`
 * instead of a live hub.
 */
export class HubClient {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // A trailing-slash DASHBOARDZ_HUB_URL (e.g. 'http://h:8484/') would otherwise concatenate with
    // this class's own leading-slash paths into '//admin/...' — a URL that 404s against the wrong
    // thing and surfaces as fetchContract's misleading "upgrade the hub" message, not the actual
    // cause (a stray trailing slash in config).
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
      const parsed = await res.json().catch(() => null) as { error?: unknown } | null
      const message = parsed && typeof parsed.error === 'string' ? parsed.error : res.statusText
      throw new HubError(res.status, message)
    }

    // 204 No Content (e.g. deletes) has no body to parse.
    if (res.status === 204) return undefined
    return res.json()
  }
}
