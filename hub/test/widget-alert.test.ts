import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import feed, { normalizeAlertFeed } from '../static/device/widgets/alert/feed.mjs'
// @ts-expect-error plain JS module without types
import { FEED_CARD, FEED_COUNTER, cardPlan, feedConfig } from '../static/device/layout-core.mjs'

type Call = { fillStyle: string; text: string; x: number; y: number; align: string; font: string }
type Rect = { fillStyle: string; x: number; y: number; w: number; h: number }

/**
 * Same recorder shape as stream/list.mjs's and table/grid.mjs's suites, plus a RECORDING fillRect
 * rather than those files' `() => {}` stub — this design paints the severity stripe as a rect, so
 * a no-op stub would throw away the very thing the severity assertions need to see. Also captures
 * `x` (those sibling suites don't need it): the meta-line overlap regression below has to reconstruct
 * each painted string's actual left/right pixel extent from `x`, `align` and the mocked measured
 * width, not just confirm text got painted. `font` rides along for the same reason the sibling
 * suites capture it: a size regression in a SHARED text-fit helper has to fail in the designs that
 * depend on it, not only in the helper's own suite (see the quiet-line size test below).
 */
function recorder() {
  const calls: Call[] = []
  const rects: Rect[] = []
  let pending: { x: number; y: number; w: number; h: number } | null = null
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string, x: number, y: number) =>
      calls.push({ fillStyle: g.fillStyle, text, x, y, align: g.textAlign, font: g.font }),
    // `rect` + `fill`, because `fillRect` is outside the portable drawing subset portable subset — the pending rect is
    // captured on `rect` and committed on `fill`, which is the same order the design issues them.
    beginPath: () => { pending = null },
    rect: (x: number, y: number, w: number, h: number) => { pending = { x, y, w, h } },
    fill: () => { if (pending) rects.push({ fillStyle: g.fillStyle, ...pending }); pending = null },
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
  }
  return { g, calls, rects }
}

const alert = (over: Record<string, unknown> = {}) => ({
  id: 'al_1', severity: 'warn', title: 'Disk almost full', body: 'root is at 91%',
  sender: { name: 'monitor' }, updated_at: 0, ...over,
})

const baseCtx = (over: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim', info: '#info', warn: '#warn', critical: '#critical' },
  config: {},
  data: null,
  rows: null,
  alerts: [alert()],
  box: { w: 300, h: 400, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...over,
})

const texts = (calls: Call[]) => calls.map((c) => c.text)

describe('alert_feed design: registry shape', () => {
  it('meta matches the widget/design ids the registry and definitions expect', () => {
    expect(feed.meta.widget).toBe('alert_feed')
    expect(feed.meta.id).toBe('feed')
  })

  it('declares min_severity flat and the three nested knobs by path', () => {
    expect(Object.keys(feed.meta.options ?? {}).sort())
      .toEqual(['body_lines', 'body_scale', 'counter', 'min_severity', 'title_lines'])
    expect(feed.meta.options.min_severity.type).toBe('select')
    // `min_severity` has no `path` on purpose: it IS a top-level key, and declaring
    // `path: 'min_severity'` would be a second spelling of the same thing.
    expect(feed.meta.options.min_severity.path).toBeUndefined()
  })

  /**
   * The nested knobs `meta.options` could not name until it gained `path`. These write
   * `config.clamp.title_lines`/`.body_lines` and `config.overflow.counter` — the exact shape
   * `hub/src/routes/admin.ts`'s `alert_feed` branch accepts (`additionalProperties: false` on both
   * sub-objects) and the exact keys `feedConfig` reads. Pinned per option rather than as a set,
   * because a typo in one path is a knob that saves into a key nothing renders.
   */
  it('points the clamp and overflow knobs at the paths feedConfig actually reads', () => {
    expect(feed.meta.options.title_lines.path).toBe('clamp.title_lines')
    expect(feed.meta.options.body_lines.path).toBe('clamp.body_lines')
    expect(feed.meta.options.counter.path).toBe('overflow.counter')
  })

  // `sound_info` is read by the Android app (Chime.kt), never by this design. Declaring it would
  // let the generated form start writing a key whose meaning lives outside the renderer.
  it('never declares sound_info, whatever else it declares', () => {
    expect(feed.meta.options.sound_info).toBeUndefined()
  })

  /**
   * Unset must LOOK like what the panel draws. The generated field shows `default` when the config
   * has nothing at that path, so a default disagreeing with `feedConfig`'s own would tell the
   * operator one thing and paint another.
   */
  it('defaults the clamp and overflow knobs to exactly what feedConfig defaults them to', () => {
    const drawn = feedConfig({})
    expect(feed.meta.options.title_lines.default).toBe(drawn.titleLines)
    expect(feed.meta.options.body_lines.default).toBe(drawn.bodyLines)
    expect(feed.meta.options.counter.default).toBe(drawn.counter)
  })

  // The generated select can only ever offer what it lists, and feedConfig silently coerces
  // anything outside its own set back to 'info'. A choice list that drifted from that set would
  // put an option in the editor that saves and then renders as something else.
  it('offers exactly the severities feedConfig accepts, in rank order', () => {
    expect(feed.meta.options.min_severity.choices).toEqual(['info', 'warn', 'critical'])
    expect(feed.meta.options.min_severity.default).toBe('info')
  })

  it('declares a colour token per severity, so no design reads a CSS variable', () => {
    expect(Object.keys(feed.meta.tokens).sort()).toEqual(['critical', 'dim', 'info', 'ink', 'warn'])
    expect(feed.meta.tokens.info.default).toBe('@info')
    expect(feed.meta.tokens.warn.default).toBe('@warn')
    expect(feed.meta.tokens.critical.default).toBe('@critical')
  })
})

