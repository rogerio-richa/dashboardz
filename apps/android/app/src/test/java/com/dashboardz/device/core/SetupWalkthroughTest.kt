package com.dashboardz.device.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SetupWalkthroughTest {

    @Test
    fun freshPairWithAnyGrantMissingNeedsTheWalkthrough() {
        assertTrue(needsSetupWalkthrough(setupDone = false, batteryExempt = false, overlay = false))
        assertTrue(needsSetupWalkthrough(setupDone = false, batteryExempt = true, overlay = false))
        assertTrue(needsSetupWalkthrough(setupDone = false, batteryExempt = false, overlay = true))
    }

    @Test
    fun bothGrantsAlreadyHeldSkipsIt() {
        // Nothing to ask for — a walkthrough of two green checkmarks would just be a speed bump.
        assertFalse(needsSetupWalkthrough(setupDone = false, batteryExempt = true, overlay = true))
    }

    @Test
    fun neverReturnsOnceDismissed() {
        // Done is a decision, not a snooze: grants stay reachable from settings, and a wall
        // panel must not greet every reboot with the same checklist.
        assertFalse(needsSetupWalkthrough(setupDone = true, batteryExempt = false, overlay = false))
    }
}
