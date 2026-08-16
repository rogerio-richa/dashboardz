import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import * as widgetRuntime from '../static/device/widgets/index.mjs'
// @ts-expect-error plain JS module without types
import { register, registered } from '../static/device/widgets/registry.mjs'
// @ts-expect-error plain JS module without types
import { BUILTIN_BOARD } from '../static/device/theme.mjs'
// @ts-expect-error plain JS module without types
import { activeCount, _setRaf, _reset } from '../static/device/widgets/loop.mjs'
// @ts-expect-error plain JS module without types
import { loadBitmapFor, resetBitmaps } from '../static/device/widgets/bitmaps.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'

const { designFor, keysToStop, paintWidgets, stopAllWidgets } = widgetRuntime
const dataForCell = (widgetRuntime as unknown as {
  dataForCell?: (cell: unknown, feeds?: unknown) => unknown
}).dataForCell

/*
 * A NOTE ON `let received = null as Record<string, unknown> | null`, which appears throughout.
 * The recorder design assigns that variable from inside a callback, which control flow analysis
 * cannot see, so the plainer `let received: Record<string, unknown> | null = null` narrows it to
 * `null` at the declaration and every `received?.field` read below becomes a property access on
 * `never`. The `as` keeps the declared union in view. The value assigned is still `null`.
 */

const VALUE = { location: { name: 'Lisbon' }, days: [{ high: 24, low: 15 }] }
const VALUE_WIRE = {
  mode: 'value', payload: VALUE, pushed_at: 1_775_000_000_000, stale_after_s: 2_700,
}
const STREAM_ROWS = [{ id: 'second', title: 'New' }, { id: 'first', title: 'Old' }]
const STREAM_WIRE = {
  mode: 'stream',
  rows: STREAM_ROWS.map((payload, i) => ({ payload, pushed_at: 1_775_000_000_000 - i })),
  pushed_at: 1_775_000_000_000,
  stale_after_s: 2_700,
}

describe('semantic cell data adapter', () => {
  it('returns the exact value payload selected by the cell feed binding', () => {
    const feeds = {
      selected: { ...VALUE_WIRE, credentials: { token: 'never-crosses' }, source: { id: 'src_private' } },
      unrelated: { mode: 'value', payload: { private: true }, admin: { owner: 'root' } },
    }

    expect(dataForCell).toBeTypeOf('function')
    expect(dataForCell?.({ widget: 'weather_forecast', config: { feed: 'selected' } }, feeds)).toBe(VALUE)
  })

  it('returns stream row payloads in wire order without row metadata', () => {
    expect(dataForCell).toBeTypeOf('function')
    const data = dataForCell?.({ widget: 'news_list', config: { feed: 'news' } }, { news: STREAM_WIRE })
    expect(data).toEqual(STREAM_ROWS)
    expect(data).not.toBe(STREAM_WIRE.rows)
  })

  it('returns null when the cell has no usable feed binding or the feed is missing', () => {
    expect(dataForCell).toBeTypeOf('function')
    expect(dataForCell?.({ widget: 'weather_forecast', config: {} }, { selected: VALUE_WIRE })).toBeNull()
    expect(dataForCell?.({ widget: 'weather_forecast', config: { feed: 'missing' } }, { selected: VALUE_WIRE })).toBeNull()
    expect(dataForCell?.(null, { selected: VALUE_WIRE })).toBeNull()
  })

  it('returns null for an empty feed id even when the map owns an empty key', () => {
    expect(dataForCell?.({ widget: 'weather_forecast', config: { feed: '' } }, { '': VALUE_WIRE })).toBeNull()
  })

  it('returns null for an own but undefined value payload', () => {
    expect(dataForCell?.(
      { widget: 'weather_forecast', config: { feed: 'selected' } },
      { selected: { mode: 'value', payload: undefined } },
    )).toBeNull()
  })

  it('returns null when any stream row owns an undefined payload', () => {
    expect(dataForCell?.(
      { widget: 'news_list', config: { feed: 'selected' } },
      { selected: { mode: 'stream', rows: [{ payload: STREAM_ROWS[0] }, { payload: undefined }] } },
    )).toBeNull()
  })

  it('preserves legitimate falsey value and stream payloads', () => {
    const cell = { widget: 'weather_forecast', config: { feed: 'selected' } }
    for (const payload of [0, false, '', null])
      expect(dataForCell?.(cell, { selected: { mode: 'value', payload } })).toBe(payload)
    expect(dataForCell?.(cell, {
      selected: { mode: 'stream', rows: [0, false, '', null].map((payload) => ({ payload })) },
    })).toEqual([0, false, '', null])
  })

  it('returns null for malformed wire feeds instead of leaking or throwing', () => {
    expect(dataForCell).toBeTypeOf('function')
    const cell = { widget: 'news_list', config: { feed: 'selected' } }
    const inherited = Object.create({ mode: 'value', payload: { leaked: true } })
    for (const selected of [null, [], { mode: 'image', image_rev: 2 }, { mode: 'value' },
      { mode: 'stream' }, { mode: 'stream', rows: {} },
      { mode: 'stream', rows: [null] }, { mode: 'stream', rows: [{}] }, inherited]) {
      expect(dataForCell?.(cell, { selected })).toBeNull()
    }
  })

  it('uses own feed bindings and map entries so prototype names cannot select data', () => {
    expect(dataForCell).toBeTypeOf('function')
    const inheritedMap = Object.create({ selected: VALUE_WIRE })
    const inheritedConfig = Object.create({ feed: 'selected' })
    expect(dataForCell?.({ widget: 'weather_forecast', config: { feed: 'constructor' } }, {})).toBeNull()
    expect(dataForCell?.({ widget: 'weather_forecast', config: { feed: 'selected' } }, inheritedMap)).toBeNull()
    expect(dataForCell?.({ widget: 'weather_forecast', config: inheritedConfig }, { selected: VALUE_WIRE })).toBeNull()
  })

  it('returns null when feeds is omitted, preserving existing direct paint callers', () => {
    expect(dataForCell).toBeTypeOf('function')
    expect(dataForCell?.({ widget: 'clock', config: {} })).toBeNull()
  })
})

