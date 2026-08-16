import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync('static/device/index.html', 'utf8')
const styles = /<style>([\s\S]*?)<\/style>/.exec(html)![1]
const withoutRoot = styles.replace(/:root\s*\{[^}]*\}/, '')

describe('every themed colour reads from a custom property', () => {
  it('leaves no bare hex outside :root', () => {
    const bare = [...withoutRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
    expect(bare).toEqual([])
  })

  it('keeps .clock-date, which five non-clock widgets reuse as muted text', () => {
    expect(withoutRoot).toMatch(/\.cell \.clock-date\s*\{/)
  })

  // `the gauge donut hole no longer punches with --bg` lived here and parsed the
  // `.cell .gauge-ring-inner` rule out of the stylesheet. That rule is gone: `gauge` is two canvas
  // designs now (`gauge/bar.mjs`, `gauge/ring.mjs`) and nothing emits a `.gauge-ring-inner`
  // element, so the CSS went with the rest of the tile DOM branch. The test could not simply be
  // left in place — its `.exec(...)![1]` would throw a TypeError on the missing rule rather than
  // fail an assertion. The `--gauge-hole` custom property it protected has since been retired too
  // With `.gauge-ring-inner` gone it was read by nothing, and
  // the migration that strips it from stored themes is what retired it for good.
})
