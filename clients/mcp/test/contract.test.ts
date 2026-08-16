import { describe, expect, it } from 'vitest'
import { HubClient, HubError } from '../src/hub.js'
import { fetchContractWithRetry } from '../src/contract.js'

const contractBody = {
  widgets: {}, cell_schema: {}, rect: { min: 0.05, quantum: 0.001, max_cells: 12 },
  contracts: {}, revision: 'rev-A',
}

describe('fetchContractWithRetry', () => {
  it('retries a network-level failure and succeeds once the hub becomes reachable', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      if (calls < 3) throw new TypeError('fetch failed')
      return new Response(JSON.stringify(contractBody), { status: 200 })
    }
    const hub = new HubClient('http://h', 'dbz_a_t', fetchImpl)
    const sleeps: number[] = []
    const contract = await fetchContractWithRetry(hub, { sleep: async (ms) => { sleeps.push(ms) } })
    expect(contract.revision).toBe('rev-A')
    expect(calls).toBe(3)
    expect(sleeps).toHaveLength(2)
  })

  it('gives up after the configured number of attempts', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => { calls++; throw new TypeError('fetch failed') }
    const hub = new HubClient('http://h', 'dbz_a_t', fetchImpl)
    await expect(fetchContractWithRetry(hub, { attempts: 2, sleep: async () => {} }))
      .rejects.toThrow('fetch failed')
    expect(calls).toBe(2)
  })

  it('does not retry a HubError — the hub answered, retrying an auth failure just wastes time', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }
    const hub = new HubClient('http://h', 'dbz_a_t', fetchImpl)
    await expect(fetchContractWithRetry(hub, { sleep: async () => {} })).rejects.toBeInstanceOf(HubError)
    expect(calls).toBe(1)
  })
})
