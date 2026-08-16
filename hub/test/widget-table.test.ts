import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import grid, { normalizeTable } from '../static/device/widgets/table/grid.mjs'
// @ts-expect-error plain JS module without types
import { TABLE_ROW, TABLE_HEADER, tableConfig } from '../static/device/layout-core.mjs'

type Call = { fillStyle: string; text: string; y: number; align: string; font: string }

/** Same recorder shape as stream/list.mjs's test suite (widget-stream.test.ts), `font` included —
 *  that is what lets a size regression in a SHARED text-fit helper fail here and not only in the
 *  helper's own suite (see the quiet-line size test below). */
function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string, x: number, y: number) =>
      calls.push({ fillStyle: g.fillStyle, text, y, align: g.textAlign, font: g.font }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
  }
  return { g, calls }
}

const row = (payload: unknown, pushed_at: number | null = 0) => ({ payload, pushed_at })

const columns = [{ header: 'Name', path: 'name', align: 'left' }, { header: 'Value', path: 'value', align: 'right' }]

/**
 * The `ctx.feed` states this design cares about (widgets/index.mjs's `feedSignalFor`).
 *
 * `NO_FEED` is `null`: the cell binds nothing. On the channel that means NOT APPLICABLE rather than
 * "something is wrong" — a chart lives there permanently — but a table with no feed is an authoring
 * mistake no push can fix, so THIS design rules it loud. `GONE` is the channel's own loud state: a
 * bound id the device does not have. `NEVER_PUSHED` is a feed that EXISTS, is a kind this widget
 * reads, and has had nothing sent to it — the quiet line. `PUSHED` is a feed with a real timestamp,
 * which keeps the loud notice for a cell whose data genuinely cannot be read.
 */
