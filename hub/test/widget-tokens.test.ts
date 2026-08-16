import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { resolveTokens } from '../static/device/widgets/tokens.mjs'

const meta = {
  tokens: {
    segment_on: { type: 'color', default: '@ink' },
    segment_off: { type: 'color', default: '#222222' },
    bezel: { type: 'color', default: '@surface' },
    glow: { type: 'number', default: 0 },
  },
}
const palette = { ink: '#ff2b2b', surface: '#141414' }

describe('token resolution', () => {
  it('prefers the theme widget token over everything', () => {
    const t = resolveTokens(meta, { tokens: { segment_on: '#00ff00' } }, palette)
    expect(t.segment_on).toBe('#00ff00')
  })

  it('expands an @palette default to the palette value', () => {
    expect(resolveTokens(meta, {}, palette).segment_on).toBe('#ff2b2b')
  })

  it('uses a literal built-in default when there is no palette reference', () => {
    expect(resolveTokens(meta, {}, palette).segment_off).toBe('#222222')
  })

  it('ignores a token the design never declared', () => {
    const t = resolveTokens(meta, { tokens: { not_a_token: '#fff' } }, palette)
    expect(t.not_a_token).toBeUndefined()
  })

  it('falls back to the built-in when a value is the wrong type', () => {
    const t = resolveTokens(meta, { tokens: { glow: 'loud' } }, palette)
    expect(t.glow).toBe(0)
  })

  it('falls back to the built-in when a colour is unparseable', () => {
    const t = resolveTokens(meta, { tokens: { segment_off: 'reddish' } }, palette)
    expect(t.segment_off).toBe('#222222')
  })

  it('falls back to the literal default when an @palette reference is missing from the palette', () => {
    expect(resolveTokens(meta, {}, {}).segment_on).toBe('#000000')
  })

  it('returns a value for every declared token', () => {
    const t = resolveTokens(meta, {}, palette)
    expect(Object.keys(t).sort()).toEqual(['bezel', 'glow', 'segment_off', 'segment_on'])
  })
})
