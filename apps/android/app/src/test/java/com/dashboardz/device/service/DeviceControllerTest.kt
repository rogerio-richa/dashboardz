package com.dashboardz.device.service

import com.dashboardz.device.core.Backoff
import com.dashboardz.device.core.DeviceState
import com.dashboardz.device.core.alert
import com.dashboardz.device.net.CloseReason
import com.dashboardz.device.net.DeviceClientListener
import com.dashboardz.device.protocol.AlertAddMsg
import com.dashboardz.device.protocol.ClientMsg
import com.dashboardz.device.protocol.Codec
import com.dashboardz.device.protocol.DataMsg
import com.dashboardz.device.protocol.StateMsg
import com.dashboardz.device.protocol.WireCell
import com.dashboardz.device.protocol.WireDevice
import com.dashboardz.device.protocol.WireFeed
import com.dashboardz.device.protocol.WireGrid
import com.dashboardz.device.protocol.WireScreen
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Records what was sent and lets a test drive the listener callbacks by hand. */
private class FakeTransport : Transport {
    val sent = mutableListOf<String>()
    // What sendFromBoard forwarded, verbatim (see DeviceControllerTest's TAB test): distinct from
    // `sent`, which only ever carries this shell's own re-encoded ClientMsg traffic.
    val rawSent = mutableListOf<String>()
    val connects = mutableListOf<Pair<String, String>>()
    // One entry per connect() call, in order, so a test can grab an earlier (superseded)
    // connection's listener specifically instead of only the latest one.
    val listeners = mutableListOf<DeviceClientListener>()
    var disconnects = 0
    lateinit var listener: DeviceClientListener

    override fun connect(hubUrl: String, token: String, listener: DeviceClientListener) {
        connects.add(hubUrl to token)
        this.listener = listener
        listeners.add(listener)
    }

    override fun send(msg: ClientMsg) { sent.add(Codec.encode(msg)) }

    override fun sendRaw(text: String) { rawSent.add(text) }

    override fun disconnect() {
        disconnects++
        // The real DeviceClient.disconnect() closes the socket with code 1000, which falls
        // into CloseReason's `else` branch — i.e. a deliberate teardown still surfaces to the
        // listener as onClosed(NETWORK). The fake must do the same or it is more forgiving than
        // reality and would hide a controller bug that only shows up against the real client.
        if (::listener.isInitialized) listener.onClosed(CloseReason.NETWORK)
    }
}

class DeviceControllerTest {

    private val fake = FakeTransport()
    private val delays = mutableListOf<Long>()
    private val pending = mutableListOf<() -> Unit>()
    private var tokenRejections = 0
    private var now = 10_000L

    private fun controller() = DeviceController(
        transport = fake,
        backoff = Backoff(random = { 1.0 }),
        clock = { now },
        schedule = { delayMs, action -> delays.add(delayMs); pending.add(action) },
        onTokenRejected = { tokenRejections++ },
    )

    private fun runScheduled() {
        val next = pending.removeAt(0)
        next()
    }

    private fun stateMsg(vararg alerts: com.dashboardz.device.protocol.WireAlert) =
        StateMsg(WireDevice("scr_1", "bedside"), server_time = 12_000, alerts = alerts.toList(), rev = 7)

