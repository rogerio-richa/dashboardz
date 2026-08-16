import { createHash, randomBytes } from 'node:crypto'

// 'device' keeps its historical dbz_c_ prefix (the entity was called "client"/"screen" before naming rule);
// stored tokens are never rewritten, so the prefix is grandfathered the same way scr_ ids are.
const TOKEN_PREFIX = { sender: 'dbz_s_', device: 'dbz_c_', agent: 'dbz_a_' } as const

export function generateToken(kind: keyof typeof TOKEN_PREFIX): string {
  return TOKEN_PREFIX[kind] + randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
