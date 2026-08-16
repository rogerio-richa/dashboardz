import { describe, expect, it, beforeEach } from 'vitest'
// @ts-expect-error plain JS modules without types
import { register, knows, _reset } from '../static/device/widgets/registry.mjs'
import {
  requestedDesign, unknownDesigns, designsNeedingReload, reloadHistory, noteReloadAttempts,
  RELOAD_BACKOFF_MS, MAX_RELOAD_ATTEMPTS,
// @ts-expect-error plain JS modules without types
} from '../static/device/widgets/index.mjs'

/**
 * A device needs to be told the design catalogue changed.
 *
 * Found by using it: `clock/flip.mjs` was added, selected in the admin, and the board kept showing
 * a digital clock until somebody reloaded the page. Nothing was broken — `widgets/index.mjs`
 * imports and registers every design once at page load, so a tab opened before flip.mjs existed
 * has a registry without it, and `lookup` correctly degrades an unrecognised id to the widget's
 * default. degradation contract, working exactly as written.
 *
 * The gap is that nothing NOTICES. On a laptop that is one refresh; on the wall-mounted panel this
 * product exists for, a new design silently never appears until somebody walks over to the kiosk.
 *
 * The condition worth acting on is narrow, and picking it precisely is the whole design: not "the
 * catalogue changed" (which would reload every panel in the building because a design none of them
 * use was added) but "this board was asked for something THIS page cannot draw".
 */
const design = (id: string, widget: string, isDefault = false) => ({
  meta: {
    id, widget, label: id, suggested_ratio: 2, tokens: {},
    animations: { transition: [], persistent: [] }, default: isDefault,
  },
  draw: () => {},
})

const cell = (widget: string, config: object = {}) => ({ rect: { x: 0, y: 0, w: 1, h: 1 }, widget, config })

/**
 * A plausible Date.now() rather than 0, so nothing here can pass by accident on a falsy timestamp.
 * `now` is injected into every one of these calls precisely so the suite needs no fake timers.
 */
const T0 = 1_770_000_000_000
const tried = (id: string, n: number, at: number) => ({ [id]: { n, at } })

