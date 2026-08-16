package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmEscalationTest {

    @Test
    fun startsAudibleButNotAtFullBlast() {
        // A critical at 3am should not open at maximum volume — it ramps.
        assertEquals(30, AlarmEscalation.volumeAt(0))
    }

    @Test
    fun reachesFullVolumeByThirtySecondsAndStaysThere() {
        assertEquals(100, AlarmEscalation.volumeAt(30_000))
        assertEquals(100, AlarmEscalation.volumeAt(60_000))
        assertEquals(100, AlarmEscalation.volumeAt(10 * 60_000))
    }

    @Test
    fun volumeRisesMonotonically() {
        var previous = -1
        for (elapsed in 0..30_000 step 1_000) {
            val v = AlarmEscalation.volumeAt(elapsed.toLong())
            assertTrue("volume must never drop (at ${elapsed}ms)", v >= previous)
            previous = v
        }
        assertEquals(65, AlarmEscalation.volumeAt(15_000))   // linear midpoint
    }

    @Test
    fun beepsGetMoreFrequentAsTheAlarmEscalates() {
        assertEquals(1_500L, AlarmEscalation.intervalMsAt(0))
        assertEquals(1_000L, AlarmEscalation.intervalMsAt(15_000))
        assertEquals(500L, AlarmEscalation.intervalMsAt(30_000))
        assertEquals(500L, AlarmEscalation.intervalMsAt(120_000))
    }

    @Test
    fun negativeElapsedIsTreatedAsZero() {
        // Guards against a clock adjustment mid-alarm producing a nonsense interval.
        assertEquals(30, AlarmEscalation.volumeAt(-5_000))
        assertEquals(1_500L, AlarmEscalation.intervalMsAt(-5_000))
    }
}
