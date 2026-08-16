import type { FastifyInstance } from 'fastify'
import { getPack, listPacks, packDesigns } from '../db/packs.js'
import { readPackDesign } from '../packStore.js'

/**
 * Serves installed theme-pack designs to devices and the admin. Public like /device/ (design code
 * holds no secrets). `no-store`, like every module the hub serves: the Galaxy A05's WebView ignores
 * no-cache for ES modules, and the `?v=<install_rev>` in each URL changes on every install anyway.
 */
export async function packsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/packs/index.json', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    if (app.appConfig.packsEnabled === false) return []
    return listPacks(app.db).map((p) => ({
      id: p.id, version: p.version,
      designs: packDesigns(p).map((d) => ({ widget: d.widget, id: d.id, url: `/packs/${p.id}/designs/${d.widget}/${d.id}.mjs?v=${p.install_rev}` })),
    }))
  })

  app.get<{ Params: { pack: string; widget: string; file: string } }>('/packs/:pack/designs/:widget/:file', async (req, reply) => {
    const { pack, widget, file } = req.params
    const row = app.appConfig.packsEnabled === false ? undefined : getPack(app.db, pack)
    const listed = row && packDesigns(row).some((d) => d.widget === widget && `${d.id}.mjs` === file)
    const bytes = listed ? readPackDesign(app.appConfig.dataDir, pack, widget, file) : null
    if (!bytes) return reply.code(404).send({ error: 'not found' })
    return reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-store').send(bytes)
  })
}
