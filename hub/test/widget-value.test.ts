import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import tile, { normalizeValue } from '../static/device/widgets/value/tile.mjs'
// @ts-expect-error plain JS module without types
import { formatAge } from '../static/device/widgets/text-fit.mjs'

type Call = { fillStyle: string; text: string }

/** Same recorder shape as text/block.mjs's test suite: enough of `g` for the portable drawing subset subset, capturing
 *  the fillStyle a fillText call was actually painted with (not just its last-set value). */
function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    fillText: (text: string) => calls.push({ fillStyle: g.fillStyle, text }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
  }
  return { g, calls }
}

/**
 * The `ctx.feed` states this design cares about (widgets/index.mjs's `feedSignalFor`).
 *
 * `NO_FEED` is `null` — the cell binds nothing. On the channel that means NOT APPLICABLE, not
 * "something is wrong" (a chart sits there on every correctly configured board), but a value tile
 * with no feed is an authoring mistake, so THIS design rules it loud. `GONE` is the channel's own
 * loud state: a bound id the device does not have. `NEVER_PUSHED` is a feed that exists, is a kind
 * this widget reads, and has had nothing sent to it — the quiet line. `PUSHED` keeps the loud notice
 * for a path that resolves to nothing on
 * a feed that HAS been pushed to.
 */