describe('widget wiring', () => {
  it('resolves a clock cell with no design to the digital default', () => {
    expect(designFor({ widget: 'clock', config: {} }).meta.id).toBe('digital')
  })

  it('resolves a named design from cell config', () => {
    expect(designFor({ widget: 'clock', config: { design: 'analog' } }).meta.id).toBe('analog')
  })

  /**
   * The stand-in id cannot name a shipped design, so the fallback assertion proves its own premise
   * rather than depending on the current set of clock designs.
   */
  const ABSENT = '__no_such_design__'

  it('falls back to digital for a design this build does not have', () => {
    expect(registered('clock').map((d: { meta: { id: string } }) => d.meta.id)).not.toContain(ABSENT)
    expect(designFor({ widget: 'clock', config: { design: ABSENT } }).meta.id).toBe('digital')
  })

  /*
   * This fixture covers a widget type the build has never heard of.
   *
   * It named whichever widget type happened to still be DOM-rendered — `table`, then `image`, then
   * `chart`; every widget type in the catalogue has a design and no real widget can stand here.
   *
   * The branch it pins is still live and still worth pinning, just for a different input: a cell
   * naming a widget type this build has never heard of (a board saved by a newer hub, a hand-edited
   * row). `designFor` must return null for it so `widgetHtml` reaches its "Unsupported widget"
   * placeholder rather than emitting a canvas nothing will ever paint. That input cannot be
   * migrated out from under this test.
   */
  it('returns null for a widget type this build has no designs for at all', () => {
    const definitions = registered('__no_such_widget__')
    expect(definitions).toEqual([])
    expect(designFor({ widget: '__no_such_widget__', config: {} })).toBe(null)
  })

  it('has a design for every widget type the definitions catalogue ships', () => {
    // Every catalogue widget must have a registered design.
    for (const definition of WIDGET_DEFINITIONS as { id: string }[])
      expect(registered(definition.id).length, definition.id).toBeGreaterThan(0)
  })

  it('tolerates a cell with no config object at all', () => {
    expect(designFor({ widget: 'clock' }).meta.id).toBe('digital')
  })

  // Was asserted against widgets/index.mjs's BUILTIN_PALETTE, a five-key copy of the same values
  // that had no importer outside this test once paintWidgets started taking the board as a
  // parameter (edge case — the constant is gone). Retargeted at the REAL board block every
  // caller now passes rather than deleted: the claim it makes, that a themeless board still paints
  // today's colours, is still worth pinning, and pinning it on the object production actually uses
  // is strictly stronger than pinning a fixture that could drift from it.
  it('reproduces today’s palette so the port is a visual no-op', () => {
    expect(BUILTIN_BOARD.bg).toBe('#0b0d12')
    expect(BUILTIN_BOARD.surface).toBe('#12141c')
    expect(BUILTIN_BOARD.ink).toBe('#e6e9f0')
    expect(BUILTIN_BOARD.dim).toBe('#8a90a0')
  })
})

describe('keysToStop (animation sweep)', () => {
  it('stops a key whose cell disappeared from the board entirely', () => {
    expect(keysToStop(['cell0', 'cell1'], ['cell0'])).toEqual(['cell1'])
  })

  it('stops a key whose cell changed to a widget with no canvas design', () => {
    // Same shape as "disappeared" from paintWidgets' point of view: the canvas element for that
    // index is simply absent from this render's DOM, so the key never gets touched.
    expect(keysToStop(['cell0'], [])).toEqual(['cell0'])
  })

  it('stops every trailing key when the cell count shrinks', () => {
    expect(keysToStop(['cell0', 'cell1', 'cell2'], ['cell0'])).toEqual(['cell1', 'cell2'])
  })

  it('stops nothing in the steady state where nothing changed', () => {
    expect(keysToStop(['cell0', 'cell1'], ['cell0', 'cell1'])).toEqual([])
  })

  it('stops nothing when a new cell is added and none removed', () => {
    expect(keysToStop(['cell0'], ['cell0', 'cell1'])).toEqual([])
  })
})

/**
 * The load-bearing invariant of this lane, driven through the REAL paintWidgets, the REAL board
 * loop and the REAL segment design — the only three parts that together decide whether a kiosk
 * burns a frame every 16ms for weeks (animation contract: "a calm board produces zero
 * frames beyond the existing 1s tick").
 *
 * paintWidgets' single DOM dependency is `document.querySelectorAll`, stubbed here with the list
 * of canvases a render would have produced. Everything downstream of that — which designs get
 * registered, what they draw, when the loop idles — is production code.
 */
function fakeCanvas(idx: number) {
  const g: Record<string, unknown> = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    lineWidth: 1, lineCap: '', shadowBlur: 0, shadowColor: '',
    setTransform: () => {}, clearRect: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, rotate: () => {}, scale: () => {}, beginPath: () => {},
    closePath: () => {}, fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => {}, rect: () => {}, ellipse: () => {}, fillRect: () => {}, roundRect: () => {},
    fillText: () => {}, measureText: (s: string) => ({ width: s.length * 10 }),
  }
  return { width: 0, height: 0, style: {} as Record<string, string>, dataset: { cell: String(idx) }, getContext: () => g }
}

const semanticBox = (idx: number) => ({
  rect: { x: idx / 2, y: 0, w: 0.5, h: 0.5 },
  px: { left: idx * 240, top: 0, width: 240, height: 160 },
  t: 0.625,
})

function registerSemanticDesign(
  draw: (g: unknown, ctx: Record<string, unknown>, elapsed: number) => void,
  widget = 'weather_forecast',
) {
  register({
    meta: {
      id: 'task-11-test', widget, label: 'Task 11 test', suggested_ratio: 1.5,
      tokens: {}, animations: { transition: [], persistent: [] }, default: true,
    },
    draw,
  })
}

/**
 * Builds and returns the exact draw context `paintWidgets` would hand a design for one cell,
 * self-contained (own document stub, own cleanup) so it can be called from any `it` without a
 * surrounding `beforeEach`/`afterEach` pair. Registers a recorder design under the cell's own
 * widget type (`registerSemanticDesign`'s `default: true` wins it over any real design already
 * registered for that widget by index.mjs's catalogue loop) so the ctx it captures is the one
 * production paints with, not a hand-built stand-in.
 */
function drawContextFor(
  cell: { widget: string; config: Record<string, unknown> },
  feeds: Record<string, unknown> = {},
  opts: { board?: Record<string, unknown> } = {},
): Record<string, unknown> {
  let received = null as Record<string, unknown> | null
  registerSemanticDesign((_g, ctx) => { received = ctx }, cell.widget)
  const canvases = [fakeCanvas(0)]
  ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => canvases }
  try {
    paintWidgets([cell], [semanticBox(0)], opts.board ?? BUILTIN_BOARD, () => AT_REST, {}, feeds)
  } finally {
    stopAllWidgets()
    delete (globalThis as Record<string, unknown>).document
  }
  return received as unknown as Record<string, unknown>
}

