package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SoundKeysTest {
    @Test fun fileNameIsKeyedByRev() { assertEquals("bells-critical-3.wav", soundFileName("bells", "critical", 3)) }
    @Test fun hostileNamesAreRejected() {
        for (bad in listOf("../etc", "a/b", "", "A", "x".repeat(41))) assertNull(soundFileName(bad, "critical", 1))
        assertNull(soundFileName("bells", "later", 1))  // not an event
        assertNull(soundFileName("bells", "critical", -1))
    }
    @Test fun urlMatchesHubStaticLayout() {
        assertEquals("http://hub:8484/sounds/bells/critical.wav?rev=3", soundUrl("http://hub:8484/", "bells", "critical", 3))
    }
    @Test fun wantedSoundsUnionsScreensAndSkipsClassic() {
        val a = WireScreen(id = "a", name = "a", sounds = mapOf("critical" to "bells", "warn" to "classic"))
        val b = WireScreen(id = "b", name = "b", sounds = mapOf("critical" to "8bit"))
        assertEquals(setOf("bells" to "critical", "8bit" to "critical"), wantedSounds(listOf(a, b)))
    }

    // stream-activity contract: stream-activity sounds extend the event whitelist with a fifth event, `activity`.

    @Test fun activityIsAValidEvent() {
        assertEquals("bells-activity-2.wav", soundFileName("bells", "activity", 2))
    }

    @Test fun wantedSoundsIncludesActivityPairsAndStillSkipsClassic() {
        val a = WireScreen(id = "a", name = "a", sounds = mapOf("activity" to "bells", "warn" to "classic"))
        val b = WireScreen(id = "b", name = "b", sounds = mapOf("activity" to "8bit"))
        assertEquals(setOf("bells" to "activity", "8bit" to "activity"), wantedSounds(listOf(a, b)))
    }
}
