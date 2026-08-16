import type { FastifyInstance, FastifyReply } from 'fastify'
import { listDeviceTabs } from '../../db/devices.js'
import {
  assignedDeviceIds, deleteScreen, getScreen, listScreens, updateScreen,
  type Orientation, type ScreenRow,
} from '../../db/screens.js'
import { getTheme } from '../../db/themes.js'
import { audit } from '../../db/audit.js'
import { getSoundManifest, parseSounds } from '../../sounds.js'
import {
  saveScreenWithSources, screenSaveErrorBody, ScreenSaveError, type ScreenGridCell,
} from '../../screens/save.js'
import { gridSchema } from '../../screens/cellSchema.js'
import { actorOf, screenTabBar, type SoundsBodySchema } from './shared.js'

export function registerScreenRoutes(
  admin: FastifyInstance,
  app: FastifyInstance,
  soundsBodySchema: SoundsBodySchema,
): void {
  /**
   * Post-AJV shape of a cell — config's precise fields vary per widget (see `cellSchema` in
   * `../../screens/cellSchema.js`). `rect` is non-optional here: `cellSchema`'s
   * `required: ['widget', 'config', 'rect']` means Fastify's schema validation has already
   * rejected any cell missing it before the save service runs, so this type does not need to
   * (and must not) hedge with `rect?`.
   */
  type GridCell = ScreenGridCell

  /**
   * `rev` is accepted on PATCH only (v14): it is the version the client read, and there is
   * nothing to have read on a create. Admitting it on POST would let a caller send a number that
   * is silently ignored — createScreen always starts at 1 — which is the shape of bug this
   * whole guard exists to remove.
   */
  const screenBody = (required: string[], withRev = false) => ({
    type: 'object', additionalProperties: false, required, minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      orientation: { enum: ['landscape', 'portrait'] },
      grid: gridSchema,
      // Nullable, not just optional: a client must be able to clear a screen's theme back to
      // the built-in default, not merely leave it unset.
      theme_id: { type: ['string', 'null'] },
      // Sparse event->family OVERRIDE map (screen state, alert-sound contract). `{}` clears the override back to
      // "follow the theme" — see ScreenPatch.sounds (hub/src/db/screens.ts).
      sounds: soundsBodySchema,
      ...(withRev ? { rev: { type: 'integer', minimum: 1 } } : {}),
    },
  })
  const screenParams = {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: { type: 'string', pattern: '^lay_[A-Za-z0-9_-]{1,80}$', maxLength: 84 } },
  }

  /**
   * Existence check for a field-only screen patch's theme reference, same shape as the
   * save service's feed checks. Grid saves validate themes in the service transaction path.
   * "unknown feed" branch. `theme_id` also carries a live FK to themes(id), but leaning on that
   * alone is wrong: better-sqlite3 surfaces a FK violation as
   * SQLITE_CONSTRAINT_FOREIGNKEY, which — like the UNIQUE-name violation this route already
   * catches — startsWith('SQLITE_CONSTRAINT'), so an unchecked typo'd theme_id would 400 with
   * the wrong, misleading "name already exists" instead of naming the actual problem.
   */
  const themeCheck = (themeId: string | null | undefined): string | null => {
    if (typeof themeId !== 'string') return null
    if (!getTheme(app.db, themeId)) return `unknown theme "${themeId}"`
    return null
  }

  // Bad data already in the database must never crash a read path (house rule). Unlike
  // buildState's degrade-to-no-screen (the device just needs *a* valid layout), the admin list
  // is where an operator finds and deletes a broken row — hiding it would make it undeletable.
  const screenOut = (s: ScreenRow) => {
    let grid: unknown
    try {
      grid = JSON.parse(s.grid)
    } catch {
      console.warn(`screen ${s.id} has unreadable grid; serving fallback in admin list`)
      grid = { cells: [] }
    }
    return {
      id: s.id, name: s.name, orientation: s.orientation, grid, theme_id: s.theme_id,
      sounds: parseSounds(s.sounds), rev: s.rev, created_at: s.created_at,
    }
  }

  const saveError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof ScreenSaveError) return reply.code(error.statusCode).send(screenSaveErrorBody(error))
    return reply.code(500).send({ error: 'screen save failed' })
  }

  const announceSavedFeeds = (feedIds: readonly string[]) => {
    for (const feedId of feedIds) {
      try {
        app.dataPusher.onFeedPush(feedId)
      } catch {
        console.warn('screen save: feed notification failed')
      }
    }
  }

  const announceSavedScreen = (screenId: string) => {
    for (const deviceId of assignedDeviceIds(app.db, screenId)) {
      try {
        app.statePusher.push(deviceId)
        app.dataPusher.snapshot(deviceId)
      } catch {
        console.warn('screen save: device notification failed')
      }
    }
  }

  admin.get('/admin/api/screens', async () =>
    listScreens(app.db).map((s) => ({ ...screenOut(s), assigned_count: assignedDeviceIds(app.db, s.id).length })))

  admin.post<{ Body: {
    name: string; orientation: Orientation; grid: { cells: GridCell[] }; theme_id?: string | null
    sounds?: Record<string, string>
  } }>(
    '/admin/api/screens', { schema: { body: screenBody(['name', 'orientation', 'grid']) } }, async (req, reply) => {
      try {
        const saved = saveScreenWithSources(app.db, { ...req.body, actor: actorOf(req) }, Date.now())
        announceSavedFeeds(saved.changed_feed_ids)
        return { ...screenOut(saved.screen), warnings: saved.warnings }
      } catch (error) {
        return saveError(error, reply)
      }
    })

  admin.patch<{ Params: { id: string }; Body: {
    name?: string; orientation?: Orientation; grid?: { cells: GridCell[] }; theme_id?: string | null
    sounds?: Record<string, string>; rev?: number
  } }>(
    '/admin/api/screens/:id', { schema: { params: screenParams, body: screenBody([], true) } }, async (req, reply) => {
      const existing = getScreen(app.db, req.params.id)
      if (!existing) return reply.code(404).send({ error: 'not found' })
      // Lost-update guard (v14). A grid PATCH replaces the WHOLE blob the editor read, so it must
      // say which version it read; anything else is a write that can silently destroy work. A
      // field-level PATCH (theme_id, name) comes from a
      // control that never loaded the grid and has no read-modify-write to lose, so it may omit
      // `rev` — but it still bumps the row's version below, because the row did change.
      if (req.body.grid !== undefined && req.body.rev === undefined) {
        return reply.code(400).send({ error: 'rev is required when saving a grid' })
      }
      // Family existence check (screen state, alert-sound contract) — runs regardless of which branch below handles the
      // rest of the patch (grid save or field-only), because a screen's sounds override is what a
      // device actually plays: unlike a theme's suggestion (tab state, loosely pattern-checked only),
      // an unresolvable family here must 400 rather than silently degrade to classic at resolve
      // time. `{}` (the "clear the override" sentinel) has no values to check, so it always passes.
      if (req.body.sounds) {
        const families = getSoundManifest().families
        for (const fam of Object.values(req.body.sounds)) {
          if (!families[fam]) return reply.code(400).send({ error: `unknown sound family: ${fam}` })
        }
      }
      if (req.body.grid !== undefined) {
        // Mirror of the tabs-PATCH agreement rule: editing a screen that already lives in a
        // multi-tab list must not strand that list (hidden bar, touch-only switching) or move
        // its bar to a different edge than its co-tabs. Checked here because the other half of
        // the invariant is enforced when the list is assigned — both edits must hold the line.
        const newBar = (() => {
          const declared = (req.body.grid as { tab_bar?: unknown }).tab_bar
          return typeof declared === 'string' ? declared : 'bottom'
        })()
        for (const deviceId of assignedDeviceIds(app.db, req.params.id)) {
          const tabs = listDeviceTabs(app.db, deviceId)
          if (tabs.length < 2) continue
          if (newBar === 'hidden') {
            return reply.code(400).send({ error: `screen is in a multi-tab list on device ${deviceId}; it cannot hide the tab bar` })
          }
          const others = tabs.filter((t) => t.screen_id !== req.params.id)
            .map((t) => getScreen(app.db, t.screen_id))
            .filter((s): s is ScreenRow => s !== undefined)
          if (others.some((s) => screenTabBar(s) !== newBar)) {
            return reply.code(400).send({ error: `tab bar position must match the other tabs on device ${deviceId}` })
          }
        }
      }
      if (req.body.grid !== undefined) {
        try {
          const saved = saveScreenWithSources(app.db, {
            id: existing.id,
            name: req.body.name ?? existing.name,
            orientation: req.body.orientation ?? existing.orientation,
            grid: req.body.grid,
            theme_id: req.body.theme_id !== undefined ? req.body.theme_id : existing.theme_id,
            sounds: req.body.sounds,
            expected_rev: req.body.rev,
            audit_fields: Object.keys(req.body),
            actor: actorOf(req),
          }, Date.now())
          announceSavedFeeds(saved.changed_feed_ids)
          announceSavedScreen(existing.id)
          return { ...screenOut(saved.screen), warnings: saved.warnings }
        } catch (error) {
          return saveError(error, reply)
        }
      }
      if (req.body.rev !== undefined && req.body.rev !== existing.rev) {
        return reply.code(409).send({ error: 'screen changed elsewhere', rev: existing.rev })
      }
      const themeErr = themeCheck(req.body.theme_id)
      if (themeErr) return reply.code(400).send({ error: themeErr })
      try {
        const actor = actorOf(req)
        app.db.transaction(() => {
          const result = updateScreen(app.db, req.params.id, req.body, req.body.rev)
          if (result.status === 'missing') throw new ScreenSaveError('not_found', 'not found', 404)
          if (result.status === 'conflict') throw new ScreenSaveError('conflict', 'screen changed elsewhere', 409, result.rev)
          audit(app.db, actor.type, actor.id, 'screen_updated', { screen_id: req.params.id, fields: Object.keys(req.body) })
          if (req.body.theme_id !== undefined && req.body.theme_id !== existing.theme_id) {
            audit(app.db, actor.type, actor.id, 'screen_theme_assigned', {
              screen_id: req.params.id, theme_id: req.body.theme_id, reason: 'screen_edited',
            })
          }
        })()
      } catch (err) {
        if ((err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
          return reply.code(400).send({ error: 'name already exists' })
        }
        if (err instanceof ScreenSaveError) return saveError(err, reply)
        return reply.code(500).send({ error: 'screen save failed' })
      }
      // The ASSIGN half of `screen_theme_assigned` (edge case). The event existed, but was
      // emitted from exactly one place — deleteTheme's cascade, always with `theme_id: null` —
      // so the event named for assignment recorded only un-assignments. Audited here rather than
      // renamed to match: `screen_updated` above records only that `theme_id` was among the
      // fields, never WHICH theme, so "when did this screen get the cypherpunk theme, and who
      // did it" was unanswerable from the log. Emitted only on an actual CHANGE, so a PATCH
      // that re-sends the same theme_id is not logged as an assignment.
      announceSavedScreen(req.params.id)
      return reply.code(204).send()
    })

  admin.delete<{ Params: { id: string } }>('/admin/api/screens/:id', { schema: { params: screenParams } }, async (req, reply) => {
    const { deleted, resetDeviceIds } = deleteScreen(app.db, req.params.id, actorOf(req))
    if (!deleted) return reply.code(404).send({ error: 'not found' })
    for (const deviceId of resetDeviceIds) {
      app.statePusher.push(deviceId)
      // Reset devices now have no screen, so referenceSet is empty and this is a natural
      // no-op — kept for uniformity with the other three STATE sites.
      app.dataPusher.snapshot(deviceId)
    }
    return reply.code(204).send()
  })
}
