package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardFailureTest {

    @Test
    fun aMainFrameFailureIsFatal() {
        assertTrue(isFatalBoardError(mainFrame = true, urlPath = "/device"))
    }

    @Test
    fun aDeadModuleGraphIsFatal() {
        // Same rule the reload gate uses: the page loads as a JS module graph, so a dead
        // device.js is as fatal as a dead page.
        assertTrue(isFatalBoardError(mainFrame = false, urlPath = "/device/device.js"))
    }

    @Test
    fun anUnrelatedSubresourceFailureIsNotFatal() {
        // A stale image feed must never raise the failure card over a healthy board.
        assertFalse(isFatalBoardError(mainFrame = false, urlPath = "/api/feeds/feed_x/image"))
    }

    @Test
    fun theDiagnosisNamesTheHubAddressAndTheError() {
        // The 2026-08-27 blackout: this single line would have ended it in seconds.
        val d = diagnose(
            hubUrl = "http://192.168.15.5:8484",
            error = BoardError(true, "/device", -6, "net::ERR_CONNECTION_REFUSED"),
            link = "OFFLINE",
            panelIp = "192.168.15.10",
        )
        assertEquals("http://192.168.15.5:8484", d.hubUrl)
        assertEquals("net::ERR_CONNECTION_REFUSED", d.error)
        assertEquals("OFFLINE", d.link)
        assertEquals("192.168.15.10", d.panel)
    }

    @Test
    fun everyFieldDegradesRatherThanBlocking() {
        // The hub is unreachable by definition, so the card must render with nothing known.
        val d = diagnose(hubUrl = null, error = null, link = "OFFLINE", panelIp = null)
        assertEquals("not set", d.hubUrl)
        assertEquals("unknown", d.error)
        assertEquals("unknown", d.panel)
    }

    @Test
    fun anErrorWithNoDescriptionFallsBackToItsCode() {
        val d = diagnose(
            hubUrl = "http://h:8484",
            error = BoardError(true, "/device", -2, null),
            link = "OFFLINE",
            panelIp = "10.0.0.9",
        )
        assertEquals("error -2", d.error)
    }
}
