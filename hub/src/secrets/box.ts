import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export interface SecretBox {
  seal(plaintext: string): string
  open(ciphertext: string): string
}

export function createSecretBox(key: Uint8Array): SecretBox {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error('Secret box key must be exactly 32 bytes')
  }
  const ownedKey = Buffer.from(key)

  return {
    seal(plaintext: string): string {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', ownedKey, nonce)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `v1.${nonce.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
    },

    open(ciphertext: string): string {
      const parts = ciphertext.split('.')
      if (parts.length !== 4) throw invalidCiphertext()

      const [version, nonceText, tagText, encryptedText] = parts
      if (version !== 'v1') throw new Error('Unsupported secret ciphertext version')

      const nonce = decodeBase64Url(nonceText!, false)
      const tag = decodeBase64Url(tagText!, false)
      const encrypted = decodeBase64Url(encryptedText!, true)
      if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
        throw invalidCiphertext()
      }

      try {
        const decipher = createDecipheriv('aes-256-gcm', ownedKey, nonce)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('Secret ciphertext authentication failed')
      }
    },
  }
}

function decodeBase64Url(value: string, allowEmpty: boolean): Buffer {
  if ((!allowEmpty && value.length === 0) || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw invalidCiphertext()
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalidCiphertext()
  return decoded
}

function invalidCiphertext(): Error {
  return new Error('Invalid secret ciphertext format')
}