describe('portable semantic draw context', () => {
  let canvases: ReturnType<typeof fakeCanvas>[] = []

  beforeEach(() => {
    _reset()
    canvases = []
    ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => canvases }
  })

  afterEach(() => {
    stopAllWidgets()
    delete (globalThis as Record<string, unknown>).document
  })

  it('hands a design only its exact normalized data and unchanged config', () => {
    let received = null as Record<string, unknown> | null
    registerSemanticDesign((_g, ctx) => { received = ctx })
    const config = { feed: 'selected', days: 5, show_precipitation: true }
    const wrapper = {
      ...VALUE_WIRE,
      credentials: { api_key: 'secret' },
      source: { id: 'src_private', provider_id: 'dashboardz.open-meteo' },
      admin: { created_by: 'operator' },
    }
    const feeds = { selected: wrapper, unrelated: { mode: 'value', payload: { private: true } } }
    canvases = [fakeCanvas(0)]

    paintWidgets(
      [{ widget: 'weather_forecast', config }], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, feeds,
    )

    expect(received).not.toBeNull()
    expect(received?.data).toBe(VALUE)
    expect(received?.config).toBe(config)
    expect(received?.box).toEqual({ w: 240, h: 160, t: 0.625 })
    expect(received).not.toHaveProperty('feeds')
    expect(received).not.toHaveProperty('credentials')
    expect(received).not.toHaveProperty('source')
    expect(received).not.toHaveProperty('admin')
  })

  it('keeps omitted feeds equivalent to the old null-data draw context', () => {
    let received = null as Record<string, unknown> | null
    registerSemanticDesign((_g, ctx) => { received = ctx })
    canvases = [fakeCanvas(0)]

    paintWidgets(
      [{ widget: 'weather_forecast', config: { days: 5 } }], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST,
    )

    expect(received?.data).toBeNull()
    expect(activeCount()).toBe(0)
  })

  it('isolates a throwing cell and still supplies normalized data to the next design', () => {
    const received: unknown[] = []
    registerSemanticDesign((_g, ctx) => {
      if ((ctx.config as { broken?: boolean }).broken) throw new Error('bad cell')
      received.push(ctx.data)
    })
    const first = { widget: 'weather_forecast', config: { feed: 'bad', broken: true } }
    const second = { widget: 'weather_forecast', config: { feed: 'good' } }
    canvases = [fakeCanvas(0), fakeCanvas(1)]
    const originalError = console.error
    console.error = () => {}
    try {
      paintWidgets(
        [first, second], [semanticBox(0), semanticBox(1)], BUILTIN_BOARD, () => AT_REST, {},
        { bad: VALUE_WIRE, good: STREAM_WIRE },
      )
    } finally {
      console.error = originalError
    }

    expect(received).toEqual([STREAM_ROWS])
    expect(activeCount()).toBe(0)
  })

  /**
   * `ctx.stale`/`ctx.age_ms` (widget contract): the draw-contract twin of
   * the DOM renderer's own `isStale(wire, hubNow())` + age chip, computed once here so every design
   * agrees with it rather than each reimplementing the rule. `text/block.mjs`, value_tile, and gauge
   * read the same two fields.
   */
  describe('ctx.stale / ctx.age_ms', () => {
    it('is false/null for a cell that binds no feed at all — nothing to be stale about', () => {
      let received = null as Record<string, unknown> | null
      registerSemanticDesign((_g, ctx) => { received = ctx })
      canvases = [fakeCanvas(0)]

      paintWidgets(
        [{ widget: 'weather_forecast', config: { days: 5 } }], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, {},
      )

      expect(received?.stale).toBe(false)
      expect(received?.age_ms).toBeNull()
    })

    it('is false with the elapsed age for a feed still inside its stale_after_s window', () => {
      let received = null as Record<string, unknown> | null
      registerSemanticDesign((_g, ctx) => { received = ctx })
      canvases = [fakeCanvas(0)]
      const now = VALUE_WIRE.pushed_at + 5_000 // stale_after_s is 2_700s — nowhere close

      paintWidgets(
        [{ widget: 'weather_forecast', config: { feed: 'selected' } }], [semanticBox(0)], BUILTIN_BOARD,
        () => now, {}, { selected: VALUE_WIRE },
      )

      expect(received?.stale).toBe(false)
      expect(received?.age_ms).toBe(5_000)
    })

    it('is true with the elapsed age once a bound feed passes its stale_after_s window', () => {
      let received = null as Record<string, unknown> | null
      registerSemanticDesign((_g, ctx) => { received = ctx })
      canvases = [fakeCanvas(0)]
      const elapsed = VALUE_WIRE.stale_after_s * 1000 + 1_000
      const now = VALUE_WIRE.pushed_at + elapsed

      paintWidgets(
        [{ widget: 'weather_forecast', config: { feed: 'selected' } }], [semanticBox(0)], BUILTIN_BOARD,
        () => now, {}, { selected: VALUE_WIRE },
      )

      expect(received?.stale).toBe(true)
      expect(received?.age_ms).toBe(elapsed)
    })

    /**
     * "never-pushed is quiet, not stale" (device.js:282-284's own words for the DOM
     * age chip) is a deliberate product rule, not an oversight — a bound feed that has not actually
     * been written to yet must render exactly like no feed at all, not like a fresh one. Pinned here
     * so a future change to `feedForCell`/the stale computation cannot silently start treating a
     * never-pushed feed as having an age of 0 (or NaN) instead of "unknown".
     */
    it('is false/null for a bound feed that has never actually been pushed to (no pushed_at)', () => {
      let received = null as Record<string, unknown> | null
      registerSemanticDesign((_g, ctx) => { received = ctx })
      canvases = [fakeCanvas(0)]
      const neverPushed = { mode: 'value', payload: VALUE, stale_after_s: 2_700 } // no pushed_at at all

      paintWidgets(
        [{ widget: 'weather_forecast', config: { feed: 'selected' } }], [semanticBox(0)], BUILTIN_BOARD,
        () => AT_REST, {}, { selected: neverPushed },
      )

      expect(received?.stale).toBe(false)
      expect(received?.age_ms).toBeNull()
    })

    it('is false/null for a bound feed whose pushed_at is malformed (not a number)', () => {
      let received = null as Record<string, unknown> | null
      registerSemanticDesign((_g, ctx) => { received = ctx })
      canvases = [fakeCanvas(0)]
      const malformed = { mode: 'value', payload: VALUE, pushed_at: 'yesterday', stale_after_s: 2_700 }

      paintWidgets(
        [{ widget: 'weather_forecast', config: { feed: 'selected' } }], [semanticBox(0)], BUILTIN_BOARD,
        () => AT_REST, {}, { selected: malformed },
      )

      expect(received?.stale).toBe(false)
      expect(received?.age_ms).toBeNull()
    })
  })
})

/**
 * `ctx.alerts` / `ctx.rows`: two additive draw-context channels neither of which
 * can be `ctx.data`. Alerts arrive by `ALERT_ADD` and live in the device's own state — there is no
 * feed id to bind, so routing them through `ctx.data` would make the contract claim something
 * false. Stream rows exist because `ctx.data`'s stream shape (bare payloads, newest first) is what
 * `news/list.mjs` already consumes and every future stream design will expect — changing it to
 * carry wire metadata would be a breaking change to a contract about to be frozen, so the
 * timestamps `stream_list`'s per-row age chips need travel on a second, additive channel instead.
 */
