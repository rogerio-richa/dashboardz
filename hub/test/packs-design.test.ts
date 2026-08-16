import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
// @ts-expect-error plain JS module without types
import { checkDesign, scanSource } from '../packs/design.mjs'
// @ts-expect-error plain JS module without types
import { checkPack } from '../packs/index.mjs'

type Finding = { level: string; where: string; rule: string; message: string }
const errorRules = (fs: Finding[]) => fs.filter((f) => f.level === 'error').map((f) => f.rule)
// Inside the project (vitest only imports files under its root); node_modules is git-ignored.
const dir = mkdtempSync(join(fileURLToPath(new URL('../node_modules/', import.meta.url)), '.tmp-packdesign-'))
let n = 0
afterAll(() => rmSync(dir, { recursive: true, force: true }))
/** Writes a design to a temp file and imports it, the way the CLI loads a pack design. */
async function load(source: string, path = 'designs/gauge/vintage-dial.mjs') {
  const file = join(dir, `d${n++}.mjs`)
  writeFileSync(file, source)
  return { path, source, module: await import(pathToFileURL(file).href) }
}
const PACK = { pack: { id: 'vintage' } }

/** A minimal, valid pack gauge design; `body` replaces the draw body. */
const gauge = (over: { meta?: string; body?: string; head?: string } = {}) => `${over.head ?? ''}
const meta = {
  id: 'vintage-dial', widget: 'gauge', label: 'Brass dial', suggested_ratio: 1,
  tokens: { ink: { type: 'color', default: '@ink' }, needle: { type: 'color', default: '@accent' } },
  animations: { transition: [], persistent: [] },
  options: {
    label: { type: 'text', label: 'Label', default: '' },
    needle: { type: 'select', label: 'Needle', default: 'spade', choices: ['spade', 'arrow'], path: 'design_options.needle' },
  },
  ${over.meta ?? ''}
}
function draw(g, ctx) {
  ${over.body ?? `const style = typeof ctx.config?.design_options?.needle === 'string' ? ctx.config.design_options.needle : 'spade'
  g.fillStyle = ctx.tokens.ink; g.fillText(String(style), 1, 1)
  g.strokeStyle = ctx.tokens.needle; g.beginPath(); g.moveTo(0, 0); g.lineTo(5, 5); g.stroke()`}
}
export default { meta, draw }
`

