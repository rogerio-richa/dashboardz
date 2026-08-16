import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { canvasHtml, prepare } from '../static/device/widgets/surface.mjs'
// @ts-expect-error plain JS module without types
import * as widgetRuntime from '../static/device/widgets/index.mjs'

const unknownWidgetTypes = (widgetRuntime as unknown as {
  unknownWidgetTypes?: (cells: unknown, definitions: unknown) => string[]
}).unknownWidgetTypes
const { designsNeedingReload, noteReloadAttempts, RELOAD_BACKOFF_MS, MAX_RELOAD_ATTEMPTS } = widgetRuntime

function fakeCanvas() {
  const calls: string[] = []
  // Assignments to width/height are recorded, not just their final value: ANY assignment to
  // either reallocates and clears the backing store per the HTML spec, even an assignment of the
  // value already there, so "did we assign" is the thing under test.
  const assigns: string[] = []
  let w = 0
  let h = 0
  const ctx = {
    setTransform: (...a: number[]) => calls.push(`setTransform(${a.join(',')})`),
    clearRect: (...a: number[]) => calls.push(`clearRect(${a.join(',')})`),
  }
  return {
    el: {
      get width() { return w },
      set width(v: number) { assigns.push(`width=${v}`); w = v },
      get height() { return h },
      set height(v: number) { assigns.push(`height=${v}`); h = v },
      style: {} as Record<string, string>,
      getContext: () => ctx,
    },
    calls,
    assigns,
  }
}

describe('cell canvas surface', () => {
  it('emits a placeholder carrying the cell index', () => {
    expect(canvasHtml(3)).toContain('data-cell="3"')
    expect(canvasHtml(3)).toContain('class="widget-canvas"')
  })

  it('sizes the backing store by device pixel ratio', () => {
    const c = fakeCanvas()
    prepare(c.el, 200, 100, 2)
    expect(c.el.width).toBe(400)
    expect(c.el.height).toBe(200)
  })

  it('keeps the CSS box in CSS pixels', () => {
    const c = fakeCanvas()
    prepare(c.el, 200, 100, 2)
    expect(c.el.style.width).toBe('200px')
    expect(c.el.style.height).toBe('100px')
  })

  it('scales the context so designs draw in CSS pixels and clears the previous frame', () => {
    const c = fakeCanvas()
    prepare(c.el, 200, 100, 2)
    expect(c.calls).toEqual(['setTransform(2,0,0,2,0,0)', 'clearRect(0,0,200,100)'])
  })

  it('rounds a fractional ratio so the backing store is a whole number of pixels', () => {
    const c = fakeCanvas()
    prepare(c.el, 100, 50, 1.5)
    expect(Number.isInteger(c.el.width)).toBe(true)
    expect(c.el.width).toBe(150)
  })

  // An animating cell calls prepare on every frame with the same size every time. Reassigning the
  // dimensions there is a full realloc-and-clear of the bitmap per frame per cell.
  it('does not touch the backing store dimensions when the size has not changed', () => {
    const c = fakeCanvas()
    prepare(c.el, 200, 100, 2)
    expect(c.assigns).toEqual(['width=400', 'height=200'])
    prepare(c.el, 200, 100, 2)
    expect(c.assigns).toEqual(['width=400', 'height=200'])
  })

  it('still resizes when the cell actually changes size', () => {
    const c = fakeCanvas()
    prepare(c.el, 200, 100, 2)
    prepare(c.el, 200, 120, 2)
    expect(c.assigns).toEqual(['width=400', 'height=200', 'height=240'])
  })

  it('clears and re-transforms on every call, resize or not — a skipped resize clears nothing', () => {
    const c = fakeCanvas()
    prepare(c.el, 200, 100, 2)
    prepare(c.el, 200, 100, 2)
    expect(c.calls).toEqual([
      'setTransform(2,0,0,2,0,0)', 'clearRect(0,0,200,100)',
      'setTransform(2,0,0,2,0,0)', 'clearRect(0,0,200,100)',
    ])
  })
})

describe('unknown widget catalogue recovery', () => {
  const T0 = 1_775_000_000_000
  const definitions = [{ id: 'clock' }, { id: 'weather_forecast' }]
  const cell = (widget: string, config: object = {}) => ({
    rect: { x: 0, y: 0, w: 1, h: 1 }, widget, config,
  })

  it('reports unknown widget ids once in stable screen order', () => {
    expect(unknownWidgetTypes).toBeTypeOf('function')
    expect(unknownWidgetTypes?.([
      cell('clock'), cell('ai_summary'), cell('weather_forecast'), cell('ai_summary'), cell('future_chart'),
    ], definitions)).toEqual(['ai_summary', 'future_chart'])
  })

  it('ignores malformed and inherited ids instead of trusting prototypes', () => {
    expect(unknownWidgetTypes).toBeTypeOf('function')
    const inheritedCell = Object.create({ widget: 'ai_summary' })
    const inheritedDefinition = Object.create({ id: 'ai_summary' })
    expect(unknownWidgetTypes?.([null, {}, inheritedCell, cell('clock')], [...definitions, inheritedDefinition])).toEqual([])
  })

  it('joins unknown designs and prefixed widget ids in the existing reload history', () => {
    const cells = [cell('clock', { design: '__future_design__' }), cell('ai_summary')]
    expect(designsNeedingReload(cells, {}, {}, T0, definitions))
      .toEqual(['__future_design__', 'widget:ai_summary'])
    const history = noteReloadAttempts({}, ['__future_design__', 'widget:ai_summary'], T0)
    expect(designsNeedingReload(cells, {}, history, T0, definitions)).toEqual([])
  })

  it('spends one rung when an unknown design key collides with an unknown widget key', () => {
    const cells = [cell('clock', { design: 'widget:future' }), cell('future')]
    const needed = designsNeedingReload(cells, {}, {}, T0, definitions)
    expect(needed).toEqual(['widget:future'])
    expect(noteReloadAttempts({}, needed, T0)).toEqual({ 'widget:future': { n: 1, at: T0 } })
  })

  it('spends the same finite reload ladder for an unknown widget and then stops', () => {
    const cells = [cell('ai_summary'), cell('ai_summary')]
    const key = 'widget:ai_summary'
    let history = {}
    let now = T0

    for (let attempt = 0; attempt < MAX_RELOAD_ATTEMPTS; attempt++) {
      expect(designsNeedingReload(cells, {}, history, now, definitions)).toEqual([key])
      history = noteReloadAttempts(history, [key], now)
      expect(designsNeedingReload(cells, {}, history, now, definitions)).toEqual([])
      if (attempt < RELOAD_BACKOFF_MS.length) now += RELOAD_BACKOFF_MS[attempt]
    }

    expect(designsNeedingReload(cells, {}, history, now + 86_400_000, definitions)).toEqual([])
  })
})