describe('a page that is older than the catalogue', () => {
  beforeEach(() => {
    _reset()
    register(design('digital', 'clock', true))
    register(design('segment', 'clock'))
  })

  describe('knows', () => {
    it('answers for an id this build actually registered', () => {
      expect(knows('clock', 'segment')).toBe(true)
    })

    it('answers false for an id from a newer catalogue', () => {
      expect(knows('clock', 'flip')).toBe(false)
    })

    /** `lookup` treats these as "use the default"; they are not a failure to resolve anything. */
    it('is false, never throwing, for an absent id or an unknown widget', () => {
      expect(knows('clock', undefined)).toBe(false)
      expect(knows('clock', '')).toBe(false)
      expect(knows('nosuchwidget', 'digital')).toBe(false)
    })
  })

  /**
   * requestedDesign must be the SAME precedence designFor resolves with — cell wins over theme,
   * `||` so an empty string is not a choice. A second, subtly different resolution rule here would
   * mean reloading for an id the renderer never actually looked up, which is the colour-token contract class of bug:
   * two substitution points computing the same answer differently.
   */
  describe('requestedDesign', () => {
    it('takes the cell’s choice over the theme’s', () => {
      expect(requestedDesign(cell('clock', { design: 'segment' }), { clock: 'digital' })).toBe('segment')
    })

    it('falls back to the theme when the cell names nothing', () => {
      expect(requestedDesign(cell('clock'), { clock: 'digital' })).toBe('digital')
    })

    it('treats a cleared form field as absent, not as a choice', () => {
      expect(requestedDesign(cell('clock', { design: '' }), { clock: 'digital' })).toBe('digital')
    })

    it('is null for a widget with no canvas designs at all', () => {
      expect(requestedDesign(cell('gauge', { design: 'ring' }), {})).toBeNull()
    })

    it('is null when neither cell nor theme names one', () => {
      expect(requestedDesign(cell('clock'), {})).toBeNull()
    })
  })

  describe('unknownDesigns', () => {
    it('reports a design the board asks for and this build cannot draw', () => {
      expect(unknownDesigns([cell('clock', { design: 'flip' })], {})).toEqual(['flip'])
    })

    it('reports one the THEME asks for, not just the cell', () => {
      expect(unknownDesigns([cell('clock')], { clock: 'nixie' })).toEqual(['nixie'])
    })

    it('says nothing when every named design resolves', () => {
      expect(unknownDesigns([cell('clock', { design: 'segment' }), cell('clock')], { clock: 'digital' })).toEqual([])
    })

    /** Naming nothing is not staleness — it is the overwhelmingly common case. */
    it('says nothing for a board that names no designs at all', () => {
      expect(unknownDesigns([cell('clock'), cell('gauge')], {})).toEqual([])
    })

    it('deduplicates, so four flip clocks are one reason and not four', () => {
      expect(unknownDesigns([cell('clock', { design: 'flip' }), cell('clock', { design: 'flip' })], {}))
        .toEqual(['flip'])
    })

    it('survives a malformed grid rather than throwing on the render path', () => {
      expect(unknownDesigns([null as never, cell('clock', { design: 'flip' })], {})).toEqual(['flip'])
      expect(unknownDesigns(null as never, {})).toEqual([])
    })
  })

  /**
   * The loop guard. A reload only helps if the page comes back with a NEWER catalogue; if the id
   * is simply wrong — an operator typo, a design that was removed — it will still be unknown
   * afterwards, and a device that reloads on that condition reloads forever.
   */
  describe('designsNeedingReload', () => {
    it('asks for a reload the first time a design cannot be drawn', () => {
      expect(designsNeedingReload([cell('clock', { design: 'flip' })], {}, {}, T0)).toEqual(['flip'])
    })

    it('does not ask again immediately after a reload that did not resolve it', () => {
      expect(designsNeedingReload([cell('clock', { design: 'flip' })], {}, tried('flip', 1, T0), T0)).toEqual([])
    })

    it('still asks for a genuinely new id after an earlier one went nowhere', () => {
      expect(designsNeedingReload([cell('clock', { design: 'nixie' })], {}, tried('flip', 1, T0), T0))
        .toEqual(['nixie'])
    })

    it('asks for nothing on a board it can fully draw', () => {
      expect(designsNeedingReload([cell('clock', { design: 'segment' })], {}, {}, T0)).toEqual([])
    })

    /** A caller with no stored history must behave as though nothing had been tried. */
    it('treats a missing history as an empty one', () => {
      expect(designsNeedingReload([cell('clock', { design: 'flip' })], {}, null as never, T0)).toEqual(['flip'])
    })
  })

  /**
   * TIME-BOXED, not permanent.
   *
   * "One reload per id, ever" cannot tell "this id will never exist" (a typo, a removed design)
   * apart from "the hub did not have it YET" (a deploy in flight, an admin who saved the theme a
   * moment before the design finished shipping). Those need opposite answers, and the second one is
   * the failure case — a panel that gives up permanently after a single attempt is a panel
   * somebody still has to walk over to. Observed live: sessionStorage held `["nixie"]` and the
   * panel sat on the wrong clock indefinitely.
   *
   * So an id gets a LADDER of attempts and then genuinely stops. Both ends are load-bearing: the
   * retries are what heal a deploy race, and the stop is what keeps a bad id from reloading a wall
   * panel until somebody unplugs it.
   */
  describe('the catch-up retry ladder', () => {
    it('spans about half an hour in four attempts, widening each time', () => {
      // Pinned deliberately: these constants are a promise about how often a WALL PANEL blanks
      // itself, so a change to them should have to come here and be argued for.
      expect(RELOAD_BACKOFF_MS).toEqual([60_000, 300_000, 1_500_000])
      expect(MAX_RELOAD_ATTEMPTS).toBe(4)
    })

    it('retries once the window elapses, because the hub may simply not have had it yet', () => {
      const board = [cell('clock', { design: 'flip' })]
      expect(designsNeedingReload(board, {}, tried('flip', 1, T0), T0 + 60_000)).toEqual(['flip'])
    })

    it('holds off inside the window, so a deploy in flight is not a reload storm', () => {
      const board = [cell('clock', { design: 'flip' })]
      expect(designsNeedingReload(board, {}, tried('flip', 1, T0), T0 + 59_999)).toEqual([])
    })

    /**
     * The widening is the whole reason this is a ladder and not a fixed interval: each attempt
     * costs a full page reload, so an id that has already disappointed us twice has to earn the
     * third attempt with a longer wait.
     */
    it('makes each successive attempt wait longer than the last', () => {
      const board = [cell('clock', { design: 'flip' })]
      expect(designsNeedingReload(board, {}, tried('flip', 2, T0), T0 + 299_999)).toEqual([])
      expect(designsNeedingReload(board, {}, tried('flip', 2, T0), T0 + 300_000)).toEqual(['flip'])
      expect(designsNeedingReload(board, {}, tried('flip', 3, T0), T0 + 1_499_999)).toEqual([])
      expect(designsNeedingReload(board, {}, tried('flip', 3, T0), T0 + 1_500_000)).toEqual(['flip'])
    })

    /** The stop. Past the ladder the honest reading is "this id is wrong", and rule covers that. */
    it('gives up for good once the ladder runs out, however long it waits', () => {
      const board = [cell('clock', { design: 'flip' })]
      expect(designsNeedingReload(board, {}, tried('flip', MAX_RELOAD_ATTEMPTS, T0), T0 + 86_400_000)).toEqual([])
    })

    /** Otherwise a panel that ticks past a boundary once would keep re-qualifying every second. */
    it('measures the window from the LAST attempt, not the first sighting', () => {
      const board = [cell('clock', { design: 'flip' })]
      const late = T0 + 10_000_000
      expect(designsNeedingReload(board, {}, tried('flip', 2, late), late + 299_999)).toEqual([])
      expect(designsNeedingReload(board, {}, tried('flip', 2, late), late + 300_000)).toEqual(['flip'])
    })

    /**
     * Date.now() on a kiosk can step backwards (an NTP correction after a cold boot with no RTC).
     * Negative elapsed time must read as "not due yet" — the same direction theme.mjs's failedAt
     * and bitmaps.mjs's failedAt already fail in. Being late is a nuisance; reloading early on
     * a jumping clock is the loop this guard exists to prevent.
     */
    it('never reloads early when the clock jumps backwards', () => {
      const board = [cell('clock', { design: 'flip' })]
      expect(designsNeedingReload(board, {}, tried('flip', 1, T0), T0 - 3_600_000)).toEqual([])
    })

    /**
     * The ladder is measured with Date.now(), so a caller with no usable clock cannot honour it.
     * A never-seen id is still safe to act on (no elapsed time is involved in "act now"), but
     * anything already on the ladder must stay put rather than be handed a free attempt.
     */
    it('refuses to advance the ladder without a clock to measure with', () => {
      expect(designsNeedingReload([cell('clock', { design: 'flip' })], {}, tried('flip', 1, T0), undefined as never))
        .toEqual([])
      expect(designsNeedingReload([cell('clock', { design: 'flip' })], {}, {}, undefined as never))
        .toEqual(['flip'])
    })
  })

  /**
   * Devices upgrading into this build are still holding the ORIGINAL marker — a bare array of ids,
   * `["nixie"]` — in a session that survives the reload that delivers the new code. It has to be
   * understood, not crashed on and not silently discarded.
   */
  describe('reloadHistory', () => {
    it('migrates the original bare-array marker into attempt records', () => {
      expect(reloadHistory(['nixie'])).toEqual({ nixie: { n: 1, at: 0 } })
    })

    /**
     * `at: 0` rather than "now" because we genuinely do not know when that attempt happened — it
     * could have been hours ago on a panel that has been stuck all afternoon. Dating it to the
     * present would invent a fact and make the stuck panel wait out a window it has already served.
     * The count still carries over, so the migration hands back the REST of the ladder, not all
     * of it.
     */
    it('leaves a migrated id due for its next attempt, which is the stuck panel being unstuck', () => {
      const board = [cell('clock', { design: 'nixie' })]
      expect(designsNeedingReload(board, {}, ['nixie'], T0)).toEqual(['nixie'])
      expect(noteReloadAttempts(['nixie'], ['nixie'], T0).nixie.n).toBe(2)
    })

    it('passes a record it already understands through unchanged', () => {
      expect(reloadHistory({ flip: { n: 2, at: 1234 } })).toEqual({ flip: { n: 2, at: 1234 } })
    })

    /** Anything can be sitting under that key; none of it may reach the render path as a throw. */
    it('answers an empty history for junk rather than throwing on the render path', () => {
      expect(reloadHistory(null)).toEqual({})
      expect(reloadHistory(undefined)).toEqual({})
      expect(reloadHistory('nixie')).toEqual({})
      expect(reloadHistory(42)).toEqual({})
      expect(reloadHistory([null, 7, ''])).toEqual({})
    })

    /**
     * The asymmetry is on purpose. A KEY that exists is proof this id has been reloaded for at
     * least once, whatever state the rest of the entry is in — so an unreadable count is treated as
     * spent, never as fresh. Guessing low is the guess that reloads a wall panel.
     */
    it('treats an entry it cannot read a count out of as spent, not as fresh', () => {
      const board = [cell('clock', { design: 'flip' })]
      expect(reloadHistory({ flip: {} }).flip.n).toBe(MAX_RELOAD_ATTEMPTS)
      expect(reloadHistory({ flip: 3 }).flip.n).toBe(MAX_RELOAD_ATTEMPTS)
      expect(designsNeedingReload(board, {}, { flip: {} }, T0 + 86_400_000)).toEqual([])
    })

    it('repairs an unreadable timestamp without discarding the attempt it records', () => {
      expect(reloadHistory({ flip: { n: 2, at: 'soon' } })).toEqual({ flip: { n: 2, at: 0 } })
    })
  })

  describe('noteReloadAttempts', () => {
    it('records the first attempt against the clock the caller measured elapsed time with', () => {
      expect(noteReloadAttempts({}, ['flip'], T0)).toEqual({ flip: { n: 1, at: T0 } })
    })

    it('advances the count, so the next attempt has to wait out the wider window', () => {
      expect(noteReloadAttempts(tried('flip', 1, T0), ['flip'], T0 + 60_000))
        .toEqual({ flip: { n: 2, at: T0 + 60_000 } })
    })

    /** Two bad ids on one board are two independent ladders; one reload spends a step of each. */
    it('leaves ids it was not told about exactly where they were', () => {
      expect(noteReloadAttempts(tried('nixie', 2, T0), ['flip'], T0 + 5))
        .toEqual({ nixie: { n: 2, at: T0 }, flip: { n: 1, at: T0 + 5 } })
    })

    it('does not mutate the history it was handed', () => {
      const before = tried('flip', 1, T0)
      noteReloadAttempts(before, ['flip'], T0 + 60_000)
      expect(before).toEqual({ flip: { n: 1, at: T0 } })
    })
  })

  /** Once the design is registered, the same board stops asking — no reload after the catch-up. */
  it('goes quiet as soon as the page has the design', () => {
    const board = [cell('clock', { design: 'flip' })]
    expect(designsNeedingReload(board, {}, {}, T0)).toEqual(['flip'])
    register(design('flip', 'clock'))
    expect(designsNeedingReload(board, {}, {}, T0)).toEqual([])
  })
})
