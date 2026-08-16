import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'

export type InjectResponse = LightMyRequestResponse
export type InjectMethod = NonNullable<InjectOptions['method']>

/**
 * The one place that knows how to hand a loosely-typed request to `app.inject`.
 *
 * `inject` is an overload set — `(opts, cb) => void`, `(opts) => Promise<Response>`, `() => Chain`.
 * When an object-literal argument fails to match ALL of them, TypeScript does not report the
 * offending property and stop; it degrades the call's result to the intersection of every
 * overload's return type, `void & Promise<Response> & Chain`. Nothing has `.statusCode` or
 * `.json()` on it, so one widened property in a test's little `request()` helper does not produce
 * one error — it produces one per assertion downstream. That is how four files came to hold 158 of
 * the 218 errors this suite had accumulated in the years nothing typechecked it.
 *
 * Two properties are routinely wider at the call site than `InjectOptions` declares, and both are
 * legitimate. This module narrows them once, here, rather than in every caller:
 *
 * - `method`. Table-driven tests iterate `[method, url]` pairs, so the element type is `string`.
 *   `METHODS` below narrows it with a real runtime check, so a typo'd verb fails loudly at the
 *   seam instead of being cast into silence.
 * - `payload`. `InjectPayload` is `string | object | Buffer | ReadableStream`, but
 *   light-my-request JSON-stringifies anything that is not a string, Buffer or stream
 *   (`lib/request.js`: `payload && typeof payload !== 'string' && !payloadResume &&
 *   !Buffer.isBuffer(payload)`), so a bare `42` or `true` round-trips fine — and there are tests
 *   that push exactly that to assert a scalar feed value is accepted. The declaration is narrower
 *   than the library; the cast records that, and does not change what is sent.
 *
 * Call this instead of `app.inject` whenever the method or the payload is not a literal.
 */
const METHODS: readonly string[] = [
  'DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS',
]

export function injectMethod(method: string): InjectMethod {
  if (!METHODS.includes(method.toUpperCase())) throw new Error(`not an injectable HTTP method: ${method}`)
  return method as InjectMethod // the string itself, unchanged — only its type is narrowed
}

export type LooseInjectOptions = Omit<InjectOptions, 'method' | 'payload'> & {
  method?: string
  payload?: unknown
}

export function inject(app: FastifyInstance, opts: LooseInjectOptions): Promise<InjectResponse> {
  const { method, payload, ...rest } = opts
  return app.inject({
    ...rest,
    ...(method === undefined ? {} : { method: injectMethod(method) }),
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  })
}
