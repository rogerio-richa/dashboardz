import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HubClient } from '../src/hub.js'
import type { WidgetContract } from '../src/contract.js'
import { buildServer } from '../src/server.js'

const baseContractBody = {
  widgets: { gauge: { config: { type: 'object' }, modes: ['value'], needs: [] } },
  cell_schema: { type: 'object', required: ['widget', 'config', 'rect'], oneOf: [] },
  rect: { min: 0.05, quantum: 0.001, max_cells: 12 },
  contracts: {},
}

type CallToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> }

/**
 * buildServer's revision-skew guard, driven end to end through a real MCP Client over an
 * in-process transport pair (the SDK's own sanctioned way to exercise a Server without a live
 * process) — not by reaching into Server's private handler map.
 */
describe('server.ts: revision skew guard', () => {
  const startupContract: WidgetContract = { ...baseContractBody, revision: 'rev-A' }

  const connect = async (fetchImpl: typeof fetch) => {
    const hub = new HubClient('http://h', 'dbz_a_t', fetchImpl)
    const server = buildServer(hub, startupContract)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
  }

  /**
   * A contract skew must not require an operator to restart the process. Hub rebuilds are a normal
   * part of developing against the hub, and schema-shaped writes continue after the fresh contract
   * is adopted.
   *
   * MCP already has the answer: a server may change its tool list and say so
   * (`notifications/tools/list_changed`), and clients re-fetch. So the guard now ADOPTS the new
   * contract, tells the client its tools changed, and lets the call through against the fresh
   * schema. The hub validates the payload either way — it is the source of truth — so the worst a
   * stale argument can do is earn a clear 400 instead of a silent wrong write.
   */
  it('adopts the new contract mid-session and lets the write through, instead of demanding a restart', async () => {
    let contractHits = 0
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('/admin/api/widget-contract')) {
        contractHits++
        return new Response(JSON.stringify({ ...baseContractBody, revision: 'rev-B' }), { status: 200 })
      }
      if (u.includes('/admin/api/screens') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'lay_new', rev: 1, warnings: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'unexpected url in test' }), { status: 404 })
    }
    const client = await connect(fetchImpl)

    let toolsChanged = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { toolsChanged++ })

    const created = await client.callTool({
      name: 'create_screen',
      arguments: { name: 'x', orientation: 'landscape', grid: { cells: [] } },
    }) as CallToolResult

    expect(created.isError).toBeFalsy()
    expect(JSON.parse(created.content[0]!.text)).toMatchObject({ id: 'lay_new' })
    expect(contractHits).toBeGreaterThan(0)
    // The client is TOLD, so it can re-read the schemas rather than keep describing the old hub.
    await new Promise((r) => setTimeout(r, 10))
    expect(toolsChanged).toBe(1)
  })

  it('only announces a change once per upgrade, not on every call afterwards', async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('/admin/api/widget-contract')) {
        return new Response(JSON.stringify({ ...baseContractBody, revision: 'rev-B' }), { status: 200 })
      }
      if (u.includes('/admin/api/screens') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'lay_new', rev: 1, warnings: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'unexpected url in test' }), { status: 404 })
    }
    const client = await connect(fetchImpl)
    let toolsChanged = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { toolsChanged++ })

    const args = { name: 'x', orientation: 'landscape', grid: { cells: [] } }
    await client.callTool({ name: 'create_screen', arguments: args })
    await client.callTool({ name: 'create_screen', arguments: args })
    await new Promise((r) => setTimeout(r, 10))
    expect(toolsChanged).toBe(1)
  })

  it('serves the NEW contract to a tools/list after the upgrade', async () => {
    // `rect.max_cells`, not a new widget key: the tool's schema is built from `cell_schema` and
    // `rect`, so a change to the widgets map would prove nothing about what the client is told.
    const upgraded = { ...baseContractBody, revision: 'rev-B', rect: { min: 0.05, quantum: 0.001, max_cells: 7 } }
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('/admin/api/widget-contract')) return new Response(JSON.stringify(upgraded), { status: 200 })
      if (u.includes('/admin/api/screens') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'lay_new', rev: 1, warnings: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'unexpected url in test' }), { status: 404 })
    }
    const client = await connect(fetchImpl)
    await client.callTool({ name: 'create_screen', arguments: { name: 'x', orientation: 'landscape', grid: { cells: [] } } })

    const listed = await client.listTools()
    const createScreen = listed.tools.find((t) => t.name === 'create_screen')!
    // The proof that the adoption reached the ADVERTISED schema, not just the call path.
    expect(JSON.stringify(createScreen.inputSchema)).toContain('"maxItems":7')
  })

  it('leaves plain reads working, as it always did', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const u = String(url)
      if (u.includes('/admin/api/widget-contract')) {
        // The hub the MCP re-checks against now serves a DIFFERENT revision than the one
        // buildServer was constructed with — the mid-session upgrade this guard exists for.
        return new Response(JSON.stringify({ ...baseContractBody, revision: 'rev-B' }), { status: 200 })
      }
      if (u.includes('/admin/api/screens')) {
        return new Response(JSON.stringify([{ id: 'lay_1', name: 'unchanged' }]), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'unexpected url in test' }), { status: 404 })
    }
    const client = await connect(fetchImpl)

    // list_screens is not in SCHEMA_SHAPED — it never re-checks the contract, so it still works
    // even mid-skew (only the tools whose SCHEMA depends on the contract refuse).
    const ok = await client.callTool({ name: 'list_screens', arguments: {} }) as CallToolResult
    expect(ok.isError).toBeFalsy()
    expect(JSON.parse(ok.content[0]!.text)).toEqual([{ id: 'lay_1', name: 'unchanged' }])
  })
})

