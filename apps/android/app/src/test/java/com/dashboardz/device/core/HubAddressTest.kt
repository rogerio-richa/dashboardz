package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * People type and read hub addresses as "192.168.1.20:8484". The app adds http:// itself
 * (normalizeHubUrl), so it must not show it back to them either; only https:// is worth showing,
 * because it's a choice the user made.
 */
class HubAddressTest {
    @Test fun plainHttpIsShownWithoutTheScheme() {
        assertEquals("192.168.1.20:8484", displayHubAddress("http://192.168.1.20:8484"))
        assertEquals("hub.lan:8484", displayHubAddress("http://hub.lan:8484/"))
    }

    @Test fun httpsKeepsItsScheme() =
        assertEquals("https://hub.example.com", displayHubAddress("https://hub.example.com/"))

    @Test fun whatTheUserSeesNormalizesBackToTheSameAddress() {
        val stored = "http://192.168.1.20:8484"
        assertEquals(stored, normalizeHubUrl(displayHubAddress(stored)))
    }

    @Test fun nothingStoredShowsNothing() = assertEquals("", displayHubAddress(null))
}