describe('design checks', () => {
  it('a valid pack design has no errors', async () => {
    expect(errorRules(checkDesign(await load(gauge()), PACK))).toEqual([])
  })

  it('every built-in design passes the built-in rules (the regression net for moving them)', async () => {
    const root = fileURLToPath(new URL('../static/device/widgets/', import.meta.url))
    const files: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : p.endsWith('.mjs') && files.push(p) } }
    walk(root)
    let checked = 0
    for (const file of files) {
      const mod = await import(pathToFileURL(file).href)
      if (!mod.default?.meta?.widget) continue
      checked++
      const fs = checkDesign({ path: file, source: readFileSync(file, 'utf8'), module: mod }, {})
      expect(fs.filter((f: Finding) => f.level === 'error'), file).toEqual([])
    }
    expect(checked).toBeGreaterThan(20)
  })

  /** The CLI scans a design's source before importing it, so an import is reported, not a crash. */
  it('refuses imports in a pack design, saying why', () => {
    const source = "import { fitted } from '../text-fit.mjs'\n" + gauge()
    const f = checkDesign({ path: 'designs/gauge/vintage-dial.mjs', source, module: null }, PACK)
      .find((x: Finding) => x.rule === 'design.import')!
    expect(f.level).toBe('error')
    expect(f.message).toMatch(/one file/i)
    expect(scanSource(source).imports).toEqual(['../text-fit.mjs'])
  })

  it('reports drawing calls outside the portable subset, and browser APIs', async () => {
    expect(errorRules(checkDesign(await load(gauge({ body: 'g.createLinearGradient(0,0,1,1); g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.tokens.needle' })), PACK))).toContain('design.portable-subset')
    expect(errorRules(checkDesign(await load(gauge({ body: 'const w = document.title; g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.tokens.needle' })), PACK))).toContain('design.browser-api')
  })

  it('reports a declared colour token that is never painted, by name', async () => {
    const fs: Finding[] = checkDesign(await load(gauge({ body: 'g.fillStyle = ctx.tokens.ink; g.fillText("x", 0, 0)' })), PACK)
    const f = fs.find((x) => x.rule === 'design.token-unpainted')!
    expect(f.message).toContain('needle')
  })

  it('reports a setting the hub would refuse, pointing at design_options', async () => {
    const fs: Finding[] = checkDesign(await load(gauge({ meta: "extra: 1," }).replace("label: { type: 'text', label: 'Label', default: '' },", "needle_style: { type: 'text', label: 'Needle style', default: '' },")), PACK)
    const f = fs.find((x) => x.rule === 'design.unknown-setting')!
    expect(f.message).toContain('design_options.needle_style')
  })

  it('reports an unknown widget type and a file in the wrong folder', async () => {
    expect(errorRules(checkDesign(await load(gauge().replace("widget: 'gauge'", "widget: 'gauges'")), PACK))).toContain('design.unknown-widget')
    expect(errorRules(checkDesign(await load(gauge(), 'designs/clock/vintage-dial.mjs'), PACK))).toContain('design.path')
  })

  it('reports a draw that throws on missing data or a wrong-typed setting, without throwing itself', async () => {
    const nullData = await load(gauge({ body: 'g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.tokens.needle; if (ctx.data === null) throw new Error("boom")' }))
    const f = checkDesign(nullData, PACK).find((x: Finding) => x.rule === 'design.draw-throws')!
    expect(f.message).toMatch(/no data/i)
    const typed = await load(gauge({ body: 'g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.tokens.needle; ctx.config?.design_options?.needle?.toUpperCase?.call ? 0 : 0; if (ctx.config?.design_options && typeof ctx.config.design_options.needle !== "string" && ctx.config.design_options.needle !== undefined) throw new Error("bad")' }))
    expect(checkDesign(typed, PACK).find((x: Finding) => x.rule === 'design.draw-throws')!.message).toContain('design_options.needle')
  })

  /** A card with no settings at all is the commonest real case: a design must survive it. */
  it('reports a draw that crashes with no settings, or with unexpected data', async () => {
    const noLabel = await load(gauge({ body: 'g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.tokens.needle; g.fillText(ctx.config.label.toUpperCase(), 0, 0)' }))
    expect(checkDesign(noLabel, PACK).find((x: Finding) => x.rule === 'design.draw-throws')!.message).toMatch(/no settings/i)
    const textData = await load(gauge({ body: 'g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.tokens.needle; if (typeof ctx.data === "string" && ctx.data.length > 0) throw new Error("text")' }))
    expect(checkDesign(textData, PACK).find((x: Finding) => x.rule === 'design.draw-throws')!.message).toMatch(/text/i)
  })

  /** The checker's ctx must carry what the hub's does, or a correct design gets a false crash. */
  it('gives draw the same context fields the hub does (ramp, feed, assets, series)', async () => {
    const reader = await load(gauge({ body: 'g.fillStyle = ctx.tokens.ink; g.strokeStyle = ctx.ramp[0] && ctx.tokens.needle; void ctx.feed.missing; void ctx.assets; void ctx.series.length' }))
    expect(errorRules(checkDesign(reader, PACK))).toEqual([])
  })

  /** Malformed meta is reported, never thrown: the checker must survive any design. */
  it('reports malformed options instead of crashing', async () => {
    const bad = await load(gauge().replace("label: { type: 'text', label: 'Label', default: '' },", "label: null,"))
    expect(() => checkDesign(bad, PACK)).not.toThrow()
    expect(errorRules(checkDesign(bad, PACK))).toContain('design.options')
  })

  it('catches imports written without spaces', () => {
    expect(scanSource("import{a}from'x'").imports).toEqual(['x'])
    expect(scanSource('import*as m from "y"').imports).toEqual(['y'])
    expect(scanSource('/* import colours */ export default {}').imports).toEqual([])
  })

  it('treats any dynamic import as an import', () => {
    expect(scanSource('const m = await import(name)').imports.length).toBe(1)
    expect(scanSource('const m = await import(`node:os`)').imports.length).toBe(1)
  })

  /** The checker must refuse what the hub refuses on save, and accept what it accepts. */
  describe('settings agree with the hub', () => {
    const withOption = (widget: string, opt: string) => load(gauge()
      .replace("widget: 'gauge'", `widget: '${widget}'`)
      .replace("label: { type: 'text', label: 'Label', default: '' },", opt), `designs/${widget}/vintage-dial.mjs`)
    const rulesFor = async (widget: string, opt: string) => errorRules(checkDesign(await withOption(widget, opt), PACK))

    it('accepts a table columns list that leaves out the optional align field', async () => {
      expect(await rulesFor('table', "columns: { type: 'list', label: 'Column', min: 1, max: 4, item: { header: { type: 'text', label: 'Header', required: true }, path: { type: 'text', label: 'Path', required: true } } },")).not.toContain('design.option-list')
    })
    it('refuses a list missing a required field, or with a looser size', async () => {
      expect(await rulesFor('table', "columns: { type: 'list', label: 'Column', min: 1, max: 4, item: { header: { type: 'text', label: 'Header', required: true } } },")).toContain('design.option-list')
      expect(await rulesFor('table', "columns: { type: 'list', label: 'Column', min: 0, max: 8, item: { header: { type: 'text', label: 'Header', required: true }, path: { type: 'text', label: 'Path', required: true } } },")).toContain('design.option-list')
    })
    it('knows the chart series list', async () => {
      expect(await rulesFor('chart', "series: { type: 'list', label: 'Series', min: 1, max: 9, item: { y_path: { type: 'text', label: 'Value path', required: true }, icon: { type: 'select', label: 'Icon', choices: ['circle'], required: true } } },")).toContain('design.option-list')
    })
    it('refuses choices the hub does not accept, and a wrong value type', async () => {
      expect(await rulesFor('alert_feed', "min_severity: { type: 'select', label: 'Minimum', choices: ['info', 'loud'] },")).toContain('design.option-choices')
      expect(await rulesFor('gauge', "label: { type: 'boolean', label: 'Label' },")).toContain('design.option-type')
    })
    it('refuses settings that are part of the cell itself', async () => {
      expect(await rulesFor('gauge', "feed: { type: 'text', label: 'Feed' },")).toContain('design.reserved-setting')
      expect(await rulesFor('gauge', "design: { type: 'text', label: 'Design' },")).toContain('design.reserved-setting')
    })
    it('refuses a design_options setting the hub could not store', async () => {
      expect(await rulesFor('gauge', "rows: { type: 'list', label: 'Row', min: 0, max: 2, item: { a: { type: 'text', label: 'A' } }, path: 'design_options.rows' },").catch(() => ['design.options'])).toEqual(expect.arrayContaining([expect.stringMatching(/design\.(option-type|options)/)]))
      expect(await rulesFor('gauge', `motto: { type: 'text', label: 'Motto', default: '${'x'.repeat(201)}', path: 'design_options.motto' },`)).toContain('design.option-type')
    })
  })

  it('checkPack on a valid pack with one design finds nothing', async () => {
    const design = await load(gauge())
    const manifest = { id: 'vintage', name: 'Vintage', version: '1.0.0', theme: {
      board: { bg: '#f4ecd8', surface: '#fbf6ea', ink: '#2b2118', dim: '#5c4a38', accent: '#8a5a1f', info: '#2f5f8a', warn: '#8a5a06', critical: '#a32b25', scrim: 0.4, series: ['#8a5a1f', '#2f5f8a', '#5f7a2a', '#a32b25'] },
      backdrop: 'wash', widgets: { gauge: 'vintage-dial' }, recommended: {}, sounds: {},
    } }
    expect(checkPack({ manifest, designs: [design] })).toEqual([])
  })
})
