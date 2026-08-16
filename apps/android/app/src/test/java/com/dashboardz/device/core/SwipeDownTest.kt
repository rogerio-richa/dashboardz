package com.dashboardz.device.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The settings gesture is the ONLY route into settings since the Compose board's status strip
 * went with the board — a silent regression here strands the operator with no way to edit the
 * hub address. Hence a JVM pin on the pure state machine.
 */
class SwipeDownTest {

    private fun detector() = TwoFingerSwipeDown(thresholdPx = 100f)

    @Test
    fun firesOnceTwoFingersTravelTheThreshold() {
        val d = detector()
        assertFalse(d.onEvent(2, false, 500f))   // anchor
        assertFalse(d.onEvent(2, false, 560f))   // short of threshold
        assertTrue(d.onEvent(2, false, 605f))    // 105px down
    }

    @Test
    fun oneFingerNeverFires_thatGestureBelongsToTheBoard() {
        val d = detector()
        assertFalse(d.onEvent(1, false, 500f))
        assertFalse(d.onEvent(1, false, 900f))
        assertFalse(d.onEvent(1, false, 1400f))
    }

    @Test
    fun swipingUpNeverFires() {
        val d = detector()
        assertFalse(d.onEvent(2, false, 800f))
        assertFalse(d.onEvent(2, false, 200f))
    }

    @Test
    fun firesAtMostOncePerTouchSession() {
        val d = detector()
        d.onEvent(2, false, 500f)
        assertTrue(d.onEvent(2, false, 700f))
        assertFalse(d.onEvent(2, false, 900f))     // keep dragging: no re-fire
        // One finger lifts and re-lands mid-session: still no re-fire.
        assertFalse(d.onEvent(1, false, 900f))
        assertFalse(d.onEvent(2, false, 900f))
        assertFalse(d.onEvent(2, false, 1100f))
    }

    @Test
    fun aNewSessionAfterAllFingersLiftCanFireAgain() {
        val d = detector()
        d.onEvent(2, false, 500f)
        assertTrue(d.onEvent(2, false, 700f))
        assertFalse(d.onEvent(0, true, 700f))      // session ends
        d.onEvent(2, false, 300f)
        assertTrue(d.onEvent(2, false, 450f))
    }

    @Test
    fun droppingToOneFingerResetsTheAnchor_noCreditForOldTravel() {
        val d = detector()
        d.onEvent(2, false, 500f)
        assertFalse(d.onEvent(2, false, 560f))     // 60px — not enough
        assertFalse(d.onEvent(1, false, 560f))     // finger lifts: anchor dropped
        assertFalse(d.onEvent(2, false, 560f))     // re-anchor here
        assertFalse(d.onEvent(2, false, 620f))     // 60px from NEW anchor — still not enough
        assertTrue(d.onEvent(2, false, 680f))      // 120px from new anchor
    }
}
