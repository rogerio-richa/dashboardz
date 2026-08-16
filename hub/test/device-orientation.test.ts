import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module without types
import { applyRotation, needsRotation, tryNativeLock } from '../static/device/orientation.mjs'

/**
 * The Android app has locked orientation since fixed-orientation rule (MainActivity sets `requestedOrientation` from
 * `state.device.orientation`). The web renderer read the same field out of STATE and did nothing
 * with it, so a phone in Chrome reflowed freely. These tests pin the rotation decision; the CSS
 * that applies it lives in index.html.
 */
describe('board orientation decision', () => {
  it('leaves a matching viewport alone', () => {
    expect(needsRotation('landscape', 800, 360)).toBe(false)
    expect(needsRotation('portrait', 360, 800)).toBe(false)
  })

  it('rotates when the viewport is the wrong way round', () => {
    expect(needsRotation('landscape', 360, 800)).toBe(true)
    expect(needsRotation('portrait', 800, 360)).toBe(true)
  })

  /**
   * A board wrongly turned on its side is far worse than one that merely reflows, so anything not
   * understood means "no opinion". `orientation` is a plain string on the wire (Wire.kt keeps it
   * that way deliberately), so a hub newer than this client can and will send values from the
   * future.
   */
  it('never rotates on an orientation it does not understand', () => {
    for (const v of ['', 'sideways', 'PORTRAIT', null, undefined, 0, {}]) {
      expect(needsRotation(v, 360, 800)).toBe(false)
    }
  })

  it('never rotates on a degenerate viewport', () => {
    expect(needsRotation('portrait', 0, 0)).toBe(false)
    expect(needsRotation('landscape', 800, 0)).toBe(false)
    expect(needsRotation('portrait', -10, 50)).toBe(false)
  })

  /** Square counts as landscape, matching device.js's own `screenW > screenH` convention. */
  it('treats a square viewport as landscape, like the grid does', () => {
    expect(needsRotation('landscape', 500, 500)).toBe(false)
    expect(needsRotation('portrait', 500, 500)).toBe(true)
  })
})

/** A tiny stand-in for document.body's classList. */
const fakeRoot = (initial = false) => {
  const set = new Set<string>(initial ? ['rotated'] : [])
  return {
    classList: {
      contains: (c: string) => set.has(c),
      toggle: (c: string, on: boolean) => (on ? set.add(c) : set.delete(c)),
    },
    has: () => set.has('rotated'),
  }
}

describe('applying the rotation', () => {
  it('adds the class when the viewport is the wrong way round', () => {
    const root = fakeRoot()
    expect(applyRotation('landscape', { root, viewportW: 360, viewportH: 800 })).toBe(true)
    expect(root.has()).toBe(true)
  })

  it('removes it again when the viewport comes back round', () => {
    const root = fakeRoot(true)
    expect(applyRotation('landscape', { root, viewportW: 800, viewportH: 360 })).toBe(true)
    expect(root.has()).toBe(false)
  })

  /**
   * The return value gates a re-render, and a re-render rebuilds every canvas backing store. A
   * no-op resize (which fires constantly on a phone, e.g. for the URL bar collapsing) must report
   * "nothing changed" or the board pays for a full repaint on every one.
   */
  it('reports no change when the class is already right', () => {
    const on = fakeRoot(true)
    expect(applyRotation('landscape', { root: on, viewportW: 360, viewportH: 800 })).toBe(false)
    expect(on.has()).toBe(true)

    const off = fakeRoot(false)
    expect(applyRotation('landscape', { root: off, viewportW: 800, viewportH: 360 })).toBe(false)
    expect(off.has()).toBe(false)
  })

  it('does nothing without a root, rather than throwing mid-render', () => {
    expect(applyRotation('portrait', { root: null, viewportW: 800, viewportH: 360 })).toBe(false)
  })
})

/**
 * The native lock is a bonus, never the mechanism: Android refuses it outside fullscreen and
 * desktop refuses it outright. A rejection must be swallowed — an unhandled rejection here would
 * surface as a console error on every single board that is not in fullscreen, i.e. all of them.
 */
describe('native orientation lock', () => {
  it('reports success when the browser accepts it', async () => {
    const lock = vi.fn(async () => {})
    expect(await tryNativeLock('portrait', { orientation: { lock } })).toBe(true)
    expect(lock).toHaveBeenCalledWith('portrait')
  })

  it('maps anything non-portrait to landscape', async () => {
    const lock = vi.fn(async () => {})
    await tryNativeLock('landscape', { orientation: { lock } })
    expect(lock).toHaveBeenCalledWith('landscape')
  })

  it('swallows a refusal instead of rejecting', async () => {
    const lock = vi.fn(async () => { throw new Error('not in fullscreen') })
    await expect(tryNativeLock('portrait', { orientation: { lock } })).resolves.toBe(false)
  })

  it('reports false where the API does not exist at all', async () => {
    expect(await tryNativeLock('portrait', undefined)).toBe(false)
    expect(await tryNativeLock('portrait', {})).toBe(false)
    expect(await tryNativeLock('portrait', { orientation: {} })).toBe(false)
  })
})
