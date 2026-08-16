import type { HubClient } from './hub.js'
import { HubError } from './hub.js'
import type { WidgetContract } from './contract.js'

/**
 * One row per admin route the MCP exposes to an agent. `inputSchema` takes the contract fetched
 * at startup (not a closed-over module constant) because the grid/rect shape it describes is
 * hub-specific — a hub with a different widget set or rect quantum serves a different schema.
 * `call` is deliberately thin: every entry is (mostly) a direct `hub.request(...)`, so the table
 * IS the route map — the MCP skill pins public tool names by reading the `name:` fields out of this file, and
 * `hub-pin.test.ts` proves the routes below still exist on a real hub.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema(contract: WidgetContract): object
  call(hub: HubClient, contract: WidgetContract, args: Record<string, unknown>): Promise<unknown>
}

// Every write tool says this exactly, so an agent reading tool descriptions in any order still
// learns the one fact that matters most: there is no draft/staging step, no dry run — a call here
// is a real write against whatever hub the operator pointed this process at.
const LIVE_WRITE = 'Acts immediately on the live hub — there is no draft or confirmation step.'

// The exact guidance shown by create_screen/update_screen (agent-facing
// wording, exactly). It is one string reused on both tools rather than typed out twice, so the
// two descriptions cannot quietly drift the way the same warning drifted across two route files
// Both tools use this shared warning, keeping their operator guidance identical.
const BINDING_GUIDANCE =
  'Run check_fit before binding a feed; read warnings[] in the response and never ignore it; ' +
  'a cell may carry a pending binding (source_draft_id + output_contract) when the data does not ' +
  'exist yet.'

const UPDATE_CONFLICT_GUIDANCE =
  'rev is required and must be the revision last read for this screen (from list_screens, ' +
  'get_screen, or a prior write’s response). A 409 means the screen changed elsewhere since ' +
  'that read: re-read it with get_screen and reconcile by hand — never blindly retry the same write.'

// Embedded directly (not copied) at properties.grid.properties.cells.items, so an agent reading
// the tool's schema is reading the SAME object AJV validates a save against — no second, drifting
// copy of the per-widget config shapes to keep in sync with cellSchema.ts.
const gridSchemaFor = (contract: WidgetContract) => ({
  type: 'object', additionalProperties: false, required: ['cells'],
  properties: {
    cells: {
      type: 'array', minItems: 1, maxItems: contract.rect.max_cells,
      items: contract.cell_schema,
    },
  },
})

// A JSON-schema-level `description` (an annotation ON the schema itself, distinct from the
// ToolDef's own static `description` string above) is the only place the served numbers —
// contract.rect.min/quantum/max_cells — can live: ToolDef.description is a fixed string shared by
// every hub this package ever talks to, but the rect quantum is not. Putting the numbers here
// means an agent meets them before guessing a rect and getting a 400, not after.
const rectRuleDescription = (contract: WidgetContract) =>
  `Screen grid rules served by this hub: each cell's rect has x, y, w, h as fractions of the ` +
  `screen (0..1). w and h must each be >= ${contract.rect.min} and a multiple of ` +
  `${contract.rect.quantum}. A grid holds at most ${contract.rect.max_cells} cells, and cells may ` +
  `not overlap (every cell needs x+w <= 1 and y+h <= 1).`

/**
 * The five sound events a screen override can name (mirrors SOUND_EVENTS in hub/src/sounds.ts;
 * the hub's own body schema rejects any other key, so drift here fails loudly, not silently).
 */
const SOUND_EVENTS = ['critical', 'warn', 'info', 'offline', 'activity'] as const

const screenFieldProps = (contract: WidgetContract) => ({
  name: { type: 'string', minLength: 1, maxLength: 100 },
  orientation: { enum: ['landscape', 'portrait'] },
  // Nullable, not just optional: a screen must be able to clear its theme back to the built-in
  // default (mirrors admin.ts's own screenBody).
  theme_id: { type: ['string', 'null'] },
  grid: gridSchemaFor(contract),
  // The same sparse event→family override the admin UI's sound picker edits (alert-sound contract). Families are
  // deliberately NOT enumerated here — the hub validates them against its live manifest, and
  // list_sounds serves the vocabulary — mirroring the hub's own screenBody, which constrains
  // shape only.
  sounds: {
    type: 'object', additionalProperties: false,
    description: 'Per-screen sound override: event → family id. Sparse — unset events follow the '
      + 'theme; {} clears the whole override back to "follow the theme". Valid family ids come '
      + 'from list_sounds; an unknown family is a 400.',
    properties: Object.fromEntries(SOUND_EVENTS.map((event) => [
      event, { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9_]+$' },
    ])),
  },
})