describe('ctx.alerts / ctx.rows', () => {
  let canvases: ReturnType<typeof fakeCanvas>[] = []

  beforeEach(() => {
    _reset()
    canvases = []
    ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => canvases }
  })
  afterEach(() => {
    stopAllWidgets()
    delete (globalThis as Record<string, unknown>).document
  })

  it('hands every design the live alert list, newest first', () => {
    let received = null as Record<string, unknown> | null
    registerSemanticDesign((_g, ctx) => { received = ctx })
    canvases = [fakeCanvas(0)]
    const alerts = [{ id: 'a2', title: 'newer' }, { id: 'a1', title: 'older' }]
    paintWidgets([{ widget: 'weather_forecast', config: {} }], [semanticBox(0)],
      BUILTIN_BOARD, () => AT_REST, {}, {}, undefined, alerts)
    expect(received?.alerts).toEqual(alerts)
  })

  it('defaults alerts to an empty array rather than undefined', () => {
    let received = null as Record<string, unknown> | null
    registerSemanticDesign((_g, ctx) => { received = ctx })
    canvases = [fakeCanvas(0)]
    paintWidgets([{ widget: 'weather_forecast', config: {} }], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST)
    expect(received?.alerts).toEqual([])
  })

  it('exposes stream rows with their wire timestamps, which ctx.data strips', () => {
    let received = null as Record<string, unknown> | null
    // Registered under news_list itself (registerSemanticDesign's own widget param, `default: true`)
    // so this design — not the real news/list.mjs — is what paints the cell below.
    registerSemanticDesign((_g, ctx) => { received = ctx }, 'news_list')
    canvases = [fakeCanvas(0)]
    paintWidgets([{ widget: 'news_list', config: { feed: 'news' } }], [semanticBox(0)],
      BUILTIN_BOARD, () => AT_REST, {}, { news: STREAM_WIRE })
    expect(received?.rows).toEqual(STREAM_WIRE.rows.map((r) => ({ payload: r.payload, pushed_at: r.pushed_at })))
    // ctx.data keeps the shape news_list already consumes.
    expect(received?.data).toEqual(STREAM_ROWS)
  })

  /**
   * The whole point of a separate `ctx.rows` channel is that `null` means
   * "not stream-bound" and `[]` means "a stream with nothing in it" — `stream_list` (stream data channel)
   * branches on exactly that to tell an empty feed ("— no rows yet") from a missing one (the loud
   * "feed missing" box). The null-cases test below covers "not stream-bound"; this pins the other
   * end, and the non-empty case alongside it so the pair pins both edges, not just the empty one.
   */
  it('gives rows [] for a well-formed stream feed with no rows, and the full length when it has some', () => {
    const seen: unknown[] = []
    registerSemanticDesign((_g, ctx) => { seen.push(ctx.rows) }, 'news_list')
    canvases = [fakeCanvas(0)]
    const empty = { mode: 'stream', rows: [], pushed_at: STREAM_WIRE.pushed_at, stale_after_s: 2_700 }

    paintWidgets([{ widget: 'news_list', config: { feed: 'news' } }], [semanticBox(0)],
      BUILTIN_BOARD, () => AT_REST, {}, { news: empty })
    paintWidgets([{ widget: 'news_list', config: { feed: 'news' } }], [semanticBox(0)],
      BUILTIN_BOARD, () => AT_REST, {}, { news: STREAM_WIRE })

    expect(seen[0]).toEqual([])
    expect(seen[0]).not.toBeNull()
    expect((seen[1] as unknown[]).length).toBe(STREAM_WIRE.rows.length)
  })

  it('gives rows null for a value feed, an unbound cell and a malformed wire', () => {
    const seen: unknown[] = []
    // Two of the three cells below are weather_forecast, one is news_list — register the recorder
    // under both so every iteration is actually painted by it rather than a real design.
    registerSemanticDesign((_g, ctx) => { seen.push(ctx.rows) })
    registerSemanticDesign((_g, ctx) => { seen.push(ctx.rows) }, 'news_list')
    canvases = [fakeCanvas(0)]
    for (const [cell, feeds] of [
      [{ widget: 'weather_forecast', config: { feed: 'v' } }, { v: VALUE_WIRE }],
      [{ widget: 'weather_forecast', config: {} }, {}],
      [{ widget: 'news_list', config: { feed: 'bad' } }, { bad: { mode: 'stream', rows: 'nope' } }],
    ] as const) {
      paintWidgets([cell], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, feeds)
    }
    expect(seen).toEqual([null, null, null])
  })
})

/**
 * `ctx.series`: the multi-feed draw-context channel a `chart` design needs to
 * reach its per-series feeds — every OTHER channel here is single-feed, but a chart binds up to
 * four via `chartConfig(config).series`. Positional and never-compacted (see the entries below):
 * `chartAllSeriesMissing` needs to tell "this series' feed does not exist" from "it exists and is
 * empty", and the legend must keep a slot — and its colour — for a series whose feed vanished.
 */
describe('ctx.series', () => {
  it('is null for a widget that declares no series', () => {
    const ctx = drawContextFor({ widget: 'value_tile', config: { feed: 'f', path: 'v' } })
    expect(ctx.series).toBeNull()
  })

  it('carries one entry per configured series, in order', () => {
    const feeds = {
      a: { mode: 'stream', rows: [{ payload: { v: 1 }, pushed_at: 10 }] },
      b: { mode: 'stream', rows: [{ payload: { v: 2 }, pushed_at: 20 }] },
    }
    const ctx = drawContextFor({
      widget: 'chart',
      config: { style: 'line', series: [{ feed: 'a', y_path: 'v', icon: 'circle' }, { feed: 'b', y_path: 'v', icon: 'square' }] },
    }, feeds)
    const series = ctx.series as Array<{ feed: string; rows: Array<{ payload: unknown; pushed_at: number | null }> }>
    expect(series).toHaveLength(2)
    expect(series[0].feed).toBe('a')
    expect(series[0].rows[0].payload).toEqual({ v: 1 })
    expect(series[1].rows[0].pushed_at).toBe(20)
  })

  it('marks a series whose feed is absent as missing, WITHOUT dropping it', () => {
    const feeds = { a: { mode: 'stream', rows: [] } }
    const ctx = drawContextFor({
      widget: 'chart',
      config: { style: 'line', series: [{ feed: 'a', y_path: 'v', icon: 'circle' }, { feed: 'gone', y_path: 'v', icon: 'square' }] },
    }, feeds)
    // Position preserved: dropping entry 1 would shift the colour ramp under entry 0.
    const series = ctx.series as Array<{ missing: boolean; rows: unknown[] }>
    expect(series).toHaveLength(2)
    expect(series[0].missing).toBe(false)
    expect(series[1].missing).toBe(true)
    expect(series[1].rows).toEqual([])
  })

  it('an empty-but-present feed is NOT missing — the distinction the channel exists for', () => {
    const ctx = drawContextFor({
      widget: 'chart',
      config: { style: 'line', series: [{ feed: 'a', y_path: 'v', icon: 'circle' }] },
    }, { a: { mode: 'stream', rows: [] } })
    const series = ctx.series as Array<{ missing: boolean; rows: unknown[] }>
    expect(series[0].missing).toBe(false)
    expect(series[0].rows).toEqual([])
  })
})

/**
 * `ctx.stale`/`ctx.age_ms` for a cell that binds PER SERIES.
 *
 * A chart has no `config.feed`, so `feedForCell` finds nothing for it and the single-feed rule would
 * report EVERY chart on every board as permanently fresh — losing both the dimmed plot and the
 * corner age chip `drawChart` has always drawn. `seriesStaleFor` supplies the aggregate instead,
 * through the already-vectored `chartIsStale`/`chartStaleAgeMs`, so the rule keeps its one home.
 *
 * The age half is deliberately STALE-GATED, unlike every other widget's: `drawChart` drew its chip
 * only when something was stale, and `null` is how "draw no chip" arrives.
 */
