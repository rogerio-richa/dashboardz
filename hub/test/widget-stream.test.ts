import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import list, { normalizeStream } from '../static/device/widgets/stream/list.mjs'
// @ts-expect-error plain JS module without types
import { formatAge } from '../static/device/widgets/text-fit.mjs'
// @ts-expect-error plain JS module without types
import { STREAM_CARD_TITLE, STREAM_CARD_BODY, streamListConfig } from '../static/device/layout-core.mjs'

type Call = { fillStyle: string; text: string; y: number; font: string }

/** Same recorder shape as value/tile.mjs's test suite (widget-value.test.ts), extended with `y` so
 *  overflow/ordering assertions can tell rows apart without a real canvas — and with `font`, which
 *  is what lets a size regression in a SHARED text-fit helper fail in this design's own suite
 *  rather than only in the helper's (see the quiet-line size test below). */
function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string, x: number, y: number) => calls.push({ fillStyle: g.fillStyle, text, y, font: g.font }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
  }
  return { g, calls }
}

const row = (payload: unknown, pushed_at: number | null = 0) => ({ payload, pushed_at })

// The delivery facts for a feed that exists, is a STREAM (the only mode `stream_list` reads —
// bindings.mjs's WIDGET_BINDINGS), and has been pushed to at least once — the shape `ctx.feed`
// carries when a cell's rows are non-empty. Individual tests override `pushed_at`/`mode`/`missing`
// to exercise the other states in the rule.
const streamFeed = (overrides: Record<string, unknown> = {}) =>
  ({ missing: false, mode: 'stream', pushed_at: 0, image_rev: null, ...overrides })

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim' },
  config: { feed: 'f', title_path: 'title', body_path: 'body' },
  data: null,
  rows: [row({ title: 'First', body: 'body one' }, 0)],
  feed: streamFeed(),
  box: { w: 300, h: 300, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

describe('stream_list design', () => {
  it('declares its two flat paths plus the three nested knobs', () => {
    expect(Object.keys(list.meta.options).sort())
      .toEqual(['body_lines', 'body_path', 'counter', 'title_lines', 'title_path'])
    // The flat two keep no `path`: they ARE top-level keys, and spelling that out twice would be
    // two places for one fact to live.
    expect(list.meta.options.title_path.path).toBeUndefined()
    expect(list.meta.options.body_path.path).toBeUndefined()
  })

  /**
   * The nested knobs `meta.options` could not name until it gained `path`. These had no admin
   * control at ALL before — unreachable from the editor, undiscoverable from the contract. Each
   * path is pinned individually against what `streamListConfig` reads and what
   * `hub/src/routes/admin.ts`'s `stream_list` branch accepts (`clamp`/`overflow`, both
   * `additionalProperties: false`): a typo here saves into a key nothing renders.
   */
  it('points the clamp and overflow knobs at the paths streamListConfig actually reads', () => {
    expect(list.meta.options.title_lines.path).toBe('clamp.title_lines')
    expect(list.meta.options.body_lines.path).toBe('clamp.body_lines')
    expect(list.meta.options.counter.path).toBe('overflow.counter')
  })

  // Unset must LOOK like what the panel draws: the generated field falls back to `default` when
  // nothing sits at the path, so a default disagreeing with the renderer's own would show the
  // operator a number the device is not using.
  it('defaults the clamp and overflow knobs to exactly what streamListConfig defaults them to', () => {
    const drawn = streamListConfig({})
    expect(list.meta.options.title_lines.default).toBe(drawn.titleLines)
    expect(list.meta.options.body_lines.default).toBe(drawn.bodyLines)
    expect(list.meta.options.counter.default).toBe(drawn.counter)
  })

  it('meta matches the widget/design ids the registry and definitions expect', () => {
    expect(list.meta.widget).toBe('stream_list')
    expect(list.meta.id).toBe('list')
  })
})

describe('normalizeStream — the three states', () => {
  it('rows === null (not stream-bound, or the feed is absent from the map) is "missing"', () => {
    expect(normalizeStream(null, null, {}, 0).state).toBe('missing')
  })

  it('rows === [] (a well-formed empty stream) is "empty", NOT "missing"', () => {
    expect(normalizeStream([], null, {}, 0).state).toBe('empty')
  })

  it('rows with entries is "ready"', () => {
    expect(normalizeStream([row({ title: 'x' })], null, {}, 0).state).toBe('ready')
  })
})

// THE RULE (docs/architecture/widgets.md, and this file's own docstring): LOUD when the binding is
// WRONG, QUIET when the binding is RIGHT but the feed is simply empty. `rows` alone can already
// distinguish "wrong" from "right but empty" for a well-formed wire (rowsForCell degrades a
// never-pushed stream to `[]` and a wrong-mode/unresolvable one to `null`), but `rows: null` also
// covers a malformed wire on an otherwise-correct binding — the case `ctx.feed` resolves. These
// tests exercise `ctx.feed` directly against `rows: null`, so the `ctx.feed` gate is pinned on its
// own rather than only incidentally through `rowsForCell`'s degradation.
describe('normalizeStream — ctx.feed resolves rows:null toward the right verdict', () => {
  it('a feed of the WRONG mode (value) with rows:null stays LOUD, even though it exists and was pushed', () => {
    const feed = streamFeed({ mode: 'value', pushed_at: 1_000 })
    expect(normalizeStream(null, feed, {}, 0).state).toBe('missing')
  })

  /**
   * The one case that actually exercises the `widgetAcceptsMode` gate rather than the `pushed_at`
   * check: a wrong-mode feed that ALSO happens to be never-pushed. Without the mode gate — i.e. if
   * "never pushed" alone were treated as quiet, the mistake this prevents — this would
   * wrongly go quiet too, hiding a value feed bound to a widget that can only ever read a stream.
   */
  it('a feed of the WRONG mode that has ALSO never been pushed stays LOUD, not quiet: the mode gate is what fixes this, not pushed_at alone', () => {
    const feed = streamFeed({ mode: 'value', pushed_at: null })
    expect(normalizeStream(null, feed, {}, 0).state).toBe('missing')
  })

  it('an UNRESOLVABLE feed (missing: true) with rows:null stays LOUD', () => {
    const feed = { missing: true, mode: null, pushed_at: null, image_rev: null }
    expect(normalizeStream(null, feed, {}, 0).state).toBe('missing')
  })

  it('no feed bound at all (ctx.feed === null) with rows:null stays LOUD', () => {
    expect(normalizeStream(null, null, {}, 0).state).toBe('missing')
  })

  it('a RIGHT-mode (stream) feed that has never been pushed, with rows:null, is QUIET — the fixed case', () => {
    const feed = streamFeed({ pushed_at: null })
    expect(normalizeStream(null, feed, {}, 0).state).toBe('empty')
  })

  it('a RIGHT-mode feed that HAS been pushed, with rows:null (a malformed wire), stays LOUD: pushed_at alone does not override a malformed row shape', () => {
    const feed = streamFeed({ pushed_at: 1_000 })
    expect(normalizeStream(null, feed, {}, 0).state).toBe('missing')
  })

  it('rows with entries is "ready" regardless of what ctx.feed says', () => {
    const feed = streamFeed({ pushed_at: null })
    expect(normalizeStream([row({ title: 'x' })], feed, {}, 0).state).toBe('ready')
  })
})

describe('normalizeStream — title_path fallback to compact JSON', () => {
  it('a title_path that resolves to undefined falls back to JSON.stringify(payload ?? null)', () => {
    const payload = { headline: 'no title field here' }
    const n = normalizeStream([row(payload)], null, { title_path: 'title' }, 0)
    expect(n.rows[0].title).toBe(JSON.stringify(payload))
  })

  it('a title_path that DOES resolve uses displayValue, not JSON', () => {
    const n = normalizeStream([row({ title: 'Hello' })], null, { title_path: 'title' }, 0)
    expect(n.rows[0].title).toBe('Hello')
  })

  it('a null payload with no title_path match falls back to "null"', () => {
    const n = normalizeStream([row(null)], null, { title_path: 'title' }, 0)
    expect(n.rows[0].title).toBe('null')
  })
})

describe('normalizeStream — per-row age', () => {
  it('computes ageMs from each row\'s own pushed_at against now', () => {
    const n = normalizeStream([row({ title: 'a' }, 1_000), row({ title: 'b' }, 4_000)], null, { title_path: 'title' }, 5_000)
    expect(n.rows[0].ageMs).toBe(4_000)
    expect(n.rows[1].ageMs).toBe(1_000)
  })

  it('a row with no numeric pushed_at gets ageMs: null (no age chip), not a crash', () => {
    const n = normalizeStream([row({ title: 'a' }, null)], null, { title_path: 'title' }, 5_000)
    expect(n.rows[0].ageMs).toBeNull()
  })
})

describe('normalizeStream — body_path is optional, per row', () => {
  it('bodyPath true only when config declares one', () => {
    expect(normalizeStream([row({ title: 'a' })], null, { title_path: 'title' }, 0).bodyPath).toBe(false)
    expect(normalizeStream([row({ title: 'a' })], null, { title_path: 'title', body_path: 'body' }, 0).bodyPath).toBe(true)
  })

  it('a row whose body_path does not resolve gets body: null, independent of other rows', () => {
    const n = normalizeStream(
      [row({ title: 'a', body: 'has one' }), row({ title: 'b' })],
      null, { title_path: 'title', body_path: 'body' }, 0,
    )
    expect(n.rows[0].body).toBe('has one')
    expect(n.rows[1].body).toBeNull()
  })
})

describe('normalizeStream — every streamListConfig knob carried over', () => {
  it('clamps scale into the shared 0.5-2 range', () => {
    expect(normalizeStream([], null, { scale: 9 }, 0).scale).toBe(2)
    expect(normalizeStream([], null, { scale: 0.1 }, 0).scale).toBe(0.5)
  })

  it('titleLines/bodyLines default to 1/2, same as streamListConfig', () => {
    const n = normalizeStream([], null, {}, 0)
    expect(n.titleLines).toBe(1)
    expect(n.bodyLines).toBe(2)
  })

  it('titleLines/bodyLines read from clamp.title_lines/clamp.body_lines', () => {
    const n = normalizeStream([], null, { clamp: { title_lines: 3, body_lines: 5 } }, 0)
    expect(n.titleLines).toBe(3)
    expect(n.bodyLines).toBe(5)
  })

  it('counter defaults true and reads overflow.counter', () => {
    expect(normalizeStream([], null, {}, 0).counter).toBe(true)
    expect(normalizeStream([], null, { overflow: { counter: false } }, 0).counter).toBe(false)
  })
})

describe('stream_list draw — the three states, rendered distinctly', () => {
  it('paints the loud "Feed missing" notice when ctx.rows is null', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: null }))
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(true)
    expect(calls.some((c) => /no rows yet/.test(c.text))).toBe(false)
  })

  it('paints the quiet "— no rows yet" line when ctx.rows is []', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: [] }))
    expect(calls.some((c) => c.text === '— no rows yet')).toBe(true)
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
  })

  /**
   * THE SIZE, not just the words — because the words alone did not catch the last regression.
   *
   * `quietLine` lives in the shared `text-fit.mjs`; each design suite pins its TEXT and its
   * `tokens.dim` COLOUR so a size regression in the helper cannot reach four widgets without a
   * design-level failure.
   *
   * `400 12px system-ui` at this box: `Math.min(16, box.w * 0.04) * scale` = `min(16, 300*0.04)` =
   * 12, at this design's own `n.scale` (1 by default). The second half is the part that is THIS
   * design's rather than the helper's: `stream_list` has a real `scale` knob and passes it through
   * (`quietLine(..., n.scale)`), so scale 2 doubles the quiet line to 24px. `image/frame.mjs`
   * deliberately passes a literal `1` on the same call and its suite pins the opposite — that
   * difference is real and neither suite flattens it.
   */
  it('paints the quiet line at the shared helper\'s size, and moves it with its own scale knob', () => {
    const unscaled = recorder()
    list.draw(unscaled.g, baseCtx({ rows: [] }))
    expect(unscaled.calls.find((c) => c.text === '— no rows yet')?.font).toBe('400 12px system-ui')

    const scaled = recorder()
    list.draw(scaled.g, baseCtx({
      rows: [], config: { feed: 'f', title_path: 'title', body_path: 'body', scale: 2 },
    }))
    expect(scaled.calls.find((c) => c.text === '— no rows yet')?.font).toBe('400 24px system-ui')
  })

  it('paints row cards when ctx.rows has entries, not either notice', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx())
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
    expect(calls.some((c) => /no rows yet/.test(c.text))).toBe(false)
    expect(calls.some((c) => c.text === 'First')).toBe(true)
  })

  it('tolerates ctx.rows being entirely absent (undefined), same as the portable-subset harness sends', () => {
    const { g, calls } = recorder()
    const ctx = baseCtx()
    delete (ctx as Record<string, unknown>).rows
    expect(() => list.draw(g, ctx)).not.toThrow()
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(true)
  })
})

