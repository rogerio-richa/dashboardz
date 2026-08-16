import { beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import scroll, { _resetScrollState } from '../static/device/widgets/stream/scroll.mjs'
// @ts-expect-error plain JS module without types
import { RAIL_W, REFOLLOW_MS, arrowLayout, dragBy, freshState, hitArrow, jumpBottom, jumpTop, maxScroll, reconcile } from '../static/device/widgets/stream/scroll-core.mjs'
// @ts-expect-error plain JS module without types
import { designIdsFor } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { STREAM_CARD_TITLE } from '../static/device/layout-core.mjs'

/**
 * The scrollable stream design: the pure state machine first (`scroll-core.mjs` — follow lock,
 * unseen counting, arrival anchoring), then the design's draw/pointer halves through the same
 * recorder shape `widget-stream.test.ts` uses. The invariants pinned here are the ones a wall
 * panel would surface as "the list jumped while I was reading it" or "the badge never cleared" —
 * bugs invisible in a diff and difficult for an operator to diagnose from the floor.
 */

const CARD = STREAM_CARD_TITLE // no body path in these tests → title-only card height
const VIEW = 300

/** Newest-first pushed_at list: newestAt, newestAt-1, ... (`count` entries). */
const times = (newestAt: number, count: number) => Array.from({ length: count }, (_, i) => newestAt - i)

describe('scroll-core: the follow lock and unseen badge', () => {
  it('starts pinned to the top with the backlog considered seen', () => {
    const s = reconcile(null, times(100, 10), CARD, VIEW)
    expect(s.offset).toBe(0)
    expect(s.follow).toBe(true)
    expect(s.unseen).toBe(0)
    expect(s.newestSeenAt).toBe(100)
  })

  it('at the top, arrivals stay pinned and stay seen (the lock)', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const s2 = reconcile(s1, times(102, 10), CARD, VIEW)
    expect(s2.offset).toBe(0)
    expect(s2.unseen).toBe(0)
    expect(s2.newestSeenAt).toBe(102)
  })

  it('scrolled away, arrivals count as unseen and the column holds still (anchor)', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const away = dragBy(s1, -CARD, 10, CARD, VIEW) // reveal older rows
    expect(away.offset).toBe(CARD)
    const s2 = reconcile(away, times(102, 10), CARD, VIEW)
    expect(s2.unseen).toBe(2)
    // Two new rows arrived above: the offset grew by exactly their height, so the rows on
    // screen did not move. (On a capped wire the clamp can shorten this — the feed's oldest
    // rows fell off the bottom — which the shrinking-rows test below covers.)
    expect(s2.offset).toBe(CARD + 2 * CARD)
  })

  it('reconcile is idempotent — a repaint with the same rows moves nothing', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const away = dragBy(s1, -CARD, 10, CARD, VIEW)
    const s2 = reconcile(away, times(102, 10), CARD, VIEW)
    const s3 = reconcile(s2, times(102, 10), CARD, VIEW)
    expect(s3).toEqual(s2)
  })

  it('dragging back to the top re-enters the lock and clears the badge on the next draw', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const away = dragBy(s1, -2 * CARD, 10, CARD, VIEW)
    const withNew = reconcile(away, times(102, 10), CARD, VIEW)
    expect(withNew.unseen).toBe(2)
    const backUp = dragBy(withNew, withNew.offset, 10, CARD, VIEW) // drag all the way down the glass
    expect(backUp.offset).toBe(0)
    const settled = reconcile(backUp, times(102, 10), CARD, VIEW)
    expect(settled.unseen).toBe(0)
    expect(settled.follow).toBe(true)
  })

  it('jumpTop clears the badge immediately, without waiting for a reconcile', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const away = dragBy(s1, -2 * CARD, 10, CARD, VIEW)
    const withNew = reconcile(away, times(102, 10), CARD, VIEW)
    const jumped = jumpTop(withNew)
    expect(jumped.offset).toBe(0)
    expect(jumped.newestSeenAt).toBe(102)
    expect(reconcile(jumped, times(102, 10), CARD, VIEW).unseen).toBe(0)
  })

  it('jumpBottom pins to the oldest row on the wire', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const jumped = jumpBottom(s1, 10, CARD, VIEW)
    expect(jumped.offset).toBe(maxScroll(10, CARD, VIEW))
  })

  it('drag clamps at both ends and shrinking rows clamp a stale offset', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    expect(dragBy(s1, 500, 10, CARD, VIEW).offset).toBe(0)            // past the top
    expect(dragBy(s1, -9999, 10, CARD, VIEW).offset).toBe(maxScroll(10, CARD, VIEW)) // past the bottom
    const bottom = jumpBottom(s1, 10, CARD, VIEW)
    const fewer = reconcile(bottom, times(100, 7), CARD, VIEW)
    expect(fewer.offset).toBe(maxScroll(7, CARD, VIEW))
  })

  it('a column that fits cannot scroll and never badges', () => {
    const s = reconcile(null, times(100, 3), CARD, VIEW)
    expect(s.max).toBe(0)
    expect(dragBy(s, -500, 3, CARD, VIEW).offset).toBe(0)
    expect(reconcile(s, times(105, 3), CARD, VIEW).unseen).toBe(0) // still at 0 → still following
  })

  it('malformed pushed_at degrades to "old", never NaN arithmetic', () => {
    const s = reconcile(freshState(100), ['soon', null, undefined, 100] as never[], CARD, VIEW)
    expect(s.unseen).toBe(0)
    expect(Number.isFinite(s.offset)).toBe(true)
  })
})

