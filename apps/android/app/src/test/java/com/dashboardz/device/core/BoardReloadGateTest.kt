package com.dashboardz.device.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardReloadGateTest {

    @Test
    fun mainFrameErrorThenLinkOnlineWantsAReload() {
        // The observed failure: Activity recreated during a wifi drop, loadUrl fired into dead
        // air, socket later reconnected — and the board stayed black forever.
        val g = BoardReloadGate()
        g.onLoadStarted()
        g.onLoadError(mainFrame = true, urlPath = "/device")
        assertTrue(g.reloadNeeded(online = true))
    }

    @Test
    fun aDeadModuleGraphIsAsFatalAsADeadPage() {
        // HTML can arrive and the module fetch still die (observed with mDNS flaking): the page
        // then sits on its splash with no JS to recover itself. Any of the board's own /device
        // assets failing means the board is dead.
        val g = BoardReloadGate()
        g.onLoadStarted()
        g.onLoadError(mainFrame = false, urlPath = "/device/device.js")
        assertTrue(g.reloadNeeded(online = true))
    }

    @Test
    fun anUnrelatedSubresourceFailureDoesNotReloadTheBoard() {
        // A stale image feed or a blocked favicon must not bounce a healthy board.
        val g = BoardReloadGate()
        g.onLoadStarted()
        g.onLoadError(mainFrame = false, urlPath = "/api/feeds/feed_x/image")
        assertFalse(g.reloadNeeded(online = true))
    }

    @Test
    fun neverReloadsWhileOffline() {
        // Reloading into dead wifi just fails again; the ONLINE transition is the retry signal.
        val g = BoardReloadGate()
        g.onLoadStarted()
        g.onLoadError(mainFrame = true, urlPath = "/device")
        assertFalse(g.reloadNeeded(online = false))
    }

    @Test
    fun aFreshLoadAttemptClearsTheFailure() {
        // reload() fires onPageStarted; the gate must not demand a second reload for a load
        // that is already underway.
        val g = BoardReloadGate()
        g.onLoadStarted()
        g.onLoadError(mainFrame = true, urlPath = "/device")
        g.onLoadStarted()
        assertFalse(g.reloadNeeded(online = true))
    }

    @Test
    fun aHealthyBoardNeverReloads() {
        val g = BoardReloadGate()
        g.onLoadStarted()
        assertFalse(g.reloadNeeded(online = true))
    }

    @Test
    fun aDeadBoardRetriesEvenWhileTheLinkNeverComesOnline() {
        // The 2026-08-27 blackout: hub_url pointed at an address that refused the port, so the
        // socket never reached ONLINE and the ONLINE-transition retry could never fire. Without a
        // link-independent retry the panel stays black forever.
        val g = BoardReloadGate(Backoff(baseMs = 1_000, maxMs = 1_000, random = { 1.0 }))
        g.onLoadStarted()
        g.onLoadError(mainFrame = true, urlPath = "/device")
        assertFalse(g.retryDue(nowMs = 0))          // arms on first poll
        assertFalse(g.retryDue(nowMs = 999))
        assertTrue(g.retryDue(nowMs = 1_000))
    }

    @Test
    fun theRetryBacksOffRatherThanSpinning() {
        val g = BoardReloadGate(Backoff(baseMs = 1_000, maxMs = 1_000, random = { 1.0 }))
        g.onLoadStarted()
        g.onLoadError(mainFrame = true, urlPath = "/device")
        assertFalse(g.retryDue(nowMs = 0))
        assertTrue(g.retryDue(nowMs = 1_000))
        // Having just fired, it must not fire again on the very next poll.
        assertFalse(g.retryDue(nowMs = 1_000))
        assertTrue(g.retryDue(nowMs = 2_000))
    }

    @Test
    fun aHealthyBoardNeverRetriesOnTheTimer() {
        val g = BoardReloadGate(Backoff(baseMs = 1_000, maxMs = 1_000, random = { 1.0 }))
        g.onLoadStarted()
        assertFalse(g.retryDue(nowMs = 10_000))
    }

    @Test
    fun aSuccessfulReloadStopsTheRetryTimer() {
        val g = BoardReloadGate(Backoff(baseMs = 1_000, maxMs = 1_000, random = { 1.0 }))
        g.onLoadStarted()
        g.onLoadError(mainFrame = true, urlPath = "/device")
        assertFalse(g.retryDue(nowMs = 0))
        g.onLoadStarted()
        assertFalse(g.retryDue(nowMs = 10_000))
    }

    @Test
    fun anUnrelatedSubresourceFailureNeverArmsTheRetry() {
        val g = BoardReloadGate(Backoff(baseMs = 1_000, maxMs = 1_000, random = { 1.0 }))
        g.onLoadStarted()
        g.onLoadError(mainFrame = false, urlPath = "/api/feeds/feed_x/image")
        assertFalse(g.retryDue(nowMs = 10_000))
    }
}