const NO_FEED = null
const GONE = { missing: true, mode: null, pushed_at: null, image_rev: null }
const NEVER_PUSHED = { missing: false, mode: 'value', pushed_at: null, image_rev: null }
const PUSHED = { missing: false, mode: 'value', pushed_at: 1_775_000_000_000, image_rev: null }

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim' },
  config: { path: 'v', label: 'Temp', unit: '°C' },
  data: { v: 21.4 },
  feed: PUSHED,
  box: { w: 300, h: 150, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

describe('value_tile design', () => {
  it('declares label, unit, format and decimals as options', () => {
    expect(Object.keys(tile.meta.options).sort()).toEqual(['decimals', 'format', 'label', 'unit'])
  })

  /**
   * `format` was schema-accepted and renderer-read but declared nowhere, so the admin drew no
   * control for it and only hand-written JSON could set it. Its declaration is pinned against the
   * normalizer rather than restated: `choices` must be exactly the pair `normalizeValue`
   * distinguishes, and the declared default must be what an unset cell actually renders as.
   */
  it('declares format as a select over exactly the two values normalizeValue distinguishes', () => {
    expect(tile.meta.options.format.type).toBe('select')
    expect(tile.meta.options.format.choices).toEqual(['raw', 'abbrev'])
  })

  it('declares the format default the normalizer already applies', () => {
    const unset = normalizeValue({ v: 1500 }, NO_FEED, { path: 'v' })
    const declared = normalizeValue({ v: 1500 }, NO_FEED, { path: 'v', format: tile.meta.options.format.default })
    expect(declared.value).toBe(unset.value)
    // …and the other choice really does render differently, so the pairing above is not vacuous.
    expect(normalizeValue({ v: 1500 }, NO_FEED, { path: 'v', format: 'abbrev' }).value).not.toBe(unset.value)
  })

  it('resolves a dotted path out of the payload', () => {
    expect(normalizeValue({ cpu: { load: 41.27 } }, NO_FEED, { path: 'cpu.load', decimals: 1 }).value).toBe('41.3')
  })

  it('shows an em-dash for a non-numeric value rather than NaN', () => {
    expect(normalizeValue({ cpu: { load: 'busy' } }, NO_FEED, { path: 'cpu.load' }).value).toBe('—')
  })

  it('is unavailable when the bound path resolves to nothing', () => {
    expect(normalizeValue({}, NO_FEED, { path: 'cpu.load' }).state).not.toBe('ready')
  })

  it('carries the unit through untouched', () => {
    expect(normalizeValue({ t: 21 }, NO_FEED, { path: 't', unit: '°C' }).unit).toBe('°C')
  })
})

describe('normalizeValue — every valueConfig knob carried over', () => {
  it('reads the newest row on a stream feed (array-shaped data), like feedScalarSource', () => {
    const n = normalizeValue([{ v: 1 }, { v: 2 }], NO_FEED, { path: 'v' })
    expect(n.value).toBe('1')
  })

  it('a literal decimals of 0 rounds to an integer, distinct from "unset"', () => {
    expect(normalizeValue({ v: 3.7 }, NO_FEED, { path: 'v', decimals: 0 }).value).toBe('4')
  })

  it('leaves an unset decimals raw (no forced rounding) — valueConfig\'s own default', () => {
    expect(normalizeValue({ v: 3.14159 }, NO_FEED, { path: 'v' }).value).toBe('3.14159')
  })

  it('abbreviates large numbers when format is abbrev', () => {
    expect(normalizeValue({ v: 12_000 }, NO_FEED, { path: 'v', format: 'abbrev', decimals: 1 }).value).toBe('12.0K')
  })

  it('carries the label through untouched, empty string when absent', () => {
    expect(normalizeValue({ v: 1 }, NO_FEED, { path: 'v', label: 'CPU' }).label).toBe('CPU')
    expect(normalizeValue({ v: 1 }, NO_FEED, { path: 'v' }).label).toBe('')
  })

  it('clamps scale into the shared 0.5-2 range', () => {
    expect(normalizeValue({ v: 1 }, NO_FEED, { path: 'v', scale: 9 }).scale).toBe(2)
    expect(normalizeValue({ v: 1 }, NO_FEED, { path: 'v', scale: 0.1 }).scale).toBe(0.5)
  })

  it('an empty path resolves to the whole payload, same as resolvePath\'s own contract', () => {
    expect(normalizeValue(7, NO_FEED, { path: '' }).value).toBe('7')
  })
})

/**
 * THE BEHAVIOUR CHANGE `ctx.feed` EXISTS FOR, pinned from both sides.
 *
 * `normalizeValue`'s old `available` boolean folded "no feed bound at all" into "a real feed nobody
 * has ever pushed to" — both arrive as `ctx.data === null`, because a never-pushed value feed's
 * payload is legitimately `null` — and painted the LOUD "No value" for both. `ctx.feed.pushed_at`
 * is what tells them apart, and it is the ONLY case that moved: a path that resolves to nothing on
 * a feed that HAS been pushed to is still loud, because that is a configuration mistake.
 */
describe('normalizeValue — ctx.feed separates "no such feed" from "never pushed"', () => {
  it('a feed that EXISTS and was never pushed is "pending" (quiet), NOT "missing"', () => {
    expect(normalizeValue(null, NEVER_PUSHED, { path: 'v' }).state).toBe('pending')
  })

  it('no feed at all is still "missing" (loud) — the state that did not move', () => {
    expect(normalizeValue(null, NO_FEED, { path: 'v' }).state).toBe('missing')
  })

  it('a bound feed the device does not have is "missing" (loud) — the channel\'s own loud state', () => {
    expect(normalizeValue(null, GONE, { path: 'v' }).state).toBe('missing')
  })

  /**
   * THE MODE GATE, the same rule `table` applies and for the same reason.
   *
   * A value tile can never read an image feed, so binding one is wrong from the moment it is bound.
   * Without `ctx.feed.mode` this design saw only "exists, never pushed" and drew the QUIET line,
   * telling the operator last — once somebody pushed a bitmap to a feed that had been wrong all
   * along. `widgetAcceptsMode` (bindings.mjs) is the same mode set the hub enforces on save.
   */
  it('stays LOUD for a feed of a kind it cannot read, pushed or not', () => {
    const image = (pushed_at: number | null) => ({ missing: false, mode: 'image', pushed_at, image_rev: 3 })
    expect(normalizeValue(null, image(null), { path: 'v' }).state).toBe('missing')
    expect(normalizeValue(null, image(5), { path: 'v' }).state).toBe('missing')
    // A mode this build cannot name (a board served by a newer hub) is loud for the same reason.
    expect(normalizeValue(null, { missing: false, mode: null, pushed_at: null, image_rev: null }, { path: 'v' }).state)
      .toBe('missing')
  })

  it('takes the quiet line for BOTH modes it does read, so the gate is not an image special case', () => {
    for (const mode of ['value', 'stream']) {
      expect(normalizeValue(null, { missing: false, mode, pushed_at: null, image_rev: null }, { path: 'v' }).state)
        .toBe('pending')
    }
  })

  it('an unresolvable path on a feed that HAS been pushed is still "missing" (loud)', () => {
    // The notice an operator needs for a `path` typo — "No value / Bind a feed with a numeric
    // path". Making this quiet would hide the one mistake the notice exists to name.
    expect(normalizeValue({ other: 1 }, PUSHED, { path: 'v' }).state).toBe('missing')
  })

  it('a resolvable value is "ready" whatever the feed says about pushes', () => {
    expect(normalizeValue({ v: 21 }, NEVER_PUSHED, { path: 'v' }).state).toBe('ready')
    expect(normalizeValue({ v: 21 }, NO_FEED, { path: 'v' }).state).toBe('ready')
  })

  it('treats an absent ctx.feed as no feed, so a host that never sets it degrades loudly as before', () => {
    expect(normalizeValue(null, undefined, { path: 'v' }).state).toBe('missing')
  })
})

describe('value_tile draw — the quiet never-pushed line', () => {
  it('paints "— no value yet" in dim, not the loud notice, for a real feed nobody has pushed to', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ data: null, feed: NEVER_PUSHED }))
    const quiet = calls.find((c) => c.text === '— no value yet')
    expect(quiet).toBeDefined()
    expect(quiet?.fillStyle).toBe('#dim')
    expect(calls.some((c) => c.text === 'No value')).toBe(false)
  })

  it('paints the loud "No value" notice when no feed is bound at all', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ data: null, feed: NO_FEED }))
    expect(calls.some((c) => c.text === 'No value')).toBe(true)
    expect(calls.some((c) => c.text === '— no value yet')).toBe(false)
  })

  it('draws no label, unit or age caption in the quiet state — it is one line, like table\'s', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ data: null, feed: NEVER_PUSHED, age_ms: 5_000 }))
    expect(calls.map((c) => c.text)).toEqual(['— no value yet'])
  })
})

