import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireReminder } from '../src/reminders.js'
import { ReminderStore, type Reminder } from '../src/store.js'
import type { Hub } from '../src/hub.js'

function hubFor(result: { state: string; option_id?: string }) {
  return {
    notify: vi.fn(async () => ({ id: 'alr_1' })),
    answer: vi.fn(async () => result),
    resolve: vi.fn(async () => true),
    pushFeed: vi.fn(async () => {}),
  } as unknown as Hub
}
const fresh = () => new ReminderStore(join(mkdtempSync(join(tmpdir(), 'dbza-')), 'r.json'))
const rep = (): Reminder => ({ id: 'meds', title: 'Take meds', at: '21:00', snoozeMin: 10 })
const OPTS = { late: false, adherenceFeed: 'feed_a', defaultDevices: [] }
const fast = { pollMs: 1, sleep: async () => {}, now: () => new Date(2026, 7, 12, 21, 0) }

describe('fireReminder', () => {
  it('done: asks with Done/Snooze, logs adherence, marks repeating fired', async () => {
    const hub = hubFor({ state: 'answered', option_id: 'done' })
    const store = fresh(); store.add(rep())
    const outcome = await fireReminder(hub, store, store.list()[0]!, OPTS, fast)
    expect(outcome).toBe('done')
    expect((hub.notify as any).mock.calls[0][0]).toMatchObject({
      title: 'Take meds', severity: 'warn', dedup_key: 'rem-meds',
      options: [{ id: 'done', label: 'Done' }, { id: 'snooze', label: 'Snooze 10m' }],
    })
    expect((hub.pushFeed as any).mock.calls[0]).toEqual(['feed_a', expect.objectContaining({ reminder: 'meds', outcome: 'done', late: false })])
    expect(store.list()[0]!.lastFiredDate).toBe('2026-08-12')
  })
  it('snooze: derives a one-shot re-fire', async () => {
    const hub = hubFor({ state: 'answered', option_id: 'snooze' })
    const store = fresh(); store.add(rep())
    const outcome = await fireReminder(hub, store, store.list()[0]!, OPTS, fast)
    expect(outcome).toBe('snoozed')
    const derived = store.list().find((r) => r.id.startsWith('meds-snooze-'))!
    expect(new Date(derived.at).getTime()).toBe(new Date(2026, 7, 12, 21, 10).getTime())
  })
  it('expired: logs missed', async () => {
    const hub = hubFor({ state: 'expired' })
    const store = fresh(); store.add(rep())
    expect(await fireReminder(hub, store, store.list()[0]!, OPTS, fast)).toBe('missed')
  })
  it('one-shot is marked done before asking (crash-safe)', async () => {
    const hub = hubFor({ state: 'answered', option_id: 'done' })
    const store = fresh()
    store.add({ id: 'once', title: 'x', at: new Date(2026, 7, 12, 21, 0).toISOString(), snoozeMin: 10 })
    await fireReminder(hub, store, store.list()[0]!, OPTS, fast)
    expect(store.list()[0]!.done).toBe(true)
  })
  it('askWithEscalation throwing entirely: outcome is missed, adherence row still pushed, reminder still marked fired', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hub = {
      notify: vi.fn(async () => { throw new Error('hub unreachable') }),
      answer: vi.fn(),
      resolve: vi.fn(async () => true),
      pushFeed: vi.fn(async () => {}),
    } as unknown as Hub
    const store = fresh(); store.add(rep())
    const outcome = await fireReminder(hub, store, store.list()[0]!, OPTS, fast)
    expect(outcome).toBe('missed')
    expect(store.list()[0]!.lastFiredDate).toBe('2026-08-12')
    expect((hub.pushFeed as any).mock.calls[0]).toEqual(['feed_a', expect.objectContaining({ reminder: 'meds', outcome: 'missed' })])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
  it('midnight-crossing: stamps lastFiredDate with scheduled date, not current date', async () => {
    // Reminder scheduled for 23:59 on Aug 11, daemon wakes at 00:10 on Aug 12
    const hub = hubFor({ state: 'answered', option_id: 'done' })
    const store = fresh(); store.add(rep())
    const scheduled = new Date(2026, 7, 11, 23, 59, 0) // Aug 11 23:59
    const now = new Date(2026, 7, 12, 0, 10, 0) // Aug 12 00:10
    const optsWithScheduled = { ...OPTS, scheduled }
    const depsWithNow = { ...fast, now: () => now }
    await fireReminder(hub, store, store.list()[0]!, optsWithScheduled, depsWithNow)
    expect(store.list()[0]!.lastFiredDate).toBe('2026-08-11') // Should be Aug 11, not Aug 12
  })
})
