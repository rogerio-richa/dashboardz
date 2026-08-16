import { describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deriveKey, open, openWithKey, seal, sealWithKey } from '../src/relay/envelope.js'

const TOKEN = 'dbz_s_0bc4rF2QDR5oxLAhOK'

/**
 * Both implementations must agree on this exact vector. If one drifts, this fails in whichever
 * package changed — which is the whole point of duplicating the file rather than sharing it.
 * The same constants live in clients/sender/test/envelope.test.ts; keep them identical.
 */
const VECTOR_TOKEN = 'dbz_s_fixed_test_vector_token'
const VECTOR_KEY_HEX = '69a4e525e96136600507d32932084737f6047e8844e370f125bdc553c15bdddb'

describe('shared vector (must match clients/sender/test/envelope.test.ts)', () => {
  it('derives the canonical key for the shared test vector', () => {
    expect(deriveKey(VECTOR_TOKEN).toString('hex')).toBe(VECTOR_KEY_HEX)
  })

  /**
   * Pins the wire layout itself — base64( 12-byte nonce | ciphertext | 16-byte tag ) — not just
   * "AEAD rejects tampering". The manual construction and manual parse below are what catch a
   * copy whose seal AND open drift together (e.g. tag moved to the front): such a copy still
   * round-trips with itself, but stops speaking the same frame as the other package.
   */
  it('frames as 12-byte nonce | ciphertext | 16-byte tag, base64', () => {
    const msg = { req_id: 'r_frame', op: 'notify' }
    const plain = Buffer.from(JSON.stringify(msg), 'utf8')
    const key = Buffer.from(VECTOR_KEY_HEX, 'hex')

    // seal writes exactly those segments at those offsets: parse them manually, without open().
    const raw = Buffer.from(seal(VECTOR_TOKEN, msg), 'base64')
    expect(raw.length).toBe(12 + plain.length + 16)
    const d = createDecipheriv('chacha20-poly1305', key, raw.subarray(0, 12), { authTagLength: 16 })
    d.setAuthTag(raw.subarray(raw.length - 16))
    expect(JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'))).toEqual(msg)

    // open accepts a frame built manually at those offsets, without seal().
    const nonce = Buffer.alloc(12, 7)
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
    const body = Buffer.concat([c.update(plain), c.final()])
    expect(open(VECTOR_TOKEN, Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64'))).toEqual(msg)

    // Disturbing any segment at its exact boundary offsets breaks the round-trip; untouched opens.
    for (const at of [0, 11, 12, 12 + plain.length - 1, 12 + plain.length, raw.length - 1]) {
      const bent = Buffer.from(raw)
      bent[at] ^= 0x01
      expect(open(VECTOR_TOKEN, bent.toString('base64'))).toBeNull()
    }
    expect(open(VECTOR_TOKEN, raw.toString('base64'))).toEqual(msg)
  })
})

describe('deriveKey', () => {
  it('is deterministic, 32 bytes, and token-specific', () => {
    const a = deriveKey(TOKEN)
    expect(a).toHaveLength(32)
    expect(a.equals(deriveKey(TOKEN))).toBe(true)
    expect(a.equals(deriveKey(TOKEN + 'x'))).toBe(false)
  })

  it('is not the raw token — the bearer credential is not reused as a key', () => {
    expect(deriveKey(TOKEN).toString('utf8')).not.toContain('dbz_s_')
  })
})

describe('seal / open', () => {
  it('round-trips a payload', () => {
    const msg = { req_id: 'r_1', op: 'notify', title: 'Disk 97%', options: [{ id: 'ok', label: 'OK' }] }
    expect(open(TOKEN, seal(TOKEN, msg))).toEqual(msg)
  })

  it('uses a fresh nonce — the same plaintext never produces the same ciphertext', () => {
    expect(seal(TOKEN, { a: 1 })).not.toBe(seal(TOKEN, { a: 1 }))
  })

  it('returns null for the wrong key rather than throwing', () => {
    expect(open('dbz_s_other', seal(TOKEN, { a: 1 }))).toBeNull()
  })

  it('returns null for tampered ciphertext (the auth tag must be checked)', () => {
    const sealed = Buffer.from(seal(TOKEN, { a: 1 }), 'base64')
    sealed[sealed.length - 1] ^= 0xff                       // corrupt the tag
    expect(open(TOKEN, sealed.toString('base64'))).toBeNull()
  })

  it('returns null for garbage instead of throwing', () => {
    for (const junk of ['', 'not base64!!', 'AAAA', Buffer.alloc(5).toString('base64')]) {
      expect(open(TOKEN, junk)).toBeNull()
    }
  })

  it('survives a large payload at the API limits', () => {
    const big = { title: 'x'.repeat(200), body: 'y'.repeat(1500) }
    expect(open(TOKEN, seal(TOKEN, big))).toEqual(big)
  })

  it('throws for a non-string senderToken (our own bug) but still returns null for a bad payload with a valid token', () => {
    const sealed = seal(TOKEN, { a: 1 })
    // A missed lookup / typo'd property handing `undefined` to open() is a programming error,
    // not an attacker-controlled input — it must fail loudly, not look like "wrong key".
    expect(() => open(undefined as unknown as string, sealed)).toThrow()
    // The payload itself remains untrusted input: still returns null, never throws.
    expect(open(TOKEN, 'not base64!!')).toBeNull()
  })

  it('rejects a frame one byte under the minimum size (nonce + tag = 28 bytes) without attempting to decrypt', () => {
    expect(open(TOKEN, Buffer.alloc(27).toString('base64'))).toBeNull()
  })

  it('accepts the minimum frame size structurally but still fails auth on all-zero garbage', () => {
    expect(open(TOKEN, Buffer.alloc(28).toString('base64'))).toBeNull()
  })

  it('returns null when a ciphertext body byte is tampered, not just the trailing tag', () => {
    const sealed = Buffer.from(seal(TOKEN, { a: 1 }), 'base64')
    sealed[15] ^= 0xff // a byte inside the ciphertext body (nonce is bytes 0-11), not the tag
    expect(open(TOKEN, sealed.toString('base64'))).toBeNull()
  })

  it('returns null when the nonce itself is tampered', () => {
    const sealed = Buffer.from(seal(TOKEN, { a: 1 }), 'base64')
    sealed[0] ^= 0xff
    expect(open(TOKEN, sealed.toString('base64'))).toBeNull()
  })
})

/**
 * The hub holds a derived key, not the token, so it uses these directly; the
 * sender holds a token and uses the wrappers above. They must be the same crypto or the two
 * halves of the relay cannot talk to each other.
 */
describe('sealWithKey / openWithKey', () => {
  const KEY = deriveKey(TOKEN)

  it('interoperates with the token-based wrappers in both directions', () => {
    const msg = { req_id: 'r_1', op: 'notify' }
    expect(openWithKey(KEY, seal(TOKEN, msg))).toEqual(msg)
    expect(open(TOKEN, sealWithKey(KEY, msg))).toEqual(msg)
  })

  it('returns null for the wrong key, tampered ciphertext, and garbage — never throws', () => {
    const other = deriveKey('dbz_s_other')
    expect(openWithKey(other, sealWithKey(KEY, { a: 1 }))).toBeNull()
    const sealed = Buffer.from(sealWithKey(KEY, { a: 1 }), 'base64')
    sealed[sealed.length - 1] ^= 0xff
    expect(openWithKey(KEY, sealed.toString('base64'))).toBeNull()
    for (const junk of ['', 'not base64!!', 'AAAA']) expect(openWithKey(KEY, junk)).toBeNull()
  })

  it('throws for a non-Buffer key (our own bug) but only returns null for a wrong-length one', () => {
    expect(() => openWithKey(undefined as unknown as Buffer, sealWithKey(KEY, { a: 1 }))).toThrow()
    // A corrupt BLOB read back out of the database is data, not a programming error: trial
    // decryption must skip it, not take the hub down.
    expect(openWithKey(Buffer.alloc(7), sealWithKey(KEY, { a: 1 }))).toBeNull()
  })

  it('imports nothing but node:crypto — this file is forked verbatim into the sender client', () => {
    const src = readFileSync(new URL('../src/relay/envelope.ts', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/^\s*(?:import|export)\s.*\sfrom\s+'([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['node:crypto'])
  })
})
