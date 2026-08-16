import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { normalizeGauge } from '../static/device/widgets/gauge/shared.mjs'
// @ts-expect-error plain JS module without types
import ring from '../static/device/widgets/gauge/ring.mjs'
// @ts-expect-error plain JS module without types
import bar from '../static/device/widgets/gauge/bar.mjs'
// @ts-expect-error plain JS module without types
import { formatAge } from '../static/device/widgets/text-fit.mjs'

type Call = { fillStyle: string; text: string }
type StrokeCall = { style: string; arc: { cx: number; cy: number; r: number; start: number; end: number } | null }
type FillCall = {
  style: string
  rect: { x: number; y: number; w: number; h: number } | null
  /** A filled path can be an arc as well as a rect — the ring's hole is a filled circle. */
  arc: StrokeCall['arc']
}

/** Same recorder shape as text/block.mjs's and value/tile.mjs's own suites (captures the colour a
 *  fillText call was actually painted with), extended with enough of the portable drawing subset subset's path/stroke
 *  ops for a ring or a bar to record what it stroked/filled and with which colour. */
function recorder() {
  const calls: Call[] = []
  const strokes: StrokeCall[] = []
  const fills: FillCall[] = []
  let lastArc: StrokeCall['arc'] = null
  let lastRect: FillCall['rect'] = null
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '',
    fillText: (text: string) => calls.push({ fillStyle: g.fillStyle, text }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => {}, closePath: () => {},
    arc: (cx: number, cy: number, r: number, start: number, end: number) => { lastArc = { cx, cy, r, start, end } },
    rect: (x: number, y: number, w: number, h: number) => { lastRect = { x, y, w, h } },
    stroke: () => strokes.push({ style: g.strokeStyle, arc: lastArc }),
    fill: () => fills.push({ style: g.fillStyle, rect: lastRect, arc: lastArc }),
  }
  return { g, calls, strokes, fills }
}

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim', info: '#info', warn: '#warn', critical: '#crit' },
  config: { path: 'v', min: 0, max: 100, label: 'CPU', unit: '%' },
  data: { v: 50 },
  box: { w: 300, h: 200, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

describe('gauge designs', () => {
  it('offers ring and bar as two designs of one widget', async () => {
    // @ts-expect-error plain JS module without types
    const bar = (await import('../static/device/widgets/gauge/bar.mjs')).default
    expect(ring.meta.widget).toBe('gauge')
    expect(bar.meta.widget).toBe('gauge')
    expect(ring.meta.id).toBe('ring')
  })

  it('maps a value onto its range as a 0..1 fraction', () => {
    expect(normalizeGauge({ v: 50 }, { path: 'v', min: 0, max: 100 }).fraction).toBe(0.5)
  })

  it('clamps a value beyond the range rather than overdrawing the arc', () => {
    expect(normalizeGauge({ v: 150 }, { path: 'v', min: 0, max: 100 }).fraction).toBe(1)
    expect(normalizeGauge({ v: -20 }, { path: 'v', min: 0, max: 100 }).fraction).toBe(0)
  })

  // The component contract's own given test spells thresholds as flat `warn`/`crit` config keys. That
  // disagrees with `gaugeConfig`'s real, existing shape (layout-core.mjs) — thresholds nested
  // under `thresholds: { warn, crit }` — which is also what the server's save schema enforces
  // (hub/src/routes/admin.ts's `gauge` branch: `additionalProperties: false` with a nested
  // `thresholds` object; a flat top-level `warn` would 400 on save). The test uses the real nested
  // shape, matching the screen state's `align` default and the save schema.
  it('reports severity from the configured thresholds', () => {
    const cfg = { path: 'v', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } }
    expect(normalizeGauge({ v: 50 }, cfg).severity).toBe('info')
    expect(normalizeGauge({ v: 75 }, cfg).severity).toBe('warn')
    expect(normalizeGauge({ v: 95 }, cfg).severity).toBe('critical')
  })

  it('draws an EMPTY track for a non-numeric value, never a coloured one', () => {
    const g = normalizeGauge({ v: 'oops' }, { path: 'v', min: 0, max: 100, crit: 90 })
    expect(g.fraction).toBe(0)
    expect(g.severity).toBe('info')
  })
})