const NO_FEED = null
const GONE = { missing: true, mode: null, pushed_at: null, image_rev: null }
const NEVER_PUSHED = { missing: false, mode: 'value', pushed_at: null, image_rev: null }
const PUSHED = { missing: false, mode: 'value', pushed_at: 1_775_000_000_000, image_rev: null }

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim' },
  config: { feed: 'f', columns },
  data: null,
  feed: PUSHED,
  rows: [row({ name: 'Alpha', value: 12 }, 0)],
  box: { w: 300, h: 300, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

describe('table design', () => {
  /**
   * Every table knob this design owns is DECLARED — `columns` was the last one that could not be,
   * and `type: 'list'` is what removed the reason. `counter` is declared by `path`, which
   * removed the earlier one.
   */
  it('declares columns, headers and the overflow counter — nothing is left hand-built', () => {
    expect(Object.keys(grid.meta.options ?? {}).sort()).toEqual(['columns', 'counter', 'headers'])
    expect(grid.meta.options.headers.path).toBeUndefined()
    expect(grid.meta.options.counter.path).toBe('overflow.counter')
  })

  /**
   * `columns` as a repeating group. The row bounds and the item fields are what the admin generates
   * a control from, and `option-bounds.test.ts` is where they are checked against the grid PATCH
   * schema they have to agree with; this pins the declaration itself, so the shape cannot quietly
   * lose a field.
   *
   * `align` is deliberately NOT required: the schema leaves it out of `items.required`, and a
   * column that omits it draws left — which is also what its `default` says, restating
   * `tableConfig`'s own `col.align === 'right' ? 'right' : 'left'`.
   */
  it('declares columns as a 1..4 list of header, path and align', () => {
    const spec = grid.meta.options.columns
    expect(spec.type).toBe('list')
    expect([spec.min, spec.max]).toEqual([1, 4])
    expect(Object.keys(spec.item)).toEqual(['header', 'path', 'align'])
    expect(spec.item.header.required).toBe(true)
    expect(spec.item.path.required).toBe(true)
    expect(spec.item.align.required).toBeUndefined()
    expect(spec.item.align.choices).toEqual(['left', 'right'])
    // Against `tableConfig`, not a hardcoded 'left': if the renderer's own fallback ever flips, the
    // generated select would show one thing while the panel drew another, and this fails first.
    expect(spec.item.align.default).toBe(tableConfig({ feed: 'f', columns: [{ header: 'H', path: 'p' }] }).columns[0].align)
  })

  // Both default ON in `tableConfig` (`c.headers !== false`, `overflow.counter !== false`), so an
  // unset generated checkbox must render CHECKED. Asserted against `tableConfig` itself rather than
  // a hardcoded `true`, so a flipped renderer default fails here instead of quietly diverging.
  it('defaults headers and the counter to exactly what tableConfig defaults them to', () => {
    const drawn = tableConfig({ feed: 'f', columns: [{ header: 'H', path: 'p' }] })
    expect(grid.meta.options.headers.default).toBe(drawn.headers)
    expect(grid.meta.options.counter.default).toBe(drawn.counter)
  })

  it('meta matches the widget/design ids the registry and definitions expect', () => {
    expect(grid.meta.widget).toBe('table')
    expect(grid.meta.id).toBe('grid')
  })
})

describe('normalizeTable — the four states', () => {
  it('rows === null and data === null (feed absent from the map entirely) is "missing"', () => {
    expect(normalizeTable(null, null, NO_FEED, { columns }).state).toBe('missing')
  })

  it('rows === null and data === undefined is also "missing"', () => {
    expect(normalizeTable(undefined, null, NO_FEED, { columns }).state).toBe('missing')
  })

  it('a value feed whose path does not resolve to an array is "not-array"', () => {
    const n = normalizeTable({ items: 'not an array' }, null, NO_FEED, { columns, path: 'items' })
    expect(n.state).toBe('not-array')
  })

  it('a value feed with no path configured whose payload itself is not an array is "not-array"', () => {
    expect(normalizeTable({ name: 'Alpha' }, null, NO_FEED, { columns }).state).toBe('not-array')
  })

  it('a value feed whose payload IS the array (empty path, the default) is ready', () => {
    const n = normalizeTable([{ name: 'Alpha', value: 12 }], null, NO_FEED, { columns })
    expect(n.state).toBe('ready')
  })

  it('a value feed whose path resolves to an array reads through it', () => {
    const n = normalizeTable({ items: [{ name: 'Alpha', value: 12 }] }, null, NO_FEED, { columns, path: 'items' })
    expect(n.state).toBe('ready')
    expect(n.rows[0]).toEqual(['Alpha', '12'])
  })

  it('rows === [] (a well-formed empty stream) is "empty", NOT "missing" or "not-array"', () => {
    expect(normalizeTable(null, [], NO_FEED, { columns }).state).toBe('empty')
  })

  it('an empty resolved array off a value feed is also "empty"', () => {
    expect(normalizeTable([], null, NO_FEED, { columns }).state).toBe('empty')
  })

  it('rows with entries is "ready", read from ctx.rows (stream mode), not ctx.data', () => {
    const n = normalizeTable(null, [row({ name: 'Alpha', value: 12 })], NO_FEED, { columns })
    expect(n.state).toBe('ready')
    expect(n.rows).toEqual([['Alpha', '12']])
  })

  it('stream mode is decided by ctx.rows, independent of what ctx.data happens to hold', () => {
    // A stream feed's ctx.data is the SAME mapped-payload array dataForCell already produces —
    // this just proves the design does not need ctx.data at all once ctx.rows says "stream".
    const n = normalizeTable('garbage', [row({ name: 'Alpha', value: 12 })], NO_FEED, { columns })
    expect(n.state).toBe('ready')
  })
})

/**
 * THE BEHAVIOUR CHANGE `ctx.feed` EXISTS FOR, pinned from both sides.
 *
 * Before this channel, `ctx.data === null` meant either "no such feed" or "a real value feed nobody
 * has ever pushed to" — a never-pushed value feed's `payload` is legitimately `null` — and this
 * design could not tell them apart, so it painted the LOUD "Feed missing" for both. An operator
 * with a correctly configured, simply empty feed went hunting for a deletion that never happened.
 *
 * `ctx.feed.pushed_at === null` is the fact that separates them, and it is the ONLY case that
 * moved: a feed that HAS been pushed to but whose data this widget cannot use is still loud.
 */
describe('normalizeTable — ctx.feed separates "no such feed" from "never pushed"', () => {
  it('a feed that EXISTS and was never pushed is "empty" (quiet), NOT "missing"', () => {
    expect(normalizeTable(null, null, NEVER_PUSHED, { columns }).state).toBe('empty')
  })

  it('no feed at all is still "missing" (loud) — the state that did not move', () => {
    expect(normalizeTable(null, null, NO_FEED, { columns }).state).toBe('missing')
  })

  it('a feed that HAS been pushed but whose data is unusable is still "missing" (loud)', () => {
    // A value feed whose payload really is null: something arrived and this cell cannot show it,
    // which is a person's problem, not an empty feed.
    expect(normalizeTable(null, null, PUSHED, { columns }).state).toBe('missing')
  })

  it('a bound feed the device does not have is "missing" (loud) — the channel\'s own loud state', () => {
    expect(normalizeTable(null, null, GONE, { columns }).state).toBe('missing')
  })

  /**
   * THE MODE GATE, and the case it fixes.
   *
   * A table can never show a picture, so an IMAGE feed bound to a table cell is a misconfiguration
   * from the moment it is bound. Without `ctx.feed.mode` this design could only see "exists, never
   * pushed" and drew the QUIET line — so the operator got the honest notice only once somebody
   * pushed a bitmap to a feed that was wrong all along. `widgetAcceptsMode` (bindings.mjs) is the
   * same mode set the hub enforces when the binding is saved, so the two cannot disagree.
   */
  it('stays LOUD for a feed of a kind it cannot read, pushed or not', () => {
    const image = (pushed_at: number | null) => ({ missing: false, mode: 'image', pushed_at, image_rev: 3 })
    expect(normalizeTable(null, null, image(5), { columns }).state).toBe('missing')
    expect(normalizeTable(null, null, image(null), { columns }).state).toBe('missing')
  })

  it('stays LOUD for a mode this build cannot name — a board served by a newer hub', () => {
    expect(normalizeTable(null, null, { missing: false, mode: null, pushed_at: null, image_rev: null }, { columns })
      .state).toBe('missing')
  })

  it('takes the quiet line for BOTH modes it does read, so the gate is not an image special case', () => {
    for (const mode of ['value', 'stream']) {
      expect(normalizeTable(null, null, { missing: false, mode, pushed_at: null, image_rev: null }, { columns }).state)
        .toBe('empty')
    }
  })

  it('never lets ctx.feed override real data — a resolvable payload still reads through', () => {
    expect(normalizeTable([{ name: 'Alpha', value: 12 }], null, NEVER_PUSHED, { columns }).state).toBe('ready')
    expect(normalizeTable({ name: 'Alpha' }, null, NEVER_PUSHED, { columns }).state).toBe('not-array')
  })

  it('treats an absent ctx.feed as no feed, so a host that never sets it degrades loudly as before', () => {
    expect(normalizeTable(null, null, undefined, { columns }).state).toBe('missing')
  })
})

describe('normalizeTable — cell values through displayValue(..., \'raw\', null)', () => {
  it('formats numbers with the raw rule (no decimal point on integers)', () => {
    const n = normalizeTable(null, [row({ name: 'Alpha', value: 12 })], NO_FEED, { columns })
    expect(n.rows[0][1]).toBe('12')
  })

  it('a column path that does not resolve prints the em-dash placeholder', () => {
    const n = normalizeTable(null, [row({ name: 'Alpha' })], NO_FEED, { columns })
    expect(n.rows[0][1]).toBe('—')
  })
})

describe('normalizeTable — every tableConfig knob carried over', () => {
  it('headers defaults true and reads the flat headers key', () => {
    expect(normalizeTable(null, [], NO_FEED, { columns }).headers).toBe(true)
    expect(normalizeTable(null, [], NO_FEED, { columns, headers: false }).headers).toBe(false)
  })

  it('counter defaults true and reads overflow.counter', () => {
    expect(normalizeTable(null, [], NO_FEED, { columns }).counter).toBe(true)
    expect(normalizeTable(null, [], NO_FEED, { columns, overflow: { counter: false } }).counter).toBe(false)
  })

  it('clamps scale into the shared 0.5-2 range', () => {
    expect(normalizeTable(null, [], NO_FEED, { columns, scale: 9 }).scale).toBe(2)
    expect(normalizeTable(null, [], NO_FEED, { columns, scale: 0.1 }).scale).toBe(0.5)
  })

  it('carries columns (header/path/align) through verbatim, defaulting align to left', () => {
    const n = normalizeTable(null, [], NO_FEED, { columns: [{ header: 'N', path: 'n' }] })
    expect(n.columns).toEqual([{ header: 'N', path: 'n', align: 'left' }])
  })
})

describe('table draw — the four states, rendered distinctly', () => {
  it('paints the loud "Feed missing" notice when both channels are empty', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ data: null, rows: null }))
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(true)
    expect(calls.some((c) => c.text === 'Not an array')).toBe(false)
    expect(calls.some((c) => /no rows yet/.test(c.text))).toBe(false)
  })

  it('paints "Not an array" when a value feed\'s path does not resolve to an array', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ data: { name: 'Alpha' }, rows: null }))
    expect(calls.some((c) => c.text === 'Not an array')).toBe(true)
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
  })

  it('paints the quiet "— no rows yet" line for a well-formed empty stream', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ data: null, rows: [] }))
    expect(calls.some((c) => c.text === '— no rows yet')).toBe(true)
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
    expect(calls.some((c) => c.text === 'Not an array')).toBe(false)
  })

  it('paints the quiet "— no rows yet" line for an empty resolved value-feed array', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ data: [], rows: null }))
    expect(calls.some((c) => c.text === '— no rows yet')).toBe(true)
  })

  /**
   * THE SIZE, not just the words. `quietLine` is shared with `stream/list.mjs`, `alert/feed.mjs`
   * and `image/frame.mjs` (text-fit.mjs), and a mutation to its `px` formula during that
   * consolidation failed only the helper's own suite — every design pinned this line's TEXT and
   * `tokens.dim` COLOUR and nothing else, so a shared-helper size regression reached four widgets
   * with no design-level signal.
   *
   * `400 12px system-ui` here: `Math.min(16, box.w * 0.04) * scale` = `min(16, 300*0.04)` = 12 at
   * `n.scale` 1. The scaled half is what is THIS design's own: `table` has a real `scale` knob and
   * hands it to `quietLine` (`n.scale`), so scale 2 doubles the line to 24px — unlike
   * `image/frame.mjs`, which passes a literal `1` because it has no such knob.
   */
  it('paints the quiet line at the shared helper\'s size, and moves it with its own scale knob', () => {
    const unscaled = recorder()
    grid.draw(unscaled.g, baseCtx({ data: null, rows: [] }))
    expect(unscaled.calls.find((c) => c.text === '— no rows yet')?.font).toBe('400 12px system-ui')

    const scaled = recorder()
    grid.draw(scaled.g, baseCtx({ data: null, rows: [], config: { feed: 'f', columns, scale: 2 } }))
    expect(scaled.calls.find((c) => c.text === '— no rows yet')?.font).toBe('400 24px system-ui')
  })

  it('paints the QUIET line, not the loud notice, for a real feed nobody has pushed to', () => {
    // The whole point of ctx.feed, on glass: same empty ctx.data, opposite notices.
    const quiet = recorder()
    grid.draw(quiet.g, baseCtx({ data: null, rows: null, feed: NEVER_PUSHED }))
    expect(quiet.calls.some((c) => c.text === '— no rows yet')).toBe(true)
    expect(quiet.calls.some((c) => c.text === 'Feed missing')).toBe(false)

    const loud = recorder()
    grid.draw(loud.g, baseCtx({ data: null, rows: null, feed: NO_FEED }))
    expect(loud.calls.some((c) => c.text === 'Feed missing')).toBe(true)
    expect(loud.calls.some((c) => c.text === '— no rows yet')).toBe(false)
  })

  it('paints row cells when rows have entries, not any notice', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx())
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
    expect(calls.some((c) => c.text === 'Not an array')).toBe(false)
    expect(calls.some((c) => /no rows yet/.test(c.text))).toBe(false)
    expect(calls.some((c) => c.text === 'Alpha')).toBe(true)
    expect(calls.some((c) => c.text === '12')).toBe(true)
  })
})

