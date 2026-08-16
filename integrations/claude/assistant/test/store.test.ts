import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ReminderStore, type Reminder } from '../src/store.js'

const r = (id: string): Reminder => ({ id, title: 't', at: '21:00', snoozeMin: 10 })
const fresh = () => new ReminderStore(join(mkdtempSync(join(tmpdir(), 'dbza-')), 'reminders.json'))

describe('ReminderStore', () => {
  it('starts empty and round-trips adds', () => {
    const s = fresh()
    expect(s.list()).toEqual([])
    s.add(r('a')); s.add(r('b'))
    expect(s.list().map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('persists to disk as JSON', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dbza-')), 'reminders.json')
    new ReminderStore(path).add(r('a'))
    expect(JSON.parse(readFileSync(path, 'utf8'))[0].id).toBe('a')
    expect(new ReminderStore(path).list()[0]!.id).toBe('a')
  })
  it('update replaces by id, remove deletes', () => {
    const s = fresh()
    s.add(r('a'))
    s.update({ ...r('a'), title: 'changed' })
    expect(s.list()[0]!.title).toBe('changed')
    expect(s.remove('a')).toBe(true)
    expect(s.remove('a')).toBe(false)
  })
  it('a corrupt file degrades to empty, not a crash, and warns naming the file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dbza-')), 'reminders.json')
    writeFileSync(path, '{nope')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(new ReminderStore(path).list()).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(path))
    warnSpy.mockRestore()
  })
  it('an absent file degrades to empty silently (no warn)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dbza-')), 'reminders.json')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(new ReminderStore(path).list()).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