describe('scroll-core: idle auto-refollow (the wall-panel ratchet)', () => {
  // The failure this kills: any nudge off offset 0 (a settings swipe leaking through, a cleaning
  // wipe) anchored the column away FOREVER — every arrival grew the offset, so a wall perpetually
  // showed the second-newest row down while the newest hid behind the badge. Sixty idle seconds
  // must snap the column back to live.
  it('a scrolled-away column snaps back to follow after the idle window', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW, 1_000)
    const away = dragBy(s1, -CARD, 10, CARD, VIEW)
    const s2 = reconcile(away, times(102, 10), CARD, VIEW, 2_000)
    expect(s2.offset).toBeGreaterThan(0)
    const s3 = reconcile(s2, times(104, 10), CARD, VIEW, 2_000 + REFOLLOW_MS)
    expect(s3.offset).toBe(0)
    expect(s3.follow).toBe(true)
    expect(s3.unseen).toBe(0)
    expect(s3.newestSeenAt).toBe(104)
  })

  it('inside the window the reading anchor still holds', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW, 1_000)
    const away = dragBy(s1, -CARD, 10, CARD, VIEW)
    const s2 = reconcile(away, times(102, 10), CARD, VIEW, 2_000)
    const s3 = reconcile(s2, times(104, 10), CARD, VIEW, 2_000 + REFOLLOW_MS - 1)
    expect(s3.offset).toBeGreaterThan(0)
    expect(s3.unseen).toBeGreaterThan(0)
  })

  it('a fresh drag restarts the idle clock', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW, 1_000)
    const away = dragBy(s1, -CARD, 10, CARD, VIEW)
    const s2 = reconcile(away, times(100, 10), CARD, VIEW, 2_000)
    const away2 = dragBy(s2, -CARD, 10, CARD, VIEW)
    // Way past the first window, but the drag between reconciles proves someone is reading.
    const s3 = reconcile(away2, times(100, 10), CARD, VIEW, 70_000)
    expect(s3.offset).toBeGreaterThan(0)
    const s4 = reconcile(s3, times(100, 10), CARD, VIEW, 70_000 + REFOLLOW_MS)
    expect(s4.offset).toBe(0)
  })

  it('a clockless caller keeps the anchor forever, exactly as before', () => {
    const s1 = reconcile(null, times(100, 10), CARD, VIEW)
    const away = dragBy(s1, -CARD, 10, CARD, VIEW)
    const s2 = reconcile(away, times(102, 10), CARD, VIEW)
    const s3 = reconcile(s2, times(104, 10), CARD, VIEW)
    expect(s3.offset).toBeGreaterThan(0)
  })
})

describe('scroll-core: the arrow rail', () => {
  it('shows nothing when the column fits and nothing is unseen', () => {
    const layout = arrowLayout(400, VIEW, false, 0)
    expect(layout.up).toBeNull()
    expect(layout.down).toBeNull()
  })

  it('shows both arrows when the column overflows', () => {
    const layout = arrowLayout(400, VIEW, true, 0)
    expect(layout.up).not.toBeNull()
    expect(layout.down).not.toBeNull()
    expect(layout.up!.cx).toBe(400 - RAIL_W / 2)
  })

  it('hit test honours finger slop and misses cleanly', () => {
    const layout = arrowLayout(400, VIEW, true, 0)
    expect(hitArrow(layout, layout.up!.cx, layout.up!.cy)).toBe('up')
    expect(hitArrow(layout, layout.up!.cx + layout.up!.r + 7, layout.up!.cy)).toBe('up') // inside slop
    expect(hitArrow(layout, layout.down!.cx, layout.down!.cy)).toBe('down')
    expect(hitArrow(layout, 10, VIEW / 2)).toBeNull()
    expect(hitArrow(null, 10, 10)).toBeNull()
  })
})

// --- the design: draw + pointer, through the recorder ---

type Call = { text: string; y: number; fillStyle: string }

function recorder() {
  const calls: Call[] = []
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillText: (text: string, _x: number, y: number) => calls.push({ text, y, fillStyle: g.fillStyle }),
    measureText: (value: string) => ({ width: Array.from(String(value)).length * 8 }),
    beginPath: () => {}, closePath: () => {}, arc: () => {},
    moveTo: () => {}, lineTo: () => {}, fill: () => {},
  }
  return { g, calls }
}

const row = (title: string, pushed_at: number) => ({ payload: { title }, pushed_at })
const rows = (newestAt: number, count: number) =>
  times(newestAt, count).map((t, i) => row(`row ${newestAt - i}`, t))

const streamFeed = () => ({ missing: false, mode: 'stream', pushed_at: 0, image_rev: null })

