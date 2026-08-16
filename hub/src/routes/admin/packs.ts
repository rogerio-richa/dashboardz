import type { FastifyInstance } from 'fastify'
import { requireHumanAdmin } from './shared.js'
import { audit } from '../../db/audit.js'
import { listDevices } from '../../db/devices.js'
import { createTheme, getTheme, updateTheme } from '../../db/themes.js'
import { deletePack, getPack, listPacks, packDesigns, upsertPack } from '../../db/packs.js'
import { checkUpload, removePack, sweepPackTemps, writePack, PACK_ID_RE, type UploadedPack } from '../../packStore.js'

const BODY_LIMIT = 2 * 1024 * 1024 + 64 * 1024

/**
 * Theme pack install (owner only: requireHumanAdmin, never an agent token). Off entirely when
 * PACKS_ENABLED=false (hosted hubs): every route here answers 404.
 */
export async function registerPackRoutes(app: FastifyInstance): Promise<void> {
  // Leftovers from a crash mid-install never pile up.
  sweepPackTemps(app.appConfig.dataDir)
  await app.register(async (owner) => {
    owner.addHook('onRequest', async (_req, reply) => {
      if (app.appConfig.packsEnabled === false) return reply.code(404).send({ error: 'theme packs are turned off on this hub' })
    })
    owner.addHook('preHandler', requireHumanAdmin)

    const reloadDevices = () => {
      for (const d of listDevices(app.db)) if (app.registry.isOnline(d.id)) app.registry.send(d.id, { type: 'RELOAD' })
    }

    /** Design ids another installed pack already owns: checked on /check and again on install. */
    const clashes = (packId: string | undefined, designs: { id: string }[]) => {
      const out: { level: 'error'; where: string; rule: string; message: string }[] = []
      for (const other of listPacks(app.db)) {
        if (other.id === packId) continue
        for (const d of packDesigns(other)) {
          if (designs.some((x) => x.id === d.id)) out.push({ level: 'error', where: `design ${d.id}`, rule: 'pack.design-clash', message: `"${d.id}" is already installed by the pack "${other.name}". Give your design a different id, or remove that pack first.` })
        }
      }
      return out
    }
    const designsOf = (body: UploadedPack) => (Array.isArray(body?.designs) ? body.designs : [])
      .filter((d) => typeof d?.path === 'string' && d.path.split('/').length === 3)
      .map((d) => { const [, widget, file] = d.path.split('/'); return { widget, id: file.replace(/\.mjs$/, '') } })

    owner.post<{ Body: UploadedPack }>('/admin/api/packs/check', { bodyLimit: BODY_LIMIT }, async (req) => {
      const findings = await checkUpload(app.appConfig.dataDir, req.body)
      const manifest = (req.body?.manifest ?? {}) as { id?: string }
      return { findings: [...findings, ...clashes(manifest.id, designsOf(req.body))] }
    })

    owner.post<{ Body: UploadedPack }>('/admin/api/packs', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const body = req.body
      const findings = await checkUpload(app.appConfig.dataDir, body)
      const manifest = (body?.manifest ?? {}) as { id?: string; name?: string; version?: string; theme?: Record<string, unknown> }
      const designs = designsOf(body)
      findings.push(...clashes(manifest.id, designs))
      if (findings.some((f) => f.level === 'error') || typeof manifest.id !== 'string' || !PACK_ID_RE.test(manifest.id)) {
        return reply.code(400).send({ error: 'This pack has problems; nothing was installed.', findings })
      }
      writePack(app.appConfig.dataDir, manifest.id, body)
      // The pack's theme follows pack.json: an update replaces its settings, a deleted one is recreated.
      const t = manifest.theme ?? {}
      const fields = {
        name: manifest.name ?? manifest.id, board: t.board as object, widgets: (t.widgets ?? {}) as Record<string, string>,
        recommended: (t.recommended ?? {}) as Record<string, string[]>, sounds: (t.sounds ?? {}) as Record<string, string>,
        backdrop: (t.backdrop as string | undefined) ?? 'flat', ...(t.chrome ? { chrome: t.chrome as object } : {}),
      }
      const existing = getPack(app.db, manifest.id)
      let themeId = existing?.theme_id ?? null
      if (themeId && getTheme(app.db, themeId)) updateTheme(app.db, themeId, fields)
      else themeId = createTheme(app.db, fields).id
      const row = upsertPack(app.db, { id: manifest.id, name: fields.name, version: String(manifest.version), theme_id: themeId, designs }, Date.now())
      audit(app.db, 'admin', null, existing ? 'pack_updated' : 'pack_installed', { pack_id: row.id, version: row.version })
      reloadDevices()
      return { id: row.id, version: row.version, theme_id: themeId, install_rev: row.install_rev, findings }
    })

    owner.get('/admin/api/packs', async () => listPacks(app.db).map((p) => ({
      id: p.id, name: p.name, version: p.version, theme_id: p.theme_id, install_rev: p.install_rev,
      designs: packDesigns(p), installed_at: p.installed_at, updated_at: p.updated_at,
    })))

    owner.delete<{ Params: { id: string } }>('/admin/api/packs/:id', async (req, reply) => {
      const row = getPack(app.db, req.params.id)
      if (!row) return reply.code(404).send({ error: 'not found' })
      removePack(app.appConfig.dataDir, row.id)
      deletePack(app.db, row.id)
      audit(app.db, 'admin', null, 'pack_removed', { pack_id: row.id })
      reloadDevices()
      return reply.code(204).send()
    })
  })
}