/**
 * The tool list intentionally excludes `create_theme`: themes are an admin
 * design surface, not something this client grants an agent write access to. Nothing below mints or
 * edits a theme; `list_themes` is read-only, for picking an existing one by id.
 */
export const TOOLS: readonly ToolDef[] = [
  {
    name: 'list_devices',
    description: 'List every device paired to this hub: assigned screen and tabs, online status, rendering state, and the health it last reported (`battery`, `charging`, `last_seen_at`). Those three are what diagnose a dark panel — an offline device whose last report was `charging: false` was almost certainly put to sleep by Android Doze, not by a hub or network fault. Read-only.',
    inputSchema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    call: async (hub) => hub.request('GET', '/admin/api/devices'),
  },
  {
    name: 'assign_screen',
    description: `Point a device at a screen (or clear it with screen_id: null). ${LIVE_WRITE} The device re-renders immediately.`,
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['device_id', 'screen_id'],
      properties: {
        device_id: { type: 'string' },
        screen_id: { type: ['string', 'null'] },
      },
    }),
    call: async (hub, _contract, args) => {
      const { device_id: deviceId, screen_id: screenId } = args as { device_id: string; screen_id: string | null }
      return hub.request('PATCH', `/admin/api/devices/${deviceId}`, { screen_id: screenId })
    },
  },
  {
    name: 'set_device_tabs',
    description: `Give a device an ordered list of screens shown as switchable tabs (replaces the whole list; [] clears; one entry behaves like assign_screen). ${LIVE_WRITE} All tab screens must share one orientation.`,
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['device_id', 'tabs'],
      properties: {
        device_id: { type: 'string' },
        tabs: { type: 'array', maxItems: 16, items: {
          type: 'object', additionalProperties: false, required: ['screen_id'],
          properties: { screen_id: { type: 'string' }, label: { type: 'string', maxLength: 40 } },
        } },
      },
    }),
    call: async (hub, _contract, args) => {
      const { device_id: deviceId, tabs } = args as { device_id: string; tabs: { screen_id: string; label?: string }[] }
      return hub.request('PATCH', `/admin/api/devices/${deviceId}`, { tabs })
    },
  },
  {
    name: 'list_screens',
    description: 'List every screen defined on this hub. Read-only.',
    inputSchema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    call: async (hub) => hub.request('GET', '/admin/api/screens'),
  },
  {
    name: 'get_screen',
    // No GET-by-id route exists on the hub (admin.ts's screens routes are collection GET, POST,
    // PATCH/DELETE-by-id only) — filtering the list is the whole implementation, not a shortcut.
    description: 'Fetch a single screen by id. Read-only. (There is no by-id route on the hub; this filters list_screens.)',
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string' } },
    }),
    call: async (hub, _contract, args) => {
      const { id } = args as { id: string }
      const screens = await hub.request('GET', '/admin/api/screens') as Array<{ id: string }>
      const found = screens.find((s) => s.id === id)
      // A missing screen is a genuine miss, not a value — returning null here would let server.ts's
      // `result ?? { ok: true }` coalesce it into a success-shaped response (an agent asking for a
      // deleted screen would see `{"ok":true}` and believe the fetch worked). Throwing means it
      // surfaces as a real tool error instead, same as every other not-found on this hub.
      if (!found) throw new HubError(404, `no such screen: ${id}`)
      return found
    },
  },
  {
    name: 'create_screen',
    description: `Create a screen from a name, orientation, and a grid of cells. ${LIVE_WRITE} ${BINDING_GUIDANCE}`,
    inputSchema: (contract) => ({
      type: 'object', additionalProperties: false, required: ['name', 'orientation', 'grid'],
      description: rectRuleDescription(contract),
      properties: screenFieldProps(contract),
    }),
    call: async (hub, _contract, args) => hub.request('POST', '/admin/api/screens', args),
  },
  {
    name: 'update_screen',
    description: `Patch a screen: any of name, orientation, theme_id, grid, sounds. ${LIVE_WRITE} ${BINDING_GUIDANCE} ${UPDATE_CONFLICT_GUIDANCE}`,
    inputSchema: (contract) => ({
      type: 'object', additionalProperties: false, required: ['id', 'rev'],
      description: rectRuleDescription(contract),
      properties: { id: { type: 'string' }, rev: { type: 'integer', minimum: 1 }, ...screenFieldProps(contract) },
    }),
    call: async (hub, _contract, args) => {
      const { id, ...body } = args as { id: string; rev: number; [key: string]: unknown }
      try {
        return await hub.request('PATCH', `/admin/api/screens/${id}`, body)
      } catch (error) {
        // The hub's own 409 body ({error: 'screen changed elsewhere', rev}) says WHAT happened;
        // it says nothing about what to do next. An agent that retries the identical PATCH on a
        // 409 clobbers whoever changed the row in between — the guidance has to travel with the
        // error itself, because server.ts's catch-all forwards `error.message` to the model
        // directly and has no tool-specific knowledge of its own to add this from.
        if (error instanceof HubError && error.status === 409) {
          throw new HubError(409, `${error.message} — ${UPDATE_CONFLICT_GUIDANCE}`)
        }
        throw error
      }
    },
  },
  {
    name: 'delete_screen',
    description: `Delete a screen. ${LIVE_WRITE} Any device assigned to it is reset to the built-in default and re-renders.`,
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string' } },
    }),
    call: async (hub, _contract, args) => {
      const { id } = args as { id: string }
      return hub.request('DELETE', `/admin/api/screens/${id}`)
    },
  },
  {
    name: 'list_feeds',
    description: 'List every feed defined on this hub. Read-only.',
    inputSchema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    call: async (hub) => hub.request('GET', '/admin/api/feeds'),
  },
  {
    name: 'get_feed',
    // The hub caps rows at 20 server-side (recentRows(app.db, f.id, 20) in admin.ts) — resolved
    // question 3 — so this tool has no page size of its own to expose or get wrong.
    description: 'Fetch one feed by id, including its current payload and its most recent rows (the hub caps this at 20). Read-only.',
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string' } },
    }),
    call: async (hub, _contract, args) => {
      const { id } = args as { id: string }
      return hub.request('GET', `/admin/api/feeds/${id}`)
    },
  },
  {
    name: 'create_feed',
    description: `Create a feed (a named place data gets pushed to). ${LIVE_WRITE} mode is immutable once created.`,
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['name', 'mode'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        mode: { enum: ['value', 'stream', 'image'] },
        cap: { type: 'integer', minimum: 1, maximum: 500 },
        stale_after_s: { type: ['integer', 'null'], minimum: 5 },
      },
    }),
    call: async (hub, _contract, args) => hub.request('POST', '/admin/api/feeds', args),
  },
  {
    name: 'create_sender',
    description: `Create a sender credential. ${LIVE_WRITE} The response carries the sender token ONCE — the agent needs it to push data to feeds; the hub cannot show it again.`,
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
    }),
    call: async (hub, _contract, args) => hub.request('POST', '/admin/api/senders', args),
  },
  {
    name: 'list_themes',
    description: 'List every theme defined on this hub, for picking one by id. Read-only — this tool set does not create or edit themes.',
    inputSchema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    call: async (hub) => hub.request('GET', '/admin/api/themes'),
  },
  {
    name: 'list_sounds',
    // The manifest is a public static file, not an /admin/api route — the same document the
    // admin UI's sound picker reads. Serving it as a tool is what makes the sounds override
    // usable: an agent must be able to learn the vocabulary before writing it.
    description: 'The hub\'s sound manifest: every sound family a screen\'s sounds override may name, keyed by family id. Read-only.',
    inputSchema: () => ({ type: 'object', additionalProperties: false, properties: {} }),
    call: async (hub) => hub.request('GET', '/sounds/manifest.json'),
  },
  {
    name: 'check_fit',
    description: `Check which of this hub's feeds CANNOT satisfy a given widget+config (the unfit set — feeds not listed are fit, or the check was inconclusive and failed open). ${BINDING_GUIDANCE} Read-only.`,
    inputSchema: () => ({
      type: 'object', additionalProperties: false, required: ['widget', 'config'],
      properties: { widget: { type: 'string' }, config: { type: 'object' } },
    }),
    call: async (hub, _contract, args) => {
      const { widget, config } = args as { widget: string; config: unknown }
      const query = `widget=${encodeURIComponent(widget)}&config=${encodeURIComponent(JSON.stringify(config ?? {}))}`
      return hub.request('GET', `/admin/api/feed-fit?${query}`)
    },
  },
]