/**
 * `sound_info` is read by ANDROID (`Chime.kt`'s `screenChimesInfo`) off the screen definition, to
 * decide whether an `info` alert is audible. It rides on this widget's config but is not a
 * rendering knob. The renderer must not consume it, drop it, or move it — breaking that silently
 * breaks the alarm path, with nothing on the panel to show for it.
 */
describe('alert_feed design: sound_info is not the renderer\'s business', () => {
  it('normalizes identically whether sound_info is true, false or absent', () => {
    const alerts = [alert()]
    const on = normalizeAlertFeed(alerts, { sound_info: true })
    const off = normalizeAlertFeed(alerts, { sound_info: false })
    const absent = normalizeAlertFeed(alerts, {})
    expect(on).toEqual(absent)
    expect(off).toEqual(absent)
  })

  it('never carries sound_info onto the normalized view model', () => {
    expect(normalizeAlertFeed([alert()], { sound_info: true })).not.toHaveProperty('sound_info')
  })

  it('offers no generated option for it — a generated field would write the key the app reads', () => {
    expect(feed.meta.options).not.toHaveProperty('sound_info')
  })

  it('draws identical pixels with sound_info on and off', () => {
    const a = recorder()
    const b = recorder()
    feed.draw(a.g, baseCtx({ config: { sound_info: true } }))
    feed.draw(b.g, baseCtx({ config: { sound_info: false } }))
    expect(a.calls).toEqual(b.calls)
  })
})

describe('normalizeAlertFeed: filtering and ordering', () => {
  it('an empty alert list is the "empty" state', () => {
    expect(normalizeAlertFeed([], {}).state).toBe('empty')
  })

  it('a non-array (a widget painted before any STATE arrived) is empty, never a throw', () => {
    expect(normalizeAlertFeed(null, {}).state).toBe('empty')
    expect(normalizeAlertFeed(undefined, {}).state).toBe('empty')
  })

  it('filters below min_severity, and everything at or above it survives', () => {
    const alerts = [
      alert({ id: 'i', severity: 'info' }),
      alert({ id: 'w', severity: 'warn' }),
      alert({ id: 'c', severity: 'critical' }),
    ]
    expect(normalizeAlertFeed(alerts, { min_severity: 'info' }).cards).toHaveLength(3)
    expect(normalizeAlertFeed(alerts, { min_severity: 'warn' }).cards).toHaveLength(2)
    expect(normalizeAlertFeed(alerts, { min_severity: 'critical' }).cards).toHaveLength(1)
  })

  it('filtering everything out is the empty state, not a zero-card ready state', () => {
    expect(normalizeAlertFeed([alert({ severity: 'info' })], { min_severity: 'critical' }).state).toBe('empty')
  })

  it('orders newest first by updated_at, regardless of input order', () => {
    const alerts = [
      alert({ id: 'old', title: 'old', updated_at: 1_000 }),
      alert({ id: 'new', title: 'new', updated_at: 9_000 }),
      alert({ id: 'mid', title: 'mid', updated_at: 5_000 }),
    ]
    expect(normalizeAlertFeed(alerts, {}).cards.map((c: { title: string }) => c.title))
      .toEqual(['new', 'mid', 'old'])
  })

  it('carries the nested knobs through from feedConfig', () => {
    const n = normalizeAlertFeed([alert()], {
      clamp: { title_lines: 3, body_lines: 4 }, overflow: { counter: false }, scale: 1.5,
    })
    expect(n.titleLines).toBe(3)
    expect(n.bodyLines).toBe(4)
    expect(n.counter).toBe(false)
    expect(n.scale).toBe(1.5)
  })

  it('a malformed alert degrades to defaults rather than throwing', () => {
    const n = normalizeAlertFeed([{ severity: 'warn', updated_at: 0 }], {})
    expect(n.state).toBe('ready')
    expect(n.cards[0].sender).toBe('')
    expect(n.cards[0].title).toBe('')
    expect(n.cards[0].body).toBeNull()
  })
})

