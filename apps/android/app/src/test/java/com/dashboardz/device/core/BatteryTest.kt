package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BatteryTest {

    @Test
    fun computesPercentFromLevelAndScale() {
        assertEquals(100, batteryPercent(level = 100, scale = 100))
        assertEquals(42, batteryPercent(level = 42, scale = 100))
        // Not every device reports a scale of 100.
        assertEquals(50, batteryPercent(level = 500, scale = 1000))
        assertEquals(0, batteryPercent(level = 0, scale = 100))
    }

    @Test
    fun returnsNullWhenTheDeviceReportsUnknown() {
        // ACTION_BATTERY_CHANGED yields -1 for both fields when it has nothing to say;
        // sending a bogus -1% to the hub would be worse than sending nothing.
        assertNull(batteryPercent(level = -1, scale = 100))
        assertNull(batteryPercent(level = 42, scale = -1))
        assertNull(batteryPercent(level = 42, scale = 0))
    }

    @Test
    fun clampsNonsenseIntoRange() {
        assertEquals(100, batteryPercent(level = 150, scale = 100))
    }
}
