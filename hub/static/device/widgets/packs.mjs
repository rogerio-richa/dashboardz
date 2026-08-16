/**
 * Loads the designs installed from theme packs, so the device page and the admin know them before
 * they render. The hub lists them at /packs/index.json (empty when packs are off); each design is
 * imported, registered with the renderer and added to the catalogue's runtime list.
 *
 * Never throws and never blocks rendering on a bad pack: a design that fails to import or register
 * is skipped with a console warning, and a card using it falls back to the widget's default design.
 */
import { addDesigns } from './catalogue.mjs'

/**
 * @param {{ fetch?: typeof fetch, importModule?: (url: string) => Promise<any>, register: (design: any) => void, indexUrl?: string }} deps
 * @returns {Promise<{ loaded: string[], skipped: { url: string, reason: string }[] }>}
 */
export async function loadInstalledPacks({ fetch: fetchFn = globalThis.fetch, importModule = (url) => import(url), register, indexUrl = '/packs/index.json', deadlineMs = 4000 }) {
  const result = { loaded: [], skipped: [] }
  // One overall deadline for the index and every design, so an unreachable hub or a design that
  // never finishes loading can't hold the board back. AbortController + setTimeout, not
  // AbortSignal.timeout, which older Android WebViews lack.
  let timer
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), deadlineMs) })
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  try {
    const index = await Promise.race([
      (async () => {
        try {
          const res = await fetchFn(indexUrl, { cache: 'no-store', signal: controller?.signal })
          return res.ok ? await res.json() : null
        } catch { return null }
      })(),
      deadline,
    ])
    if (!Array.isArray(index)) { controller?.abort(); return result }
    const entries = index.flatMap((pack) => (Array.isArray(pack?.designs) ? pack.designs : [])).filter((e) => typeof e?.url === 'string')
    const attempts = entries.map(async (entry) => {
      try {
        const mod = await importModule(entry.url)
        const design = mod?.default
        if (!design?.meta?.id || typeof design.draw !== 'function') throw new Error('not a design (export default { meta, draw })')
        return { entry, design }
      } catch (e) {
        return { entry, error: e instanceof Error ? e.message : String(e) }
      }
    })
    const settled = await Promise.race([Promise.all(attempts), deadline])
    const outcomes = Array.isArray(settled) ? settled : []
    if (!Array.isArray(settled)) console.warn('theme packs: gave up waiting for installed designs to load')
    const designs = []
    for (const o of outcomes) {
      if (o.design) {
        try { register(o.design); designs.push(o.design); result.loaded.push(o.design.meta.id) } catch (e) {
          result.skipped.push({ url: o.entry.url, reason: e instanceof Error ? e.message : String(e) })
        }
      } else {
        console.warn(`theme pack design ${o.entry.url} skipped: ${o.error}`)
        result.skipped.push({ url: o.entry.url, reason: o.error })
      }
    }
    addDesigns(designs)
    return result
  } finally {
    clearTimeout(timer)
  }
}
