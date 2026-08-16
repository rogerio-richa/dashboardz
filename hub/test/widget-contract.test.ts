import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createAgentToken } from '../src/db/agents.js'
import { cellSchema, gridSchema, RECT_MIN, RECT_QUANTUM } from '../src/screens/cellSchema.js'
import { WIDGET_CONTRACT, buildWidgetContract } from '../src/screens/widgetContract.js'
import { WIDGET_FEED_MODES } from '../src/screens/save.js'
import { WIDGET_NEEDS } from '../src/data/needs.js'
import { WIDGET_REQUIREMENTS } from '../src/widgets/requirements.js'

const enumWidgets = (cellSchema.properties.widget as { enum: string[] }).enum
const branchConfig = (widget: string): unknown => {
  const branch = (cellSchema as { oneOf: { properties: { widget: { const: string }; config: unknown } }[] })
    .oneOf.find((b) => b.properties.widget.const === widget)
  return branch?.properties.config
}

describe('the served widget contract IS the schema AJV validates with', () => {
  it('names every widget in the enum, with its exact config branch', () => {
    expect(Object.keys(WIDGET_CONTRACT.widgets).sort()).toEqual([...enumWidgets].sort())
    for (const widget of enumWidgets) {
      expect(WIDGET_CONTRACT.widgets[widget]!.config).toEqual(branchConfig(widget))
    }
  })

  it('generic widgets carry the modes and needs tables; the semantic three carry their contract ids, not empty stubs', () => {
    for (const [widget, modes] of Object.entries(WIDGET_FEED_MODES)) {
      expect(WIDGET_CONTRACT.widgets[widget]!.modes).toEqual(modes)
      expect(WIDGET_CONTRACT.widgets[widget]!.needs).toEqual(WIDGET_NEEDS[widget])
      expect(WIDGET_CONTRACT.widgets[widget]!.contract).toBeUndefined()
    }
    for (const [widget, requirement] of Object.entries(WIDGET_REQUIREMENTS)) {
      const entry = WIDGET_CONTRACT.widgets[widget]!
      expect(entry.contract).toBe(requirement.contract_id)
      expect(entry.required_capabilities).toEqual(requirement.required_capabilities)
      expect(entry.optional_capabilities).toEqual(requirement.optional_capabilities)
      expect(entry.modes).toBeUndefined()
    }
  })

  it('serves the verbatim cell schema, the real rect rules, and a self-consistent revision', () => {
    expect(WIDGET_CONTRACT.cell_schema).toEqual(cellSchema)
    expect(WIDGET_CONTRACT.rect).toEqual({
      min: RECT_MIN, quantum: RECT_QUANTUM,
      max_cells: (gridSchema.properties.cells as { maxItems: number }).maxItems,
    })
    const { revision, ...body } = buildWidgetContract()
    expect(revision).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'))
  })
})

describe('GET /admin/api/widget-contract', () => {
  const config = { port: 0, dataDir: '/tmp', adminPassword: 'sekret', publicUrl: 'http://pi:8484', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
  let app: FastifyInstance, db: ReturnType<typeof openDb>

  beforeEach(async () => {
    db = openDb(':memory:')
    app = await buildServer({ config, db })
  })

  it('is guarded, and a Bearer agent token is enough', async () => {
    expect((await app.inject({ url: '/admin/api/widget-contract' })).statusCode).toBe(401)
    const { token } = createAgentToken(db, 'reader')
    const res = await app.inject({ url: '/admin/api/widget-contract', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().revision).toBe(WIDGET_CONTRACT.revision)
  })
})
