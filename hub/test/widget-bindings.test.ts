import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { WIDGET_BINDINGS, feedModesFor, needsFor, bindsPhrase } from '../static/device/widgets/bindings.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'
import { WIDGET_NEEDS } from '../src/data/needs.js'
import { WIDGET_FEED_MODES } from '../src/routes/admin.js'

/**
 * The data half of the widget contract, and the same argument catalogue.mjs makes for designs: a
 * widget's accepted feed modes were written down in THREE places — CellConfig's
 * `'any' | 'stream' | 'image'` filter arguments, Widgets.tsx's hand-typed `binds:` strings, and
 * feedCheck's per-widget branches — and the three had already drifted. Widgets.tsx said value_tile
 * and gauge bind "a value feed"; both have accepted stream feeds since they shipped, and the
 * catalogue page is exactly where somebody goes to find that out.
 *
 * `bindings.mjs` is now the one declaration. The admin imports it directly (it is pure — no
 * assets.mjs, so it crosses the bundler boundary the way catalogue.mjs does). The hub CANNOT: its
 * tsconfig has `rootDir: src`, so an import of `../static/...` is outside the compilation root and
 * breaks `npm run build`. So admin.ts carries a duplicate, exactly as it does for CHART_ICONS —
 * and, exactly as for CHART_ICONS, THIS test is what keeps the copy honest. A comment cannot catch
 * drift; only a test that reads both sources can.
 */
describe('WIDGET_BINDINGS — one declaration of what each widget consumes', () => {
  const WIDGETS = ['clock', 'alert_feed', 'value_tile', 'gauge', 'stream_list', 'table', 'text_block', 'chart', 'image']

  it('declares every widget the cell schema accepts, and no others', () => {
    expect(Object.keys(WIDGET_BINDINGS).sort()).toEqual([...WIDGETS].sort())
  })

  it('admin.ts WIDGET_FEED_MODES is byte-identical to bindings.mjs (change both or neither)', () => {
    const fromDeclaration = Object.fromEntries(WIDGETS.map((w) => [w, feedModesFor(w)]))
    expect(WIDGET_FEED_MODES).toEqual(fromDeclaration)
  })

  /**
   * The same guard one field over, and it needs to exist for the same reason: `needs` is now the
   * second half of the enforceable contract, and the server enforces it from its OWN copy in
   * `src/data/needs.ts` (`rootDir: src` forbids importing `../static`). A `needs` entry added on
   * one side only is a widget the renderer reads one way and the save path checks another — which
   * is precisely the drift that produced the mode tables' original disagreement.
   */
  it('src/data/needs.ts WIDGET_NEEDS is byte-identical to bindings.mjs (change both or neither)', () => {
    const fromDeclaration = Object.fromEntries(WIDGETS.map((w) => [w, needsFor(w)]))
    expect(WIDGET_NEEDS).toEqual(fromDeclaration)
  })

  /**
   * A widget that binds a feed but declares nothing about what must be at the path is exactly the
   * gap this whole contract exists to close — it looks declared and enforces nothing. The no-feed
   * list is explicit rather than derived from `modes.length === 0` so that adding a feed-binding
   * widget cannot silently join it.
   */
  it('every feed-binding widget declares what it needs', () => {
    const NO_FEED_WIDGETS = ['clock', 'alert_feed']
    for (const widget of WIDGETS) {
      const bindsAFeed = feedModesFor(widget).length > 0
      expect(bindsAFeed, `${widget}`).toBe(!NO_FEED_WIDGETS.includes(widget))
      expect(needsFor(widget).length > 0, `${widget} declares needs`).toBe(bindsAFeed)
    }
  })

  it('every declared mode is a real feed mode', () => {
    for (const widget of WIDGETS) {
      for (const mode of feedModesFor(widget)) expect(['value', 'stream', 'image']).toContain(mode)
    }
  })

  /** The three feed-bound rules the hub enforces at save time, read off the declaration. */
  it('pins the mode sets the hub validates against', () => {
    expect(feedModesFor('clock')).toEqual([])
    expect(feedModesFor('alert_feed')).toEqual([])
    expect(feedModesFor('value_tile')).toEqual(['value', 'stream'])
    expect(feedModesFor('gauge')).toEqual(['value', 'stream'])
    expect(feedModesFor('stream_list')).toEqual(['stream'])
    expect(feedModesFor('table')).toEqual(['value', 'stream'])
    expect(feedModesFor('text_block')).toEqual(['value', 'stream'])
    expect(feedModesFor('chart')).toEqual(['stream'])
    expect(feedModesFor('image')).toEqual(['image'])
  })

  it('an unknown widget binds nothing rather than throwing', () => {
    expect(feedModesFor('not_a_widget')).toEqual([])
  })

  /**
   * The catalogue page's phrase is DERIVED, not authored beside the modes — that redundancy is
   * what let it say "a value feed" for a widget that has always taken stream feeds too.
   */
  it('derives the catalogue phrase from the same modes', () => {
    expect(bindsPhrase('clock')).toBe('nothing')
    expect(bindsPhrase('alert_feed')).toBe('alerts')
    expect(bindsPhrase('value_tile')).toBe('a value or stream feed')
    expect(bindsPhrase('stream_list')).toBe('a stream feed')
    expect(bindsPhrase('table')).toBe('a value or stream feed')
    expect(bindsPhrase('text_block')).toBe('nothing, or a value or stream feed')
    expect(bindsPhrase('chart')).toBe('stream feeds, one per series')
    expect(bindsPhrase('image')).toBe('an image feed')
  })

  it('every widget declares a one-line payload expectation', () => {
    for (const widget of WIDGETS) {
      expect(typeof WIDGET_BINDINGS[widget].payload).toBe('string')
      expect(WIDGET_BINDINGS[widget].payload.length).toBeGreaterThan(0)
    }
  })

  it('keeps semantic widgets out of the legacy mode-only binding registry', () => {
    const semantic = WIDGET_DEFINITIONS.filter((definition: { consumes?: unknown }) => definition.consumes)
    expect(semantic.map((definition: { id: string }) => definition.id).sort()).toEqual(['calendar_events', 'news_list', 'weather_forecast'])
    for (const definition of semantic) {
      expect(WIDGET_BINDINGS[definition.id]).toBeUndefined()
      expect(feedModesFor(definition.id)).toEqual([])
    }
  })
})

/**
 * `widget-definitions.test.ts`'s "agrees exactly with the server semantic requirement registry"
 * already pins every widget's `consumes` to `WIDGET_REQUIREMENTS` (and, via the whole-object
 * `toEqual` plus its hardcoded key list, that widgets without a server entry declare none). This
 * block only adds what nothing else pins: that every widget type declares an `emits` list.
 */
describe('client emits declaration', () => {
  it('gives every widget type an emits list', () => {
    for (const def of WIDGET_DEFINITIONS as { id: string; emits?: unknown }[]) {
      expect(Array.isArray(def.emits), `${def.id} must declare emits`).toBe(true)
    }
  })
})