/**
 * The meta line's relative time comes from device.js's own `ago()` — `45s` / `3m` / `2h`, with
 * Math.ROUND and no " ago" suffix. That is NOT `ageChip`/`formatAge`'s wording (`now`, `3m ago`,
 * with Math.FLOOR), which `stream_list` and `news_list` reuse because THEIR DOM branches called
 * `ageChip`. Reusing the shared helper here would look like consolidation and would silently
 * change what the wall shows, so these pin `ago`'s exact output.
 */
describe('alert card age: device.js\'s ago(), not ageChip\'s wording', () => {
  const ageOf = (ms: number) => normalizeAlertFeed([alert({ updated_at: 0 })], {}, ms).cards[0].age

  it('under a minute reads in seconds, never "now"', () => {
    expect(ageOf(0)).toBe('0s')
    expect(ageOf(45_000)).toBe('45s')
  })

  it('rounds rather than floors, and carries no " ago" suffix', () => {
    expect(ageOf(150_000)).toBe('3m')
    expect(ageOf(5_400_000)).toBe('2h')
  })

  it('never goes negative when an alert is stamped in the future', () => {
    expect(normalizeAlertFeed([alert({ updated_at: 10_000 })], {}, 0).cards[0].age).toBe('0s')
  })
})

describe('alert_feed draw: states', () => {
  it('paints the empty notice verbatim as the DOM branch worded it', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({ alerts: [] }))
    expect(texts(calls)).toContain('no active alerts')
  })

  /**
   * THE SIZE of that notice, not just its wording. `quietLine` lives in the shared `text-fit.mjs`
   * with `stream/list.mjs`, `table/grid.mjs` and `image/frame.mjs`, and a mutation to its `px`
   * formula during that consolidation failed only the helper's own suite: every design pinned this
   * line's TEXT and `tokens.dim` COLOUR and nothing else, so a shared-helper size regression
   * reached four widgets with no design-level signal.
   *
   * `400 12px system-ui` at this box: `Math.min(16, box.w * 0.04) * scale` = `min(16, 300*0.04)` =
   * 12 at `n.scale` 1. The scaled half is this design's own contribution: `alert_feed` gained a
   * real `scale` knob and hands it to `quietLine`, so scale 2
   * doubles the line to 24px — unlike `image/frame.mjs`, which passes a literal `1` because it has
   * no scale knob at all.
   */
  it('paints the empty notice at the shared helper\'s size, and moves it with its own scale knob', () => {
    const unscaled = recorder()
    feed.draw(unscaled.g, baseCtx({ alerts: [] }))
    expect(unscaled.calls.find((c) => c.text === 'no active alerts')?.font).toBe('400 12px system-ui')

    const scaled = recorder()
    feed.draw(scaled.g, baseCtx({ alerts: [], config: { scale: 2 } }))
    expect(scaled.calls.find((c) => c.text === 'no active alerts')?.font).toBe('400 24px system-ui')
  })

  it('paints a card per alert: sender and severity uppercased, then title and body', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx())
    expect(texts(calls)).toEqual(expect.arrayContaining([
      expect.stringContaining('MONITOR'), expect.stringContaining('WARN'),
      'Disk almost full', 'root is at 91%',
    ]))
  })

  it('stripes the card in the severity token, never a CSS variable', () => {
    const critical = recorder()
    feed.draw(critical.g, baseCtx({ alerts: [alert({ severity: 'critical' })] }))
    expect(critical.rects.map((r) => r.fillStyle)).toContain('#critical')

    const warn = recorder()
    feed.draw(warn.g, baseCtx({ alerts: [alert({ severity: 'warn' })] }))
    expect(warn.rects.map((r) => r.fillStyle)).toContain('#warn')

    const used = [...critical.rects, ...critical.calls].map((c) => String(c.fillStyle))
    expect(used.every((c) => !c.includes('var('))).toBe(true)
  })

  it('falls back to the info token for a severity it does not recognise', () => {
    const { g, rects } = recorder()
    feed.draw(g, baseCtx({ alerts: [alert({ severity: 'catastrophic' })] }))
    expect(rects.map((r) => r.fillStyle)).toContain('#info')
  })

  /**
   * The layout invariant: both the sender/severity string and the age use separate widths rather than
   * be painted with `maxWidth: usableWidth` — the FULL text column, not "whatever room the age left
   * behind" — so a long sender was never clipped near the age, and the right-aligned age landed
   * directly on top of it. Observed on a real panel: sender `MESHTASTIC-MONITOR`, severity `INFO`,
   * age `0m` rendered as `MESHTASTIC-MONITOR · INF0m`, the age's `0m` overlapping the severity's `O`.
   * The widget's own sizing gate does not expose it when its fixture sender (`OPENCLAW`) is short
   * enough to fit.
   *
   * A test that only asserts "both strings got painted" is insufficient — that was true even while
   * they overlapped. This reconstructs each string's actual painted pixel extent from the recorded
   * `x`/`align` and the recorder's deterministic `measureText` (`text.length * 8`), and asserts the
   * sender/severity string's right edge never reaches the age's left edge. The box below is sized so
   * the sender's full, unclipped width would reach the age without the reserved gap, while the
   * current layout keeps room to spare.
   */
  it('never lets the sender/severity string reach the age painted on the same line', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({
      alerts: [alert({ sender: { name: 'meshtastic-monitor' }, severity: 'info', updated_at: 0 })],
      box: { w: 240, h: 400, t: 1 },
      now: 0,
    }))

    const width = (text: string) => Array.from(text).length * 8
    const meta = calls.find((c) => c.text.startsWith('MESHTASTIC'))
    const age = calls.find((c) => c.align === 'right')
    if (!meta || !age) throw new Error('expected both the meta line and the age to be painted')

    const metaRightEdge = meta.x + width(meta.text)
    const ageLeftEdge = age.x - width(age.text)
    expect(metaRightEdge).toBeLessThanOrEqual(ageLeftEdge)
  })

  it('omits the body line entirely when the alert has none', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({ alerts: [alert({ body: null })] }))
    expect(texts(calls)).not.toContain('root is at 91%')
    expect(texts(calls)).toContain('Disk almost full')
  })

  it('draws nothing at all in a zero-area cell', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({ box: { w: 0, h: 0, t: 1 } }))
    expect(calls).toHaveLength(0)
  })
})

