import { describe, expect, it } from 'vitest'
import { HubClient, HubError } from '../src/hub.js'

describe('hub client', () => {
  it('sends Bearer + JSON and surfaces the hub error body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ error: 'unknown screen' }), { status: 400 })
    }
    const hub = new HubClient('http://h:8484', 'dbz_a_t', fake)
    await expect(hub.request('POST', '/admin/api/screens', { name: 'x' })).rejects.toMatchObject({ status: 400, message: 'unknown screen' })
    expect(calls[0]!.url).toBe('http://h:8484/admin/api/screens')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer dbz_a_t')
  })

  it('normalizes a trailing slash on the base URL (a trailing-slash DASHBOARDZ_HUB_URL must not double up to //admin/...)', async () => {
    const calls: { url: string }[] = []
    const fake: typeof fetch = async (url) => {
      calls.push({ url: String(url) })
      return new Response(JSON.stringify([]), { status: 200 })
    }
    const hub = new HubClient('http://h:8484/', 'dbz_a_t', fake)
    await hub.request('GET', '/admin/api/screens')
    expect(calls[0]!.url).toBe('http://h:8484/admin/api/screens')
  })
})
