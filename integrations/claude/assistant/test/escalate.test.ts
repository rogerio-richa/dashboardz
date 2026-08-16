import { describe, expect, it, vi } from 'vitest'
import { askWithEscalation } from '../src/escalate.js'
import { HubError, type Answer, type Hub } from '../src/hub.js'

function hubStub(answers: Record<string, Answer[]>) {
  let n = 0
  const stub = {
    notifyCalls: [] as unknown[],
    resolved: [] as string[],
    notify: vi.fn(async (body: unknown) => {
      stub.notifyCalls.push(body)
      return { id: `alr_${++n}` }
    }),
    answer: vi.fn(async (id: string) =>
      answers[id]!.length > 1 ? answers[id]!.shift()! : answers[id]![0]!),
    resolve: vi.fn(async (k: string) => { stub.resolved.push(k); return true }),
    pushFeed: vi.fn(),
  }
  return stub as unknown as Hub & typeof stub
}

const OPTS = { options: [{ id: 'ok', label: 'OK' }], ttlS: 600, dedupKey: 'k' }
const fast = { pollMs: 1, sleep: async () => {} }

describe('askWithEscalation', () => {
  it('returns the tapped option without escalating when answered promptly', async () => {
    const hub = hubStub({ alr_1: [{ state: 'pending' }, { state: 'answered', option_id: 'ok' }] })
    const res = await askWithEscalation(hub, { title: 'q', ...OPTS }, fast)
    expect(res).toEqual({ state: 'answered', optionId: 'ok' })
    expect(hub.notifyCalls).toHaveLength(1)
    expect(hub.resolved).toEqual(['k', 'k-esc'])
  })
  it('escalates with a NEW alert carrying sound after the threshold', async () => {
    const hub = hubStub({
      alr_1: [{ state: 'pending' }],
      alr_2: [{ state: 'pending' }, { state: 'answered', option_id: 'ok' }],
    })
    const res = await askWithEscalation(hub, { title: 'q', ...OPTS, escalateAfterMin: 0 }, fast)
    expect(res.state).toBe('answered')
    expect(hub.notifyCalls).toHaveLength(2)
    expect(hub.notifyCalls[1]).toMatchObject({ sound: true, dedup_key: 'k-esc', title: 'Still waiting: q' })
  })
  it('reports expired when both alerts expire', async () => {
    const hub = hubStub({ alr_1: [{ state: 'expired' }], alr_2: [{ state: 'expired' }] })
    const res = await askWithEscalation(hub, { title: 'q', ...OPTS, escalateAfterMin: 0 }, fast)
    expect(res).toEqual({ state: 'expired' })
    expect(hub.resolved).toEqual(['k', 'k-esc'])
  })
  it('dismissed is terminal', async () => {
    const hub = hubStub({ alr_1: [{ state: 'dismissed' }] })
    expect(await askWithEscalation(hub, { title: 'q', ...OPTS }, fast)).toEqual({ state: 'dismissed' })
  })
  it('a transient HubError from answer() is logged and treated as still-pending', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const hub = {
      notifyCalls: [] as unknown[],
      resolved: [] as string[],
      notify: vi.fn(async (body: unknown) => { hub.notifyCalls.push(body); return { id: 'alr_1' } }),
      answer: vi.fn(async (_id: string) => {
        calls++
        if (calls === 1) throw new HubError(502, 'answer(alr_1) -> 502')
        return { state: 'answered', option_id: 'ok' }
      }),
      resolve: vi.fn(async (k: string) => { hub.resolved.push(k); return true }),
      pushFeed: vi.fn(),
    } as unknown as Hub & { notifyCalls: unknown[]; resolved: string[] }
    const res = await askWithEscalation(hub, { title: 'q', ...OPTS }, fast)
    expect(res).toEqual({ state: 'answered', optionId: 'ok' })
    expect(calls).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('alr_1'))
    errSpy.mockRestore()
  })
  it('a non-HubError from answer() propagates', async () => {
    const hub = {
      notify: vi.fn(async () => ({ id: 'alr_1' })),
      answer: vi.fn(async () => { throw new Error('boom') }),
      resolve: vi.fn(async () => true),
      pushFeed: vi.fn(),
    } as unknown as Hub
    await expect(askWithEscalation(hub, { title: 'q', ...OPTS }, fast)).rejects.toThrow('boom')
  })
  it('extends deadline when escalation fires and answer arrives on escalated alert', async () => {
    // Scenario: escalateAfterMin=0.001 (60ms), ttlS=0.1 (100ms base deadline, 160ms extended)
    // pollMs=10ms, so: escalation at ~60ms, old deadline at 100ms, new deadline at 160ms
    // Answer on alr_2 arrives at ~110ms (AFTER old deadline, BEFORE extended)
    // Without deadline extension, would return expired at 100ms, losing the answer
    // With deadline extension, correctly polls until 160ms and gets the answer
    const hub = hubStub({
      alr_1: [
        { state: 'pending' }, { state: 'pending' }, { state: 'pending' }, { state: 'pending' },
        { state: 'pending' }, { state: 'pending' }, { state: 'pending' }, { state: 'pending' },
        { state: 'pending' }, { state: 'pending' }, { state: 'pending' }, { state: 'pending' },
      ],
      alr_2: [
        { state: 'pending' }, { state: 'pending' }, { state: 'pending' }, { state: 'pending' },
        { state: 'pending' }, { state: 'answered', option_id: 'ok' },
      ],
    })
    const res = await askWithEscalation(
      hub,
      { title: 'q', options: [{ id: 'ok', label: 'OK' }], ttlS: 0.1, escalateAfterMin: 0.001, dedupKey: 'k' },
      { pollMs: 10, sleep: async () => {} }
    )
    expect(res).toEqual({ state: 'answered', optionId: 'ok' })
    expect(hub.notifyCalls).toHaveLength(2)
    expect(hub.resolved).toEqual(['k', 'k-esc'])
  })
})
