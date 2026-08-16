import { createHash } from 'node:crypto'
import { CONTRACTS, type ContractDefinition } from '../data/contracts.js'
import { WIDGET_NEEDS } from '../data/needs.js'
import { WIDGET_REQUIREMENTS } from '../widgets/requirements.js'
import { cellSchema, gridSchema, RECT_MIN, RECT_QUANTUM } from './cellSchema.js'
import { WIDGET_FEED_MODES } from './save.js'

export interface WidgetContract {
  widgets: Record<string, {
    config: unknown                       // the widget's cellSchema oneOf branch config, verbatim
    modes?: readonly string[]             // generic widgets (incl. [] for clock/alert_feed)
    needs?: readonly unknown[]            // generic widgets
    contract?: string                     // semantic widgets: the contract id
    required_capabilities?: readonly string[]
    optional_capabilities?: readonly string[]
  }>
  cell_schema: unknown                    // cellSchema, verbatim — what AJV actually validates with
  rect: { min: number; quantum: number; max_cells: number }
  contracts: Record<string, { mode: string; collection_limit?: number }>
  revision: string                        // sha256 hex of the JSON above; the MCP's skew sentinel
}

/**
 * The machine-readable contract GET /admin/api/widget-contract is built FROM the objects AJV
 * validates with — this module copies nothing, it
 * rearranges: the config branches come off cellSchema itself, so a new widget or knob cannot
 * ship invisible to agents (widget-contract.test.ts pins that). The semantic three carry their
 * contract ids from WIDGET_REQUIREMENTS rather than empty modes/needs stubs — served empty, a
 * weather_forecast would be indistinguishable from clock, which is GENUINELY feedless.
 *
 * `revision` is a content hash, not a version number: nobody has to remember to bump it, and the
 * MCP compares it mid-session to refuse politely across a hub upgrade (deployment skew is the
 * argument for this endpoint existing at all — the MCP is built independently of the hub it
 * talks to).
 */
export function buildWidgetContract(): WidgetContract {
  const widgets: WidgetContract['widgets'] = {}
  for (const branch of (cellSchema as { oneOf: { properties: { widget: { const: string }; config: unknown } }[] }).oneOf) {
    const widget = branch.properties.widget.const
    const requirement = WIDGET_REQUIREMENTS[widget as keyof typeof WIDGET_REQUIREMENTS]
    widgets[widget] = requirement
      ? {
          config: branch.properties.config,
          contract: requirement.contract_id,
          required_capabilities: requirement.required_capabilities,
          optional_capabilities: requirement.optional_capabilities,
        }
      : {
          config: branch.properties.config,
          modes: WIDGET_FEED_MODES[widget] ?? [],
          needs: WIDGET_NEEDS[widget as keyof typeof WIDGET_NEEDS] ?? [],
        }
  }
  const body = {
    widgets,
    cell_schema: cellSchema,
    rect: {
      min: RECT_MIN, quantum: RECT_QUANTUM,
      max_cells: (gridSchema.properties.cells as { maxItems: number }).maxItems,
    },
    contracts: Object.fromEntries(Object.entries(CONTRACTS).map(([id, c]) => {
      const contract = c as ContractDefinition
      return [
        id, { mode: contract.mode, ...(contract.collection_limit !== undefined ? { collection_limit: contract.collection_limit } : {}) },
      ]
    })),
  }
  return { ...body, revision: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

/** Static per build — the schema cannot change under a running hub. */
export const WIDGET_CONTRACT = buildWidgetContract()
