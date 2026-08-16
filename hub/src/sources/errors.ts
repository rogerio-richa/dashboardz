import type { ProviderRunContext } from './provider.js'

export type SourceErrorCode =
  | 'authentication_required'
  | 'rate_limited'
  | 'unreachable'
  | 'invalid_response'

export class SourceError extends Error {
  readonly code: SourceErrorCode
  declare readonly retryAt?: number

  constructor(code: SourceErrorCode, message: string, retryAt?: number) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    if (retryAt !== undefined) this.retryAt = retryAt
  }
}

export const PROVIDER_FETCH_TIMEOUT_MS = 10_000
const responseCleanup = new WeakMap<Response, () => void>()
const supportedTimestamp = (value: number): value is number =>
  Number.isFinite(value) && Number.isFinite(new Date(value).getTime())

export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const timestamp = now + Number(trimmed) * 1000
    return supportedTimestamp(timestamp) ? timestamp : undefined
  }
  const timestamp = Date.parse(trimmed)
  return supportedTimestamp(timestamp) ? timestamp : undefined
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** One redacted HTTP boundary for every built-in provider. */
export async function fetchProvider(
  input: RequestInfo | URL,
  ctx: ProviderRunContext,
  init: RequestInit = {},
): Promise<Response> {
  if (ctx.signal.aborted) {
    throw new SourceError('unreachable', 'The provider request was cancelled')
  }
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Provider deadline exceeded', 'TimeoutError'))
  }, PROVIDER_FETCH_TIMEOUT_MS)
  timeout.unref()
  const onRunnerAbort = () => controller.abort(ctx.signal.reason)
  if (ctx.signal.aborted) onRunnerAbort()
  else ctx.signal.addEventListener('abort', onRunnerAbort, { once: true })

  const cleanup = () => {
    clearTimeout(timeout)
    ctx.signal.removeEventListener('abort', onRunnerAbort)
  }
  let response: Response
  try {
    response = await Promise.race([
      ctx.fetch(input, { ...init, signal: controller.signal }),
      abortPromise(controller.signal),
    ])
  } catch {
    cleanup()
    throw new SourceError(
      'unreachable',
      timedOut
        ? `The provider timed out after ${PROVIDER_FETCH_TIMEOUT_MS / 1000} seconds`
        : 'The provider could not be reached',
    )
  }

  if (response.status === 401 || response.status === 403) {
    cleanup()
    throw new SourceError('authentication_required', 'Authentication is required for this connection')
  }
  if (response.status === 429) {
    cleanup()
    throw new SourceError(
      'rate_limited',
      'The provider is rate limiting this connection',
      parseRetryAfter(response.headers.get('retry-after'), ctx.now),
    )
  }
  if (!response.ok) {
    cleanup()
    throw new SourceError('unreachable', `The provider returned HTTP ${response.status}`)
  }
  // Keep the request deadline attached until the capped reader consumes the body. Native fetch
  // resolves when headers arrive, not when a slow or stuck body has finished streaming.
  responseCleanup.set(response, cleanup)
  return response
}

async function readCappedTextBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SourceError('invalid_response', 'The provider response was too large')
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    let read: ReadableStreamReadResult<Uint8Array>
    try {
      read = await reader.read()
    } catch {
      throw new SourceError('unreachable', 'The provider response could not be read')
    }
    if (read.done) break
    total += read.value.byteLength
    if (total > maxBytes) {
      void reader.cancel()
      throw new SourceError('invalid_response', 'The provider response was too large')
    }
    chunks.push(read.value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SourceError('invalid_response', 'The provider response was not valid UTF-8')
  }
}

export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  try {
    return await readCappedTextBody(response, maxBytes)
  } finally {
    responseCleanup.get(response)?.()
    responseCleanup.delete(response)
  }
}

export async function readCappedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const text = await readCappedText(response, maxBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SourceError('invalid_response', 'The provider did not return valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SourceError('invalid_response', 'The provider returned an unexpected JSON body')
  }
  return parsed as Record<string, unknown>
}