describe('alert_feed draw: overflow', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    alert({ id: `a${i}`, title: `alert ${i}`, updated_at: 10_000 - i }))

  it('shows only the cards that fit, and counts the rest', () => {
    const { g, calls } = recorder()
    // Two cards fit, then the counter band eats into what is left.
    feed.draw(g, baseCtx({ alerts: many, box: { w: 300, h: FEED_CARD * 3, t: 1 } }))
    const shown = texts(calls).filter((t) => t.startsWith('alert '))
    const counter = texts(calls).find((t) => t.startsWith('and '))
    expect(counter).toBe(`and ${10 - shown.length} more`)
  })

  it('suppresses the counter when overflow.counter is false', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({
      alerts: many, config: { overflow: { counter: false } }, box: { w: 300, h: FEED_CARD * 3, t: 1 },
    }))
    expect(texts(calls).some((t) => t.startsWith('and '))).toBe(false)
  })

  // Pre-scroll this drew NOTHING (the plan refused partial cards). A scrolling list shows the
  // sliver it has room for — the top of card one — and never a later card jumped ahead of it.
  it('a cell too short for one card still shows the top of the first, and only the first', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({
      alerts: many, config: { overflow: { counter: false } },
      box: { w: 300, h: Math.floor(FEED_COUNTER / 2), t: 1 },
    }))
    const painted = texts(calls).filter((t) => t.startsWith('alert '))
    expect(painted.length).toBeGreaterThan(0)
    expect(painted.every((t) => t === 'alert 0')).toBe(true)
  })

  /*
   * The plan (and the handover before it) carried this as "plan.visible goes NEGATIVE on tiny
   * cells; the Math.max(0, …) guard is load-bearing". It is not, and it never has been: cardPlan's
   * counter branch has had its OWN Math.max(0, …) since layout-core.mjs was created (452aee6), and
   * its non-counter branch is floor(h / cardHeight), which cannot go negative for the positive h
   * that `draw` already guarantees. Swept the whole space below and found no negative.
   *
   * So the design's outer Math.max(0, plan.visible) is defence in depth, not the thing standing
   * between the wall and a slice(0, -1) — and a test asserting otherwise would pass whether the
   * guard were there or not, which is worse than no test. What IS worth pinning is the invariant
   * the designs actually lean on: cardPlan's own promise never to return a negative count. If
   * someone deletes THAT, this fails loudly and three designs are told why.
   */
  it('cardPlan never returns a negative visible count — the invariant the guard assumes', () => {
    const negatives = []
    for (const h of [1, 5, 14, 27, 28, 29, 50, 131, 132, 133, 200, 400, 1000]) {
      for (const counter of [true, false]) {
        for (const count of [0, 1, 3, 10, 100]) {
          const plan = cardPlan(h, count, counter, FEED_CARD)
          if (plan.visible < 0) negatives.push({ h, counter, count, visible: plan.visible })
        }
      }
    }
    expect(negatives).toEqual([])
  })
})