    @Test
    fun connectsOnStartAndGoesOnlineWhenStateArrives() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        assertEquals(listOf("http://hub:8484" to "tok"), fake.connects)
        assertEquals(Link.CONNECTING, c.state.value.link)

        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg(alert("a", "warn", 5)))
        assertEquals(Link.ONLINE, c.state.value.link)
        assertEquals(listOf("a"), c.state.value.device.alerts.map { it.id })
        // server_time 12_000 against a device clock of 10_000
        assertEquals(2_000L, c.state.value.device.serverOffsetMs)
    }

    @Test
    fun acksEveryAlertAddAsDelivered() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.sent.clear()   // drop the HELLO the real transport would have sent
        fake.listener.onMessage(AlertAddMsg(alert("a", "critical", 7)))
        assertTrue(fake.sent.any { it == """{"type":"ACK","id":"a","stage":"delivered"}""" })
    }

    @Test
    fun networkCloseSchedulesAReconnectWithBackoff() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.NETWORK)
        assertEquals(Link.OFFLINE, c.state.value.link)
        assertEquals(listOf(1_000L), delays)

        runScheduled()
        assertEquals(2, fake.connects.size)

        fake.listener.onClosed(CloseReason.NETWORK)
        assertEquals(listOf(1_000L, 2_000L), delays)
    }

    @Test
    fun retryNowWhileOfflineReconnectsAtOnceAndResetsTheBackoff() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.NETWORK)
        runScheduled()
        fake.listener.onClosed(CloseReason.NETWORK)   // second failure: backoff now at 2s
        assertEquals(listOf(1_000L, 2_000L), delays)

        // The platform says a network is back: no waiting out the 2s.
        c.retryNow()
        assertEquals(3, fake.connects.size)

        // And the ladder restarted from the bottom — a NEW network earns the fast ladder.
        fake.listener.onClosed(CloseReason.NETWORK)
        assertEquals(listOf(1_000L, 2_000L, 1_000L), delays)
    }

    @Test
    fun retryNowIsANoOpUnlessActuallyOffline() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        c.retryNow()                                   // CONNECTING: must not race the attempt
        assertEquals(1, fake.connects.size)

        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg())
        c.retryNow()                                   // ONLINE: must not drop a live socket
        assertEquals(1, fake.connects.size)

        c.stop()
        c.retryNow()                                   // stopped: must not resurrect
        assertEquals(1, fake.connects.size)
    }

    @Test
    fun aStaleScheduledRetryDoesNotDropTheConnectionRetryNowAlreadyMade() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.NETWORK)    // schedules a retry; cannot be cancelled
        c.retryNow()                                   // reconnects ahead of it
        assertEquals(2, fake.connects.size)
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg())
        assertEquals(Link.ONLINE, c.state.value.link)

        runScheduled()                                 // the stale timer finally fires
        // Guarded on OFFLINE at fire time: the live connection is left alone.
        assertEquals(2, fake.connects.size)
        assertEquals(Link.ONLINE, c.state.value.link)
    }

    @Test
    fun successfulStateResetsTheBackoff() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.NETWORK)
        runScheduled()
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg())
        fake.listener.onClosed(CloseReason.NETWORK)
        // Back to the 1 s base rather than continuing to 2 s.
        assertEquals(listOf(1_000L, 1_000L), delays)
    }

    @Test
    fun authFailureStopsRetryingAndAsksForRePairing() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.AUTH_FAILED)
        assertEquals(Link.NEEDS_PAIRING, c.state.value.link)
        assertEquals(1, tokenRejections)
        assertTrue("must not retry with a token the hub rejected", delays.isEmpty())
    }

    @Test
    fun replacedStopsRetryingSoTwoDevicesDoNotFight() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.REPLACED)
        assertEquals(Link.REPLACED, c.state.value.link)
        assertTrue(delays.isEmpty())
    }

    @Test
    fun helloTimeoutIsRetriedLikeAnyNetworkFailure() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.HELLO_TIMEOUT)
        assertEquals(Link.OFFLINE, c.state.value.link)
        assertEquals(listOf(1_000L), delays)
    }

    @Test
    fun displayedAckIsSentOncePerTakeoverAndAgainForASwappedInCritical() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.sent.clear()

        c.onTakeoverDisplayed("c1")
        c.onTakeoverDisplayed("c1")
        c.onTakeoverDisplayed("c1")
        assertEquals(
            listOf("""{"type":"ACK","id":"c1","stage":"displayed"}"""),
            fake.sent.filter { it.contains("displayed") },
        )

        // A different critical takes over: it gets its own displayed ACK.
        c.onTakeoverDisplayed("c2")
        assertEquals(
            listOf(
                """{"type":"ACK","id":"c1","stage":"displayed"}""",
                """{"type":"ACK","id":"c2","stage":"displayed"}""",
            ),
            fake.sent.filter { it.contains("displayed") },
        )
    }

    @Test
    fun silenceTapUpdatesLocalStateImmediatelyAndDismissDoesNot() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg(alert("c1", "critical", 5)))
        fake.sent.clear()

        c.tap("c1", "silence")
        assertEquals(listOf("""{"type":"TAP","id":"c1","action":"silence"}"""), fake.sent)
        // Local silence must be instant — waiting for a hub round-trip means the alarm keeps
        // screaming for as long as the network takes.
        assertTrue(c.state.value.device.silenced.contains("c1"))

        fake.sent.clear()
        c.tap("c1", "dismiss")
        assertEquals(listOf("""{"type":"TAP","id":"c1","action":"dismiss"}"""), fake.sent)
        // Removal comes from the hub's ALERT_REMOVE, not from guessing locally.
        assertEquals(listOf("c1"), c.state.value.device.alerts.map { it.id })
    }

    @Test
    fun answerSendsTheOptionIdAndLeavesRemovalToTheHub() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg(alert("q1", "warn", 5)))
        fake.sent.clear()

        c.answer("q1", "taken")
        assertEquals(
            listOf("""{"type":"TAP","id":"q1","action":"answer","option_id":"taken"}"""),
            fake.sent,
        )
        // No local state change: the hub validates the option and echoes ALERT_REMOVE
        // (reason "dismissed"), exactly as it does for a dismiss tap.
        assertEquals(listOf("q1"), c.state.value.device.alerts.map { it.id })
        assertTrue(c.state.value.device.silenced.isEmpty())
    }

    @Test
    fun healthIsSentThrough() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.sent.clear()
        c.reportHealth(battery = 42, charging = true)
        assertEquals(listOf("""{"type":"HEALTH","battery":42,"charging":true}"""), fake.sent)
    }

    @Test
    fun stopDisconnectsAndCancelsPendingReconnects() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onClosed(CloseReason.NETWORK)
        assertEquals(listOf(1_000L), delays)

        c.stop()
        // FakeTransport.disconnect() surfaces to the listener as onClosed(NETWORK), exactly
        // like the real DeviceClient closing with code 1000. stop() must not treat its own
        // teardown as a network failure: no extra reconnect may be scheduled, and the link must
        // land on OFFLINE rather than bouncing through it as if the connection had just failed.
        assertEquals(listOf(1_000L), delays)
        assertEquals(Link.OFFLINE, c.state.value.link)

        val connectsBefore = fake.connects.size
        runScheduled()   // the already-queued reconnect must be a no-op after stop()
        assertEquals(connectsBefore, fake.connects.size)
        assertTrue(fake.disconnects > 0)
    }

    @Test
    fun ignoresACloseCallbackFromAConnectionSupersededByARepeatStart() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        val firstListener = fake.listeners[0]

        // A second start() on top of a still-live connection is routine: the pairing flow and
        // the service's START_STICKY restart can both call start() again. DeviceClient.connect()
        // closes the old socket but does not cancel that socket's own listener, so its callbacks
        // can still arrive after being superseded.
        c.start("http://hub:8484", "tok2")
        assertEquals(2, fake.connects.size)
        assertEquals(Link.CONNECTING, c.state.value.link)

        // A stray close from the FIRST (now superseded) connection must be inert: it must not
        // schedule a reconnect or knock the link off of what the current connection is doing.
        firstListener.onClosed(CloseReason.NETWORK)
        assertTrue(
            "a superseded connection's close must not schedule a reconnect",
            delays.isEmpty(),
        )
        assertEquals(Link.CONNECTING, c.state.value.link)
    }

    @Test
    fun sendsStateAckAfterApplyingState() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.sent.clear()
        fake.listener.onMessage(stateMsg())
        // Wiring test, sabotage-checked by construction: a client that never acks fails here.
        assertTrue(fake.sent.any { it == """{"type":"STATE_ACK","rev":7}""" })
        // And the ack reflects the applied screen when one is present:
        fake.sent.clear()
        fake.listener.onMessage(
            stateMsg().copy(rev = 8, screen = WireScreen("lay_9", "B", "landscape", grid = WireGrid(listOf(WireCell("clock"))))),
        )
        assertTrue(fake.sent.any { it == """{"type":"STATE_ACK","rev":8,"screen_id":"lay_9"}""" })
    }

    @Test
    fun stateAckReflectsTheFullScreenSetWhenScreensIsPresent() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.sent.clear()
        val screens = listOf(
            WireScreen("lay_1", "A", "landscape", grid = WireGrid(listOf(WireCell("clock")))),
            WireScreen("lay_2", "B", "landscape", grid = WireGrid(emptyList())),
        )
        fake.listener.onMessage(stateMsg().copy(rev = 9, screens = screens))
        // screen_id falls back to the first of the set; screen_ids carries the whole thing —
        // the honest set-ack this code restores.
        assertTrue(
            fake.sent.any {
                it == """{"type":"STATE_ACK","rev":9,"screen_id":"lay_1","screen_ids":["lay_1","lay_2"]}"""
            },
        )
    }

    @Test
    fun dataMessageUpdatesStateAndSendsNothingBack() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg())
        fake.sent.clear()   // drop the STATE_ACK from the STATE above

        val feed = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 1) })
        fake.listener.onMessage(DataMsg(server_time = 12_000, feeds = mapOf("feed_a" to feed)))

        assertEquals(feed, c.state.value.device.feeds["feed_a"])
        // No STATE_ACK analog for DATA: nothing goes back over the wire for it.
        assertTrue(fake.sent.isEmpty())
    }

    @Test
    fun activitySinkFiresOnLivePushesOnlyAndCarriesEveryPushedFeedId() {
        val c = controller()
        val pushes = mutableListOf<Set<String>>()
        c.activitySink = { pushes.add(it) }
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg())
        fake.sent.clear()   // drop the STATE_ACK from the STATE above

        val feedA = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 1) })
        val feedB = WireFeed(mode = "stream")

        // A snapshot is a reconnect resync, not new activity — silent, exactly like the alert
        // chimes' "silence on reconnect" rule (and like the web board's identical guard).
        fake.listener.onMessage(
            DataMsg(server_time = 12_000, feeds = mapOf("feed_a" to feedA), snapshot = true),
        )
        assertTrue("a snapshot must never tick", pushes.isEmpty())

        // A live push hands over every feed id it touched, unfiltered: which of them anyone
        // opted in to is the sink's decision (activityVoice), never the controller's.
        fake.listener.onMessage(
            DataMsg(server_time = 12_100, feeds = mapOf("feed_a" to feedA, "feed_b" to feedB)),
        )
        assertEquals(listOf(setOf("feed_a", "feed_b")), pushes)

        // A push carrying no feeds has nothing to have been activity on.
        fake.listener.onMessage(DataMsg(server_time = 12_200, feeds = emptyMap()))
        assertEquals(listOf(setOf("feed_a", "feed_b")), pushes)

        // reduce is untouched by any of it: the merge still lands, the offset still tracks, and
        // DATA still puts nothing back on the wire.
        assertEquals(feedA, c.state.value.device.feeds["feed_a"])
        assertEquals(feedB, c.state.value.device.feeds["feed_b"])
        assertEquals(2_200L, c.state.value.device.serverOffsetMs)
        assertTrue(fake.sent.isEmpty())
    }

    @Test
    fun tabFromBoardUpdatesActiveScreenIdAndStillForwardsTheOriginalTextVerbatim() {
        val c = controller()
        c.start("http://hub:8484", "tok")
        fake.listener.onOpen()
        fake.listener.onMessage(stateMsg())
        fake.rawSent.clear()

        val frame = """{"type":"TAB","screen_id":"b"}"""
        assertTrue(c.sendFromBoard(frame))

        // Existing forwarding semantics (BoardBridgeTest) still hold: the ORIGINAL text, unchanged.
        assertEquals(listOf(frame), fake.rawSent)
        // New: the board's own tab switch is now tracked natively too.
        assertEquals("b", c.state.value.device.activeScreenId)
    }
}
