import type { FastifyInstance } from 'fastify'
import {
  createTheme, deleteTheme, getTheme, listThemes, updateTheme,
  type ThemeRow, type ThemeWidgetEntry,
} from '../../db/themes.js'
import { audit } from '../../db/audit.js'
import { parseSounds } from '../../sounds.js'
import {
  actorOf, pushDevicesForScreens, pushDevicesForTheme, type SoundsBodySchema,
} from './shared.js'

export function registerThemeRoutes(
  admin: FastifyInstance,
  app: FastifyInstance,
  soundsBodySchema: SoundsBodySchema,
): void {
  /**
   * Themes CRUD. Colorsets are no longer stored.
   * will drive, following the same session guard, `additionalProperties: false` discipline and
   * `newId` prefixes as every other route in this file.
   *
   * A theme write must reach devices already rendering it, or an operator sees nothing
   * happen until a reconnect or an unrelated screen edit — a device only refetches its theme
   * document when the `{id, rev}` pair on its next STATE differs from what it cached (see
   * theme.mjs's noteThemeRef). `app.statePusher.push(deviceId)` is the SAME mechanism
   * `registerScreenRoutes` uses after a grid edit; buildState (stateBuilder.ts) reads the theme's
   * CURRENT rev fresh on every push, so re-pushing STATE after a theme write is
   * sufficient — there is no separate "theme changed" message type, and no dataPusher call is
   * needed (that path is for FEED data, which theme colour has nothing to do with).
   */
  /**
   * A colour literal, rejected at the door. Every colour property
   * below was a bare `{ type: 'string' }`, so `PATCH /admin/api/themes/:id` happily stored
   * `ink: "not-a-colour"` — which the device then wrote onto `--text`, where it is invalid at
   * computed-value time and drops the whole property to its initial value. The device now
   * degrades per key regardless (theme.mjs's applyBoardToCss/resolveTokens), but a value that
   * can never render should not be storable in the first place, and rejecting it at save time
   * beats discovering it on a kiosk.
   *
   * The SAME shape as theme.mjs's and tokens.mjs's COLOR_RE, written out longhand because JSON
   * Schema `pattern` takes no `i` flag: `#rgb`, `#rrggbb` or `#rrggbbaa`. AJV applies `pattern`
   * only to strings, so a `['string','null']` property (bg_color) still accepts null to clear.
   */
  const COLOR_PATTERN = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'
  const color = { type: 'string', pattern: COLOR_PATTERN }
  const boardColorProps = {
    bg: color, surface: color, ink: color, dim: color,
    accent: color, scrim: { type: 'number', minimum: 0, maximum: 1 },
    info: color, warn: color, critical: color,
    series: { type: 'array', items: color },
    // Gap in px between a cell's edge and its card, under the `cards` backdrop (device-web
    // paintWidgets). A number on the board block like `scrim`, and like `scrim` it has no CSS
    // mapping — the pipeline consumes it directly. Unset means the renderer default (2).
    card_gap: { type: 'number', minimum: 0, maximum: 16 },
    // Interior padding in px between a card's border and the widget's content, same consumer
    // and same conventions as card_gap. Unset means the renderer default (8).
    card_padding: { type: 'number', minimum: 0, maximum: 24 },
  }
  const boardSchema = { type: 'object', additionalProperties: false, properties: boardColorProps }
  // The eleven optional chrome keys (tab-bar chrome / themeDefaults.ts's ChromeBlock) — every key
  // optional (a theme may override any subset), but the map itself must be an object: a string
  // or an array here would corrupt the device's per-key CSS fallback (applyChromeToCss expects
  // to `Object.entries` it).
  const chromeSchema = {
    type: 'object', additionalProperties: false,
    properties: {
      hairline: color, muted: color, chip: color, border: color,
      surface_warn: color, surface_critical: color,
      takeover_bg: color, takeover_meta: color, takeover_body: color,
      takeover_hint_bg: color, on_critical: color,
    },
  }
  // One entry per widget type this theme customises (ThemeWidgetEntry, db/themes.ts) — design
  const themeWidgetsSchema = {
    type: 'object',
    // A bare design id (v11). A theme names GEOMETRY per widget type; colour comes from the
    // palette, because every design's slots already default to a board colour. Deliberately not
    // enumerated, for the same reason design ids never were: a hub must be able to store one its
    // clients do not yet have, and an unknown id falls back to the widget's default at render.
    additionalProperties: { type: 'string', minLength: 1, maxLength: 40 },
  }
  /**
   * `bg_kind`/`bg_color` are writable here. The columns and the theme
   * document have carried them since the data model was introduced, and `PUT /admin/api/themes/:id/bg` can set
   * `bg_kind` to 'image' — but `additionalProperties: false` meant nothing could ever set the
   * OTHER two values, so a flat-colour background was unreachable and an uploaded image could
   * never be removed (the only writer only ever moved it to 'image'). Enumerated rather than
   * left a free string, and `bg_color` is nullable so it can be cleared, not merely left.
   *
   * The device-side rendering of either (and `board.scrim`) is deliberately NOT part of this
   * change — this is the API the next plan's renderer will read; the hub storing a value the
   * device does not yet paint is the same staging every other field here went through.
   */
  const themeBody = (required: string[]) => ({
    type: 'object', additionalProperties: false, required, minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      board: boardSchema,
      widgets: themeWidgetsSchema,
      chrome: chromeSchema,
      bg_kind: { enum: ['none', 'flat', 'image'] },
      bg_color: { type: ['string', 'null'], pattern: COLOR_PATTERN },
      // Deliberately NOT an enum. A hub must be able to store a backdrop a client older than it
      // does not render — the client falls back to 'flat' — which is the same degradation rule
      // design ids follow, and the same reason the schema does not enumerate those either.
      backdrop: { type: 'string', minLength: 1, maxLength: 40 },
      // Sparse event→family suggestion map (schema v27, alert-sound contract) — see `soundsBodySchema` above
      // (shared with `screenBody`; a theme's sounds is a SUGGESTION only, so unlike a screen's
      // override this is the only place it's checked — no manifest-family existence check at
      // write time, same "unknown degrades to classic" rule design ids and backdrop follow).
      sounds: soundsBodySchema,
    },
  })

  // Guarded JSON.parse -> plain-object-or-fallback, the same "bad data already in the DB must
  // never crash a read path" guard screenOut/themeDocument already apply, reused here for the
  // admin-facing shape (parsed, not the raw JSON-string columns).
  const parseObj = (s: string): object => {
    try {
      const parsed = JSON.parse(s)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  const themeOut = (t: ThemeRow) => ({
    id: t.id, name: t.name,
    board: parseObj(t.board), widgets: parseObj(t.widgets), chrome: parseObj(t.chrome),
    bg_kind: t.bg_kind, bg_color: t.bg_color, bg_rev: t.bg_rev, backdrop: t.backdrop ?? 'flat',
    sounds: parseSounds(t.sounds),
    rev: t.rev, builtin: t.builtin === 1, created_at: t.created_at,
  })

  admin.get('/admin/api/themes', async () => listThemes(app.db).map(themeOut))

  admin.post<{ Body: {
    name: string; board: object; widgets?: Record<string, ThemeWidgetEntry>; chrome?: object
    bg_kind?: string; bg_color?: string | null; backdrop?: string; sounds?: Record<string, string>
  } }>(
    '/admin/api/themes', { schema: { body: themeBody(['name', 'board']) } }, async (req) => {
      // createTheme's own default (`input.widgets ?? {}`) is JS-only — its TS signature keeps
      // `widgets` required, so the optional-on-the-wire contract is made explicit here instead.
      const row = createTheme(app.db, { ...req.body, widgets: req.body.widgets ?? {} })
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'theme_created', { theme_id: row.id, name: row.name })
      return themeOut(row)
    })

  admin.patch<{ Params: { id: string }; Body: {
    name?: string; board?: object; widgets?: Record<string, ThemeWidgetEntry>; chrome?: object
    bg_kind?: string; bg_color?: string | null; backdrop?: string; sounds?: Record<string, string>
  } }>(
    '/admin/api/themes/:id', { schema: { body: themeBody([]) } }, async (req, reply) => {
      if (!updateTheme(app.db, req.params.id, req.body)) return reply.code(404).send({ error: 'not found' })
      const actor = actorOf(req)
      audit(app.db, actor.type, actor.id, 'theme_updated', { theme_id: req.params.id, fields: Object.keys(req.body) })
      pushDevicesForTheme(app, req.params.id)
      return themeOut(getTheme(app.db, req.params.id)!)
    })

  admin.delete<{ Params: { id: string } }>('/admin/api/themes/:id', async (req, reply) => {
    const existing = getTheme(app.db, req.params.id)
    if (!existing) return reply.code(404).send({ error: 'not found' })
    if (existing.builtin) return reply.code(400).send({ error: 'cannot delete a builtin theme' })
    const { resetScreenIds } = deleteTheme(app.db, req.params.id, actorOf(req))
    // Every screen that referenced this theme now points at the built-in default instead — its
    // assigned device(s) must re-render with that, matching `registerScreenRoutes`' screen-delete
    // behavior in routes/admin/screens.ts.
    pushDevicesForScreens(app, resetScreenIds)
    return { resetScreenIds }
  })
}
