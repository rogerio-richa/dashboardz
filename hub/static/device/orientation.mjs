/**
 * Make the board read the way the operator configured it, whatever the hardware is doing.
 *
 * The Android app has had this behavior from the start: `MainActivity` sets `requestedOrientation` from
 * `state.device.orientation` before the first frame and re-applies it on every STATE. The web
 * renderer had nothing — `orientation` reached the browser in STATE and was simply never read, so
 * a phone in Chrome reflowed freely and a portrait board turned landscape with the handset.
 *
 * A browser cannot do what the app does. `screen.orientation.lock()` is refused outside fullscreen
 * on Android and refused outright on desktop, so it can only ever be a bonus, never the mechanism.
 * The mechanism is to COUNTER-ROTATE: lay the board out at the configured aspect and turn it 90°
 * so it reads correctly on a panel mounted the other way round.
 *
 * WHY A CSS TRANSFORM IS SAFE HERE, WHICH IS NOT OBVIOUS. Cell geometry comes from
 * `grid.clientWidth`/`clientHeight` (device.js), which report the UNTRANSFORMED layout box — a
 * transform changes what is painted, not what is measured. Had those reads been
 * `getBoundingClientRect()`, every canvas design would have been handed post-rotation dimensions
 * and sized its backing store wrongly. Pointer events map through the transform on their own, so
 * dismiss and answer taps keep landing where they look.
 */

/** Best-effort native lock. Resolves to whether it actually took. */
export async function tryNativeLock(wanted, screenApi) {
  const api = screenApi?.orientation
  if (!api || typeof api.lock !== 'function') return false
  try {
    await api.lock(wanted === 'portrait' ? 'portrait' : 'landscape')
    return true
  } catch {
    // Refused outside fullscreen (Android) or unsupported (desktop). Expected, not an error:
    // the counter-rotation below is the real mechanism and does not need this to succeed.
    return false
  }
}

/**
 * Does the board need turning 90° to read as `wanted` in a viewport of this shape?
 *
 * Pure and exported so the hub's Node suite can pin the decision without a DOM. An unknown or
 * missing orientation means "no opinion" — never rotate on a value we do not understand, because
 * a board wrongly turned on its side is far worse than one that merely reflows.
 *
 * A perfectly square viewport counts as landscape, matching device.js's own `screenW > screenH`
 * convention, so the two never disagree about what shape they are looking at.
 */
export function needsRotation(wanted, viewportW, viewportH) {
  if (wanted !== 'portrait' && wanted !== 'landscape') return false
  if (!(viewportW > 0) || !(viewportH > 0)) return false
  const viewportIsLandscape = viewportW >= viewportH
  return wanted === 'landscape' ? !viewportIsLandscape : viewportIsLandscape
}

/**
 * Apply (or clear) the counter-rotation. Returns whether the class changed, so the caller can
 * re-render only when the grid actually resized — every canvas cell has to re-measure and resize
 * its backing store when it does.
 */
export function applyRotation(wanted, deps) {
  const { root, viewportW, viewportH } = deps
  if (!root) return false
  const want = needsRotation(wanted, viewportW, viewportH)
  const had = root.classList.contains('rotated')
  if (want === had) return false
  root.classList.toggle('rotated', want)
  return true
}
