import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { tabsFromState, resolveActiveTab, tabBarModel, tabsWithStreamRows, tabScrollState, pageOffset, offsetToShow, tabBarSignature } from '../static/device/device-core.mjs'

describe('tabsFromState', () => {
  it('extracts tabs from msg.screens when present', () => {
    const msg = {
      screens: [
        { id: 'screen1', name: 'Kitchen', label: 'Main' },
        { id: 'screen2', name: 'Bedroom' },
      ],
    }
    const tabs = tabsFromState(msg)
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toEqual({ id: 'screen1', name: 'Kitchen', label: 'Main' })
    expect(tabs[1]).toEqual({ id: 'screen2', name: 'Bedroom' })
  })

  it('falls back to msg.screen when screens is absent', () => {
    const msg = { screen: { id: 'screen1', name: 'Kitchen' } }
    const tabs = tabsFromState(msg)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toEqual({ id: 'screen1', name: 'Kitchen' })
  })

  it('returns empty array when neither screens nor screen exist', () => {
    const msg = {}
    const tabs = tabsFromState(msg)
    expect(tabs).toEqual([])
  })

  it('handles screens: undefined explicitly', () => {
    const msg = { screens: undefined, screen: { id: 'screen1', name: 'Kitchen' } }
    const tabs = tabsFromState(msg)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe('screen1')
  })

  it('prefers screens over screen when both exist', () => {
    const msg = {
      screens: [{ id: 'screen1', name: 'Kitchen' }],
      screen: { id: 'screen2', name: 'Bedroom' },
    }
    const tabs = tabsFromState(msg)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe('screen1')
  })
})

describe('resolveActiveTab', () => {
  it('returns storedId when it is in tabIds', () => {
    const tabIds = ['screen1', 'screen2', 'screen3']
    const active = resolveActiveTab(tabIds, 'screen2')
    expect(active).toBe('screen2')
  })

  it('returns first tab when storedId is null', () => {
    const tabIds = ['screen1', 'screen2', 'screen3']
    const active = resolveActiveTab(tabIds, null)
    expect(active).toBe('screen1')
  })

  it('returns null when tabIds is empty and storedId is null', () => {
    const active = resolveActiveTab([], null)
    expect(active).toBeNull()
  })

  it('returns first tab when storedId is not in tabIds', () => {
    const tabIds = ['screen1', 'screen2']
    const active = resolveActiveTab(tabIds, 'screen3')
    expect(active).toBe('screen1')
  })

  it('returns null when tabIds is empty even if storedId is provided', () => {
    const active = resolveActiveTab([], 'screen1')
    expect(active).toBeNull()
  })
})