/**
 * Answer buttons on question cards — the migration to canvas dropped them (a warn/info question
 * on a screen must remain answerable. The design paints an option row and answers taps through
 * the host's actions channel.
 */
describe('alert_feed design: question cards carry options', () => {
  it('normalize carries the alert id and its options onto the card', () => {
    const n = normalizeAlertFeed(
      [alert({ options: [{ id: 'good', label: 'Looks good' }, { id: 'tweak', label: 'Needs tweaks' }] })],
      {}, 0)
    expect(n.cards[0].id).toBe('al_1')
    expect(n.cards[0].options).toEqual([
      { id: 'good', label: 'Looks good' }, { id: 'tweak', label: 'Needs tweaks' }])
  })

  it('normalize treats absent, empty or malformed options as none at all', () => {
    expect(normalizeAlertFeed([alert()], {}, 0).cards[0].options).toBeNull()
    expect(normalizeAlertFeed([alert({ options: [] })], {}, 0).cards[0].options).toBeNull()
    expect(normalizeAlertFeed([alert({ options: 'tap me' })], {}, 0).cards[0].options).toBeNull()
    expect(normalizeAlertFeed(
      [alert({ options: [{ id: 'ok', label: 'OK' }, { id: 42 }, 'junk'] })], {}, 0,
    ).cards[0].options).toEqual([{ id: 'ok', label: 'OK' }])
  })

  it('draw paints the option labels on a question card', () => {
    const { g, calls } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ alerts: [alert({ options: [{ id: 'good', label: 'Looks good' }] })], config }))
    expect(calls.map((c) => c.text)).toContain('Looks good')
  })

  it('a question card is taller: the card below it starts lower than FEED_CARD', () => {
    const { g, rects } = recorder()
    feed.draw(g, baseCtx({
      alerts: [
        alert({ id: 'al_q', options: [{ id: 'good', label: 'Looks good' }], updated_at: 5 }),
        alert({ id: 'al_plain', updated_at: 1 }),
      ],
      box: { w: 400, h: 600 }, config: {},
    }))
    const stripes = rects.filter((r) => r.w === 4)
    expect(stripes).toHaveLength(2)
    expect(stripes[1].y).toBeGreaterThan(FEED_CARD)
  })

  it('a tap on a painted option answers through the actions channel and repaints', () => {
    const { g, calls } = recorder()
    const config = {}
    feed.draw(g, baseCtx({
      alerts: [alert({ options: [{ id: 'good', label: 'Looks good' }] })], config,
    }))
    const label = calls.find((c) => c.text === 'Looks good')
    expect(label).toBeDefined()
    const answered: unknown[] = []
    const actions = { answer: (...a: unknown[]) => answered.push(a), dismiss: () => {} }
    const hit = feed.pointer.tap({ config }, label!.x, label!.y, actions)
    expect(hit).toBe(true)
    expect(answered).toEqual([['al_1', 'good']])
  })

  it('a tap outside every option answers nothing', () => {
    const { g } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ alerts: [alert({ options: [{ id: 'good', label: 'Looks good' }] })], config }))
    const answered: unknown[] = []
    const actions = { answer: (...a: unknown[]) => answered.push(a), dismiss: () => {} }
    expect(feed.pointer.tap({ config }, 399, 599, actions)).toBe(false)
    expect(answered).toEqual([])
  })

  it('a tap racing the first draw returns false rather than throwing', () => {
    const actions = { answer: () => {}, dismiss: () => {} }
    expect(feed.pointer.tap({ config: { never: 'drawn' } }, 10, 10, actions)).toBe(false)
  })
})