const baseCtx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#ink', dim: '#dim', badge: '#badge' },
  config: { feed: 'f', title_path: 'title' },
  data: null,
  rows: rows(100, 10),
  feed: streamFeed(),
  box: { w: 400, h: VIEW, t: 1 },
  now: 0,
  state: {},
  motion: 'full',
  stale: false,
  age_ms: null,
  ...overrides,
})

const cell = { config: { feed: 'f' } }

describe('stream_list/scroll design', () => {
  beforeEach(() => _resetScrollState())

  it('registers after list, so list stays the widget default', () => {
    expect(designIdsFor('stream_list')).toEqual(['list', 'scroll', 'chat', 'ticker'])
  })

  it('declares the list knobs minus the overflow counter scrolling replaces', () => {
    expect(Object.keys(scroll.meta.options).sort())
      .toEqual(['body_lines', 'body_path', 'title_lines', 'title_path'])
  })

  it('keeps normalizeStream\'s loud/quiet split: missing feed is loud, empty stream is quiet', () => {
    const missing = recorder()
    scroll.draw(missing.g, baseCtx({ rows: null, feed: { ...streamFeed(), missing: true } }))
    expect(missing.calls.some((c) => c.text === 'Feed missing')).toBe(true)
    const empty = recorder()
    scroll.draw(empty.g, baseCtx({ rows: [], feed: { ...streamFeed(), pushed_at: null } }))
    expect(empty.calls.some((c) => c.text === '— no rows yet')).toBe(true)
  })

  it('paints newest-first from the top, and a wheel scroll shifts the column up', () => {
    const first = recorder()
    scroll.draw(first.g, baseCtx())
    const topRow = first.calls.find((c) => c.text.startsWith('row'))
    expect(topRow!.text).toBe('row 100')
    expect(topRow!.y).toBe(4) // the card's own top padding, at offset 0

    // One wheel notch toward older rows (less than a card, so the newest row is still partially
    // on screen), then the repaint the host would issue.
    expect(scroll.pointer.wheel(cell, 20)).toBe(true)
    const second = recorder()
    scroll.draw(second.g, baseCtx())
    const shifted = second.calls.find((c) => c.text === 'row 100')
    expect(shifted!.y).toBe(4 - 20)
  })

  it('culls rows fully outside the viewport instead of painting the whole queue', () => {
    scroll.draw(recorder().g, baseCtx())
    scroll.pointer.move(cell, -2 * CARD) // exactly two cards down: rows 100/99 are fully above
    const { g, calls } = recorder()
    scroll.draw(g, baseCtx())
    expect(calls.some((c) => c.text === 'row 100')).toBe(false)
    expect(calls.find((c) => c.text === 'row 98')!.y).toBe(4)
  })

  it('badges the up arrow with the unseen count while scrolled away', () => {
    scroll.draw(recorder().g, baseCtx())
    expect(scroll.pointer.move(cell, -2 * CARD)).toBe(true) // drag up: reveal older rows
    scroll.draw(recorder().g, baseCtx()) // host repaint at the new offset
    const { g, calls } = recorder()
    scroll.draw(g, baseCtx({ rows: rows(102, 10) })) // two arrivals while reading
    expect(calls.some((c) => c.text === '2')).toBe(true)
  })

  it('tapping the up arrow jumps to the top and clears the badge', () => {
    scroll.draw(recorder().g, baseCtx())
    scroll.pointer.move(cell, -2 * CARD)
    scroll.draw(recorder().g, baseCtx({ rows: rows(102, 10) }))
    const up = arrowLayout(400, VIEW, true, 2).up!
    expect(scroll.pointer.tap(cell, up.cx, up.cy)).toBe(true)
    const after = recorder()
    scroll.draw(after.g, baseCtx({ rows: rows(102, 10) }))
    expect(after.calls.some((c) => c.text === '2')).toBe(false)
    const top = after.calls.find((c) => c.text.startsWith('row'))
    expect(top!.text).toBe('row 102')
  })

  it('a tap on card text (not an arrow) is not claimed', () => {
    scroll.draw(recorder().g, baseCtx())
    expect(scroll.pointer.tap(cell, 30, VIEW / 2)).toBe(false)
  })

  it('a gesture racing the first draw returns false rather than throwing', () => {
    expect(scroll.pointer.move({ config: { feed: 'never-drawn' } }, -50)).toBe(false)
    expect(scroll.pointer.tap({ config: { feed: 'never-drawn' } }, 10, 10)).toBe(false)
    expect(scroll.pointer.move({ config: {} }, -50)).toBe(false)
  })

  it('scroll state survives across draws but respects _resetScrollState', () => {
    scroll.draw(recorder().g, baseCtx())
    scroll.pointer.move(cell, -20)
    const { g, calls } = recorder()
    scroll.draw(g, baseCtx())
    expect(calls.find((c) => c.text === 'row 100')!.y).toBe(4 - 20)
    _resetScrollState()
    const fresh = recorder()
    scroll.draw(fresh.g, baseCtx())
    expect(fresh.calls.find((c) => c.text === 'row 100')!.y).toBe(4)
  })
})
