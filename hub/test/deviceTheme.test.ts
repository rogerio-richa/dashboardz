import { describe, expect, it, beforeEach } from 'vitest'
// @ts-expect-error plain JS module without types
import { currentBoard, currentChrome, currentWidgets, noteThemeRef, _reset, BUILTIN_BOARD, BUILTIN_CHROME } from '../static/device/theme.mjs'
import { BUILTIN_BOARD as HUB_BOARD, BUILTIN_CHROME as HUB_CHROME } from '../src/themeDefaults.js'

const doc = (bg: string) => ({ id: 'thm_a', rev: 1, board: { ...BUILTIN_BOARD, bg }, bg: { kind: 'none' }, widgets: {} })

describe('device theme layer', () => {
  beforeEach(() => _reset())

  it('serves built-in defaults before any fetch resolves', () => {
    expect(currentBoard().bg).toBe(BUILTIN_BOARD.bg)
    expect(currentWidgets()).toEqual({})
  })

  it('applies a fetched theme', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => doc('#111111') })
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 0 })
    expect(currentBoard().bg).toBe('#111111')
  })

  it('does not refetch while id:rev is unchanged', async () => {
    let calls = 0
    const fetchFn = async () => { calls++; return { ok: true, json: async () => doc('#111111') } }
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 0 })
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 1000 })
    expect(calls).toBe(1)
  })

  it('refetches when rev bumps', async () => {
    let calls = 0
    const fetchFn = async () => { calls++; return { ok: true, json: async () => doc('#222222') } }
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 0 })
    await noteThemeRef({ id: 'thm_a', rev: 2 }, { fetchFn, now: () => 1000 })
    expect(calls).toBe(2)
  })

  it('keeps the last good theme when a fetch fails', async () => {
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn: async () => ({ ok: true, json: async () => doc('#333333') }), now: () => 0 })
    await noteThemeRef({ id: 'thm_a', rev: 2 }, { fetchFn: async () => { throw new Error('offline') }, now: () => 1000 })
    expect(currentBoard().bg).toBe('#333333')
  })

  it('does not retry a failure more often than every 30s', async () => {
    let calls = 0
    const fetchFn = async () => { calls++; throw new Error('offline') }
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 0 })
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 5_000 })
    expect(calls).toBe(1)
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 31_000 })
    expect(calls).toBe(2)
  })

  it('falls back to built-in defaults when the ref is null', async () => {
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn: async () => ({ ok: true, json: async () => doc('#444444') }), now: () => 0 })
    await noteThemeRef(null, { fetchFn: async () => { throw new Error('unused') }, now: () => 1000 })
    expect(currentBoard().bg).toBe(BUILTIN_BOARD.bg)
  })

  it('ignores a malformed document rather than corrupting the board', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ nonsense: true }) })
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 0 })
    expect(currentBoard().bg).toBe(BUILTIN_BOARD.bg)
  })

  it('the device copy of the board block matches the hub copy exactly', () => {
    // Two copies exist because hub/static/ has no build step and cannot import TypeScript.
    // They must never drift: the hub seeds `default` from its copy, the device renders from this one.
    expect(BUILTIN_BOARD).toEqual(HUB_BOARD)
  })

  it('the device copy of the chrome map matches the hub copy exactly', () => {
    // Same twin-pin as the board block above, for the optional tab-bar chrome map.
    expect(BUILTIN_CHROME).toEqual(HUB_CHROME)
  })

  it('serves built-in chrome before any fetch resolves', () => {
    expect(currentChrome()).toEqual(BUILTIN_CHROME)
  })

  it('carries a fetched theme’s chrome overrides through to currentChrome()', async () => {
    const docWithChrome = { id: 'thm_a', rev: 1, board: BUILTIN_BOARD, bg: { kind: 'none' }, widgets: {}, chrome: { muted: '#123456' } }
    const fetchFn = async () => ({ ok: true, json: async () => docWithChrome })
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn, now: () => 0 })
    expect(currentChrome().muted).toBe('#123456')
  })

  it('a theme document with no chrome field yields an empty override map, not built-ins', async () => {
    // Mirrors currentWidgets(): the RAW override map, defaults applied later at the CSS layer —
    // not merged here, matching how widgets already behaves.
    const docNoChrome = { id: 'thm_a', rev: 1, board: BUILTIN_BOARD, bg: { kind: 'none' }, widgets: {} }
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn: async () => ({ ok: true, json: async () => docNoChrome }), now: () => 0 })
    expect(currentChrome()).toEqual({})
  })

  it('falls back to built-in chrome when the ref is null', async () => {
    const docWithChrome = { id: 'thm_a', rev: 1, board: BUILTIN_BOARD, bg: { kind: 'none' }, widgets: {}, chrome: { muted: '#123456' } }
    await noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn: async () => ({ ok: true, json: async () => docWithChrome }), now: () => 0 })
    await noteThemeRef(null, { fetchFn: async () => { throw new Error('unused') }, now: () => 1000 })
    expect(currentChrome()).toEqual(BUILTIN_CHROME)
  })

  // A fetch started for an OLDER call must not overwrite state a NEWER
  // call already set once it finally resolves. Both variants interleave a genuinely in-flight
  // fetch (controlled by hand via a Promise executor, not awaited immediately) with a second,
  // synchronously-settling call, then let the stale fetch resolve last.
  it('discards a stale in-flight fetch when a later call clears the theme first', async () => {
    let resolveStale: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {}
    const staleFetch = () => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => { resolveStale = resolve })

    // STATE#1: theme A starts a fetch that will not settle until we say so.
    const inFlight = noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn: staleFetch, now: () => 0 })
    // STATE#2 arrives before it settles: no theme assigned at all — must win immediately.
    await noteThemeRef(null, { fetchFn: async () => { throw new Error('unused') }, now: () => 0 })
    expect(currentBoard().bg).toBe(BUILTIN_BOARD.bg)

    // Theme A's stale fetch finally resolves — must NOT resurrect theme A.
    resolveStale({ ok: true, json: async () => doc('#555555') })
    await inFlight
    expect(currentBoard().bg).toBe(BUILTIN_BOARD.bg)
  })

  it('discards a stale in-flight fetch when a later call switches to a different theme', async () => {
    let resolveStale: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {}
    const staleFetch = () => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => { resolveStale = resolve })
    const docB = { id: 'thm_b', rev: 1, board: { ...BUILTIN_BOARD, bg: '#666666' }, bg: { kind: 'none' }, widgets: {} }

    // STATE#1: theme A starts a fetch that will not settle until we say so.
    const inFlightA = noteThemeRef({ id: 'thm_a', rev: 1 }, { fetchFn: staleFetch, now: () => 0 })
    // STATE#2 arrives before it settles: a DIFFERENT theme, B, whose own fetch settles immediately.
    await noteThemeRef({ id: 'thm_b', rev: 1 }, { fetchFn: async () => ({ ok: true, json: async () => docB }), now: () => 0 })
    expect(currentBoard().bg).toBe('#666666')

    // Theme A's stale fetch finally resolves — must NOT clobber theme B.
    resolveStale({ ok: true, json: async () => doc('#777777') })
    await inFlightA
    expect(currentBoard().bg).toBe('#666666')
  })
})
