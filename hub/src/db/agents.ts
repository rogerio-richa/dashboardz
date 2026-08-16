import type { DB } from './index.js'
import { newId } from '../ids.js'
import { generateToken, hashToken } from '../auth/tokens.js'

export interface AgentTokenRow {
  id: string
  name: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

const COLUMNS = 'id, name, created_at, last_used_at, revoked_at'

export function createAgentToken(db: DB, name: string): { agent: AgentTokenRow; token: string } {
  const token = generateToken('agent')
  const agent: AgentTokenRow = { id: newId('agt'), name, created_at: Date.now(), last_used_at: null, revoked_at: null }
  db.prepare('INSERT INTO agent_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(agent.id, agent.name, hashToken(token), agent.created_at)
  return { agent, token }
}

/**
 * Returns revoked rows too. The guard needs the difference between "no such token" (silent 401)
 * and "a revoked token was just used" (worth an audit entry) — collapsing both to undefined here
 * would erase the signal an operator most wants after revoking a leaked credential.
 */
export function findAgentByToken(db: DB, token: string): AgentTokenRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM agent_tokens WHERE token_hash = ?`)
    .get(hashToken(token)) as AgentTokenRow | undefined
}

export function listAgentTokens(db: DB): AgentTokenRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM agent_tokens ORDER BY created_at`).all() as AgentTokenRow[]
}

export function revokeAgentToken(db: DB, id: string, now: number): boolean {
  return db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, id).changes > 0
}

export function touchAgentToken(db: DB, id: string, now: number): void {
  db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').run(now, id)
}