describe('ctx.stale / ctx.age_ms for a per-series binding', () => {
  const fresh = { mode: 'stream', rows: [], pushed_at: AT_REST - 1_000, stale_after_s: 600 }
  const stale = { mode: 'stream', rows: [], pushed_at: AT_REST - 60_000, stale_after_s: 5 }
  const staler = { mode: 'stream', rows: [], pushed_at: AT_REST - 900_000, stale_after_s: 5 }
  const chart = (feeds: string[]) => ({
    widget: 'chart',
    config: { style: 'line', series: feeds.map((feed) => ({ feed, y_path: 'v', icon: 'circle' })) },
  })

  it('is not stale, and shows no age, while every series is fresh', () => {
    const ctx = drawContextFor(chart(['a', 'b']), { a: fresh, b: fresh })
    expect(ctx.stale).toBe(false)
    expect(ctx.age_ms).toBeNull()
  })

  it('one stale series is enough to flag the whole chart', () => {
    const ctx = drawContextFor(chart(['a', 'b']), { a: fresh, b: stale })
    expect(ctx.stale).toBe(true)
    expect(ctx.age_ms).toBe(60_000)
  })

  it('the age is the STALEST stale series, not simply the oldest reading', () => {
    const ctx = drawContextFor(chart(['a', 'b', 'c']), { a: fresh, b: stale, c: staler })
    expect(ctx.age_ms).toBe(900_000)
  })

  it('a series whose feed is gone votes neither way', () => {
    const ctx = drawContextFor(chart(['a', 'gone']), { a: fresh })
    expect(ctx.stale).toBe(false)
    expect(ctx.age_ms).toBeNull()
  })

  it('leaves a single-feed cell on the single-feed rule, age and all', () => {
    // The regression guard for the branch itself: `age_ms` here must stay non-null for a FRESH feed
    // (the documented rule), which is the opposite of the chart's stale-gated answer above. Same
    // wire shape as the chart's `fresh`, so the only difference under test is how it is bound.
    const ctx = drawContextFor({ widget: 'news_list', config: { feed: 'news' } }, { news: fresh })
    expect(ctx.stale).toBe(false)
    expect(ctx.age_ms).toBe(1_000)
  })

  /**
   * THE TRIPWIRE FOR THE ONE THING THIS BRANCH GETS WRONG IF IT EVER HAS A SECOND USER.
   *
   * `seriesStaleFor` keys off the CONFIG SHAPE — `Array.isArray(cell.config.series)` — not off
   * `cell.widget === 'chart'`, deliberately: a `widget ===` branch on the paint path is the exact
   * thing this renderer removed from `device.js`. The cost is that any FUTURE widget declaring a
   * `series` array silently inherits the chart's stale-gated `age_ms`, which contradicts the rule
   * documented for that field everywhere else ("non-null for any feed pushed at least once").
   *
   * That is correct today because `chart` is the only widget with a series-shaped config, and it is
   * written down in three places — but nothing FAILED if a second one appeared, so the next author
   * would have inherited a contradiction with no signal. This is the signal. When it fires, the
   * answer is not to delete it: decide whether the new widget wants the chart's stale-gated age or
   * the documented one, and if it wants the documented one, the gate has to move out of the host and
   * into `chart/plot.mjs` (per-series `stale`/`age_ms` on `ctx.series` — the option weighed and
   * rejected because the chart is currently the only consumer; if another consumer appears, revisit
   * whether it should use the chart's stale-gated age or the general rule.
   */
  it('is reached by chart and nothing else — a second series-shaped widget must fail here', () => {
    const seriesShaped = (WIDGET_DEFINITIONS as { id: string; sample_config: Record<string, unknown> }[])
      .filter((definition) => Array.isArray(definition.sample_config?.series))
      .map((definition) => definition.id)
    expect(seriesShaped).toEqual(['chart'])
  })
})

/**
 * `ctx.ramp` (stream data): the variable-length series colour ramp a `chart` design cycles
 * with `ramp[i % ramp.length]`. Not `meta.tokens` — a fixed name->colour vocabulary can't express
 * "however many colours the board declares". Sourced from `board.series` (via `themeSeriesRamp`)
 * when it validates, else a built-in four-colour ramp resolved from the palette, never from CSS.
 */