describe('server.ts: HubError -> isError seam (a thrown HubError becomes a tool-level error, not success)', () => {
  const startupContract: WidgetContract = { ...baseContractBody, revision: 'rev-A' }

  it('a get_screen miss surfaces as isError with the hub-style not-found message, never a success-shaped null', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const u = String(url)
      if (u.includes('/admin/api/screens')) {
        return new Response(JSON.stringify([{ id: 'lay_other', name: 'other' }]), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'unexpected url in test' }), { status: 404 })
    }
    const hub = new HubClient('http://h', 'dbz_a_t', fetchImpl)
    const server = buildServer(hub, startupContract)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

    const result = await client.callTool({ name: 'get_screen', arguments: { id: 'lay_missing' } }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/lay_missing/)
  })
})

describe('server.ts: a network-level failure (not a HubError) also surfaces as isError, not a dropped connection', () => {
  const startupContract: WidgetContract = { ...baseContractBody, revision: 'rev-A' }

  it('a fetch rejection becomes a readable tool-level error', async () => {
    const fetchImpl: typeof fetch = async () => { throw new TypeError('fetch failed') }
    const hub = new HubClient('http://h', 'dbz_a_t', fetchImpl)
    const server = buildServer(hub, startupContract)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

    const result = await client.callTool({ name: 'list_screens', arguments: {} }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/fetch failed/)
  })
})

/**
 * SKILL.md rides MCP initialize `instructions` — the client-visible half is what matters, so this
 * goes through a real Client, not into Server internals. The degrade case is the
 * loader's own contract: a missing file yields undefined, never a throw.
 */
describe('server.ts: SKILL.md as initialize instructions', () => {
  it('a connected client receives the skill (identified by its own heading)', async () => {
    const hub = new HubClient('http://h', 'dbz_a_t', (() => { throw new Error('no fetch in this test') }) as never)
    const server = buildServer(hub, { ...baseContractBody, revision: 'rev-A' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    expect(client.getInstructions()).toContain('Dashboardz Screens (via dashboardz-mcp)')
  })

  it('loadSkillInstructions degrades to undefined on a missing file', async () => {
    const { loadSkillInstructions } = await import('../src/server.js')
    expect(loadSkillInstructions('/nowhere/SKILL.md')).toBeUndefined()
  })
})