/**
 * Dismiss and scroll make the wall's alert feed self-service: every card carries a Dismiss button
 * (the idle view always had one; the widget never did) and an overflowing feed drags/wheels
 * instead of hiding everything behind the counter.
 */
describe('alert_feed design: dismiss on every card', () => {
  it('paints a Dismiss control on a plain card', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({ config: {} }))
    expect(calls.map((c) => c.text)).toContain('Dismiss')
  })

  it('a tap on Dismiss dismisses that alert through the actions channel', () => {
    const { g, calls } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ config }))
    const label = calls.find((c) => c.text === 'Dismiss')
    expect(label).toBeDefined()
    const dismissed: unknown[] = []
    const actions = { answer: () => {}, dismiss: (...a: unknown[]) => dismissed.push(a) }
    // Dismiss is right-aligned: the recorded x is the text's RIGHT edge, so tap just left of it.
    expect(feed.pointer.tap({ config }, label!.x - 5, label!.y + 2, actions)).toBe(true)
    expect(dismissed).toEqual([['al_1']])
  })
})

describe('alert_feed design: scrolling an overflowing feed', () => {
  const three = [
    alert({ id: 'al_3', title: 'third card', updated_at: 3 }),
    alert({ id: 'al_2', title: 'second card', updated_at: 2 }),
    alert({ id: 'al_1', title: 'first card', updated_at: 1 }),
  ]
  const smallBox = { w: 300, h: 170, t: 1 } // fits one FEED_CARD (132px) plus the counter strip

  it('at rest the next card pokes up from the bottom edge instead of hiding', () => {
    const { g, calls } = recorder()
    feed.draw(g, baseCtx({ alerts: three, box: smallBox, config: {} }))
    const texts = calls.map((c) => c.text)
    expect(texts).toContain('third card')
    // The second card starts at 132px in a 170px box: partially visible, painted — the scroll
    // affordance a hidden-behind-a-counter card never was.
    expect(texts).toContain('second card')
    // The first (oldest) card starts at 264px, fully below the box: not painted, counted.
    expect(texts).not.toContain('first card')
    expect(texts).toContain('and 1 more')
  })

  it('dragging up scrolls older cards into view; the counter tracks what is still fully below', () => {
    const { g } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ alerts: three, box: smallBox, config }))
    expect(feed.pointer.move({ config }, -140)).toBe(true)
    const after = recorder()
    feed.draw(after.g, baseCtx({ alerts: three, box: smallBox, config }))
    const texts = after.calls.map((c) => c.text)
    // offset 140: the first (oldest) card now starts at 124px — partially visible, painted.
    expect(texts).toContain('first card')
    expect(texts).not.toContain('and 1 more')
  })

  it('scroll clamps: a huge drag still shows the oldest card, and dragging back re-pins', () => {
    const { g } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ alerts: three, box: smallBox, config }))
    feed.pointer.move({ config }, -100000)
    const bottom = recorder()
    feed.draw(bottom.g, baseCtx({ alerts: three, box: smallBox, config }))
    expect(bottom.calls.map((c) => c.text)).toContain('first card')
    feed.pointer.move({ config }, 100000)
    const top = recorder()
    feed.draw(top.g, baseCtx({ alerts: three, box: smallBox, config }))
    expect(top.calls.map((c) => c.text)).toContain('and 1 more')
  })

  it('a wheel notch scrolls like a drag', () => {
    const { g } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ alerts: three, box: smallBox, config }))
    expect(feed.pointer.wheel({ config }, 140)).toBe(true)
  })

  it('a feed that fits does not scroll at all', () => {
    const { g } = recorder()
    const config = {}
    feed.draw(g, baseCtx({ box: { w: 300, h: 400, t: 1 }, config }))
    expect(feed.pointer.move({ config }, -140)).toBe(false)
    expect(feed.pointer.wheel({ config }, 140)).toBe(false)
  })

  it('a gesture racing the first draw moves nothing and never throws', () => {
    expect(feed.pointer.move({ config: { never: 'drawn' } }, -50)).toBe(false)
    expect(feed.pointer.wheel({ config: { never: 'drawn' } }, 50)).toBe(false)
  })
})