describe('ctx.ramp', () => {
  it('falls back to the palette when the board declares no series ramp', () => {
    const ctx = drawContextFor({ widget: 'chart', config: { style: 'line', series: [] } }, {}, {
      board: { info: '#111111', warn: '#222222', critical: '#333333', dim: '#444444' },
    })
    expect(ctx.ramp).toEqual(['#111111', '#222222', '#333333', '#444444'])
  })

  it('prefers a valid board.series ramp of any length', () => {
    const ctx = drawContextFor({ widget: 'chart', config: { style: 'line', series: [] } }, {}, {
      board: { series: ['#aaaaaa', '#bbbbbb'] },
    })
    expect(ctx.ramp).toEqual(['#aaaaaa', '#bbbbbb'])
  })

  it('rejects a ramp with one bad entry WHOLE, rather than compacting it', () => {
    // Compacting would silently re-order the operator's colours; themeSeriesRamp's own rule.
    const ctx = drawContextFor({ widget: 'chart', config: { style: 'line', series: [] } }, {}, {
      board: { series: ['#aaaaaa', 'not-a-colour'], info: '#111111', warn: '#222222', critical: '#333333', dim: '#444444' },
    })
    expect(ctx.ramp).toEqual(['#111111', '#222222', '#333333', '#444444'])
  })

  it('is never empty, so a design can index it unconditionally', () => {
    const ctx = drawContextFor({ widget: 'chart', config: { style: 'line', series: [] } }, {}, { board: {} })
    // `drawContextFor` returns the ctx as a bag of `unknown`s; the two tests above pin what
    // `ramp` is, so this one narrows to it rather than re-asserting the shape.
    const ramp = ctx.ramp as string[]
    expect(ramp.length).toBeGreaterThan(0)
    expect(ramp.every((c: string) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true)
  })
})

/**
 * `ctx.bitmap` (tab state): the decoded drawable for a cell's bound image feed, sourced
 * from bitmaps.mjs's module-global cache — see that module's own docstring for the full
 * load/decode/backoff state machine. `bitmapForCell` (index.mjs) is a PURE lookup: it never calls
 * `loadBitmapFor` itself, so populating the cache here is this test's job, exactly the way
 * widget-bitmaps.test.ts drives `loadBitmapFor` with injected fake deps — no reaching into
 * bitmaps.mjs's module internals.
 */
describe('ctx.bitmap', () => {
  beforeEach(() => resetBitmaps())

  it('is null for a cell bound to a feed whose mode is not "image" — even with a bitmap cached under that same feed id', async () => {
    // A cached bitmap under 'f' proves this is the mode gate at work, not merely an empty cache
    // (the "nothing decoded yet" case below already covers that).
    await loadBitmapFor('f', 1, {
      fetchBlob: async () => ({ blob: 'B1' }),
      decode: async (raw: unknown) => ({ drawable: raw }),
      revoke: () => {},
      now: () => 0,
    })
    const ctx = drawContextFor({ widget: 'image', config: { feed: 'f' } }, { f: { mode: 'stream', rows: [] } })
    expect(ctx.bitmap).toBeNull()
  })

  it('is null for a cell bound to no feed at all', () => {
    const ctx = drawContextFor({ widget: 'image', config: {} }, {})
    expect(ctx.bitmap).toBeNull()
  })

  it('is null for an image feed with nothing decoded yet', () => {
    const ctx = drawContextFor({ widget: 'image', config: { feed: 'f' } }, { f: { mode: 'image', image_rev: 1 } })
    expect(ctx.bitmap).toBeNull()
  })

  it('carries the exact decoded bitmap once bitmaps.mjs has one cached for the feed', async () => {
    await loadBitmapFor('f', 1, {
      fetchBlob: async () => ({ blob: 'B1' }),
      decode: async (raw: unknown) => ({ drawable: raw }),
      revoke: () => {},
      now: () => 0,
    })
    const ctx = drawContextFor({ widget: 'image', config: { feed: 'f' } }, { f: { mode: 'image', image_rev: 1 } })
    expect(ctx.bitmap).toEqual({ drawable: { blob: 'B1' } })
  })
})

/**
 * `ctx.feed`: `{ missing, mode, pushed_at, image_rev }` for a cell that binds one single feed, or
 * `null` for a cell that binds none.
 *
 * THE CHANNEL EXISTS BECAUSE NOTHING ELSE COULD ANSWER "does this cell's feed exist". `ctx.data` is
 * `null` for both "no such feed" and "a value feed nobody has ever pushed to" (a never-pushed value
 * feed's payload is legitimately `null`), and `ctx.stale`/`ctx.age_ms` are `false`/`null` for both,
 * so every single-feed design guessed — and each guessed the LOUDER answer.
 *
 * THREE ANSWERS, NOT TWO, and the distinction is what this suite pins: `null` means unbound, a
 * bound feed reports `missing: true` when it is not found, and `missing: false` means the feed
 * exists, including an existing feed that has never been pushed to. This keeps the value a
 * per-series design sees on every board from being mistaken for a missing feed. The flag is
 * spelled exactly like `ctx.series[i].missing`.
 *
 * It replaces the former widget-specific image revision field with the complete feed descriptor;
 * the revision survives as `image_rev`, under the name that says which mode it belongs to.
 */
describe('ctx.feed', () => {
  // The bitmap cache is module-global; the ctx.bitmap suite above leaves an entry under 'f'.
  beforeEach(() => resetBitmaps())

  const feedOf = (cell: { widget: string; config: Record<string, unknown> }, feeds: Record<string, unknown>) =>
    drawContextFor(cell, feeds).feed as Record<string, unknown> | null

  it('carries the wire\'s mode, pushed_at and image_rev for a feed that resolves', () => {
    expect(feedOf({ widget: 'image', config: { feed: 'f' } }, {
      f: { mode: 'image', image_rev: 7, pushed_at: 1_775_000_000_000, stale_after_s: 900 },
    })).toEqual({ missing: false, mode: 'image', pushed_at: 1_775_000_000_000, image_rev: 7 })

    expect(feedOf({ widget: 'weather_forecast', config: { feed: 'f' } }, { f: VALUE_WIRE }))
      .toEqual({ missing: false, mode: 'value', pushed_at: 1_775_000_000_000, image_rev: null })
  })

  /** The entire point of the channel, and the bug it closes. */
  it('separates a feed that exists but was never pushed from a feed that does not exist', () => {
    const neverPushed = feedOf({ widget: 'value_tile', config: { feed: 'f' } },
      { f: { mode: 'value', payload: null, pushed_at: null, stale_after_s: 600 } })
    const noSuchFeed = feedOf({ widget: 'value_tile', config: { feed: 'f' } }, {})

    expect(neverPushed).toEqual({ missing: false, mode: 'value', pushed_at: null, image_rev: null })
    expect(noSuchFeed).toEqual({ missing: true, mode: null, pushed_at: null, image_rev: null })

    // Both look identical on every other channel — which is the whole reason this one exists.
    const a = drawContextFor({ widget: 'value_tile', config: { feed: 'f' } },
      { f: { mode: 'value', payload: null, pushed_at: null, stale_after_s: 600 } })
    const b = drawContextFor({ widget: 'value_tile', config: { feed: 'f' } }, {})
    expect([a.data, a.rows, a.stale, a.age_ms]).toEqual([null, null, false, null])
    expect([b.data, b.rows, b.stale, b.age_ms]).toEqual([null, null, false, null])
  })

  /**
   * THE THREE ANSWERS, SIDE BY SIDE — the shape of the whole channel in one test.
   *
   * A cell that binds an id the device does not have is the LOUD state and is NOT `null`; a cell
   * that binds nothing is `null` and is not a complaint about anything.
   */
  it('says "not applicable", "not there" and "here are the facts" with three different values', () => {
    const notApplicable = feedOf({ widget: 'text_block', config: { text: 'typed in' } }, { f: VALUE_WIRE })
    const notThere = feedOf({ widget: 'value_tile', config: { feed: 'gone' } }, { f: VALUE_WIRE })
    const facts = feedOf({ widget: 'value_tile', config: { feed: 'f' } }, { f: VALUE_WIRE })

    expect(notApplicable).toBeNull()
    expect(notThere).toEqual({ missing: true, mode: null, pushed_at: null, image_rev: null })
    expect(facts).toMatchObject({ missing: false, mode: 'value' })
  })

  it('is null when the cell names no feed id at all — a binding nobody made, not a broken one', () => {
    expect(feedOf({ widget: 'image', config: {} }, { f: VALUE_WIRE })).toBeNull()
    expect(feedOf({ widget: 'image', config: { feed: '' } }, { '': VALUE_WIRE })).toBeNull()
  })

  it('flags a named-but-unresolvable feed as missing rather than reporting it as no binding', () => {
    // Includes the malformed-wire case: an own key holding something that is not a feed object is
    // a binding that resolves to nothing, which is the same operator-visible fact.
    expect(feedOf({ widget: 'image', config: { feed: 'gone' } }, { f: VALUE_WIRE })?.missing).toBe(true)
    expect(feedOf({ widget: 'image', config: { feed: 'f' } }, { f: { no: 'mode' } })?.missing).toBe(true)
    expect(feedOf({ widget: 'image', config: { feed: 'f' } }, { f: null })?.missing).toBe(true)
  })

  /**
   * THE TRAP THE `missing` FLAG EXISTS TO CLOSE, stated as a property of the channel.
   *
   * A chart binds per series and has no `config.feed`, so `null` is what it gets on every board it
   * ever paints — including a perfectly configured one. If `null` were also how a broken binding
   * reported itself, a per-series design following the contract literally would paint "Feed missing"
   * over a board where nothing at all is wrong. The two values must be distinguishable, and the
   * correctly configured cell must be the one that carries no complaint.
   */
  it('gives a correctly configured chart a value that is NOT the loud state', () => {
    const chart = drawContextFor(
      { widget: 'chart', config: { style: 'line', series: [{ feed: 'a', y_path: 'v' }] } },
      { a: STREAM_WIRE },
    )
    const brokenBinding = feedOf({ widget: 'value_tile', config: { feed: 'gone' } }, {})

    expect(chart.feed).toBeNull()
    expect(chart.series).toHaveLength(1)
    // `ctx.series[i].missing` is where a chart's "does this feed exist" lives, the same split
    // `ctx.stale` already makes through seriesStaleFor.
    expect((chart.series as { missing: boolean }[])[0].missing).toBe(false)

    // The load-bearing line: the correctly configured chart and the broken binding do not look the
    // same, and the loud one is the one that is not null.
    expect(chart.feed).not.toEqual(brokenBinding)
    expect(brokenBinding?.missing).toBe(true)
  })

  it('REPORTS the mode rather than rule on it: a value feed bound to an image cell still exists', () => {
    // Inherited from `ctx.image_feed`: `missing: true` here would draw the
    // LOUD "Feed missing", where the DOM branch drew the quiet `— no image yet` for exactly this
    // case. What a wrong-kind feed MEANS is each design's rule; the channel only states the fact.
    const feed = feedOf({ widget: 'image', config: { feed: 'f' } }, { f: VALUE_WIRE })
    expect(feed).toMatchObject({ missing: false, mode: 'value', image_rev: null })
  })

  it('normalises every field so a malformed wire cannot put undefined on the contract', () => {
    for (const wire of [
      { mode: 'image' },
      { mode: 'image', image_rev: null, pushed_at: 'soon' },
      { mode: 'image', image_rev: 'seven', pushed_at: Number.NaN },
    ]) {
      expect(feedOf({ widget: 'image', config: { feed: 'f' } }, { f: wire }))
        .toEqual({ missing: false, mode: 'image', pushed_at: null, image_rev: null })
    }
  })

  it('reports a mode this build cannot name as null, not as the raw string', () => {
    // A board served by a newer hub: a design switching on the three documented modes must land on
    // its own default branch, not on a fourth it has never heard of.
    expect(feedOf({ widget: 'image', config: { feed: 'f' } }, { f: { mode: 'hologram', pushed_at: 1 } })?.mode)
      .toBeNull()
  })

  it('carries those four facts and nothing else — no delivery wrapper crosses the boundary', () => {
    const feed = feedOf({ widget: 'image', config: { feed: 'f' } }, {
      f: {
        mode: 'image', image_rev: 3, pushed_at: 1_775_000_000_000, stale_after_s: 60,
        payload: { secret: 1 }, rows: [], credentials: { token: 'never-crosses' },
      },
    })
    expect(Object.keys(feed as object).sort()).toEqual(['image_rev', 'missing', 'mode', 'pushed_at'])
  })

  it('does NOT carry stale_after_s — an unread field does not get frozen into the contract', () => {
    // `isStale` (layout-core.mjs) applies the rule and `ctx.stale` delivers
    // the verdict, so the raw threshold answered no question any design was asking. Removing a field
    // after the freeze costs every design that reads it; not shipping it costs nothing.
    const feed = feedOf({ widget: 'image', config: { feed: 'f' } },
      { f: { mode: 'image', image_rev: 3, stale_after_s: 60 } })
    expect(feed).not.toHaveProperty('stale_after_s')
  })

  it('names the revision for the mode it belongs to, with null (not 0) for absent', () => {
    // `rev` on a general channel did not say which of three modes it
    // described, and `0`-for-absent was a second spelling of absence on an object where every other
    // key uses `null`.
    expect(feedOf({ widget: 'image', config: { feed: 'f' } }, { f: { mode: 'image', image_rev: 5 } })?.image_rev)
      .toBe(5)
    expect(feedOf({ widget: 'weather_forecast', config: { feed: 'f' } }, { f: VALUE_WIRE })?.image_rev).toBeNull()
  })

  it('agrees with ctx.age_ms about whether anything was ever pushed', () => {
    // One home for the fact: `pushedAt` is read back off this channel rather than re-derived, so a
    // design's quiet/loud choice and the age caption can never disagree.
    const pushed = drawContextFor({ widget: 'value_tile', config: { feed: 'f' } }, { f: VALUE_WIRE })
    const never = drawContextFor({ widget: 'value_tile', config: { feed: 'f' } },
      { f: { mode: 'value', payload: null, pushed_at: null } })
    expect((pushed.feed as { pushed_at: number | null }).pushed_at).not.toBeNull()
    expect(pushed.age_ms).not.toBeNull()
    expect((never.feed as { pushed_at: number | null }).pushed_at).toBeNull()
    expect(never.age_ms).toBeNull()
  })

  /**
   * THE SECOND, SMALLER BEHAVIOUR CHANGE THIS BRANCH MAKES.
   *
   * `pushedAt` accepts only finite wire timestamps. `NaN` and `Infinity` become `age_ms: null`,
   * preventing `value_tile`/`text_block` from rendering an age chip for a garbage timestamp.
   *
   * Pinned in both directions because it was an undeclared consequence of the refactor rather than
   * an intended change, and the branch's rule is that a divergence gets stated and tested.
   */
  it('treats a NaN or Infinity pushed_at as never-pushed, not as an age', () => {
    for (const pushed_at of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ctx = drawContextFor({ widget: 'value_tile', config: { feed: 'f' } },
        { f: { mode: 'value', payload: { v: 1 }, pushed_at } })
      expect((ctx.feed as { pushed_at: number | null }).pushed_at, `pushed_at: ${pushed_at}`).toBeNull()
      expect(ctx.age_ms, `age_ms for pushed_at: ${pushed_at}`).toBeNull()
    }
  })

  it('is gone as ctx.image_feed — the widget-specific channel it replaced', () => {
    const ctx = drawContextFor({ widget: 'image', config: { feed: 'f' } }, { f: { mode: 'image', image_rev: 1 } })
    expect(Object.keys(ctx)).not.toContain('image_feed')
  })
})

/**
 * Painting a subset of the board.
 *
 * The 1s tick exists for the cells whose output moves with the clock. Repainting the whole board to
 * serve them redraws every cell that is a pure function of socket data — on the A05 that measured
 * 30-45ms a pass, every second, forever. `only` is how the tick says "just the clock".
 */
describe('partial repaint', () => {
  let canvases: ReturnType<typeof fakeCanvas>[] = []

  beforeEach(() => {
    _reset()
    canvases = []
    ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => canvases }
  })
  afterEach(() => {
    stopAllWidgets()
    delete (globalThis as Record<string, unknown>).document
  })

  it('draws only the cells asked for and leaves the rest untouched', () => {
    const drawn: number[] = []
    registerSemanticDesign((_g, ctx) => { drawn.push((ctx.config as { idx: number }).idx) })
    const cells = [
      { widget: 'weather_forecast', config: { idx: 0 } },
      { widget: 'weather_forecast', config: { idx: 1 } },
      { widget: 'weather_forecast', config: { idx: 2 } },
    ]
    canvases = [fakeCanvas(0), fakeCanvas(1), fakeCanvas(2)]

    paintWidgets(
      cells, [semanticBox(0), semanticBox(1), semanticBox(2)], BUILTIN_BOARD, () => AT_REST, {}, {}, [1],
    )

    expect(drawn).toEqual([1])
  })

  it('still draws every cell when no subset is named', () => {
    const drawn: number[] = []
    registerSemanticDesign((_g, ctx) => { drawn.push((ctx.config as { idx: number }).idx) })
    const cells = [
      { widget: 'weather_forecast', config: { idx: 0 } },
      { widget: 'weather_forecast', config: { idx: 1 } },
    ]
    canvases = [fakeCanvas(0), fakeCanvas(1)]

    paintWidgets(cells, [semanticBox(0), semanticBox(1)], BUILTIN_BOARD, () => AT_REST, {}, {})

    expect(drawn).toEqual([0, 1])
  })

  /**
   * The sweep exists because a full render rebuilds the board wholesale, so a cell that vanished is
   * never visited again and would otherwise be handed frames forever. A PARTIAL paint
   * deliberately does not visit most of the board — none of those cells vanished, they simply were
   * not due — so running the sweep against a subset would stop the animation of every cell the tick
   * skipped. The clock tick would be the thing that kills the clock's own crossfade.
   */
  it('does not stop an animating cell that this paint simply did not visit', () => {
    harness()
    registerSemanticDesign(() => {})
    const cells = [
      { widget: 'clock', config: { design: 'segment' } },
      { widget: 'weather_forecast', config: {} },
    ]
    const boxes = [semanticBox(0), semanticBox(1)]
    canvases = [fakeCanvas(0), fakeCanvas(1)]

    // A full paint inside the crossfade window registers the clock with the board loop.
    paintWidgets(cells, boxes, BUILTIN_BOARD, () => BOUNDARY + 45, {}, {})
    expect(activeCount()).toBe(1)

    // A tick that repaints only the OTHER cell must not disturb it.
    paintWidgets(cells, boxes, BUILTIN_BOARD, () => BOUNDARY + 45, {}, {}, [1])
    expect(activeCount()).toBe(1)
  })

  /**
   * The flip side: a partial paint must not become the baseline the NEXT full render diffs against,
   * or a cell that really did disappear would keep its frames because the partial had already
   * "forgotten" it.
   */
  it('keeps the full board as the sweep baseline across a partial paint', () => {
    harness()
    registerSemanticDesign(() => {})
    const twoCells = [
      { widget: 'clock', config: { design: 'segment' } },
      { widget: 'weather_forecast', config: {} },
    ]
    canvases = [fakeCanvas(0), fakeCanvas(1)]
    paintWidgets(twoCells, [semanticBox(0), semanticBox(1)], BUILTIN_BOARD, () => BOUNDARY + 45, {}, {})
    expect(activeCount()).toBe(1)

    paintWidgets(twoCells, [semanticBox(0), semanticBox(1)], BUILTIN_BOARD, () => BOUNDARY + 45, {}, {}, [1])

    // The clock cell is now gone from the board, and the next FULL render must sweep it.
    canvases = [fakeCanvas(0)]
    paintWidgets([{ widget: 'weather_forecast', config: {} }], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, {})
    expect(activeCount()).toBe(0)
  })
})

