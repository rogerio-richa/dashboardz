package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffTest {

    @Test
    fun growsExponentiallyAndCapsAtSixtySeconds() {
        // random() pinned to 1.0 => no jitter reduction, so we see the raw ceiling.
        val b = Backoff(random = { 1.0 })
        assertEquals(1_000L, b.nextDelayMs())
        assertEquals(2_000L, b.nextDelayMs())
        assertEquals(4_000L, b.nextDelayMs())
        assertEquals(8_000L, b.nextDelayMs())
        repeat(20) { b.nextDelayMs() }
        assertEquals(60_000L, b.nextDelayMs())   // capped, and no overflow after many attempts
    }

    @Test
    fun jitterKeepsDelayBetweenHalfAndFullOfTheCeiling() {
        // Jitter matters: without it, every device in the building reconnects in lockstep
        // and hammers the hub the instant it comes back.
        val low = Backoff(random = { 0.0 })
        assertEquals(500L, low.nextDelayMs())
        val mid = Backoff(random = { 0.5 })
        assertEquals(750L, mid.nextDelayMs())
    }

    @Test
    fun resetReturnsToTheBase() {
        val b = Backoff(random = { 1.0 })
        b.nextDelayMs(); b.nextDelayMs(); b.nextDelayMs()
        b.reset()
        assertEquals(1_000L, b.nextDelayMs())
    }

    @Test
    fun derivesWebSocketAndPairUrls() {
        assertEquals("ws://10.0.2.2:8484/ws/device", wsUrl("http://10.0.2.2:8484"))
        assertEquals("ws://10.0.2.2:8484/ws/device", wsUrl("http://10.0.2.2:8484/"))
        assertEquals("wss://hub.example.com/ws/device", wsUrl("https://hub.example.com"))
        assertEquals("http://10.0.2.2:8484/api/pair", pairUrl("http://10.0.2.2:8484"))
    }

    @Test
    fun normalizesHubUrlsTypedByHand() {
        assertEquals("http://10.0.2.2:8484", normalizeHubUrl("  10.0.2.2:8484 "))
        assertEquals("http://10.0.2.2:8484", normalizeHubUrl("http://10.0.2.2:8484/"))
        assertEquals("https://hub.local", normalizeHubUrl("https://hub.local///"))
    }

    @Test
    fun formatsAgesAgainstHubTimeAndNeverGoesNegative() {
        assertEquals("12s", ageLabel(updatedAt = 88_000, serverNow = 100_000))
        assertEquals("5m", ageLabel(updatedAt = 700_000, serverNow = 1_000_000))
        assertEquals("3h", ageLabel(updatedAt = 0, serverNow = 3 * 3_600_000))
        // A device clock ahead of the hub must render "0s", not a negative age.
        assertEquals("0s", ageLabel(updatedAt = 100_000, serverNow = 90_000))
    }

    @Test
    fun delaysAreAlwaysPositive() {
        val b = Backoff(random = { 0.0 })
        repeat(40) { assertTrue(b.nextDelayMs() > 0) }
    }
}
