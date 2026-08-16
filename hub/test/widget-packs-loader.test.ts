import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module without types
import { addDesigns, allDesigns, designIdsFor, designMinimum, CATALOGUE } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { loadInstalledPacks } from '../static/device/widgets/packs.mjs'

const design = (id: string, widget = 'gauge') => ({ meta: { id, widget, label: id, suggested_ratio: 1, tokens: {}, animations: { transition: [], persistent: [] }, minimum_px: { w: 120, h: 100 } }, draw: () => {} })

/**
 * Installed theme-pack designs join the catalogue at runtime, next to the built-in ones, so the
 * editor's design list and the device renderer see them without a build.
 */
describe('runtime catalogue', () => {
  it('addDesigns makes an installed design visible everywhere the catalogue is asked', () => {
    const before = CATALOGUE.length
    addDesigns([design('testpack-dial')])
    expect(designIdsFor('gauge')).toContain('testpack-dial')
    expect(designMinimum('gauge', 'testpack-dial')).toEqual({ w: 120, h: 100 })
    expect(allDesigns().length).toBe(before + 1)
    expect(CATALOGUE.length).toBe(before)
  })
})

describe('loadInstalledPacks', () => {
  it('loads good designs, skips one that throws on import, and never rejects', async () => {
    const index = [{ id: 'p', version: '1.0.0', designs: [
      { widget: 'gauge', id: 'p-good', url: '/packs/p/designs/gauge/p-good.mjs?v=1' },
      { widget: 'gauge', id: 'p-bad', url: '/packs/p/designs/gauge/p-bad.mjs?v=1' },
    ] }]
    const register = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await loadInstalledPacks({
      fetch: async () => new Response(JSON.stringify(index)),
      importModule: async (url: string) => { if (url.includes('p-bad')) throw new Error('boom'); return { default: design('p-good') } },
      register,
    })
    warn.mockRestore()
    expect(result.loaded).toEqual(['p-good'])
    expect(result.skipped).toEqual([{ url: '/packs/p/designs/gauge/p-bad.mjs?v=1', reason: 'boom' }])
    expect(register).toHaveBeenCalledTimes(1)
    expect(designIdsFor('gauge')).toContain('p-good')
  })

  it('resolves with nothing loaded when the index cannot be fetched', async () => {
    const result = await loadInstalledPacks({ fetch: async () => { throw new Error('offline') }, importModule: async () => ({}), register: () => {} })
    expect(result).toEqual({ loaded: [], skipped: [] })
  })
  it('gives up on a design that never finishes loading, within the deadline', async () => {
    const index = [{ id: 'p', version: '1', designs: [{ widget: 'gauge', id: 'p-slow', url: '/slow.mjs' }] }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started = Date.now()
    const result = await loadInstalledPacks({ fetch: async () => new Response(JSON.stringify(index)), importModule: () => new Promise(() => {}), register: () => {}, deadlineMs: 50 })
    warn.mockRestore()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(result.loaded).toEqual([])
  })
})