/** Manual clock, same shape as widget-loop.test.ts: nothing runs until step() is called. */
function harness() {
  let queued: ((t: number) => void) | null = null
  _setRaf((cb: (t: number) => void) => { queued = cb; return 1 }, () => { queued = null })
  return {
    step: (t: number) => { const c = queued; queued = null; c?.(t) },
    pending: () => queued !== null,
  }
}

const BOUNDARY = Date.UTC(2026, 7, 2, 15, 31, 0) // epoch-derived: a boundary in every timezone
const AT_REST = BOUNDARY + 20_000                // 15:30:20-ish — nowhere near a rollover

/** One board: a single full-cell segment clock, the cheapest board that can animate at all. */
function board(design: string) {
  return {
    cells: [{ widget: 'clock', config: { design } }],
    boxes: [{ rect: { x: 0, y: 0, w: 1, h: 0.5 }, px: { left: 0, top: 0, width: 400, height: 200 }, t: 1 }],
    canvases: [fakeCanvas(0)],
  }
}

describe('a calm board idles the frame loop to zero (animation contract)', () => {
  let canvases: ReturnType<typeof fakeCanvas>[] = []

  beforeEach(() => {
    _reset()
    canvases = []
    ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => canvases }
  })
  afterEach(() => {
    stopAllWidgets()
    delete (globalThis as Record<string, unknown>).document
  })

  it('hands a resting segment clock no frames at all', () => {
    const h = harness()
    const b = board('segment')
    canvases = b.canvases
    paintWidgets(b.cells, b.boxes, BUILTIN_BOARD, () => AT_REST)
    expect(activeCount()).toBe(0)
    expect(h.pending()).toBe(false)
  })

  it('produces ZERO frames across ten seconds of 1s render ticks between minute boundaries', () => {
    const h = harness()
    const b = board('segment')
    canvases = b.canvases
    let hub = AT_REST
    let frames = 0
    for (let tick = 0; tick < 10; tick++) {
      paintWidgets(b.cells, b.boxes, BUILTIN_BOARD, () => hub)
      while (h.pending() && frames < 5_000) { frames++; hub += 16; h.step(hub) }
      hub += 1_000
    }
    expect(frames).toBe(0)
    expect(activeCount()).toBe(0)
  })

  it('animates a bounded burst across a minute rollover and then drops itself back to zero', () => {
    const h = harness()
    const b = board('segment')
    canvases = b.canvases
    let hub = BOUNDARY + 45 // the 1s render tick happened to land inside the crossfade window
    let frames = 0
    paintWidgets(b.cells, b.boxes, BUILTIN_BOARD, () => hub)
    expect(activeCount()).toBe(1)
    while (h.pending() && frames < 5_000) { frames++; hub += 16; h.step(hub) }
    expect(frames).toBeGreaterThan(0)
    expect(frames).toBeLessThan(20) // a 180ms window at 60fps, not an unbounded run
    expect(activeCount()).toBe(0)
    expect(h.pending()).toBe(false)
  })

  it('never registers a design that declares no animations', () => {
    const h = harness()
    for (const id of ['digital', 'analog']) {
      const b = board(id)
      canvases = b.canvases
      paintWidgets(b.cells, b.boxes, BUILTIN_BOARD, () => BOUNDARY)
      expect(activeCount()).toBe(0)
      expect(h.pending()).toBe(false)
    }
  })

  it('stops everything when the board goes away with no render to sweep it', () => {
    const h = harness()
    const b = board('segment')
    canvases = b.canvases
    paintWidgets(b.cells, b.boxes, BUILTIN_BOARD, () => BOUNDARY + 45)
    expect(activeCount()).toBe(1)
    stopAllWidgets()
    expect(activeCount()).toBe(0)
    expect(h.pending()).toBe(false)
  })

  it('stopAllWidgets is safe to call twice, and on a board that never animated', () => {
    stopAllWidgets()
    stopAllWidgets()
    expect(activeCount()).toBe(0)
  })
})

