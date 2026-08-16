package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The board (hub/static/device) uses `?.` and `??`, which need Chromium 80. An old phone that
 * never got a WebView update parses device.js, fails silently, and would sit on the splash
 * forever without this check.
 */
class WebViewSupportTest {
    private val android6Stock =
        "Mozilla/5.0 (Linux; Android 6.0.1; SM-T805 Build/MMB29K; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/44.0.2403.117 Safari/537.36"
    private val updated =
        "Mozilla/5.0 (Linux; Android 14; Pixel 3a; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36"

    @Test fun readsTheChromiumMajorVersion() {
        assertEquals(44, webViewMajor(android6Stock))
        assertEquals(131, webViewMajor(updated))
    }

    @Test fun anUnparseableUserAgentIsUnknownNotTooOld() {
        assertNull(webViewMajor("Mozilla/5.0 something else"))
        assertNull(webViewMajor(null))
        assertFalse(webViewTooOld(null))
    }

    @Test fun theFloorIsChromium80() {
        assertTrue(webViewTooOld(44))
        assertTrue(webViewTooOld(79))
        assertFalse(webViewTooOld(80))
        assertFalse(webViewTooOld(131))
    }
}
