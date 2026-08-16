import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { runDaemon } from '../src/daemon.js'
import { ReminderStore } from '../src/store.js'
import { fireReminder } from '../src/reminders.js'
import type { Hub } from '../src/hub.js'

describe('runDaemon', () => {
  it('fires due reminders and persists lastTick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbza-'))
    const cfg = loadConfig({
      DASHBOARDZ_HUB_URL: 'http://h:1', DASHBOARDZ_SENDER_TOKEN: 's', DASHBOARDZ_AGENT_TOKEN: 'a',
      ASSISTANT_DATA_DIR: dir, ASSISTANT_TICK_MS: '1',
    })
    const store = new ReminderStore(join(dir, 'reminders.json'))
    const nowRef = { t: new Date(2026, 7, 12, 8, 59, 30) }
    store.add({ id: 'm', title: 'meds', at: '09:00', snoozeMin: 10 })
    const fire = vi.fn(async () => 'done' as const)
    await runDaemon(cfg, store, {} as Hub, {
      sleep: async () => { nowRef.t = new Date(2026, 7, 12, 9, 0, 30) },
      now: () => nowRef.t,
      fire: fire as any,
      maxTicks: 2,
    })
    expect(fire).toHaveBeenCalledTimes(1)
    const calledReminder = (fire as any).mock.calls[0]?.[2]
    expect(calledReminder).toMatchObject({ id: 'm' })
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    expect(new Date(state.lastTick).getTime()).toBe(nowRef.t.getTime())
  })
  it('a throwing fire does not kill the loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbza-'))
    const cfg = loadConfig({
      DASHBOARDZ_HUB_URL: 'http://h:1', DASHBOARDZ_SENDER_TOKEN: 's', DASHBOARDZ_AGENT_TOKEN: 'a',
      ASSISTANT_DATA_DIR: dir, ASSISTANT_TICK_MS: '1',
    })
    const store = new ReminderStore(join(dir, 'reminders.json'))
    store.add({ id: 'm', title: 'meds', at: '09:00', snoozeMin: 10 })
    const nowRef = { t: new Date(2026, 7, 12, 9, 0, 30) }
    const fire = vi.fn(async () => { throw new Error('hub down') })
    await expect(runDaemon(cfg, store, {} as Hub, {
      sleep: async () => {}, now: () => nowRef.t, fire, maxTicks: 2,
    })).resolves.toBeUndefined()
  })
})
