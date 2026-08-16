import { describe, expect, it } from 'vitest'
import { createSecretBox } from '../src/secrets/box.js'

const key = (fill: number) => new Uint8Array(32).fill(fill)

function replaceFirstCharacter(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
}

function addNoncanonicalPadBits(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const remainder = value.length % 4
  if (remainder === 0) return `${value}A`

  const last = alphabet.indexOf(value.at(-1)!)
  const padBits = remainder === 2 ? 4 : 2
  const replacement = (last & ~((1 << padBits) - 1)) | 1
  return `${value.slice(0, -1)}${alphabet[replacement]}`
}

describe('SecretBox', () => {
  it('round trips UTF-8 plaintext in the versioned authenticated format', () => {
    const box = createSecretBox(key(7))
    const ciphertext = box.seal('café ☕ dashboard')

    expect(ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/)
    expect(box.open(ciphertext)).toBe('café ☕ dashboard')
  })

  it('uses a fresh nonce so sealing the same plaintext produces different ciphertext', () => {
    const box = createSecretBox(key(11))

    expect(box.seal('same secret')).not.toBe(box.seal('same secret'))
  })

  it('never includes plaintext in its stored representation', () => {
    const box = createSecretBox(key(13))
    const plaintext = 'db-password=correct horse battery staple'

    expect(box.seal(plaintext)).not.toContain(plaintext)
  })

  it('rejects a ciphertext whose authenticated bytes were tampered with', () => {
    const box = createSecretBox(key(17))
    const parts = box.seal('protected').split('.')
    parts[3] = replaceFirstCharacter(parts[3]!)

    expect(() => box.open(parts.join('.'))).toThrow(/authentication failed/i)
  })

  it('rejects a ciphertext sealed with a different key', () => {
    const ciphertext = createSecretBox(key(19)).seal('protected')

    expect(() => createSecretBox(key(20)).open(ciphertext)).toThrow(/authentication failed/i)
  })

  it('rejects unknown versions before attempting decryption', () => {
    const box = createSecretBox(key(23))
    const ciphertext = box.seal('protected').replace(/^v1\./, 'v2.')

    expect(() => box.open(ciphertext)).toThrow(/unsupported.*version/i)
  })

  it.each([
    ['missing fields', 'v1.only-two'],
    ['non-base64url nonce', 'v1.!!!!!!!!!!!!.AAAAAAAAAAAAAAAAAAAAAA.AA'],
    ['wrong nonce length', 'v1.AA.AAAAAAAAAAAAAAAAAAAAAA.AA'],
    ['wrong tag length', 'v1.AAAAAAAAAAAAAAAA.AA.AA'],
  ])('rejects malformed ciphertext: %s', (_case, ciphertext) => {
    expect(() => createSecretBox(key(29)).open(ciphertext)).toThrow(/invalid secret ciphertext/i)
  })

  it.each([
    ['nonce', 1],
    ['tag', 2],
    ['ciphertext', 3],
  ] as const)('rejects noncanonical base64url pad bits in the %s component', (_component, index) => {
    const box = createSecretBox(key(31))
    const parts = box.seal('five!').split('.')
    const canonical = parts[index]!
    const noncanonical = addNoncanonicalPadBits(canonical)
    expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(canonical, 'base64url'))
    parts[index] = noncanonical

    expect(() => box.open(parts.join('.'))).toThrow(/invalid secret ciphertext/i)
  })

  it('does not reveal plaintext or ciphertext in authentication errors', () => {
    const plaintext = 'private-database-password-9381'
    const ciphertext = createSecretBox(key(37)).seal(plaintext)

    let message = ''
    try {
      createSecretBox(key(38)).open(ciphertext)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/authentication failed/i)
    expect(message).not.toContain(plaintext)
    expect(message).not.toContain(ciphertext)
  })

  it('does not reveal supplied plaintext or ciphertext in format errors', () => {
    const plaintext = 'format-error-must-not-echo-this-secret'
    const ciphertext = `v1.${plaintext}.invalid`

    let message = ''
    try {
      createSecretBox(key(39)).open(ciphertext)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/invalid secret ciphertext/i)
    expect(message).not.toContain(plaintext)
    expect(message).not.toContain(ciphertext)
  })

  it('rejects keys that are not exactly 32 bytes', () => {
    expect(() => createSecretBox(new Uint8Array(31))).toThrow(/exactly 32 bytes/i)
    expect(() => createSecretBox(new Uint8Array(33))).toThrow(/exactly 32 bytes/i)
  })
})