describe('table draw — headers and per-column align', () => {
  it('paints a header row with each column\'s own header text when headers is on', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx())
    expect(calls.some((c) => c.text === 'Name')).toBe(true)
    expect(calls.some((c) => c.text === 'Value')).toBe(true)
  })

  it('paints no header row when headers is off', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ config: { feed: 'f', columns, headers: false } }))
    expect(calls.some((c) => c.text === 'Name')).toBe(false)
    expect(calls.some((c) => c.text === 'Value')).toBe(false)
    expect(calls.some((c) => c.text === 'Alpha')).toBe(true)
  })

  it('aligns each column\'s cell text per its own "align", independent of the other columns', () => {
    const { g, calls } = recorder()
    grid.draw(g, baseCtx())
    const name = calls.find((c) => c.text === 'Alpha')
    const value = calls.find((c) => c.text === '12')
    expect(name?.align).toBe('left')
    expect(value?.align).toBe('right')
  })
})

describe('table draw — header arithmetic (TABLE_HEADER before cardPlan divides by TABLE_ROW)', () => {
  it('reserves TABLE_HEADER off the cell height before deciding how many rows fit', () => {
    // A cell exactly TABLE_HEADER + TABLE_ROW tall fits exactly one row when headers are on.
    const rows = [row({ name: 'a', value: 1 }), row({ name: 'b', value: 2 })]
    const box = { w: 300, h: TABLE_HEADER + TABLE_ROW, t: 1 }
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ rows, box, config: { feed: 'f', columns, overflow: { counter: false } } }))
    expect(calls.some((c) => c.text === 'a')).toBe(true)
    expect(calls.some((c) => c.text === 'b')).toBe(false)
  })

  it('without headers, the same cell height that fit one row with headers now fits two', () => {
    const rows = [row({ name: 'a', value: 1 }), row({ name: 'b', value: 2 })]
    // Exactly two TABLE_ROWs tall: with a header reserved (previous test) only one row fits;
    // with no header to reserve, the full height goes to rows and both fit.
    const box = { w: 300, h: TABLE_ROW * 2, t: 1 }
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({
      rows, box, config: { feed: 'f', columns, headers: false, overflow: { counter: false } },
    }))
    expect(calls.some((c) => c.text === 'a')).toBe(true)
    expect(calls.some((c) => c.text === 'b')).toBe(true)
  })
})