describe('normalizeGauge — every gaugeConfig knob carried over', () => {
  it('reads thresholds nested under `thresholds`, matching gaugeConfig\'s own shape', () => {
    const cfg = { path: 'v', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } }
    expect(normalizeGauge({ v: 95 }, cfg).severity).toBe('critical')
  })

  it('defaults min/max to 0/100, the same defaults gaugeConfig has always used', () => {
    expect(normalizeGauge({ v: 50 }, { path: 'v' }).fraction).toBe(0.5)
  })

  it('carries label and unit through untouched, empty string when absent', () => {
    expect(normalizeGauge({ v: 1 }, { path: 'v', label: 'CPU', unit: '%' }).label).toBe('CPU')
    expect(normalizeGauge({ v: 1 }, { path: 'v', label: 'CPU', unit: '%' }).unit).toBe('%')
    expect(normalizeGauge({ v: 1 }, { path: 'v' }).label).toBe('')
    expect(normalizeGauge({ v: 1 }, { path: 'v' }).unit).toBe('')
  })

  it('rounds the displayed value to `decimals`, unset means no forced rounding', () => {
    expect(normalizeGauge({ v: 41.2731 }, { path: 'v', decimals: 1 }).value).toBe('41.3')
    expect(normalizeGauge({ v: 41.2731 }, { path: 'v' }).value).toBe('41.2731')
  })

  it('shows an em-dash for a non-numeric resolved value, never the raw string', () => {
    expect(normalizeGauge({ v: 'busy' }, { path: 'v' }).value).toBe('—')
  })

  it('is unavailable (non-numeric) when the bound path resolves to nothing', () => {
    expect(normalizeGauge({}, { path: 'v' }).available).toBe(false)
    expect(normalizeGauge({ v: 1 }, { path: 'v' }).available).toBe(true)
  })

  it('clamps scale into the shared 0.5-2 range', () => {
    expect(normalizeGauge({ v: 1 }, { path: 'v', scale: 9 }).scale).toBe(2)
    expect(normalizeGauge({ v: 1 }, { path: 'v', scale: 0.1 }).scale).toBe(0.5)
  })

  it('reads the newest row on a stream feed (array-shaped data), like feedScalarSource', () => {
    expect(normalizeGauge([{ v: 1 }, { v: 2 }], { path: 'v', min: 0, max: 10 }).fraction).toBe(0.1)
  })

  it('never reports gauge has no format knob — always raw, unlike value_tile', () => {
    // gaugeConfig has never accepted `format`; the old DOM branch always called
    // displayValue(raw, 'raw', cfg.decimals). Passing `format: 'abbrev'` must have no effect.
    expect(normalizeGauge({ v: 12_000 }, { path: 'v', format: 'abbrev' }).value).toBe('12000')
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

describe('ring.meta', () => {
  it('declares its colour tokens, including the themeable hole', () => {
    expect(Object.keys(ring.meta.tokens).sort())
      .toEqual(['critical', 'dim', 'hole', 'info', 'ink', 'warn'])
  })

  it('declares label, unit, min, max, decimals — and warn/crit, by path', () => {
    expect(Object.keys(ring.meta.options).sort())
      .toEqual(['crit', 'decimals', 'label', 'max', 'min', 'unit', 'warn'])
  })
})

/**
 * `thresholds.warn`/`.crit` were the contract's headline example of a knob `meta.options` could not
 * express: they nest, and until `path` arrived a generated field only ever wrote a flat top-level
 * key. They were hand-built in `CellConfig.tsx` (`renderGaugeThresholds`) instead, which is now
 * deleted — so these declarations are the only thing standing between an operator and the
 * thresholds, and the path has to be exactly what `gaugeConfig` reads and what
 * `hub/src/routes/admin.ts`'s `gauge` branch accepts (`thresholds`, `additionalProperties: false`).
 *
 * Asserted on BOTH designs: they share `normalizeGauge`, so which design a cell picks must not
 * change which thresholds it can set.
 */
describe('gauge thresholds are declared, not hand-built', () => {
  for (const [name, design] of [['ring', ring], ['bar', bar]] as const) {
    it(`${name} points warn/crit at config.thresholds`, () => {
      expect(design.meta.options.warn.path).toBe('thresholds.warn')
      expect(design.meta.options.crit.path).toBe('thresholds.crit')
      expect(design.meta.options.warn.type).toBe('number')
      expect(design.meta.options.crit.type).toBe('number')
    })

    // No default, for the same reason `decimals` has none: `normalizeGauge` reads an absent
    // threshold as `null`, meaning "no threshold — severity can never be anything but info", which
    // is not a number either could hold. A placebo `0` in the generated field would be
    // indistinguishable from an operator who typed 0 on purpose, and 0 is a real threshold.
    it(`${name} declares no default for warn/crit, matching "no threshold at all"`, () => {
      expect(normalizeGauge(50, { path: '', min: 0, max: 100 }).severity).toBe('info')
      expect('default' in design.meta.options.warn).toBe(false)
      expect('default' in design.meta.options.crit).toBe(false)
    })
  }
})

describe('ring draw', () => {
  it('shows the label, value and unit', () => {
    const { g, calls } = recorder()
    ring.draw(g, baseCtx())
    expect(calls.map((c) => c.text)).toEqual(expect.arrayContaining(['CPU', '50', '%']))
  })

  it('strokes the fill arc in the info colour below the warn threshold', () => {
    const { g, strokes } = recorder()
    ring.draw(g, baseCtx({ config: { path: 'v', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } } }))
    const filled = strokes.filter((s) => s.arc && Math.abs(s.arc.end - s.arc.start) < Math.PI * 2)
    expect(filled.some((s) => s.style === '#info')).toBe(true)
    expect(filled.every((s) => s.style !== '#warn' && s.style !== '#crit')).toBe(true)
  })

  it('strokes the fill arc in the critical colour at/above the crit threshold', () => {
    const { g, strokes } = recorder()
    ring.draw(g, baseCtx({
      config: { path: 'v', min: 0, max: 100, thresholds: { warn: 70, crit: 90 } },
      data: { v: 95 },
    }))
    const filled = strokes.filter((s) => s.arc && Math.abs(s.arc.end - s.arc.start) < Math.PI * 2)
    expect(filled.some((s) => s.style === '#crit')).toBe(true)
  })

  it('draws no visible fill arc for a non-numeric value — an EMPTY track', () => {
    const { g, strokes } = recorder()
    ring.draw(g, baseCtx({ data: { v: 'oops' } }))
    // Only the full-circle background track strokes (sweep === 2π); no partial-sweep fill arc.
    const partial = strokes.filter((s) => s.arc && Math.abs(s.arc.end - s.arc.start) < Math.PI * 2)
    expect(partial).toEqual([])
    expect(strokes.some((s) => s.style === '#dim')).toBe(true)
  })

  it('shows the unit only alongside a real number, never next to the em-dash', () => {
    const { g, calls } = recorder()
    ring.draw(g, baseCtx({ data: { v: 'oops' } }))
    expect(calls.some((c) => c.text === '—')).toBe(true)
    expect(calls.some((c) => c.text === '%')).toBe(false)
  })
})

describe('ring draw reflects ctx.stale / ctx.age_ms (widget contract)', () => {
  it('shows the age caption for a bound feed even when fresh (stale: false)', () => {
    const { g, calls } = recorder()
    ring.draw(g, baseCtx({ stale: false, age_ms: 5_000 }))
    const texts = calls.map((c) => c.text)
    expect(texts).toContain(formatAge(5_000))
    expect(calls.find((c) => c.text === '50')?.fillStyle).toBe('#ink')
    expect(calls.find((c) => c.text === formatAge(5_000))?.fillStyle).toBe('#dim')
  })

  it('dims the value and keeps the age caption once the bound value is stale', () => {
    const { g, calls } = recorder()
    ring.draw(g, baseCtx({ stale: true, age_ms: 5 * 60_000 }))
    expect(calls.find((c) => c.text === '50')?.fillStyle).toBe('#dim')
    expect(calls.some((c) => c.text === formatAge(5 * 60_000))).toBe(true)
  })

  it('shows no caption and never dims with no feed bound (age_ms: null)', () => {
    const { g, calls } = recorder()
    ring.draw(g, baseCtx({ stale: false, age_ms: null }))
    expect(calls.some((c) => /ago|now/.test(c.text))).toBe(false)
    expect(calls.find((c) => c.text === '50')?.fillStyle).toBe('#ink')
  })

  it('does not dim the track colouring when stale — only the value text dims', () => {
    const { g, strokes } = recorder()
    ring.draw(g, baseCtx({ stale: true, age_ms: 1_000 }))
    const filled = strokes.filter((s) => s.arc && s.arc.start !== s.arc.end)
    expect(filled.some((s) => s.style === '#info')).toBe(true)
  })

  it('tolerates a ctx with no stale/age_ms fields at all, same as the portable-subset harness sends', () => {
    const { g, calls } = recorder()
    const ctx = baseCtx()
    delete (ctx as Record<string, unknown>).stale
    delete (ctx as Record<string, unknown>).age_ms
    expect(() => ring.draw(g, ctx)).not.toThrow()
    expect(calls.some((c) => /ago|now/.test(c.text))).toBe(false)
  })
})

describe('bar design', () => {
  it('fills a rectangle sized to the fraction, in the resolved severity colour', async () => {
    // @ts-expect-error plain JS module without types
    const bar = (await import('../static/device/widgets/gauge/bar.mjs')).default
    const { g, fills } = recorder()
    bar.draw(g, baseCtx({ config: { path: 'v', min: 0, max: 100, thresholds: { warn: 40 } }, data: { v: 50 } }))
    const filled = fills.filter((f) => f.rect && f.rect.w > 0)
    expect(filled.some((f) => f.style === '#warn')).toBe(true)
  })

  /**
   * Two designs of one widget must offer the operator the same knobs — a cell that switches from
   * bar to ring should not silently lose a setting. Colour tokens are the design's own geometry
   * vocabulary and may legitimately differ: `ring` declares `hole` for the centre it paints, and a
   * bar has no centre to paint. So options are pinned equal, tokens only up to that difference.
   */
  it('offers the same options as ring, and the same tokens bar its hole', async () => {
    // @ts-expect-error plain JS module without types
    const bar = (await import('../static/device/widgets/gauge/bar.mjs')).default
    expect(Object.keys(bar.meta.options).sort()).toEqual(Object.keys(ring.meta.options).sort())
    expect(Object.keys(bar.meta.tokens).sort())
      .toEqual(Object.keys(ring.meta.tokens).filter((k) => k !== 'hole').sort())
    expect(Object.keys(ring.meta.tokens)).toContain('hole')
    expect(Object.keys(bar.meta.tokens)).not.toContain('hole')
    expect(bar.meta.widget).toBe('gauge')
    expect(bar.meta.id).toBe('bar')
  })
})

/**
 * The ring's hole is controlled by a declared design token. Canvas designs cannot read the
 * `--gauge-hole` chrome key, so the token keeps the board showing through by default while allowing
 * a theme to choose another colour.
 *
 * A canvas design cannot read chrome at all — `resolveTokens` resolves against the BOARD palette —
 * so the capability comes back the way every other design colour does: a declared token. Defaulting
 * it to `@bg` reproduces exactly what an unpainted hole looked like (the board showing through), so
 * no existing board changes; a theme that wants a different hole now has a slot to set.
 */
describe('gauge ring hole', () => {
  it('declares a hole token defaulting to the board background', () => {
    expect(ring.meta.tokens.hole).toEqual({ type: 'color', default: '@bg' })
  })

  it('fills the hole with its themed colour, inside the track it draws', () => {
    const r = recorder()
    ring.draw(r.g, baseCtx({
      tokens: { ink: '#ink', dim: '#dim', info: '#info', warn: '#warn', critical: '#crit', hole: '#hole' },
    }), 0)

    const hole = r.fills.find((f) => f.style === '#hole')
    expect(hole, 'the hole should be painted with the declared token').toBeTruthy()
    expect(hole?.arc, 'the hole is a filled circle, not a rect').toBeTruthy()

    const track = r.strokes.find((s) => s.style === '#dim')
    expect(track?.arc).toBeTruthy()
    // Concentric with the track, and strictly inside it — otherwise it would paint over the ring.
    expect(hole!.arc!.cx).toBe(track!.arc!.cx)
    expect(hole!.arc!.cy).toBe(track!.arc!.cy)
    expect(hole!.arc!.r).toBeLessThan(track!.arc!.r)
  })
})
