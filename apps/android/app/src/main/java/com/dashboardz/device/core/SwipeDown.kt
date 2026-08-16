package com.dashboardz.device.core

/**
 * The settings gesture: a TWO-finger swipe down anywhere on the board opens the native settings
 * surface.
 *
 * Two fingers, deliberately. Every single-finger gesture already belongs to the board: taps hit
 * answer/dismiss buttons, the tab bar and the scroll design's arrow rail, and a one-finger
 * vertical drag IS the scroll design's scroll (docs/architecture/widgets.md, "Pointer input") —
 * a one-finger swipe-down opener would fire every time someone read back through a journal. Two
 * fingers collide with nothing the board or the page's takeover listens for, and are hard to
 * produce by brushing a wall panel accidentally.
 *
 * Pure state machine over (pointerCount, gestureEnded, averageY) rather than MotionEvent, so the
 * decision — the part that can silently break the ONLY route into settings — is JVM-testable.
 * The activity's dispatchTouchEvent feeds it and stays an observer: events flow on to the
 * WebView/Compose untouched, so a swipe that opens settings still scrolls the journal under it
 * (harmless: the board is covered the next frame) rather than this detector claiming gestures.
 *
 * Fires AT MOST ONCE per touch session (all fingers up ends a session): holding two fingers down
 * and wiggling must not toggle settings repeatedly.
 */
class TwoFingerSwipeDown(private val thresholdPx: Float) {

    private var anchorY: Float? = null
    private var fired = false

    /**
     * Feed every touch event; returns true exactly when the gesture triggers.
     *
     * @param pointerCount fingers currently down
     * @param gestureEnded true on the event that ends the whole touch session (last finger up,
     *   or the system cancelling the gesture)
     * @param avgY the average Y of all current pointers, in px — averaged so lifting one of the
     *   two fingers a moment before the other cannot fake a jump
     */
    fun onEvent(pointerCount: Int, gestureEnded: Boolean, avgY: Float): Boolean {
        if (gestureEnded) {
            anchorY = null
            fired = false
            return false
        }
        if (pointerCount != 2) {
            // Not (or no longer) a two-finger gesture: drop the anchor but keep `fired` — a
            // finger lifting after a successful swipe must not arm a second trigger in the same
            // session.
            anchorY = null
            return false
        }
        val anchor = anchorY ?: run { anchorY = avgY; return false }
        if (fired) return false
        if (avgY - anchor >= thresholdPx) {
            fired = true
            return true
        }
        return false
    }
}
