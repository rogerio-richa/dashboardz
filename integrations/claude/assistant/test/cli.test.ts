import { describe, expect, it } from 'vitest'
import { parseAskArgs, parseReminderArgs } from '../src/cli.js'

describe('parseReminderArgs', () => {
  it('parses a repeating reminder', () => {
    expect(parseReminderArgs(['Take meds', '--at', '21:00', '--days', 'mon,wed', '--snooze', '5', '--escalate', '15'])).toEqual({
      title: 'Take meds', at: '21:00', days: [1, 3], snoozeMin: 5, escalateAfterMin: 15,
    })
  })
  it('defaults snooze to 10 and accepts ISO one-shots', () => {
    const p = parseReminderArgs(['x', '--at', '2026-08-13T09:00:00.000Z'])
    expect(p.snoozeMin).toBe(10)
    expect(p.at).toBe('2026-08-13T09:00:00.000Z')
  })
  it('rejects a missing/invalid --at with usage in the message', () => {
    expect(() => parseReminderArgs(['x'])).toThrow(/--at/)
    expect(() => parseReminderArgs(['x', '--at', '25:99'])).toThrow(/--at/)
  })
  it('rejects invalid numeric --snooze', () => {
    expect(() => parseReminderArgs(['x', '--at', '21:00', '--snooze', 'abc'])).toThrow(/snooze/)
  })
  it('rejects invalid numeric --escalate', () => {
    expect(() => parseReminderArgs(['x', '--at', '21:00', '--escalate', 'xyz'])).toThrow(/escalate/)
  })
})

describe('parseAskArgs', () => {
  it('parses options as id=Label pairs, max 4', () => {
    const p = parseAskArgs(['Deploy?', '--option', 'yes=Ship it', '--option', 'no=Hold'])
    expect(p.options).toEqual([{ id: 'yes', label: 'Ship it' }, { id: 'no', label: 'Hold' }])
    expect(p.ttlS).toBe(3600)
    expect(() => parseAskArgs(['q', '--option', 'a=1', '--option', 'b=2', '--option', 'c=3', '--option', 'd=4', '--option', 'e=5'])).toThrow(/4/)
  })
  it('requires at least one option', () => {
    expect(() => parseAskArgs(['q'])).toThrow(/--option/)
  })
  it('rejects invalid numeric --ttl', () => {
    expect(() => parseAskArgs(['q', '--option', 'a=A', '--ttl', 'xh'])).toThrow(/ttl/)
  })
  it('rejects invalid numeric --escalate', () => {
    expect(() => parseAskArgs(['q', '--option', 'a=A', '--escalate', 'not_a_number'])).toThrow(/escalate/)
  })
})
