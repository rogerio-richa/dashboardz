import { HubError, type HubClient } from './hub.js'

/**
 * The consumer-side mirror of `hub/src/screens/widgetContract.ts`'s `WidgetContract` — copied
 * field-for-field rather than imported, because this package is built independently of the hub
 * and must never pull hub source into `src/`. `revision` is the skew sentinel: a hub too old to
 * serve this endpoint at all is the case `fetchContract` guards against explicitly below.
 */
export interface WidgetContract {
  widgets: Record<string, {
    config: unknown
    modes?: readonly string[]
    needs?: readonly unknown[]
    contract?: string
    required_capabilities?: readonly string[]
    optional_capabilities?: readonly string[]
  }>
  cell_schema: unknown
  rect: { min: number; quantum: number; max_cells: number }
  contracts: Record<string, { mode: string; collection_limit?: number }>
  revision: string
}

/**
 * Fetches and structurally checks the hub's machine-readable widget contract. The only check
 * worth doing here is `revision` being a string: a hub that predates GET /admin/api/widget-contract
 * either 404s (HubClient already throws on that) or, behind some other route conflict, returns
 * something with no revision — either way that is a hub-version problem, not a shape the caller
 * should have to detect for itself.
 */
export async function fetchContract(hub: HubClient): Promise<WidgetContract> {
  const body = await hub.request('GET', '/admin/api/widget-contract')
  if (!body || typeof body !== 'object' || typeof (body as { revision?: unknown }).revision !== 'string') {
    throw new Error('this hub does not serve /admin/api/widget-contract — upgrade the hub')
  }
  return body as WidgetContract
}

export interface RetryOpts {
  /** Total attempts, including the first. Default 3. */
  attempts?: number
  /** Base delay between attempts, in ms, multiplied by the attempt number (1, 2, 3, ...). Default 500. */
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * cli.ts calls this instead of fetchContract directly: that call happens before the stdio
 * transport is up, so a single transient failure (hub mid-restart, a DNS hiccup) must not exit the
 * whole process before Claude Code can retry the connection. The session remains connected while
 * the contract request retries.
 *
 * A HubError means the hub DID answer — retrying an auth failure or a real 404 only delays the
 * actionable message cli.ts already prints, so those still fail on the first attempt.
 */
export async function fetchContractWithRetry(hub: HubClient, opts: RetryOpts = {}): Promise<WidgetContract> {
  const attempts = opts.attempts ?? 3
  const delayMs = opts.delayMs ?? 500
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchContract(hub)
    } catch (error) {
      if (error instanceof HubError || attempt >= attempts) throw error
      await sleep(delayMs * attempt)
    }
  }
}
