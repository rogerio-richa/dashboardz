package com.dashboardz.device.core

import com.dashboardz.device.protocol.AlertAddMsg
import com.dashboardz.device.protocol.AlertRemoveMsg
import com.dashboardz.device.protocol.DataMsg
import com.dashboardz.device.protocol.PlaySoundMsg
import com.dashboardz.device.protocol.StateMsg
import com.dashboardz.device.protocol.WireAlert
import com.dashboardz.device.protocol.WireCell
import com.dashboardz.device.protocol.WireDevice
import com.dashboardz.device.protocol.WireFeed
import com.dashboardz.device.protocol.WireGrid
import com.dashboardz.device.protocol.WireScreen
import com.dashboardz.device.protocol.WireSender
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

fun alert(
    id: String,
    severity: String = "info",
    updatedAt: Long = 1,
    silenced: Boolean = false,
    title: String = id,
    sound: Boolean = false,
    options: List<com.dashboardz.device.protocol.WireOption>? = null,
) = WireAlert(
    id = id, title = title, body = null, severity = severity,
    sender = WireSender("snd", "Netdata"), sound = sound,
    created_at = updatedAt, updated_at = updatedAt,
    update_count = 0, expires_at = null, silenced = silenced,
    options = options,
)

class ReducerTest {

    @Test
    fun stateReplacesEverythingAndSeedsDeviceNameAndOffset() {
        val start = DeviceState(alerts = listOf(alert("old")), silenced = setOf("old"))
        val s = reduce(
            start,
            StateMsg(
                device = WireDevice("scr_1", "bedside"),
                server_time = 5_000,
                alerts = listOf(alert("a"), alert("b")),
            ),
            deviceNow = 3_000,
        )
        assertEquals(listOf("a", "b"), s.alerts.map { it.id })
        assertEquals("bedside", s.deviceName)
        // Ages must be computed against the hub clock, not the (drifting) device clock.
        assertEquals(2_000L, s.serverOffsetMs)
        assertTrue(s.silenced.isEmpty())
    }

    @Test
    fun stateSeedsSilencedSetFromPerAlertFlags() {
        // A silenced-but-not-dismissed critical must NOT start alarming again after a reconnect.
        val s = reduce(
            DeviceState(),
            StateMsg(
                device = WireDevice("scr_1", "x"),
                server_time = 0,
                alerts = listOf(alert("quiet", "critical", silenced = true), alert("loud", "critical")),
            ),
            deviceNow = 0,
        )
        assertEquals(setOf("quiet"), s.silenced)
    }

    @Test
    fun alertAddAppendsAndUpsertsById() {
        var s = reduce(DeviceState(), AlertAddMsg(alert("a")), 0)
        s = reduce(s, AlertAddMsg(alert("b", "warn")), 0)
        s = reduce(s, AlertAddMsg(alert("a", "critical", title = "updated")), 0)
        assertEquals(2, s.alerts.size)
        assertEquals("updated", s.alerts.single { it.id == "a" }.title)
        assertEquals("critical", s.alerts.single { it.id == "a" }.severity)
    }

    @Test
    fun alertAddClearsTheSilencedFlagSoADedupUpdateReAlarms() {
        // THE bug the browser client still has. A dedup update is new information: the alarm
        // must fire again even though the user silenced the previous occurrence.
        val silencedState = DeviceState(
            alerts = listOf(alert("a", "critical")),
            silenced = setOf("a"),
        )
        val s = reduce(silencedState, AlertAddMsg(alert("a", "critical", updatedAt = 99)), 0)
        assertFalse("ALERT_ADD must un-silence its alert", s.silenced.contains("a"))
    }

    @Test
    fun alertRemoveDropsTheAlertAndItsSilencedEntry() {
        val start = DeviceState(alerts = listOf(alert("a"), alert("b")), silenced = setOf("a"))
        val s = reduce(start, AlertRemoveMsg("a", "dismissed"), 0)
        assertEquals(listOf("b"), s.alerts.map { it.id })
        assertTrue(s.silenced.isEmpty())
    }

    @Test
    fun stateCarriesScreenOrientationAndRev() {
        val screen = WireScreen(
            id = "lay_1", name = "Board", orientation = "portrait",
            grid = WireGrid(cells = listOf(WireCell(widget = "clock"))),
        )
        val s = reduce(
            DeviceState(),
            StateMsg(
                device = WireDevice("dev_1", "kitchen", orientation = "portrait"),
                server_time = 5_000, alerts = emptyList(), rev = 4, screen = screen,
            ),
            deviceNow = 3_000,
        )
        assertEquals(screen, s.screen)
        assertEquals("portrait", s.orientation)
        assertEquals(4L, s.rev)
        // And ALERT_ADD must not reset them (copy semantics):
        val s2 = reduce(s, AlertAddMsg(alert("a")), deviceNow = 3_000)
        assertEquals(screen, s2.screen)
    }

