import { describe, expect, it, beforeEach, vi } from 'vitest'
// @ts-expect-error plain JS module without types
import { startAnimation, stopAnimation, activeCount, _setRaf, _reset } from '../static/device/widgets/loop.mjs'

/** Manual clock: nothing runs until step() is called, so no timers and no flake. */
function harness() {
  let queued: ((t: number) => void) | null = null
  let cancels = 0
  _setRaf((cb: (t: number) => void) => { queued = cb; return 1 }, () => { cancels++; queued = null })
  return {
    step: (t: number) => { const c = queued; queued = null; c?.(t) },
    pending: () => queued !== null,
    cancels: () => cancels,
  }
}

describe('board frame loop', () => {
  beforeEach(() => _reset())

  it('schedules no frame while nothing is animating', () => {
    const h = harness()
    expect(h.pending()).toBe(false)
    expect(activeCount()).toBe(0)
  })

  it('runs a registered callback with elapsed time from its start', () => {
    const h = harness()
    const seen: number[] = []
    startAnimation('cell0', (elapsed: number) => seen.push(elapsed))
    h.step(1000)
    h.step(1200)
    expect(seen).toEqual([0, 200])
  })

  it('stops scheduling once the last animation is removed', () => {
    const h = harness()
    startAnimation('cell0', () => {})
    h.step(1000)
    expect(h.pending()).toBe(true)
    stopAnimation('cell0')
    h.step(1100)
    expect(h.pending()).toBe(false)
    expect(activeCount()).toBe(0)
  })

  it('keeps running while other animations remain', () => {
    const h = harness()
    startAnimation('a', () => {})
    startAnimation('b', () => {})
    h.step(1000)
    stopAnimation('a')
    h.step(1100)
    expect(h.pending()).toBe(true)
    expect(activeCount()).toBe(1)
  })

  it('restarting a key resets its elapsed clock rather than stacking a second callback', () => {
    const h = harness()
    const seen: number[] = []
    startAnimation('cell0', (e: number) => seen.push(e))
    h.step(1000)
    startAnimation('cell0', (e: number) => seen.push(e))
    h.step(1500)
    expect(activeCount()).toBe(1)
    expect(seen).toEqual([0, 0])
  })

  it('idles after a callback stops itself from inside tick', () => {
    const h = harness()
    startAnimation('digit', (elapsed: number) => {
      if (elapsed >= 100) {
        stopAnimation('digit')
      }
    })
    h.step(1000) // elapsed = 0, doesn't stop
    expect(h.pending()).toBe(true)
    h.step(1100) // elapsed = 100, stops itself from inside tick
    expect(h.pending()).toBe(false)
    expect(activeCount()).toBe(0)
  })

  // How a bounded transition ENDS. paintWidgets registers a callback it
  // does not own and cannot stop from outside, so the callback reporting completion is the only
  // path back to an idle loop for a design that finishes on its own.
  it('drops a key whose callback reports it has finished by returning false', () => {
    const h = harness()
    let finished = false
    startAnimation('digit', () => !finished)
    h.step(1000)
    expect(activeCount()).toBe(1)
    expect(h.pending()).toBe(true)
    finished = true
    h.step(1100)
    expect(activeCount()).toBe(0)
    expect(h.pending()).toBe(false)
  })

  it('keeps every other key when one reports it has finished', () => {
    const h = harness()
    startAnimation('done', () => false)
    startAnimation('busy', () => true)
    h.step(1000)
    expect(activeCount()).toBe(1)
    expect(h.pending()).toBe(true)
  })

  it('keeps a callback that returns nothing — only an explicit false ends an animation', () => {
    const h = harness()
    startAnimation('cell0', () => undefined)
    h.step(1000)
    h.step(1100)
    expect(activeCount()).toBe(1)
    expect(h.pending()).toBe(true)
  })

  it('a throwing callback does not prevent a healthy animation from continuing', () => {
    const h = harness()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: number[] = []
    startAnimation('broken', () => {
      throw new Error('bad design')
    })
    startAnimation('healthy', (elapsed: number) => seen.push(elapsed))
    h.step(1000)
    expect(seen).toEqual([0])
    expect(activeCount()).toBe(1) // broken was dropped
    h.step(1100)
    expect(seen).toEqual([0, 100])
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('a single throwing callback drops and idles', () => {
    const h = harness()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    startAnimation('broken', () => {
      throw new Error('bad design')
    })
    h.step(1000)
    expect(activeCount()).toBe(0) // broken was dropped
    expect(h.pending()).toBe(false) // loop idles
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('a throwing callback is logged once, not once per frame', () => {
    const h = harness()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    startAnimation('broken', () => {
      throw new Error('bad design')
    })
    h.step(1000)
    // Try to step again (would have thrown again if not caught)
    h.step(1100)
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})
