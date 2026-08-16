/**
 * The theme-pack checker's entry point: everything that can be said about a pack held in memory.
 * Reading files and importing modules is the caller's job (hub/scripts/check-pack.mjs), so this runs
 * the same in Node, in a browser, and on the hub.
 */
import { CATALOGUE } from '../static/device/widgets/catalogue.mjs'
import { checkManifest } from './theme.mjs'
import { checkDesign } from './design.mjs'

export { checkManifest, checkTheme, checkContrast, contrastRatio } from './theme.mjs'
export { checkDesign } from './design.mjs'
export { scanSource } from './scan.mjs'

/** Built-in design ids per widget type. */
export function catalogueIds() {
  const out = {}
  for (const d of CATALOGUE) (out[d.meta.widget] ??= []).push(d.meta.id)
  return out
}

/**
 * @param {{ manifest: unknown, designs: { path: string, source: string, module: any, loadError?: string }[] }} pack
 * @returns {import('./findings.mjs').Finding[]}
 */
export function checkPack({ manifest, designs }) {
  const catalogue = catalogueIds()
  const packDesigns = designs
    .map((d) => d.module?.default?.meta)
    .filter((m) => m && typeof m.id === 'string' && typeof m.widget === 'string')
    .map((m) => ({ widget: m.widget, id: m.id }))
  const pack = manifest && typeof manifest === 'object' && typeof manifest.id === 'string' ? { id: manifest.id } : { id: '' }
  return [
    ...checkManifest(manifest, packDesigns, catalogue),
    ...designs.flatMap((d) => checkDesign(d, { pack })),
  ]
}
