import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import block, { normalizeText } from '../static/device/widgets/text/block.mjs'
// @ts-expect-error plain JS module without types
import { formatAge } from '../static/device/widgets/text-fit.mjs'

type Call = { fillStyle: string; text: string }

/** Same recorder shape as news/list.mjs's test suite: enough of `g` for the portable drawing subset subset, capturing
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

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim' },
  config: { text: 'demo board' },
  data: null,
  box: { w: 300, h: 100, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

describe('text_block design', () => {
  it('declares its alignment option so the admin can generate the field', () => {
    expect(block.meta.options.align.choices).toEqual(['left', 'center', 'right'])
    expect(block.meta.options.align.default).toBe('left')
  })

  it('renders a literal string from config', () => {
    expect(normalizeText(null, { text: 'demo board' }).text).toBe('demo board')
  })

  it('renders a bound value when the cell binds a feed instead of a literal', () => {
    expect(normalizeText({ note: 'from data' }, { path: 'note' }).text).toBe('from data')
  })

  it('reports unavailable rather than drawing an empty box when there is nothing to say', () => {
    expect(normalizeText(null, {}).available).toBe(false)
  })

  it('falls back to the declared default when align is absent or nonsense', () => {
    expect(normalizeText(null, { text: 'x' }).align).toBe('left')
    expect(normalizeText(null, { text: 'x', align: 'sideways' }).align).toBe('left')
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
    expect(formatAge(2 * 3_600_000)).toBe('2h ago')
    expect(formatAge(86_400_000)).toBe('1d ago')
  })
})

describe('text_block draw reflects ctx.stale / ctx.age_ms', () => {
  // The age caption is gated by "is a feed bound" (age_ms !== null), NOT
  // by staleness — matching the old DOM branch's `${wire ? ageChipHtml(wire) : ''}`, which showed
  // the chip for any bound feed regardless of `stale`. `stale` only ever decides the dimmed
  // treatment. A fresh, bound feed must still show its age: that is the "is this still current?"
  // at-a-glance signal a person reads off the wall, and hiding it until the feed actually goes
  // stale would make a silently-stopped feed indistinguishable from a live one.
  it('shows the age caption for a bound feed even when fresh (stale: false)', () => {
    const { g, calls } = recorder()
    block.draw(g, baseCtx({ stale: false, age_ms: 5_000 }))

    expect(calls).toHaveLength(2)
    expect(calls[0].text).toBe('demo board')
    expect(calls[0].fillStyle).toBe('#ink') // main line stays ink — not stale
    expect(calls[1].text).toBe(formatAge(5_000))
    expect(calls[1].fillStyle).toBe('#dim') // caption is always dim, like the old .age-chip class
  })

  it('dims the line and keeps the age caption once the bound value is stale', () => {
    const { g, calls } = recorder()
    block.draw(g, baseCtx({ stale: true, age_ms: 5 * 60_000 }))

    expect(calls).toHaveLength(2)
    expect(calls[0].text).toBe('demo board')
    expect(calls[0].fillStyle).toBe('#dim') // main line dims — stale
    expect(calls[1].text).toBe(formatAge(5 * 60_000))
    expect(calls[1].fillStyle).toBe('#dim')
  })

  it('shows no caption and never dims typed-in text with no feed bound', () => {
    const { g, calls } = recorder()
    block.draw(g, baseCtx({ stale: false, age_ms: null }))

    expect(calls).toHaveLength(1)
    expect(calls[0].fillStyle).toBe('#ink')
  })

  // "never-pushed is quiet, not stale" (device.js:282-284's rule for the DOM age
  // chip) — a feed that is BOUND but has never actually been pushed to must render identically to
  // no feed at all, not as a fresh feed with a caption. `paintWidgets` enforces this by producing
  // the exact same `{ stale: false, age_ms: null }` for both cases (pinned separately in
  // widget-paint.test.ts against real wire shapes); at the design level the two are — correctly —
  // indistinguishable, since a design only ever sees the resolved ctx, never the wire itself.
  it('renders a bound-but-never-pushed feed exactly like no feed at all — no caption, no dim', () => {
    const { g, calls } = recorder()
    block.draw(g, baseCtx({ config: { feed: 'f', path: 'note' }, data: { note: 'demo board' }, stale: false, age_ms: null }))

    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe('demo board')
    expect(calls[0].fillStyle).toBe('#ink')
  })

  it('tolerates a ctx with no stale/age_ms fields at all, same as the portable-subset harness sends', () => {
    const { g, calls } = recorder()
    const ctx = baseCtx()
    delete (ctx as Record<string, unknown>).stale
    delete (ctx as Record<string, unknown>).age_ms

    expect(() => block.draw(g, ctx)).not.toThrow()
    expect(calls).toHaveLength(1) // age_ms absent => not a number => no caption, same as no feed
    expect(calls[0].fillStyle).toBe('#ink')
  })
})