/**
 * THE RULE, at draw level: LOUD when the binding is WRONG, QUIET when it is RIGHT but the feed is
 * empty — same distinction `table/grid.mjs`'s own draw-level suite pins for `ctx.feed`. `ctx.rows`
 * alone already gets the well-formed cases right; these pin `ctx.feed` as the tie-breaker for
 * `rows: null` so the fixed case (a malformed wire on an otherwise-correct stream binding) cannot
 * silently regress back to the loud notice.
 */
describe('stream_list draw — ctx.feed separates "wrong binding" from "right binding, empty feed"', () => {
  it('a feed of the wrong mode (value) stays LOUD, with rows: null', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: null, feed: streamFeed({ mode: 'value', pushed_at: 1_000 }) }))
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(true)
    expect(calls.some((c) => /no rows yet/.test(c.text))).toBe(false)
  })

  it('an unresolvable feed (missing: true) stays LOUD, with rows: null', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: null, feed: { missing: true, mode: null, pushed_at: null, image_rev: null } }))
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(true)
  })

  it('no feed bound at all stays LOUD, with rows: null', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: null, feed: null }))
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(true)
  })

  it('a right-mode (stream) feed nobody has pushed to is QUIET, even when rows comes back null — the fixed case', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: null, feed: streamFeed({ pushed_at: null }) }))
    expect(calls.some((c) => c.text === '— no rows yet')).toBe(true)
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
  })

  it('rows with entries still draws cards, regardless of ctx.feed', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ feed: streamFeed({ pushed_at: null }) }))
    expect(calls.some((c) => c.text === 'First')).toBe(true)
    expect(calls.some((c) => c.text === 'Feed missing')).toBe(false)
    expect(calls.some((c) => /no rows yet/.test(c.text))).toBe(false)
  })
})