describe('tabBarModel', () => {
  it('returns { visible: false } for 0 tabs', () => {
    const model = tabBarModel([], {}, null)
    expect(model.visible).toBe(false)
    expect(model.tabs).toEqual([])
  })

  it('returns { visible: false } for 1 tab', () => {
    const tabs = [{ id: 'screen1', name: 'Kitchen' }]
    const model = tabBarModel(tabs, {}, 'screen1')
    expect(model.visible).toBe(false)
    expect(model.tabs).toHaveLength(1)
  })

  it('returns { visible: true } for 2+ tabs', () => {
    const tabs = [
      { id: 'screen1', name: 'Kitchen' },
      { id: 'screen2', name: 'Bedroom' },
    ]
    const model = tabBarModel(tabs, {}, 'screen1')
    expect(model.visible).toBe(true)
    expect(model.tabs).toHaveLength(2)
  })

  it('uses label when present, falls back to name', () => {
    const tabs = [
      { id: 'screen1', name: 'Kitchen', label: 'Main Floor' },
      { id: 'screen2', name: 'Bedroom' },
    ]
    const model = tabBarModel(tabs, {}, 'screen1')
    expect(model.tabs[0].text).toBe('Main Floor')
    expect(model.tabs[1].text).toBe('Bedroom')
  })

  it('marks active tab correctly', () => {
    const tabs = [
      { id: 'screen1', name: 'Kitchen' },
      { id: 'screen2', name: 'Bedroom' },
    ]
    const model = tabBarModel(tabs, {}, 'screen1')
    expect(model.tabs[0].active).toBe(true)
    expect(model.tabs[1].active).toBe(false)
  })

  it('applies tab status dots from tabStatus', () => {
    const tabs = [
      { id: 'screen1', name: 'Kitchen' },
      { id: 'screen2', name: 'Bedroom' },
      { id: 'screen3', name: 'Lounge' },
    ]
    const tabStatus = { screen1: 'critical', screen2: 'warn' }
    const model = tabBarModel(tabs, tabStatus, 'screen1')
    expect(model.tabs[0].dot).toBe('critical')
    expect(model.tabs[1].dot).toBe('warn')
    expect(model.tabs[2].dot).toBeNull()
  })

  it('returns null dot when tabStatus key is absent', () => {
    const tabs = [{ id: 'screen1', name: 'Kitchen' }]
    const tabStatus = {}
    const model = tabBarModel(tabs, tabStatus, 'screen1')
    expect(model.tabs[0].dot).toBeNull()
  })

  it('handles info severity dot', () => {
    const tabs = [{ id: 'screen1', name: 'Kitchen' }]
    const tabStatus = { screen1: 'info' }
    const model = tabBarModel(tabs, tabStatus, 'screen1')
    expect(model.tabs[0].dot).toBe('info')
  })

  it('builds complete tab object with all fields', () => {
    const tabs = [
      { id: 'screen1', name: 'Kitchen', label: 'Main' },
      { id: 'screen2', name: 'Bedroom' },
    ]
    const tabStatus = { screen1: 'warn' }
    const model = tabBarModel(tabs, tabStatus, 'screen1')
    expect(model.tabs[0]).toEqual({
      id: 'screen1',
      text: 'Main',
      active: true,
      dot: 'warn',
      blink: false,
    })
    expect(model.tabs[1]).toEqual({
      id: 'screen2',
      text: 'Bedroom',
      active: false,
      dot: null,
      blink: false,
    })
  })

  it('blinks background tabs in the unseen set, never the active tab', () => {
    const tabs = [
      { id: 'screen1', name: 'Kitchen' },
      { id: 'screen2', name: 'Bedroom' },
      { id: 'screen3', name: 'Lounge' },
    ]
    const model = tabBarModel(tabs, {}, 'screen1', new Set(['screen1', 'screen2']))
    expect(model.tabs[0].blink).toBe(false) // active — you are looking at it
    expect(model.tabs[1].blink).toBe(true) // background + unseen
    expect(model.tabs[2].blink).toBe(false) // background but nothing unseen
  })

  it('blink coexists with a severity dot (colour kept, pulse added downstream)', () => {
    const tabs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    const model = tabBarModel(tabs, { b: 'warn' }, 'a', new Set(['b']))
    expect(model.tabs[1]).toEqual({ id: 'b', text: 'B', active: false, dot: 'warn', blink: true })
  })

  it('defaults to no blink when the unseen set is not passed (old callers unchanged)', () => {
    const model = tabBarModel([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, 'a')
    expect(model.tabs.every((t: { blink: boolean }) => t.blink === false)).toBe(true)
  })
})

describe('tabsWithStreamRows', () => {
  const stream = (feed: string) => ({ widget: 'stream_list', config: { feed } })
  const table = (feed: string) => ({ widget: 'table', config: { feed } })
  const gauge = (feed: string) => ({ widget: 'gauge', config: { feed } })
  const tab = (id: string, cells: unknown[]) => ({ id, name: id, grid: { cells } })

  it('returns background tabs whose stream/table cells match a pushed feed', () => {
    const tabs = [
      tab('active', [stream('f1')]),
      tab('bg1', [stream('f1')]),
      tab('bg2', [table('f2')]),
      tab('bg3', [stream('f3')]),
    ]
    expect(tabsWithStreamRows(tabs, ['f1', 'f2'], 'active')).toEqual(['bg1', 'bg2'])
  })

  it('ignores non-stream widgets even when their feed matches', () => {
    expect(tabsWithStreamRows([tab('bg', [gauge('f1')])], ['f1'], 'x')).toEqual([])
  })

  it('degrades on malformed tabs/cells/configs without throwing', () => {
    const tabs = [
      null,
      tab('bg1', [null, { widget: 'stream_list' }, { widget: 'stream_list', config: { feed: 5 } }]),
      { id: 'bg2', name: 'bg2' }, // no grid at all
      tab('bg3', [stream('f1')]),
    ]
    expect(tabsWithStreamRows(tabs as never, ['f1', '5'], 'x')).toEqual(['bg3'])
  })
})

/**
 * Scrolling the tab strip.
 *
 * A device accumulates tabs for as long as its owner keeps adding screens, and the strip is a flex
 * row that simply ran off the edge: past ~11 tabs the rest was CLIPPED, with no affordance and no
 * hint it existed. The Finance tab was live on a panel while being invisible in its own strip.
 *
 * All three functions here are pure arithmetic on sizes the DOM measured — no element, no
 * scrollTo — so the paging rules can be pinned without a browser, the same split the rest of the
 * tab logic follows.
 */
describe('tabScrollState', () => {
  it('reports no overflow when everything fits', () => {
    expect(tabScrollState({ scrollSize: 400, viewport: 800, offset: 0 }))
      .toEqual({ overflowing: false, atStart: true, atEnd: true })
  })

  it('knows it is at the start, in the middle, and at the end', () => {
    expect(tabScrollState({ scrollSize: 1600, viewport: 800, offset: 0 }))
      .toMatchObject({ overflowing: true, atStart: true, atEnd: false })
    expect(tabScrollState({ scrollSize: 1600, viewport: 800, offset: 400 }))
      .toMatchObject({ overflowing: true, atStart: false, atEnd: false })
    expect(tabScrollState({ scrollSize: 1600, viewport: 800, offset: 800 }))
      .toMatchObject({ overflowing: true, atStart: false, atEnd: true })
  })

  it('treats a sub-pixel remainder as the end, not as a hair more to scroll', () => {
    // Fractional layout sizes are normal; an arrow that stays enabled for 0.4px is a dead control.
    expect(tabScrollState({ scrollSize: 1600.4, viewport: 800, offset: 800 })).toMatchObject({ atEnd: true })
  })

  it('survives a strip that has not been laid out yet', () => {
    expect(tabScrollState({ scrollSize: 0, viewport: 0, offset: 0 }))
      .toEqual({ overflowing: false, atStart: true, atEnd: true })
  })
})

describe('pageOffset', () => {
  it('pages by most of a viewport, so a half-cut tab lands fully in view', () => {
    // 80% — a full-viewport page would jump the partly visible tab clean past the edge.
    expect(pageOffset(0, 800, 1, 1600)).toBe(640)
  })

  it('pages back the same distance', () => {
    expect(pageOffset(640, 800, -1, 1600)).toBe(0)
  })

  it('never scrolls past either end', () => {
    expect(pageOffset(0, 800, -1, 1600)).toBe(0)
    expect(pageOffset(700, 800, 1, 1600)).toBe(800)
  })

  it('stays put when there is nothing to scroll', () => {
    expect(pageOffset(0, 800, 1, 400)).toBe(0)
  })
})

describe('offsetToShow', () => {
  it('leaves the offset alone when the tab is already fully visible', () => {
    expect(offsetToShow({ itemStart: 100, itemSize: 90, offset: 0, viewport: 800, scrollSize: 1600 })).toBe(0)
  })

  it('scrolls forward just far enough to reveal a tab off the far edge', () => {
    // The active tab sits at 1200..1290 with 0..800 showing: bring its end to the edge, no further.
    expect(offsetToShow({ itemStart: 1200, itemSize: 90, offset: 0, viewport: 800, scrollSize: 1600 })).toBe(490)
  })

  it('scrolls back to reveal a tab off the near edge', () => {
    expect(offsetToShow({ itemStart: 100, itemSize: 90, offset: 400, viewport: 800, scrollSize: 1600 })).toBe(100)
  })

  it('clamps to the ends rather than overscrolling', () => {
    expect(offsetToShow({ itemStart: 1550, itemSize: 90, offset: 0, viewport: 800, scrollSize: 1600 })).toBe(800)
  })

  it('does nothing when the strip does not overflow', () => {
    expect(offsetToShow({ itemStart: 100, itemSize: 90, offset: 0, viewport: 800, scrollSize: 400 })).toBe(0)
  })
})

/**
 * Rebuilding the strip is what loses its scroll position, and `renderTabBar` runs on EVERY render
 * — every data push included. On a board with a 5s feed that meant the bar was torn down and
 * rebuilt twelve times a minute, snapping back to the start each time and then being dragged back
 * by the auto-scroll: unreadable. The signature is how the renderer decides it has nothing to do.
 */
describe('tabBarSignature', () => {
  const model = (over = {}) => tabBarModel(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { }, 'a', new Set(), ...[]) as any

  it('is stable for an unchanged model', () => {
    expect(tabBarSignature(model())).toBe(tabBarSignature(model()))
  })

  it('changes when the active tab changes', () => {
    const tabs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    expect(tabBarSignature(tabBarModel(tabs, {}, 'a')))
      .not.toBe(tabBarSignature(tabBarModel(tabs, {}, 'b')))
  })

  it('changes when a status dot appears, or starts blinking', () => {
    const tabs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    expect(tabBarSignature(tabBarModel(tabs, {}, 'a')))
      .not.toBe(tabBarSignature(tabBarModel(tabs, { b: 'warn' }, 'a')))
    expect(tabBarSignature(tabBarModel(tabs, {}, 'a')))
      .not.toBe(tabBarSignature(tabBarModel(tabs, {}, 'a', new Set(['b']))))
  })

  it('changes when a tab is added, removed or relabelled', () => {
    const tabs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    expect(tabBarSignature(tabBarModel(tabs, {}, 'a')))
      .not.toBe(tabBarSignature(tabBarModel([...tabs, { id: 'c', name: 'C' }], {}, 'a')))
    expect(tabBarSignature(tabBarModel(tabs, {}, 'a')))
      .not.toBe(tabBarSignature(tabBarModel([{ id: 'a', name: 'A', label: 'Renamed' }, tabs[1]], {}, 'a')))
  })
})
