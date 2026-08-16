/**
 * ONE requestAnimationFrame loop for the whole board (animation contract). No design
 * may start its own loop, timer or interval — fifteen widgets each running a timer is exactly the
 * failure mode this exists to prevent.
 *
 * rule is the load-bearing one: the loop must idle to ZERO frames when nothing is animating.
 * A loop that keeps ticking "just in case" would burn a frame every 16ms on a phone that is on
 * 24/7, which is the cost DOM would have avoided via the compositor.
 *
 * Callbacks receive elapsed-ms-since-their-own-start, never a timestamp, because an animation is
 * required to be a pure function of its inputs (rule) — resumable after a dropped frame and
 * testable without a clock.
 *
 * A callback RETURNS whether it is still animating, and returning `false` drops its key. That is
 * how a bounded transition ends: the registrar (widgets/index.mjs paintWidgets) hands over a
 * closure it cannot reach again, so without a completion signal from the callback itself the only
 * things that ever remove a key are a cell vanishing and a throw — and a transition that finishes
 * normally would pin the loop at full rate forever.
 */
let raf = (cb) => globalThis.requestAnimationFrame(cb)
let cancelRaf = (id) => globalThis.cancelAnimationFrame(id)

const active = new Map() // key -> { cb, startedAt }
let frameId = null

/** Test seam: swap in a manual clock so the suite needs no timers and cannot flake. */
export function _setRaf(rafFn, cancelFn) {
  raf = rafFn
  cancelRaf = cancelFn
}

export function _reset() {
  active.clear()
  frameId = null
}

export function activeCount() {
  return active.size
}

function tick(now) {
  frameId = null
  // The spread is load-bearing and oxlint is wrong about it (`unicorn/no-useless-spread`): the body
  // calls `active.delete(key)`, and a design's own callback can register or drop others. Iterating
  // the live Map would mean mutating a collection mid-iteration. Snapshot first, then mutate freely.
  for (const [key, entry] of [...active.entries()]) {
    if (entry.startedAt === null) entry.startedAt = now
    try {
      // Strictly `false`, not falsy: a callback that returns nothing keeps running, which is what
      // a persistent animation (no natural end) looks like and what every pre-existing caller does.
      if (entry.cb(now - entry.startedAt) === false) active.delete(key)
    } catch (err) {
      // One bad design must not freeze the board. Drop it and
      // keep the loop alive; logged once, not once per frame.
      active.delete(key)
      console.error(`widget animation ${key} threw; dropped`, err)
    }
  }
  schedule()
}

function schedule() {
  if (frameId !== null || active.size === 0) return
  frameId = raf(tick)
}

export function startAnimation(key, cb) {
  active.set(key, { cb, startedAt: null })
  schedule()
}

export function stopAnimation(key) {
  active.delete(key)
  if (active.size === 0 && frameId !== null) {
    cancelRaf(frameId)
    frameId = null
  }
}
