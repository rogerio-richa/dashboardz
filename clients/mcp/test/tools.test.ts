import { describe, expect, it } from 'vitest'
import { HubClient } from '../src/hub.js'
import type { WidgetContract } from '../src/contract.js'
import { TOOLS } from '../src/tools.js'

// A minimal but structurally real contract: cell_schema/rect carry the shapes create_screen and
// update_screen embed exactly, so a test asserting on THAT embedding is asserting on the same
// object identity the real hub's WIDGET_CONTRACT would produce.
const contract: WidgetContract = {
  widgets: { gauge: { config: { type: 'object' }, modes: ['value', 'stream'], needs: [] } },
  cell_schema: { type: 'object', required: ['widget', 'config', 'rect'], oneOf: [] },
  rect: { min: 0.05, quantum: 0.001, max_cells: 12 },
  contracts: {},
  revision: 'rev-a',
}

const tool = (name: string) => {
  const found = TOOLS.find((t) => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

/** A fake `fetch` that records every call and replays canned responses in order. */
function fakeFetch(responses: { status: number; body: unknown }[]): { fetch: typeof fetch; calls: { url: string; method: string; body: unknown }[] } {
  const calls: { url: string; method: string; body: unknown }[] = []
  let i = 0
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = responses[Math.min(i, responses.length - 1)]
    i += 1
    return new Response(JSON.stringify(next.body), { status: next.status })
  }
  return { fetch: fetchImpl, calls }
}

describe('TOOLS table', () => {
  it('exposes the documented tool set, excluding the admin-only create_theme operation', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'list_devices', 'assign_screen', 'set_device_tabs', 'list_screens', 'get_screen', 'create_screen',
      'update_screen', 'delete_screen', 'list_feeds', 'get_feed', 'create_feed',
      'create_sender', 'list_themes', 'list_sounds', 'check_fit',
    ])
  })

  it('create_screen embeds the served cell_schema exactly and states the served rect numbers', () => {
    const schema = tool('create_screen').inputSchema(contract) as {
      properties: { grid: { properties: { cells: { items: unknown } } } }
      description?: string
    }
    expect(schema.properties.grid.properties.cells.items).toBe(contract.cell_schema)
    expect(schema.description).toContain(String(contract.rect.min))
    expect(schema.description).toContain(String(contract.rect.quantum))
    expect(schema.description).toContain(String(contract.rect.max_cells))
  })

  it('update_screen requires rev, and a 409 tells the caller to re-read with get_screen and never retry', async () => {
    const schema = tool('update_screen').inputSchema(contract) as { required: string[] }
    expect(schema.required).toContain('rev')

    const { fetch } = fakeFetch([{ status: 409, body: { error: 'screen changed elsewhere', rev: 5 } }])
    const hub = new HubClient('http://h', 'dbz_a_t', fetch)
    await expect(tool('update_screen').call(hub, contract, { id: 'lay_x', rev: 1, name: 'renamed' }))
      .rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/get_screen/),
      })
    await expect(tool('update_screen').call(hub, contract, { id: 'lay_x', rev: 1, name: 'renamed' }))
      .rejects.toMatchObject({ message: expect.stringMatching(/never.*retry|retry.*never/i) })
  })

  it('create_screen and update_screen accept the same sparse sounds override the admin UI edits', () => {
    for (const name of ['create_screen', 'update_screen']) {
      const schema = tool(name).inputSchema(contract) as {
        properties: { sounds: { properties: Record<string, unknown>; additionalProperties: boolean } }
      }
      expect(Object.keys(schema.properties.sounds.properties).sort(),
        `${name} sounds events`).toEqual(['activity', 'critical', 'info', 'offline', 'warn'])
      expect(schema.properties.sounds.additionalProperties).toBe(false)
    }
  })

  it('update_screen passes sounds through the PATCH body, and {} travels intact (the clear-override sentinel)', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
    const hub = new HubClient('http://h', 'dbz_a_t', fetch)
    await tool('update_screen').call(hub, contract, { id: 'lay_x', rev: 3, sounds: {} })
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.body).toEqual({ rev: 3, sounds: {} })
  })

  it('list_sounds returns the public sound manifest exactly — the vocabulary the sounds override accepts', async () => {
    const manifest = { rev: 3, families: { classic: { name: 'Classic beeps' }, bells: { name: 'Soft bells' } } }
    const { fetch, calls } = fakeFetch([{ status: 200, body: manifest }])
    const hub = new HubClient('http://h', 'dbz_a_t', fetch)
    const result = await tool('list_sounds').call(hub, contract, {})
    expect(result).toEqual(manifest)
    expect(calls[0]!.url).toBe('http://h/sounds/manifest.json')
    expect(calls[0]!.method).toBe('GET')
  })

  it('get_screen filters list_screens by id (no GET-by-id route exists on the hub)', async () => {
    const screens = [{ id: 'lay_a', name: 'A' }, { id: 'lay_b', name: 'B' }]
    const { fetch, calls } = fakeFetch([{ status: 200, body: screens }])
    const hub = new HubClient('http://h', 'dbz_a_t', fetch)
    const result = await tool('get_screen').call(hub, contract, { id: 'lay_b' })
    expect(result).toEqual({ id: 'lay_b', name: 'B' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://h/admin/api/screens')
    expect(calls[0]!.method).toBe('GET')
  })

  it('get_screen throws a 404 HubError naming the id when no screen matches (never a success-shaped null)', async () => {
    const screens = [{ id: 'lay_a', name: 'A' }]
    const { fetch } = fakeFetch([{ status: 200, body: screens }])
    const hub = new HubClient('http://h', 'dbz_a_t', fetch)
    await expect(tool('get_screen').call(hub, contract, { id: 'lay_missing' }))
      .rejects.toMatchObject({ status: 404, message: expect.stringMatching(/lay_missing/) })
  })

  it('check_fit calls GET /admin/api/feed-fit with widget and url-encoded JSON config', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { unfit: [] } }])
    const hub = new HubClient('http://h', 'dbz_a_t', fetch)
    await tool('check_fit').call(hub, contract, { widget: 'gauge', config: { feed: 'fed_1', path: 'v' } })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/admin/api/feed-fit')
    expect(url.searchParams.get('widget')).toBe('gauge')
    expect(JSON.parse(url.searchParams.get('config')!)).toEqual({ feed: 'fed_1', path: 'v' })
  })

  it('every write tool describes itself as acting immediately on the live hub', () => {
    for (const name of ['assign_screen', 'set_device_tabs', 'create_screen', 'update_screen', 'delete_screen', 'create_feed', 'create_sender']) {
      expect(tool(name).description).toMatch(/live hub/i)
    }
  })

  it('create_screen/update_screen carry the check_fit + warnings[] + pending-binding guidance exactly', () => {
    for (const name of ['create_screen', 'update_screen']) {
      const d = tool(name).description
      expect(d).toContain('check_fit')
      expect(d).toContain('warnings[]')
      expect(d).toContain('source_draft_id')
      expect(d).toContain('output_contract')
    }
  })

  it('maps the rest of the table straight onto their routes', async () => {
    const cases: { name: string; args: Record<string, unknown>; method: string; path: string; body?: unknown }[] = [
      { name: 'list_devices', args: {}, method: 'GET', path: '/admin/api/devices' },
      { name: 'assign_screen', args: { device_id: 'dev_1', screen_id: 'lay_1' }, method: 'PATCH', path: '/admin/api/devices/dev_1', body: { screen_id: 'lay_1' } },
      { name: 'set_device_tabs', args: { device_id: 'dev_1', tabs: [{ screen_id: 'lay_1', label: 'Home' }, { screen_id: 'lay_2' }] }, method: 'PATCH', path: '/admin/api/devices/dev_1', body: { tabs: [{ screen_id: 'lay_1', label: 'Home' }, { screen_id: 'lay_2' }] } },
      { name: 'list_screens', args: {}, method: 'GET', path: '/admin/api/screens' },
      { name: 'delete_screen', args: { id: 'lay_1' }, method: 'DELETE', path: '/admin/api/screens/lay_1' },
      { name: 'list_feeds', args: {}, method: 'GET', path: '/admin/api/feeds' },
      { name: 'get_feed', args: { id: 'fed_1' }, method: 'GET', path: '/admin/api/feeds/fed_1' },
      { name: 'create_feed', args: { name: 'x', mode: 'value' }, method: 'POST', path: '/admin/api/feeds', body: { name: 'x', mode: 'value' } },
      { name: 'create_sender', args: { name: 'x' }, method: 'POST', path: '/admin/api/senders', body: { name: 'x' } },
      { name: 'list_themes', args: {}, method: 'GET', path: '/admin/api/themes' },
    ]
    for (const c of cases) {
      const { fetch, calls } = fakeFetch([{ status: 200, body: {} }])
      const hub = new HubClient('http://h', 'dbz_a_t', fetch)
      await tool(c.name).call(hub, contract, c.args)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe(c.method)
      expect(new URL(calls[0]!.url).pathname).toBe(c.path)
      if (c.body !== undefined) expect(calls[0]!.body).toEqual(c.body)
    }
  })
})