/**
 * A theme names a design per widget type; a cell may override it.
 * without leaving the theme. It carries a REFERENCE, never colour values — colours stay named,
 * reusable theme data, and a theme switch still recolours every clock not deliberately pinned.
 */

describe('cards backdrop chrome (pipeline-painted)', () => {
  const CARD_RADIUS = (widgetRuntime as unknown as { CARD_RADIUS: number }).CARD_RADIUS
  const CARD_BORDER = (widgetRuntime as unknown as { CARD_BORDER: number }).CARD_BORDER

  it('paints the card under the design, honours gap and padding, and skips opted-out cells', () => {
    const events: string[] = []
    let firstMoveX = null as number | null
    let translated = null as [number, number] | null
    let received = null as Record<string, unknown> | null
    const canvas = fakeCanvas(0)
    const g = canvas.getContext() as unknown as Record<string, unknown>
    g.moveTo = (x: number) => { if (firstMoveX === null) firstMoveX = x }
    g.translate = (x: number, y: number) => { translated = [x, y] }
    g.fill = () => events.push(`fill:${g.fillStyle}`)
    g.stroke = () => events.push(`stroke:${g.strokeStyle}`)
    registerSemanticDesign((_g, ctx) => { events.push('design'); received = ctx })
    ;(globalThis as Record<string, unknown>).document = { querySelectorAll: () => [canvas] }
    const chrome = { surface: '#fff5e6', border: '#c0ffee', gap: 4, padding: 6 }
    const inset = chrome.gap + CARD_BORDER + chrome.padding
    const cell = { widget: 'weather_forecast', config: { feed: 'selected' } }
    try {
      paintWidgets([cell], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, {}, undefined, [], chrome)
      expect(events).toEqual([`fill:${chrome.surface}`, `stroke:${chrome.border}`, 'design'])
      // The card outline is inset by gap + half the border, radius first: moveTo at inset + r.
      expect(firstMoveX).toBe(chrome.gap + CARD_BORDER / 2 + CARD_RADIUS)
      // The design's origin and box both respect the content inset (gap + border + padding).
      expect(translated).toEqual([inset, inset])
      expect((received?.box as { w: number; h: number }).w).toBe(240 - inset * 2)
      expect((received?.box as { w: number; h: number }).h).toBe(160 - inset * 2)

      events.length = 0
      translated = null
      paintWidgets([{ ...cell, config: { ...cell.config, card: false } }],
        [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, {}, undefined, [], chrome)
      expect(events).toEqual(['design'])
      expect(translated).toBeNull()
      expect((received?.box as { w: number }).w).toBe(240)

      events.length = 0
      paintWidgets([cell], [semanticBox(0)], BUILTIN_BOARD, () => AT_REST, {}, {})
      expect(events).toEqual(['design'])
      expect((received?.box as { w: number }).w).toBe(240)
    } finally {
      stopAllWidgets()
      delete (globalThis as Record<string, unknown>).document
    }
  })
})