describe('stream_list draw — per-row age chip', () => {
  it('draws formatAge(pushed_at vs ctx.now) for a row with a numeric pushed_at', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: [row({ title: 'a' }, 1_000)], now: 61_000 }))
    expect(calls.some((c) => c.text === formatAge(60_000))).toBe(true)
  })

  it('draws no age chip for a row with pushed_at: null', () => {
    const { g, calls } = recorder()
    list.draw(g, baseCtx({ rows: [row({ title: 'a' }, null)], now: 61_000 }))
    expect(calls.some((c) => /ago|now/.test(c.text))).toBe(false)
  })
})

describe('stream_list draw — overflow (cardPlan) and the negative-visible guard', () => {
  it('shows every row when they all fit', () => {
    const { g, calls } = recorder()
    const rows = [row({ title: 'a' }, 0), row({ title: 'b' }, 0)]
    list.draw(g, baseCtx({ rows, config: { title_path: 'title' }, box: { w: 300, h: 300, t: 1 } }))
    expect(calls.some((c) => c.text === 'a')).toBe(true)
    expect(calls.some((c) => c.text === 'b')).toBe(true)
    expect(calls.some((c) => /and \d+ more/.test(c.text))).toBe(false)
  })

  it('reports "and N more" once rows overflow the cell, with the counter reserved before fit', () => {
    const { g, calls } = recorder()
    // STREAM_CARD_TITLE is 48px/row; a 100px cell with 5 rows and the counter on fits fewer than 5.
    const rows = Array.from({ length: 5 }, (_, i) => row({ title: `row${i}` }, 0))
    list.draw(g, baseCtx({ rows, config: { title_path: 'title' }, box: { w: 300, h: 100, t: 1 } }))
    expect(calls.some((c) => /and \d+ more/.test(c.text))).toBe(true)
  })

  it('draws nothing but the notice-free empty body — never all-but-the-last-row — on a cell too small for even one card', () => {
    const { g, calls } = recorder()
    const rows = [row({ title: 'only' }, 0)]
    // `plan.visible` can go negative here (contract) once cardHeight exceeds cellHeight and
    // the no-counter branch runs. A `slice(0, plan.visible)` bug would render the row anyway.
    list.draw(g, baseCtx({
      rows, config: { title_path: 'title', overflow: { counter: false } }, box: { w: 300, h: 1, t: 1 },
    }))
    expect(calls.some((c) => c.text === 'only')).toBe(false)
  })

  it('does not throw and paints nothing for a negative-visible plan with the counter on', () => {
    const { g, calls } = recorder()
    const rows = [row({ title: 'only' }, 0)]
    expect(() => list.draw(g, baseCtx({
      rows, config: { title_path: 'title' }, box: { w: 300, h: 1, t: 1 },
    }))).not.toThrow()
    expect(calls.some((c) => c.text === 'only')).toBe(false)
  })
})

