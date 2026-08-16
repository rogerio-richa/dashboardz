export interface HelloHubMsg { type: 'HELLO_HUB'; hub_uid: string; secret: string; account_token?: string }
export interface HelloSenderMsg { type: 'HELLO_SENDER'; hub_uid: string }
export interface SendMsg { type: 'SEND'; payload: string }
export interface ReplyMsg { type: 'REPLY'; conn_id: string; payload: string }
export type ClientMsg = HelloHubMsg | HelloSenderMsg | SendMsg | ReplyMsg

export type ErrorCode = 'hub_offline' | 'rate_limited' | 'not_authenticated' | 'malformed'

/**
 * WebSocket close codes the relay uses for protocol/abuse enforcement (private-use range
 * 4000-4999). Named here — not just used as inline literals at each `socket.close()` call —
 * so a consumer of this protocol (e.g. the hub's outbound client) has one place to import them
 * from instead of copying magic numbers out of relay source.
 */
export const CLOSE_BAD_SECRET = 4401 // HELLO_HUB for a hub_uid whose secret doesn't match the incumbent's.
export const CLOSE_MALFORMED = 4400 // Reserved: malformed frames currently get an ERROR frame and stay open (see socket.ts); not emitted yet.
export const CLOSE_RATE_LIMITED = 4429 // Registration or SEND rate limit exceeded.
// A hub reconnected with the same hub_uid and secret while this socket was still the
// registered one; this socket's slot was handed to the new connection. Not an auth failure —
// a client seeing this code should NOT treat it like CLOSE_BAD_SECRET (stop retrying) and
// should reconnect normally, the same as any other clean disconnect.
export const CLOSE_SUPERSEDED = 4409
// The relay requires an account token (REQUIRE_TOKEN=true) and this connection had none, or one
// that is unknown/revoked. Like CLOSE_BAD_SECRET this is terminal for the client: retrying the
// same credentials cannot succeed, and a hub that reconnect-loops on it is just noise on someone
// else's service. Distinct from 4401 so the hub can say WHICH credential is wrong.
export const CLOSE_TOKEN_REQUIRED = 4403

/**
 * JSON.parse only guarantees syntax. A client — or a bug in one — can send null, an array,
 * or wrong field types, and none of that may throw inside the message handler.
 */
export function isClientMsg(v: unknown): v is ClientMsg {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
}
