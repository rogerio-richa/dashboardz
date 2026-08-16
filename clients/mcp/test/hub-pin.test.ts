import { afterEach, describe, expect, it } from 'vitest'
// Cross-package imports: clients/mcp, the hub, relay and the sender client are separate npm
// packages sharing this repo but not a dependency graph (same pattern as relay/test/e2e.test.ts).
// The test reaches into the hub's src/ directly; hub/node_modules still resolves its own deps
// (fastify, better-sqlite3) because bare imports resolve relative to the importing FILE, not this
// package's node_modules.
import { buildServer as buildHub } from '../../../hub/src/server.js'
import { openDb } from '../../../hub/src/db/index.js'
import { createAgentToken } from '../../../hub/src/db/agents.js'
import { HubClient } from '../src/hub.js'
import { fetchContract } from '../src/contract.js'
import { TOOLS } from '../src/tools.js'
// Type-only, erased at build time (no runtime import, no side effect): hub/src/server.ts's
// `declare module 'fastify' { interface FastifyInstance { ... } }` augmentation for `relayClient`
// lives in relay/bootstrap.ts, reached in the hub's OWN program only because hub/src/boot.ts
// imports it — and boot.ts is not on this test's import path (it imports server.ts directly, per
// this test's design). Without this, the typecheck program never sees that file, and admin.ts's
// `app.relayClient` reference fails to resolve under this package's tsconfig.check.json (relay's
// own cross-package test avoids this only because IT imports boot.js).
import type {} from '../../../hub/src/relay/bootstrap.js'

/**
 * Every tool is exercised against a REAL hub, so an admin route that
 * appears, changes, or disappears fails here instead of silently leaving the agent behind. This
 * is why clients/mcp lives in the monorepo: this import is the pin.
 */
describe('every MCP tool works against a live hub', () => {
  const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
  let close: (() => Promise<void>) | null = null
  afterEach(async () => { await close?.(); close = null })

  it('drives the whole loop over real HTTP with a real agent token', async () => {
    const db = openDb(':memory:')
    const app = await buildHub({ config, db })
    await app.listen({ port: 0, host: '127.0.0.1' })
    close = () => app.close()
    const { token } = createAgentToken(db, 'pin')
    const port = (app.server.address() as { port: number }).port
    const hub = new HubClient(`http://127.0.0.1:${port}`, token)

    const contract = await fetchContract(hub)
    expect(Object.keys(contract.widgets)).toContain('gauge')

    // The unit test's schema assertions run against a hand-written minimal contract — real in
    // shape, but never the LIVE one this hub actually
    // serves. Re-assert the same two facts here, against `contract` fetched above over real HTTP,
    // so a hub-side change to cell_schema or the rect numbers that tools.test.ts's fixture doesn't
    // track still fails this test.
    const schema = TOOLS.find((t) => t.name === 'create_screen')!.inputSchema(contract) as {
      properties: { grid: { properties: { cells: { items: unknown } } } }
      description?: string
    }
    expect(schema.properties.grid.properties.cells.items).toBe(contract.cell_schema)
    expect(schema.description).toContain(String(contract.rect.min))
    expect(schema.description).toContain(String(contract.rect.quantum))
    expect(schema.description).toContain(String(contract.rect.max_cells))

    const call = async (name: string, args: Record<string, unknown>) =>
      TOOLS.find((t) => t.name === name)!.call(hub, contract, args)

    const feed = await call('create_feed', { name: 'pin-feed', mode: 'value' }) as { id: string }
    await call('create_sender', { name: 'pin-sender' })
    const fit = await call('check_fit', { widget: 'gauge', config: { path: 'v' } }) as { unfit: unknown[] }
    expect(Array.isArray(fit.unfit)).toBe(true)

    // POST /admin/api/screens returns the save result FLAT (screenOut(...) spread, not nested
    // under a `screen` key — see admin.ts's `{ ...screenOut(saved.screen), warnings: ... }`), so
    // the id/rev this test needs come straight off the response, not off a `.screen` property.
    const screen = await call('create_screen', {
      name: 'pin-screen', orientation: 'landscape',
      grid: { cells: [{ widget: 'gauge', config: { feed: feed.id, path: 'v' }, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] },
    }) as { id: string; rev: number; warnings: unknown[] }
    expect(Array.isArray(screen.warnings)).toBe(true)

    // Field-only PATCH (no grid): admin.ts's `rev` is carried in the BODY (screenBody's `withRev`
    // branch), and this branch of the route returns 204 with no body — update_screen's `call`
    // just forwards whatever hub.request resolves to, which HubClient turns into `undefined`.
    await call('update_screen', { id: screen.id, rev: screen.rev, name: 'renamed' })
    expect(((await call('get_screen', { id: screen.id })) as { name: string }).name).toBe('renamed')

    await call('list_screens', {})
    await call('list_feeds', {})
    await call('list_themes', {})
    await call('get_feed', { id: feed.id })
    await call('list_devices', {})
    await call('delete_screen', { id: screen.id })

    // assign_screen needs a paired device; a 404 on a fake id still proves the ROUTE exists — a
    // missing/renamed route would 404 with fastify's OWN not-found body, not the hub's
    // `{error: 'not found'}` shape (a route that vanished behind auth would 401 instead), so the
    // body shape is asserted too, not just the status.
    await expect(call('assign_screen', { device_id: 'dev_none', screen_id: null }))
      .rejects.toMatchObject({ status: 404, message: 'not found' })
  })
})