describe('table draw — overflow (cardPlan) and the negative-visible guard', () => {
  it('reports "and N more" once rows overflow the cell, with the counter reserved before fit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ name: `row${i}`, value: i }))
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({ rows, box: { w: 300, h: 100, t: 1 } }))
    expect(calls.some((c) => /and \d+ more/.test(c.text))).toBe(true)
  })

  it('draws nothing on a cell too small for even one row — plan.visible can go negative', () => {
    const rows = [row({ name: 'only', value: 1 })]
    const { g, calls } = recorder()
    grid.draw(g, baseCtx({
      rows, config: { feed: 'f', columns, overflow: { counter: false } }, box: { w: 300, h: 1, t: 1 },
    }))
    expect(calls.some((c) => c.text === 'only')).toBe(false)
  })

  it('does not throw for a negative-visible plan with the counter on', () => {
    const rows = [row({ name: 'only', value: 1 })]
    const { g } = recorder()
    expect(() => grid.draw(g, baseCtx({ rows, box: { w: 300, h: 1, t: 1 } }))).not.toThrow()
  })
})

describe('table draw — scale moves TEXT ONLY (contract)', () => {
  it('the same number of rows fit regardless of scale — TABLE_ROW/TABLE_HEADER are not scaled', () => {
    const box = { w: 300, h: TABLE_ROW * 2, t: 1 }
    const rows = [row({ name: 'a', value: 1 }), row({ name: 'b', value: 2 }), row({ name: 'c', value: 3 })]
    const cfg = { feed: 'f', columns, headers: false }

    const small = recorder()
    grid.draw(small.g, baseCtx({ rows, config: { ...cfg, scale: 0.5 }, box }))
    const big = recorder()
    grid.draw(big.g, baseCtx({ rows, config: { ...cfg, scale: 2 }, box }))

    const visibleTexts = (calls: Call[]) => ['a', 'b', 'c'].filter((t) => calls.some((c) => c.text === t))
    expect(visibleTexts(small.calls)).toEqual(visibleTexts(big.calls))
  })

  it('bumps the cell font size with scale', () => {
    const track = (sink: string[]) => {
      const g: any = { font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1 }
      Object.defineProperty(g, 'font', {
        get() { return this._font },
        set(v) { this._font = v; sink.push(v) },
      })
      g.fillText = () => {}
      g.measureText = (value: string) => ({ width: Array.from(String(value)).length * 8 })
      return g
    }
    const smallFonts: string[] = []
    const bigFonts: string[] = []
    grid.draw(track(smallFonts), baseCtx({ config: { feed: 'f', columns, scale: 0.5 } }))
    grid.draw(track(bigFonts), baseCtx({ config: { feed: 'f', columns, scale: 2 } }))
    const maxPx = (fonts: string[]) => Math.max(...fonts.map((f) => parseInt(f.split(' ')[1], 10)).filter((n) => !Number.isNaN(n)))
    expect(maxPx(bigFonts)).toBeGreaterThan(maxPx(smallFonts))
  })
})

describe('table draw — staleness dims body rows only (ctx.stale)', () => {
  it('applies reduced alpha while painting a stale row and restores it after', () => {
    const alphaAtFillText: number[] = []
    const g: any = { font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1 }
    g.fillText = () => alphaAtFillText.push(g.globalAlpha)
    g.measureText = (value: string) => ({ width: Array.from(String(value)).length * 8 })
    grid.draw(g, baseCtx({ stale: true }))
    expect(alphaAtFillText.some((a) => a < 1)).toBe(true)
    expect(g.globalAlpha).toBe(1) // reset after the last row
  })
})