    @Test
    fun dataMergesFeedsPerEntryAndUpdatesServerOffset() {
        val feedA = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 1) })
        val start = DeviceState(feeds = mapOf("feed_a" to feedA))
        val feedB = WireFeed(mode = "value", payload = buildJsonObject { put("mem", 2) })
        val s = reduce(
            start,
            DataMsg(server_time = 5_000, feeds = mapOf("feed_b" to feedB)),
            deviceNow = 1_000,
        )
        assertEquals(setOf("feed_a", "feed_b"), s.feeds.keys)
        assertEquals(feedA, s.feeds["feed_a"])
        assertEquals(feedB, s.feeds["feed_b"])
        assertEquals(4_000L, s.serverOffsetMs)
    }

    @Test
    fun dataReplacesAnExistingFeedEntryWholesale() {
        val oldFeed = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 1) })
        val start = DeviceState(feeds = mapOf("feed_a" to oldFeed))
        val newFeed = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 2) })
        val s = reduce(
            start,
            DataMsg(server_time = 0, feeds = mapOf("feed_a" to newFeed)),
            deviceNow = 0,
        )
        assertEquals(1, s.feeds.size)
        assertEquals(newFeed, s.feeds["feed_a"])
    }

    @Test
    fun stateReplaceKeepsFeedsButReplacesEverythingElse() {
        // THE gotcha this code exists for: feed data rides the separate DATA stream and must
        // survive a STATE replace, even though StateMsg rebuilds DeviceState wholesale.
        val feed = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 1) })
        val start = DeviceState(
            feeds = mapOf("feed_a" to feed),
            alerts = listOf(alert("old")),
        )
        val screen = WireScreen(
            id = "lay_2", name = "New",
            grid = WireGrid(cells = listOf(WireCell(widget = "clock"))),
        )
        val s = reduce(
            start,
            StateMsg(
                device = WireDevice("dev_1", "kitchen"),
                server_time = 0,
                alerts = listOf(alert("a")),
                screen = screen,
            ),
            deviceNow = 0,
        )
        assertEquals(mapOf("feed_a" to feed), s.feeds)
        assertEquals(listOf("a"), s.alerts.map { it.id })
    }

    @Test
    fun dataSnapshotReplacesTheFeedsMapWholesale() {
        // A snapshot DataMsg (msg.snapshot = true) REPLACES the feeds map outright, per the
        // controller rule: a deleted feed's entry must drop out of state, matching
        // the renderer's "feed missing" placeholder behaviour. A non-snapshot push only merges (pinned
        // by dataMergesFeedsPerEntryAndUpdatesServerOffset above).
        val oldFeed = WireFeed(mode = "value", payload = buildJsonObject { put("cpu", 1) })
        val start = DeviceState(feeds = mapOf("feed_old" to oldFeed))
        val newFeed = WireFeed(mode = "value", payload = buildJsonObject { put("mem", 2) })
        val s = reduce(
            start,
            DataMsg(server_time = 0, feeds = mapOf("feed_new" to newFeed), snapshot = true),
            deviceNow = 0,
        )
        assertEquals(mapOf("feed_new" to newFeed), s.feeds)
        assertFalse("a snapshot must drop feeds absent from it", s.feeds.containsKey("feed_old"))
    }

    private val screenA = WireScreen(id = "a", name = "A")
    private val screenB = WireScreen(id = "b", name = "B")

    @Test
    fun stateStoresScreensAndKeepsActiveIdWhenStillPresent() {
        val start = DeviceState(screens = listOf(screenA, screenB), activeScreenId = "b")
        val s = reduce(
            start,
            StateMsg(
                device = WireDevice("dev_1", "kitchen"),
                server_time = 0, alerts = emptyList(),
                screens = listOf(screenA, screenB),
            ),
            deviceNow = 0,
        )
        assertEquals(listOf(screenA, screenB), s.screens)
        assertEquals("b", s.activeScreenId)
    }

    @Test
    fun activeIdResetsWhenItsScreenDisappears() {
        val start = DeviceState(screens = listOf(screenA, screenB), activeScreenId = "b")
        val s = reduce(
            start,
            StateMsg(
                device = WireDevice("dev_1", "kitchen"),
                server_time = 0, alerts = emptyList(),
                screens = listOf(screenA),
            ),
            deviceNow = 0,
        )
        assertNull("visibleScreen falls back to first once the active tab is gone", s.activeScreenId)
    }

    @Test
    fun stateScreensFallsBackToTheSingleScreenFieldOnAHubThatPredatesTabs() {
        val s = reduce(
            DeviceState(),
            StateMsg(
                device = WireDevice("dev_1", "kitchen"),
                server_time = 0, alerts = emptyList(),
                screen = screenA,
            ),
            deviceNow = 0,
        )
        assertEquals(listOf(screenA), s.screens)
    }

    @Test
    fun visibleScreenFallsBackToFirst() {
        assertEquals(screenA, visibleScreen(DeviceState(screens = listOf(screenA, screenB), activeScreenId = null)))
        assertEquals(screenB, visibleScreen(DeviceState(screens = listOf(screenA, screenB), activeScreenId = "b")))
    }

    @Test
    fun playSoundDoesNotChangeState() {
        val s1 = DeviceState(alerts = listOf(alert("a")), screens = listOf(screenA), activeScreenId = "a")
        assertEquals(s1, reduce(s1, PlaySoundMsg("bells", "critical"), 0))
    }
}