describe('alert_feed design: sender allowlist', () => {
  const mixed = [
    alert({ id: 'al_c', sender: { name: 'claude-code' }, updated_at: 2 }),
    alert({ id: 'al_n', sender: { name: 'netdata-sc' }, title: 'disk warn', updated_at: 1 }),
  ]

  it('with no allowlist every sender shows, exactly as before', () => {
    const n = normalizeAlertFeed(mixed, {}, 0)
    expect(n.cards.map((c: { id: string }) => c.id)).toEqual(['al_c', 'al_n'])
  })

  it('an allowlist keeps only the named senders, case-insensitively', () => {
    const n = normalizeAlertFeed(mixed, { senders: ['Claude-Code'] }, 0)
    expect(n.cards.map((c: { id: string }) => c.id)).toEqual(['al_c'])
  })

  it('an allowlist that filters everything is the ordinary empty state', () => {
    expect(normalizeAlertFeed(mixed, { senders: ['nobody'] }, 0).state).toBe('empty')
  })

  it('a malformed allowlist is ignored rather than blanking the wall', () => {
    expect(normalizeAlertFeed(mixed, { senders: 'claude-code' }, 0).cards).toHaveLength(2)
    expect(normalizeAlertFeed(mixed, { senders: [] }, 0).cards).toHaveLength(2)
  })
})

describe('alert_feed design: body_scale sizes only the body text', () => {
  it('normalize carries a clamped body_scale, defaulting to 1', () => {
    expect(normalizeAlertFeed([alert()], {}, 0).bodyScale).toBe(1)
    expect(normalizeAlertFeed([alert()], { body_scale: 1.6 }, 0).bodyScale).toBe(1.6)
    expect(normalizeAlertFeed([alert()], { body_scale: 'big' }, 0).bodyScale).toBe(1)
    expect(normalizeAlertFeed([alert()], { body_scale: 99 }, 0).bodyScale).toBe(3)
  })

  it('grows the body font and leaves the title and meta fonts alone', () => {
    const plain = recorder()
    feed.draw(plain.g, baseCtx({ config: {} }))
    const scaled = recorder()
    feed.draw(scaled.g, baseCtx({ config: { body_scale: 2 } }))
    const font = (r: ReturnType<typeof recorder>, text: string) =>
      r.calls.find((c) => c.text === text)?.font
    expect(font(scaled, 'Disk almost full')).toBe(font(plain, 'Disk almost full'))
    const plainBody = Number(/(\d+)px/.exec(font(plain, 'root is at 91%') ?? '')?.[1])
    const scaledBody = Number(/(\d+)px/.exec(font(scaled, 'root is at 91%') ?? '')?.[1])
    expect(scaledBody).toBe(plainBody * 2)
  })

  it('a scaled body makes the card taller, so the next card starts lower', () => {
    const two = [alert({ id: 'al_b', updated_at: 2 }), alert({ id: 'al_a', updated_at: 1 })]
    const plain = recorder()
    feed.draw(plain.g, baseCtx({ alerts: two, box: { w: 300, h: 800, t: 1 }, config: {} }))
    const scaled = recorder()
    feed.draw(scaled.g, baseCtx({ alerts: two, box: { w: 300, h: 800, t: 1 }, config: { body_scale: 2 } }))
    const secondStripeY = (r: ReturnType<typeof recorder>) =>
      r.rects.filter((x) => x.w === 4)[1]?.y
    expect(secondStripeY(scaled)).toBeGreaterThan(secondStripeY(plain)!)
  })
})
