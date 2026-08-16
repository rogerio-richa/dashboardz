import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import type { Hub } from './hub.js'
import { dueReminders } from './scheduler.js'
import { fireReminder } from './reminders.js'
import type { ReminderStore } from './store.js'

export interface DaemonDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  fire?: typeof fireReminder
  maxTicks?: number
}

function readLastTick(dataDir: string): Date | null {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { lastTick?: string }
    const d = s.lastTick ? new Date(s.lastTick) : null
    return d && !Number.isNaN(d.getTime()) ? d : null
  } catch { return null }
}

function writeLastTick(dataDir: string, t: Date): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'state.json')
  writeFileSync(`${file}.tmp`, JSON.stringify({ lastTick: t.toISOString() }))
  renameSync(`${file}.tmp`, file)
}

export async function runDaemon(cfg: Config, store: ReminderStore, hub: Hub, deps: DaemonDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => new Date())
  const fire = deps.fire ?? fireReminder
  let lastTick = readLastTick(cfg.dataDir)

  for (let tick = 0; deps.maxTicks === undefined || tick < deps.maxTicks; tick++) {
    const t = now()
    const due = dueReminders(store.load(), t, lastTick)
    for (const d of due) {
      // Deliberately not awaited: a reminder polls for up to an hour and
      // must never block the tick. Failures are logged, never fatal.
      void fire(hub, store, d.reminder, {
        late: d.late, adherenceFeed: cfg.adherenceFeed, defaultDevices: cfg.devices,
        scheduled: d.scheduled,
      }).catch((err: unknown) => console.error(`reminder ${d.reminder.id} failed:`, err))
    }
    lastTick = t
    writeLastTick(cfg.dataDir, t)
    await sleep(cfg.tickMs)
  }
}