describe('formatAge', () => {
  it('reads as "now" inside the first minute', () => {
    expect(formatAge(0)).toBe('now')
    expect(formatAge(59_999)).toBe('now')
  })

  it('steps through minutes, hours and days the same way layout-core.mjs\'s ageChip does', () => {
    expect(formatAge(60_000)).toBe('1m ago')
    expect(formatAge(5 * 60_000)).toBe('5m ago')
    expect(formatAge(3_600_000)).toBe('1h ago')
    expect(formatAge(86_400_000)).toBe('1d ago')
  })
})

describe('value_tile draw reflects ctx.stale / ctx.age_ms (screen state\'s contract)', () => {
  it('shows the age caption for a bound feed even when fresh (stale: false)', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ stale: false, age_ms: 5_000 }))

    const texts = calls.map((c) => c.text)
    expect(texts).toContain(formatAge(5_000))
    const valueCall = calls.find((c) => c.text === '21.4')
    expect(valueCall?.fillStyle).toBe('#ink') // not stale: value stays ink
    const ageCall = calls.find((c) => c.text === formatAge(5_000))
    expect(ageCall?.fillStyle).toBe('#dim') // caption is always dim
  })

  it('dims the value and keeps the age caption once the bound value is stale', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ stale: true, age_ms: 5 * 60_000 }))

    const valueCall = calls.find((c) => c.text === '21.4')
    expect(valueCall?.fillStyle).toBe('#dim') // stale: value dims
    expect(calls.some((c) => c.text === formatAge(5 * 60_000))).toBe(true)
  })

  it('shows no caption and never dims with no feed bound (age_ms: null)', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ stale: false, age_ms: null }))

    expect(calls.some((c) => /ago|now/.test(c.text))).toBe(false)
    const valueCall = calls.find((c) => c.text === '21.4')
    expect(valueCall?.fillStyle).toBe('#ink')
  })

  it('renders a bound-but-never-pushed feed exactly like no feed at all — no caption, no dim', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ stale: false, age_ms: null }))
    expect(calls.some((c) => /ago|now/.test(c.text))).toBe(false)
    expect(calls.find((c) => c.text === '21.4')?.fillStyle).toBe('#ink')
  })

  it('tolerates a ctx with no stale/age_ms fields at all, same as the portable-subset harness sends', () => {
    const { g, calls } = recorder()
    const ctx = baseCtx()
    delete (ctx as Record<string, unknown>).stale
    delete (ctx as Record<string, unknown>).age_ms

    expect(() => tile.draw(g, ctx)).not.toThrow()
    expect(calls.some((c) => /ago|now/.test(c.text))).toBe(false)
    expect(calls.find((c) => c.text === '21.4')?.fillStyle).toBe('#ink')
  })

  it('shows a "no value" notice, not a crash, when the bound path resolves to nothing', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx({ config: { path: 'missing' }, data: {} }))
    expect(calls.some((c) => c.text === 'No value')).toBe(true)
  })

  it('shows the unit right after the value', () => {
    const { g, calls } = recorder()
    tile.draw(g, baseCtx())
    expect(calls.map((c) => c.text)).toEqual(expect.arrayContaining(['Temp', '21.4', '°C']))
  })
})
