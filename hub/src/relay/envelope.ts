import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const ALGO = 'chacha20-poly1305'
const NONCE_LEN = 12
const TAG_LEN = 16
const INFO = 'dashboardz-relay-v1'

/**
 * The sender token is already a shared secret between that sender and this hub, so it doubles
 * as the relay key material — no PKI, no key distribution (design rationale schema wording, documented contract).
 *
 * A distinct HKDF `info` string means the encryption key is NOT the bearer token reused for a
 * second purpose: leaking one does not directly hand over the other's role.
 */
export function deriveKey(senderToken: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(senderToken, 'utf8'), Buffer.alloc(0), Buffer.from(INFO, 'utf8'), 32))
}

/**
 * The key-based half of `seal`/`open`. The hub reaches for these because it stores a derived
 * `relay_key` per sender rather than the raw token: it can encrypt and decrypt
 * without ever holding a working bearer credential. A sender, which does hold its token, uses
 * the token-based wrappers below — they are thin delegations, so both sides run identical code.
 *
 * This file must keep importing nothing but `node:crypto`: it is forked verbatim into the sender
 * client, which has no database, no Fastify, and no hub types.
 */
export function sealWithKey(key: Buffer, plaintext: object): string {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv(ALGO, key, nonce, { authTagLength: TAG_LEN })
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), 'utf8')),
    cipher.final(),
  ])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

/**
 * Returns null for anything in `payload` that does not authenticate cleanly — that input is
 * attacker-controlled (it crosses the relay), so it must never throw.
 *
 * `key`, by contrast, is ours: it comes from our own lookup, not the wire. A missed lookup or a
 * typo'd property handing this `undefined` is a programming error, and swallowing it into the
 * same `null` as "wrong key" or "tampered ciphertext" would hide our own bug behind an
 * indistinguishable crypto failure. So the type guard sits outside the try/catch and throws.
 *
 * A *wrong-length* key is a different case and stays inside the try: trial decryption walks keys
 * read back out of the database, and a corrupt row there must be skipped like any other failure
 * to authenticate rather than taking the hub down.
 */
export function openWithKey<T>(key: Buffer, payload: string): T | null {
  if (!Buffer.isBuffer(key)) {
    throw new TypeError('openWithKey: key must be a Buffer')
  }
  try {
    const raw = Buffer.from(payload, 'base64')
    if (raw.length < NONCE_LEN + TAG_LEN) return null
    const nonce = raw.subarray(0, NONCE_LEN)
    const tag = raw.subarray(raw.length - TAG_LEN)
    const body = raw.subarray(NONCE_LEN, raw.length - TAG_LEN)
    const decipher = createDecipheriv(ALGO, key, nonce, { authTagLength: TAG_LEN })
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(body), decipher.final()])
    return JSON.parse(out.toString('utf8')) as T
  } catch {
    return null
  }
}

export function seal(senderToken: string, plaintext: object): string {
  return sealWithKey(deriveKey(senderToken), plaintext)
}

/** See `openWithKey` — the same contract, with the key derived from the token for callers that
 *  hold one. The non-string guard throws for the same reason: it can only be our own bug. */
export function open<T>(senderToken: string, payload: string): T | null {
  if (typeof senderToken !== 'string') {
    throw new TypeError('open: senderToken must be a string')
  }
  return openWithKey<T>(deriveKey(senderToken), payload)
}
