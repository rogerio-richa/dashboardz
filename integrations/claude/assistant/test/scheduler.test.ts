import { describe, expect, it } from 'vitest'
import { dueReminders } from '../src/scheduler.js'
import type { Reminder } from '../src/store.js'

// 2026-08-12 is a Wednesday (day 3)
const d = (h: number, m: number) => new Date(2026, 7, 12, h, m, 0)
const rep = (over: Partial<Reminder> = {}): Reminder => ({ id: 'r', title: 't', at: '09:00', snoozeMin: 10, ...over })

describe('dueReminders', () => {
  it('fires a repeating reminder in the (lastTick, now] window, on time', () => {
    const due = dueReminders([rep()], d(9, 0), d(8, 59))
    expect(due).toHaveLength(1)
    expect(due[0]!.late).toBe(false)
  })
  it('does not fire before its time or twice in one day', () => {
    expect(dueReminders([rep()], d(8, 59), d(8, 58))).toHaveLength(0)
    expect(dueReminders([rep({ lastFiredDate: '2026-08-12' })], d(9, 1), d(9, 0))).toHaveLength(0)
  })
  it('respects the days filter', () => {
    expect(dueReminders([rep({ days: [3] })], d(9, 0), d(8, 59))).toHaveLength(1) // Wed
    expect(dueReminders([rep({ days: [0, 6] })], d(9, 0), d(8, 59))).toHaveLength(0)
  })
  it('catches up late after sleep, with the late marker', () => {
    const due = dueReminders([rep()], d(9, 20), d(8, 0)) // slept 8:00→9:20
    expect(due).toHaveLength(1)
    expect(due[0]!.late).toBe(true)
  })
  it('fresh start fires only within the catch-up window', () => {
    expect(dueReminders([rep()], d(9, 30), null)).toHaveLength(1)  // 30 min ago
    expect(dueReminders([rep()], d(11, 0), null)).toHaveLength(0)  // 2 h ago
  })
  it('one-shot fires once and honors done', () => {
    const iso = d(9, 0).toISOString()
    const one = (over: Partial<Reminder> = {}): Reminder => ({ id: 'o', title: 't', at: iso, snoozeMin: 10, ...over })
    expect(dueReminders([one()], d(9, 0), d(8, 59))).toHaveLength(1)
    expect(dueReminders([one({ done: true })], d(9, 0), d(8, 59))).toHaveLength(0)
    expect(dueReminders([one()], d(9, 5), d(9, 1))).toHaveLength(0) // already inside a past window
  })
})