describe('stream_list draw — scale moves TEXT ONLY (contract)', () => {
  it('the same number of rows fit regardless of scale — the card height constants are not scaled', () => {
    // A cell exactly two STREAM_CARD_TITLE cards tall: scale must not change how many rows fit.
    const box = { w: 300, h: STREAM_CARD_TITLE * 2, t: 1 }
    const rows = [row({ title: 'a' }, 0), row({ title: 'b' }, 0), row({ title: 'c' }, 0)]
    const cfg = { title_path: 'title' }

    const small = recorder()
    list.draw(small.g, baseCtx({ rows, config: { ...cfg, scale: 0.5 }, box }))
    const big = recorder()
    list.draw(big.g, baseCtx({ rows, config: { ...cfg, scale: 2 }, box }))

    const visibleTexts = (calls: Call[]) => ['a', 'b', 'c'].filter((t) => calls.some((c) => c.text === t))
    expect(visibleTexts(small.calls)).toEqual(visibleTexts(big.calls))
    // Two STREAM_CARD_TITLE cards fit by raw height, but the default counter reserves FEED_COUNTER
    // (28px) of that budget first — floor((96-28)/48) = 1 row visible, "and 2 more" for the rest.
    expect(visibleTexts(big.calls).length).toBe(1)
  })

  it('bumps the title/body font size with scale, unlike the fixed-size age caption', () => {
    const smallFonts: string[] = []
    const bigFonts: string[] = []
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
    list.draw(track(smallFonts), baseCtx({ config: { title_path: 'title', body_path: 'body', scale: 0.5 } }))
    list.draw(track(bigFonts), baseCtx({ config: { title_path: 'title', body_path: 'body', scale: 2 } }))
    // scale 2 must produce at least one larger title font than scale 0.5 produced.
    const maxPx = (fonts: string[]) => Math.max(...fonts.map((f) => parseInt(f.split(' ')[1], 10)).filter((n) => !Number.isNaN(n)))
    expect(maxPx(bigFonts)).toBeGreaterThan(maxPx(smallFonts))
  })
})

describe('stream_list draw — staleness dims the whole card (ctx.stale)', () => {
  it('applies reduced alpha while painting a stale row and restores it after', () => {
    const alphaAtFillText: number[] = []
    const g: any = { font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1 }
    g.fillText = () => alphaAtFillText.push(g.globalAlpha)
    g.measureText = (value: string) => ({ width: Array.from(String(value)).length * 8 })
    list.draw(g, baseCtx({ stale: true }))
    expect(alphaAtFillText.some((a) => a < 1)).toBe(true)
    expect(g.globalAlpha).toBe(1) // reset after the last row
  })
})
