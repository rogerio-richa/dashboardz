import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Reminder {
  id: string; title: string; body?: string
  at: string
  days?: number[]
  devices?: string[]
  snoozeMin: number
  escalateAfterMin?: number
  lastFiredDate?: string
  done?: boolean
}

export class ReminderStore {
  private items: Reminder[]

  constructor(private readonly filePath: string) {
    this.items = this.read()
  }

  private read(): Reminder[] {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [] // absent: normal on first run
      console.warn(`ReminderStore: could not read ${this.filePath}: ${(e as Error)?.message ?? e}`)
      return []
    }
    try {
      const data = JSON.parse(raw)
      return Array.isArray(data) ? (data as Reminder[]) : []
    } catch (e) {
      // Present but corrupt: a broken file must not stop the daemon, but it
      // must not fail silently either — someone should notice and fix it.
      console.warn(`ReminderStore: corrupt JSON in ${this.filePath}: ${(e as Error)?.message ?? e}`)
      return []
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.items, null, 2))
    renameSync(tmp, this.filePath) // atomic: a crash mid-write cannot truncate
  }

  load(): Reminder[] { this.items = this.read(); return this.list() }
  list(): Reminder[] { return [...this.items] }
  add(r: Reminder): void { this.items.push(r); this.save() }
  update(r: Reminder): void {
    const i = this.items.findIndex((x) => x.id === r.id)
    if (i < 0) throw new Error(`unknown reminder ${r.id}`)
    this.items[i] = r; this.save()
  }
  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((x) => x.id !== id)
    if (this.items.length !== before) { this.save(); return true }
    return false
  }
}
