import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { GLYPH_H, GLYPH_W, glyphFor, LED_FALLBACK, ledCoverage } from '../static/device/widgets/text/led-font.mjs'
// @ts-expect-error plain JS module without types
import led, { hueAt, ledConfig, ledLines, litAt, borderBulbs, bulbLit, revealAt } from '../static/device/widgets/text/led.mjs'

/**
 * `text_block`/`led` — a dot-matrix sign, and the font table it paints with.
 *
 * The font is the part worth pinning hardest: it is DATA, and a typo in it is a glyph that renders
 * as garbage on a wall with nothing to catch it. So every glyph is checked for shape (5×7, nothing
 * but lit/unlit), the documented character set is checked for presence, and anything outside that
 * set must resolve to the fallback box rather than to `undefined` — a sign that cannot draw a
 * character should say so with a box, not vanish it.
 */

type Call = { fillStyle: string; x: number; y: number; w: number; h: number }

function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: () => {},
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {},
    arc: (x: number, y: number, r: number) => calls.push({ fillStyle: g.fillStyle, x, y, w: r * 2, h: r * 2 }),
    rect: (x: number, y: number, w: number, h: number) => calls.push({ fillStyle: g.fillStyle, x, y, w, h }),
    fill: () => {}, stroke: () => {}, save: () => {}, restore: () => {},
  }
  return { g, calls }
}

const tokens = { on: '#on', off: '#off', glow: '#glow', ink: '#ink', dim: '#dim' }
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)
const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens,
  config: { text: 'HELLO' },
  data: null,
  rows: [],
  feed: { missing: false, mode: 'value', pushed_at: NOW, image_rev: null },
  box: { w: 400, h: 120, t: 1 },
  now: NOW, state: {}, motion: 'full', stale: false, age_ms: null,
  ...overrides,
})

describe('led-font', () => {
  it('is a 5×7 matrix', () => {
    expect(GLYPH_W).toBe(5)
    expect(GLYPH_H).toBe(7)
  })

  it('gives every glyph exactly 7 rows of 5 cells, lit or unlit and nothing else', () => {
    for (const ch of ledCoverage()) {
      const rows = glyphFor(ch)
      expect(rows, `glyph ${ch}`).toHaveLength(7)
      for (const row of rows) {
        expect(row, `glyph ${ch}`).toHaveLength(5)
        expect(/^[.X]{5}$/.test(row), `glyph ${ch} row "${row}"`).toBe(true)
      }
    }
  })

  it('covers A–Z and 0–9', () => {
    const covered = new Set(ledCoverage())
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') expect(covered.has(ch), ch).toBe(true)
  })

  it('folds lowercase onto its uppercase glyph rather than dropping it', () => {
    expect(glyphFor('a')).toEqual(glyphFor('A'))
    expect(glyphFor('z')).toEqual(glyphFor('Z'))
  })

  it('draws an unknown character as the fallback box, never as nothing', () => {
    expect(glyphFor('☃')).toEqual(LED_FALLBACK)
    expect(glyphFor('')).toEqual(LED_FALLBACK)
  })

  it('leaves the space glyph completely unlit', () => {
    expect(glyphFor(' ').join('')).not.toContain('X')
  })

  it('lights at least one dot in every non-space glyph', () => {
    for (const ch of ledCoverage()) {
      if (ch === ' ') continue
      expect(glyphFor(ch).join(''), `glyph ${ch} is blank`).toContain('X')
    }
  })
})

