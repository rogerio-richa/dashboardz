import { describe, expect, it, vi } from 'vitest'
import { Hub, HubError } from '../src/hub.js'

function fetchStub(status: number, json: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch & { mock: { calls: any[][] } }
}

describe('Hub', () => {
  it('posts notify with bearer auth and returns the alert id', async () => {
    const f = fetchStub(200, { id: 'alr_1' })
    const hub = new Hub('http://h:1', 'dbz_s_t', f as unknown as typeof fetch)
    const res = await hub.notify({ title: 'x', severity: 'warn' })
    expect(res.id).toBe('alr_1')
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('http://h:1/api/notify')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer dbz_s_t')
    expect(JSON.parse(init!.body as string)).toEqual({ title: 'x', severity: 'warn' })
  })
  it('resolve sends {resolve:true,dedup_key} and returns the resolved flag', async () => {
    const f = fetchStub(200, { ok: true, resolved: false })
    const hub = new Hub('http://h:1', 't', f as unknown as typeof fetch)
    expect(await hub.resolve('k')).toBe(false)
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ resolve: true, dedup_key: 'k' })
  })
  it('answer hits /api/alerts/:id/answer', async () => {
    const f = fetchStub(200, { state: 'answered', option_id: 'done' })
    const hub = new Hub('http://h:1', 't', f as unknown as typeof fetch)
    const a = await hub.answer('alr_9')
    expect(a).toEqual({ state: 'answered', option_id: 'done' })
    expect(f.mock.calls[0]![0]).toBe('http://h:1/api/alerts/alr_9/answer')
  })
  it('throws HubError with status on non-2xx', async () => {
    const hub = new Hub('http://h:1', 'bad', fetchStub(401, { error: 'invalid token' }) as unknown as typeof fetch)
    await expect(hub.notify({ title: 'x', severity: 'info' })).rejects.toMatchObject({ status: 401 })
    await expect(hub.notify({ title: 'x', severity: 'info' })).rejects.toBeInstanceOf(HubError)
  })
  it('pushFeed posts payload to /api/feeds/:id', async () => {
    const f = fetchStub(200, { ok: true, pushed_at: 1 })
    const hub = new Hub('http://h:1', 't', f as unknown as typeof fetch)
    await hub.pushFeed('feed_a', { outcome: 'done' })
    expect(f.mock.calls[0]![0]).toBe('http://h:1/api/feeds/feed_a')
  })
})
