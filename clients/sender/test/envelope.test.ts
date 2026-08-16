import { describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deriveKey, open, seal } from '../src/envelope.js'

const TOKEN = 'dbz_s_0bc4rF2QDR5oxLAhOK'

/**
 * Both implementations must agree on this exact vector. If one drifts, this fails in whichever
 * package changed — which is the whole point of duplicating the file rather than sharing it.
 * The same constants live in hub/test/envelope.test.ts; keep them identical.
 */
const VECTOR_TOKEN = 'dbz_s_fixed_test_vector_token'
const VECTOR_KEY_HEX = '69a4e525e96136600507d32932084737f6047e8844e370f125bdc553c15bdddb'

describe('shared vector (must match hub/test/envelope.test.ts)', () => {
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

describe('envelope (forked from hub/src/relay/envelope.ts — keep byte-identical)', () => {
  it('round-trips a payload and returns null for the wrong token', () => {
    const msg = { req_id: 'r_1', op: 'notify', title: 'Disk 97%', options: [{ id: 'ok', label: 'OK' }] }
    expect(open(TOKEN, seal(TOKEN, msg))).toEqual(msg)
    expect(open('dbz_s_other', seal(TOKEN, msg))).toBeNull()
  })

  it('returns null for tampered ciphertext and garbage instead of throwing', () => {
    const sealed = Buffer.from(seal(TOKEN, { a: 1 }), 'base64')
    sealed[sealed.length - 1] ^= 0xff
    expect(open(TOKEN, sealed.toString('base64'))).toBeNull()
    for (const junk of ['', 'not base64!!', 'AAAA', Buffer.alloc(27).toString('base64')]) {
      expect(open(TOKEN, junk)).toBeNull()
    }
  })

  it('imports nothing but node:crypto — the fork must stay standalone', () => {
    const src = readFileSync(new URL('../src/envelope.ts', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/^\s*(?:import|export)\s.*\sfrom\s+'([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['node:crypto'])
  })
})
