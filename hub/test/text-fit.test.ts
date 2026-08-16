import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { formatAge, quietLine } from '../static/device/widgets/text-fit.mjs'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/data-widget-vectors.json', import.meta.url), 'utf8'))

/** `formatAge` is the browser implementation covered by the shared age-format vector corpus. */
describe('formatAge behavior (shared browser vectors)', () => {
  it('formats every shared age vector', () => {
    for (const v of vectors.ageChip) expect(formatAge(v.ageMs), v.name).toBe(v.expect)
  })
})

type Call = {
  text: string
  x: number
  y: number
  font: string
  fillStyle: string
  textAlign: string
  textBaseline: string
}

function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    fillText: (text: string, x: number, y: number) =>
      calls.push({ text, x, y, font: g.font, fillStyle: g.fillStyle, textAlign: g.textAlign, textBaseline: g.textBaseline }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
  }
  return { g, calls }
}

/**
 * `quietLine`'s own suite — the four call sites (`stream/list.mjs`, `table/grid.mjs`,
 * `alert/feed.mjs`, `image/frame.mjs`) each pin their own text/state through their design-level
 * tests; this pins the shared arithmetic directly, once, the way `centredNotice` never got its own
 * (its five call sites carry that weight instead). `centredNotice`'s signature is the template:
 * `(g, ..., box, tokens, pad, scale)`, `tokens.dim`, weight 400, centred/middle.
 */
describe('quietLine — centredNotice\'s one-line, quiet sibling', () => {
  const tokens = { ink: '#ink', dim: '#dim' }

  it('paints centred/middle, in tokens.dim, at weight 400', () => {
    const { g, calls } = recorder()
    quietLine(g, '— no rows yet', { w: 300, h: 200 }, tokens, 12, 1)
    expect(calls).toEqual([{
      text: '— no rows yet', x: 150, y: 100,
      font: '400 12px system-ui', fillStyle: '#dim', textAlign: 'center', textBaseline: 'middle',
    }])
  })

  it('px is Math.min(16, box.w * 0.04) * scale, floored at 10', () => {
    const { g, calls } = recorder()
    quietLine(g, 'x', { w: 1000, h: 500 }, tokens, 12, 0.5)
    // Math.min(16, 1000*0.04) = 16; 16 * 0.5 = 8; floored at 10.
    expect(calls[0].font).toBe('400 10px system-ui')
  })

  it('scale multiplies px up past the unscaled cap', () => {
    const { g, calls } = recorder()
    quietLine(g, 'x', { w: 500, h: 500 }, tokens, 12, 2)
    // Math.min(16, 500*0.04) = 16; 16 * 2 = 32.
    expect(calls[0].font).toBe('400 32px system-ui')
  })

  it('maxWidth is box.w - pad*2, clamped at 0 — a pad wider than the box paints nothing', () => {
    const { g, calls } = recorder()
    quietLine(g, 'well past the available width', { w: 20, h: 20 }, tokens, 12, 1)
    expect(calls).toEqual([])
  })
})
