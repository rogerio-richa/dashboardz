import type { Reminder } from './store.js'

export const LATE_AFTER_MS = 5 * 60_000
export const CATCHUP_WINDOW_MS = 60 * 60_000

export interface FireDecision { reminder: Reminder; late: boolean; scheduled: Date }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function ymd(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

/** Most recent scheduled instant <= now for a repeating reminder, or null. */
function lastScheduled(at: string, days: number[] | undefined, now: Date): Date | null {
  const m = HHMM.exec(at)
  if (!m) return null
  for (let back = 0; back < 8; back++) {
    const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, Number(m[1]), Number(m[2]), 0)
    if (c.getTime() > now.getTime()) continue
    if (days && days.length > 0 && !days.includes(c.getDay())) continue
    return c
  }
  return null
}

export function dueReminders(reminders: Reminder[], now: Date, lastTick: Date | null): FireDecision[] {
  const out: FireDecision[] = []
  for (const r of reminders) {
    let scheduled: Date | null
    if (HHMM.test(r.at)) {
      scheduled = lastScheduled(r.at, r.days, now)
      if (!scheduled) continue
      if (r.lastFiredDate === ymd(scheduled)) continue
    } else {
      if (r.done) continue
      const t = new Date(r.at)
      if (Number.isNaN(t.getTime()) || t.getTime() > now.getTime()) continue
      scheduled = t
    }
    const age = now.getTime() - scheduled.getTime()
    const inWindow = lastTick === null
      ? age <= CATCHUP_WINDOW_MS
      : scheduled.getTime() > lastTick.getTime()
    if (!inWindow) continue
    out.push({ reminder: r, late: age > LATE_AFTER_MS, scheduled })
  }
  return out
}
