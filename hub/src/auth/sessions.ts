import { randomBytes } from 'node:crypto'

const TTL_MS = 24 * 60 * 60 * 1000

export class SessionStore {
  private sessions = new Map<string, number>()

  create(): string {
    const id = randomBytes(16).toString('hex')
    this.sessions.set(id, Date.now() + TTL_MS)
    return id
  }

  valid(id: string | undefined): boolean {
    if (!id) return false
    const exp = this.sessions.get(id)
    if (!exp) return false
    if (exp < Date.now()) { this.sessions.delete(id); return false }
    return true
  }

  destroy(id: string): void {
    this.sessions.delete(id)
  }
}
