import { askWithEscalation, type AskResult, type EscalateDeps } from './escalate.js'
import type { Hub } from './hub.js'
import type { Reminder, ReminderStore } from './store.js'

export type Outcome = 'done' | 'snoozed' | 'dismissed' | 'missed'
export interface FireDeps extends EscalateDeps { now?: () => Date }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function ymd(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

export async function fireReminder(
  hub: Hub, store: ReminderStore, r: Reminder,
  opts: { late: boolean; adherenceFeed: string | null; defaultDevices: string[]; scheduled?: Date },
  deps: FireDeps = {},
): Promise<Outcome> {
  const now = deps.now ?? (() => new Date())

  // Mark BEFORE asking: a crash mid-poll must not re-fire on restart.
  if (HHMM.test(r.at)) store.update({ ...r, lastFiredDate: ymd(opts.scheduled ?? now()) })
  else store.update({ ...r, done: true })

  const devices = r.devices ?? (opts.defaultDevices.length ? opts.defaultDevices : undefined)
  let res: AskResult | undefined
  try {
    res = await askWithEscalation(hub, {
      title: opts.late ? `Late: ${r.title}` : r.title,
      body: r.body,
      devices,
      options: [
        { id: 'done', label: 'Done' },
        { id: 'snooze', label: `Snooze ${r.snoozeMin}m` },
      ],
      ttlS: 3600,
      dedupKey: `rem-${r.id}`,
      escalateAfterMin: r.escalateAfterMin,
    }, deps)
  } catch (e) {
    // The reminder was already marked fired above; a failed ask must not
    // crash the daemon — degrade to a missed outcome and keep going.
    console.error(`fireReminder: askWithEscalation failed for ${r.id}: ${(e as Error)?.message ?? e}`)
  }

  let outcome: Outcome
  if (!res) outcome = 'missed'
  else if (res.state === 'answered' && res.optionId === 'snooze') {
    outcome = 'snoozed'
    const at = new Date(now().getTime() + r.snoozeMin * 60_000)
    store.add({
      id: `${r.id}-snooze-${at.getTime()}`, title: r.title, body: r.body,
      at: at.toISOString(), devices: r.devices, snoozeMin: r.snoozeMin,
      escalateAfterMin: r.escalateAfterMin,
    })
  } else if (res.state === 'answered') outcome = 'done'
  else if (res.state === 'dismissed') outcome = 'dismissed'
  else outcome = 'missed'

  if (opts.adherenceFeed) {
    try {
      await hub.pushFeed(opts.adherenceFeed, {
        reminder: r.id, title: r.title, outcome, late: opts.late, at: now().toISOString(),
      })
    } catch { /* adherence logging must never fail the reminder */ }
  }
  return outcome
}