describe('text/led design', () => {
  it('registers as a text_block design named led', () => {
    expect(led.meta.widget).toBe('text_block')
    expect(led.meta.id).toBe('led')
  })

  it('declares its knobs under led., including the colour and effect the user asked for', () => {
    const o = led.meta.options
    expect(o.lines).toMatchObject({ type: 'number', path: 'led.lines' })
    expect(o.color).toMatchObject({ type: 'text', path: 'led.color' })
    expect(o.colors).toMatchObject({ type: 'text', path: 'led.colors' })
    expect(o.effect).toMatchObject({ type: 'select', path: 'led.effect' })
    expect(o.effect.choices).toEqual(['none', 'scroll', 'blink', 'rainbow', 'wipe', 'snow'])
    expect(o.speed).toMatchObject({ type: 'number', path: 'led.speed' })
    expect(o.off_dots).toMatchObject({ type: 'boolean', path: 'led.off_dots' })
    expect(o.glow).toMatchObject({ type: 'boolean', path: 'led.glow' })
  })

  it('declares on/off/glow tokens so a theme owns the panel colours', () => {
    for (const slot of ['on', 'off', 'glow']) expect(led.meta.tokens[slot]).toBeTruthy()
  })

  describe('ledConfig', () => {
    it('defaults to one line, no effect, panel colours from the theme', () => {
      const c = ledConfig({})
      expect(c).toMatchObject({ lines: 1, effect: 'none', color: null })
    })

    it('takes a full RGB hex and normalises it', () => {
      expect(ledConfig({ led: { color: '#FF0044' } }).color).toBe('#ff0044')
      expect(ledConfig({ led: { color: 'ff0044' } }).color).toBe('#ff0044')
      expect(ledConfig({ led: { color: '#f04' } }).color).toBe('#ff0044')
    })

    it('refuses anything that is not a colour, falling back to the theme token', () => {
      expect(ledConfig({ led: { color: 'red; drop table' } }).color).toBeNull()
      expect(ledConfig({ led: { color: '#12345' } }).color).toBeNull()
    })

    it('reads a per-line colour list', () => {
      expect(ledConfig({ led: { colors: '#ff0044, #00ff88' } }).colors).toEqual(['#ff0044', '#00ff88'])
    })

    it('clamps the line count to what a sign can hold', () => {
      expect(ledConfig({ led: { lines: 99 } }).lines).toBe(6)
      expect(ledConfig({ led: { lines: 0 } }).lines).toBe(1)
    })
  })

  describe('ledLines', () => {
    it('splits the text on newlines and caps it at the configured count', () => {
      expect(ledLines('ONE\nTWO\nTHREE', 2)).toEqual(['ONE', 'TWO'])
    })

    it('keeps a single line whole', () => {
      expect(ledLines('DASHBOARDZ', 1)).toEqual(['DASHBOARDZ'])
    })
  })

  describe('effects', () => {
    /**
     * `speed` is a RATE, not a 1.0-based multiplier: it is px/s for `scroll`, and blink derives its
     * period from the same number so one knob means one thing. At the default 40 the period is
     * 1200ms — lit for the first half, dark for the second — and doubling the speed halves it.
     */
    it('blink is a pure function of time, on for half its period', () => {
      expect(litAt('blink', 0, 40)).toBe(true)
      expect(litAt('blink', 600, 40)).toBe(false)
      expect(litAt('blink', 1_200, 40)).toBe(true)
    })

    it('blinks faster when the speed goes up', () => {
      expect(litAt('blink', 300, 80)).toBe(false)
      expect(litAt('blink', 300, 40)).toBe(true)
    })

    it('leaves every other effect permanently lit', () => {
      for (const e of ['none', 'scroll', 'rainbow']) expect(litAt(e, 600, 40)).toBe(true)
    })

    it('rainbow walks the hue across the panel and around the wheel', () => {
      expect(hueAt(0, 0, 40)).toBe(0)
      expect(hueAt(10, 0, 40)).toBe(hueAt(10, 0, 40))
      expect(hueAt(0, 0, 40)).not.toBe(hueAt(20, 0, 40))
      expect(hueAt(0, 1_000, 40)).toBeGreaterThanOrEqual(0)
      expect(hueAt(0, 1_000, 40)).toBeLessThan(360)
    })
  })

  describe('isAnimating', () => {
    it('is false with no effect — a still sign must not pin the frame loop', () => {
      expect(led.isAnimating(baseCtx({ config: { text: 'HI', led: { effect: 'none' } } }))).toBe(false)
    })

    it('is true for a moving effect', () => {
      for (const effect of ['scroll', 'blink', 'rainbow']) {
        expect(led.isAnimating(baseCtx({ config: { text: 'HI', led: { effect } } })), effect).toBe(true)
      }
    })

    it('is false under reduced motion, whatever the effect', () => {
      expect(led.isAnimating(baseCtx({ config: { text: 'HI', led: { effect: 'scroll' } }, motion: 'none' }))).toBe(false)
    })

    it('is false with nothing to show', () => {
      expect(led.isAnimating(baseCtx({ config: { text: '', led: { effect: 'blink' } } }))).toBe(false)
    })
  })

  describe('draw', () => {
    it('paints lit dots in the theme colour by default', () => {
      const { g, calls } = recorder()
      led.draw(g, baseCtx(), 0)
      expect(calls.some((c) => c.fillStyle === '#on')).toBe(true)
    })

    it('paints unlit dots too, so the panel reads as a panel', () => {
      const { g, calls } = recorder()
      led.draw(g, baseCtx({ config: { text: 'I', led: { off_dots: true } } }), 0)
      expect(calls.some((c) => c.fillStyle === '#off')).toBe(true)
    })

    it('lets a hex override the theme entirely', () => {
      const { g, calls } = recorder()
      led.draw(g, baseCtx({ config: { text: 'HI', led: { color: '#ff0044' } } }), 0)
      expect(calls.some((c) => c.fillStyle === '#ff0044')).toBe(true)
      expect(calls.some((c) => c.fillStyle === '#on')).toBe(false)
    })

    it('gives each line its own colour from the list', () => {
      const { g, calls } = recorder()
      led.draw(g, baseCtx({ config: { text: 'A\nB', led: { lines: 2, colors: '#ff0044,#00ff88' } } }), 0)
      expect(calls.some((c) => c.fillStyle === '#ff0044')).toBe(true)
      expect(calls.some((c) => c.fillStyle === '#00ff88')).toBe(true)
    })

    /**
     * The wrap. With ONE copy of the message the sign slides off the left edge and leaves dead
     * space behind it — the first render of this design read "CROLLING TEXT", the S already gone
     * and nothing coming in behind it. A second copy one span back means whatever leaves one edge
     * is entering the other, the trick `stream/ticker.mjs` uses.
     *
     * The invariant is CONTINUITY, not "something is on screen": a centred message never fully
     * exits a panel this size, so "not blank" passes against the bug. What fails against it is
     * asking for lit dots in BOTH halves of the panel at every point in the travel.
     */
    it('keeps the panel covered as it scrolls, instead of dragging a hole behind it', () => {
      const box = { w: 400, h: 120, t: 1 }
      for (const elapsed of [0, 1_000, 2_500, 4_000, 5_500, 7_000, 9_000]) {
        const { g, calls } = recorder()
        led.draw(g, baseCtx({ box, config: { text: 'HI', led: { effect: 'scroll', speed: 40, off_dots: false } } }), elapsed)
        const on = calls.filter((c) => c.fillStyle === '#on')
        const left = on.some((c) => c.x >= 0 && c.x < box.w / 2)
        const right = on.some((c) => c.x >= box.w / 2 && c.x <= box.w)
        expect(left && right, `gap at ${elapsed}ms (left ${left}, right ${right})`).toBe(true)
      }
    })

    /** The clock is `ctx.now`; `elapsedMs` restarts on every repaint and is ignored. See the ticker. */
    it('ignores elapsedMs, so a repaint does not move the sign', () => {
      const xAt = (now: number, elapsed: number) => {
        const { g, calls } = recorder()
        led.draw(g, baseCtx({ now, config: { text: 'HI', led: { effect: 'scroll', speed: 40, off_dots: false } } }), elapsed)
        return calls[0].x
      }
      expect(xAt(NOW, 0)).toBeCloseTo(xAt(NOW, 3_000), 5)
    })

    it('says so plainly when there is nothing to show', () => {
      const { g } = recorder()
      expect(() => led.draw(g, baseCtx({ config: { text: '' } }), 0)).not.toThrow()
    })

    it('survives a zero-sized box', () => {
      const { g } = recorder()
      expect(() => led.draw(g, baseCtx({ box: { w: 0, h: 0, t: 1 } }), 0)).not.toThrow()
    })

    it('draws a bound feed value, not just literal text', () => {
      const { g, calls } = recorder()
      led.draw(g, baseCtx({ config: { feed: 'f', path: 'v', led: {} }, data: { v: 'LIVE' } }), 0)
      expect(calls.some((c) => c.fillStyle === '#on')).toBe(true)
    })
  })

  /**
   * MARQUEE BULBS. The border of a real sign is not the same hardware as its matrix: bigger lamps,
   * fewer of them, running their own pattern. So it gets its own knobs (`border`, `border_color`)
   * and its own clock arithmetic, and — like everything else here — it must cost nothing when off.
   */
  describe('borderBulbs', () => {
    it('rings the panel, evenly spaced, and never fewer than the four corners', () => {
      const bulbs = borderBulbs(400, 120, 40)
      expect(bulbs.length).toBeGreaterThanOrEqual(4)
      for (const b of bulbs) {
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.x).toBeLessThanOrEqual(400)
        expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.y).toBeLessThanOrEqual(120)
      }
    })

    it('puts every bulb ON the border, never in the middle where the text lives', () => {
      const w = 400, h = 120, inset = 8
      for (const b of borderBulbs(w, h, 40, inset)) {
        const onEdge = Math.abs(b.x - inset) < 1 || Math.abs(b.x - (w - inset)) < 1
          || Math.abs(b.y - inset) < 1 || Math.abs(b.y - (h - inset)) < 1
        expect(onEdge, `bulb at ${b.x},${b.y} is not on the edge`).toBe(true)
      }
    })

    it('scales its count with the panel rather than the other way round', () => {
      expect(borderBulbs(800, 240, 40).length).toBeGreaterThan(borderBulbs(200, 80, 40).length)
    })

    it('survives a degenerate box', () => {
      expect(borderBulbs(0, 0, 40)).toEqual([])
      expect(borderBulbs(400, 120, 0)).toEqual([])
    })
  })

  describe('bulbLit', () => {
    it('chase lights a run that travels around the ring', () => {
      const at = (clock: number) => Array.from({ length: 6 }, (_, i) => bulbLit('chase', i, 6, clock, 40))
      const first = at(0)
      const later = at(1_000)
      expect(first).not.toEqual(later)          // it moved
      expect(first.filter(Boolean).length).toBe(later.filter(Boolean).length)  // same run length
      expect(first.filter(Boolean).length).toBeGreaterThan(0)
    })

    it('chase comes back around: one full cycle is identical', () => {
      // 3-bulb period at the default rate of 5 steps/s => 600ms per full cycle.
      expect(bulbLit('chase', 0, 6, 0, 40)).toBe(bulbLit('chase', 0, 6, 600, 40))
    })

    it('blink turns the whole ring on and off together', () => {
      const ring = (clock: number) => Array.from({ length: 6 }, (_, i) => bulbLit('blink', i, 6, clock, 40))
      expect(new Set(ring(0)).size).toBe(1)
      expect(ring(0)[0]).not.toBe(ring(200)[0])
    })

    it('alternate swaps odds and evens', () => {
      expect(bulbLit('alternate', 0, 6, 0, 40)).not.toBe(bulbLit('alternate', 1, 6, 0, 40))
      expect(bulbLit('alternate', 0, 6, 0, 40)).not.toBe(bulbLit('alternate', 0, 6, 200, 40))
    })

    it('is dark for an unknown or absent mode, so a typo cannot light the ring', () => {
      expect(bulbLit('none', 0, 6, 0, 40)).toBe(false)
      expect(bulbLit('sparkle', 0, 6, 0, 40)).toBe(false)
      expect(bulbLit(undefined, 0, 6, 0, 40)).toBe(false)
    })
  })

  describe('the border on a real draw', () => {
    it('declares the knobs', () => {
      expect(led.meta.options.border).toMatchObject({ type: 'select', path: 'led.border' })
      expect(led.meta.options.border.choices).toEqual(['none', 'chase', 'blink', 'alternate'])
      expect(led.meta.options.border_color).toMatchObject({ type: 'text', path: 'led.border_color' })
    })

    it('paints nothing extra when the border is off', () => {
      const plain = (() => { const { g, calls } = recorder(); led.draw(g, baseCtx(), 0); return calls.length })()
      const bordered = (() => {
        const { g, calls } = recorder()
        led.draw(g, baseCtx({ config: { text: 'HELLO', led: { border: 'chase' } } }), 0)
        return calls.length
      })()
      expect(bordered).toBeGreaterThan(plain)
    })

    it('paints the bulbs in their own colour when one is given', () => {
      const { g, calls } = recorder()
      led.draw(g, baseCtx({ config: { text: 'HI', led: { border: 'chase', border_color: '#ff0044' } } }), 0)
      expect(calls.some((c) => c.fillStyle === '#ff0044')).toBe(true)
    })

    it('keeps the frame loop alive for a border effect even when the text is still', () => {
      expect(led.isAnimating(baseCtx({ config: { text: 'HI', led: { effect: 'none', border: 'chase' } } }))).toBe(true)
      expect(led.isAnimating(baseCtx({ config: { text: 'HI', led: { effect: 'none', border: 'none' } } }))).toBe(false)
    })
  })

  /**
   * ENTRY EFFECTS, the vocabulary every programmable sign ships with (`snow`, `scan`/wipe, `hold`).
   * Both of these are per-DOT reveals rather than whole-panel moves, so they are a pure function of
   * the dot's position and the clock — no state, testable, identical on every device.
   */
  describe('revealAt', () => {
    it('shows everything for effects that are not reveals', () => {
      for (const e of ['none', 'scroll', 'blink', 'rainbow']) {
        expect(revealAt(e, 3, 2, 0, 40, 40, 7)).toBe(true)
      }
    })

    describe('wipe', () => {
      it('reveals left to right as the clock runs', () => {
        expect(revealAt('wipe', 0, 0, 0, 40, 40, 7)).toBe(true)
        expect(revealAt('wipe', 39, 0, 0, 40, 40, 7)).toBe(false)
        // A 40-column sweep at 40 px/s takes ~1.2s, so 1s in the front is at column 40.
        expect(revealAt('wipe', 39, 0, 1_000, 40, 40, 7)).toBe(true)
      })

      it('repeats: the front comes back around', () => {
        const period = ((40 + 8) / 40) * 1000
        expect(revealAt('wipe', 20, 0, 0, 40, 40, 7)).toBe(revealAt('wipe', 20, 0, period, 40, 40, 7))
      })
    })

    describe('snow', () => {
      it('assembles the message over a cycle rather than all at once', () => {
        const shown = (clock: number) => {
          let n = 0
          for (let x = 0; x < 40; x++) for (let y = 0; y < 7; y++) if (revealAt('snow', x, y, clock, 40, 40, 7)) n++
          return n
        }
        const early = shown(200)
        const late = shown(2_600)
        expect(early).toBeGreaterThan(0)
        expect(early).toBeLessThan(280)
        expect(late).toBeGreaterThan(early)
      })

      it('is deterministic — the same dot at the same instant, every time and every device', () => {
        expect(revealAt('snow', 7, 3, 1_234, 40, 40, 7)).toBe(revealAt('snow', 7, 3, 1_234, 40, 40, 7))
      })

      it('scatters: neighbours do not land together', () => {
        const row = Array.from({ length: 20 }, (_, x) => revealAt('snow', x, 0, 900, 40, 40, 7))
        expect(new Set(row).size).toBe(2)
      })
    })
  })

  it('offers the sign vocabulary a real panel has', () => {
    expect(led.meta.options.effect.choices).toEqual(['none', 'scroll', 'blink', 'rainbow', 'wipe', 'snow'])
  })
})
