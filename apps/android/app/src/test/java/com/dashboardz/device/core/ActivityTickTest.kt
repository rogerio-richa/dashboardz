package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireCell
import com.dashboardz.device.protocol.WireGrid
import com.dashboardz.device.protocol.WireScreen
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A stream_list/table cell config, stream-activity contract's `chime_activity`/`feed` shape. [chimeActivity] and
 *  [feed] are `Any?` so tests can push a non-boolean/non-string value through the same
 *  malformed-config door [ChimeTest]'s `alertFeed` helper uses for `sound_info`. */
private fun streamCell(
    widget: String = "stream_list",
    feed: Any? = "feed_1",
    chimeActivity: Any? = true,
) = WireCell(
    widget = widget,
    config = JsonObject(buildMap {
        if (feed != null) put("feed", jsonOf(feed))
        if (chimeActivity != null) put("chime_activity", jsonOf(chimeActivity))
    }),
)

private fun jsonOf(value: Any): JsonPrimitive = when (value) {
    is Boolean -> JsonPrimitive(value)
    is String -> JsonPrimitive(value)
    is Int -> JsonPrimitive(value)
    else -> error("unsupported test value: $value")
}

private fun screen(id: String, sounds: Map<String, String>? = null, vararg cells: WireCell) =
    WireScreen(id = id, name = id, grid = WireGrid(cells.toList()), sounds = sounds)

class ActivityTickTest {

    // --- activityVoice: any-tab subscription (stream-activity contract) ---

    @Test
    fun anOptedInCellOnANonVisibleTabStillVoices() {
        val hidden = screen("hidden", mapOf("activity" to "bells"), streamCell(feed = "feed_1", chimeActivity = true))
        val visible = screen("visible", mapOf("activity" to "8bit"))
        val voice = activityVoice(
            screens = listOf(hidden, visible),
            activeScreenId = "visible",
            pushedFeedIds = setOf("feed_1"),
        )
        assertEquals("the hidden tab carries the opted-in cell, so it must still voice", "bells", voice)
    }

    @Test
    fun theVisibleScreenWinsWhenBothTabsCarry() {
        val hidden = screen("hidden", mapOf("activity" to "bells"), streamCell(feed = "feed_1", chimeActivity = true))
        val visible = screen("visible", mapOf("activity" to "8bit"), streamCell(feed = "feed_1", chimeActivity = true))
        val voice = activityVoice(
            screens = listOf(hidden, visible),
            activeScreenId = "visible",
            pushedFeedIds = setOf("feed_1"),
        )
        assertEquals("visible tab must win over a hidden carrier", "8bit", voice)
    }

    @Test
    fun firstCarrierInListOrderWinsWhenNoneAreVisible() {
        val first = screen("a", mapOf("activity" to "bells"), streamCell(feed = "feed_1", chimeActivity = true))
        val second = screen("b", mapOf("activity" to "8bit"), streamCell(feed = "feed_1", chimeActivity = true))
        val voice = activityVoice(
            screens = listOf(first, second),
            activeScreenId = "elsewhere",
            pushedFeedIds = setOf("feed_1"),
        )
        assertEquals("bells", voice)
    }

    @Test
    fun voiceDefaultsToClassicWhenTheCarryingScreenHasNoActivitySound() {
        val carrier = screen("a", sounds = null, streamCell(feed = "feed_1", chimeActivity = true))
        val voice = activityVoice(listOf(carrier), activeScreenId = null, pushedFeedIds = setOf("feed_1"))
        assertEquals("classic", voice)
    }

    // --- activityVoice: chime_activity gating ---

    @Test
    fun chimeActivityAbsentIsNotOptedIn() {
        val screen = screen("a", mapOf("activity" to "bells"), streamCell(feed = "feed_1", chimeActivity = null))
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    @Test
    fun chimeActivityFalseIsNotOptedIn() {
        val screen = screen("a", mapOf("activity" to "bells"), streamCell(feed = "feed_1", chimeActivity = false))
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    @Test
    fun chimeActivityNonBooleanIsNotOptedIn() {
        val screen = screen("a", mapOf("activity" to "bells"), streamCell(feed = "feed_1", chimeActivity = "yes"))
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    // --- activityVoice: feed matching ---

    @Test
    fun aNonMatchingFeedIdDoesNotVoice() {
        val screen = screen("a", mapOf("activity" to "bells"), streamCell(feed = "feed_other", chimeActivity = true))
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    @Test
    fun aMissingFeedIdDoesNotVoice() {
        val screen = screen("a", mapOf("activity" to "bells"), streamCell(feed = null, chimeActivity = true))
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    /** `contentOrNull` would stringify a JSON number `5` into `"5"`, which could then
     *  string-collide with a genuine feed id of `"5"`. A malformed `"feed": 5` must be rejected
     *  outright, not coerced into a match. */
    @Test
    fun aNonStringFeedPrimitiveDoesNotVoiceEvenIfItsStringFormMatches() {
        val screen = screen("a", mapOf("activity" to "bells"), streamCell(feed = 5, chimeActivity = true))
        assertNull(
            "a JSON number feed must not string-coerce into matching a \"5\" feed id",
            activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("5")),
        )
    }

    /** Safe-path pin: a cell with no config object at all (`config == null`) must read as
     *  not-opted-in, same as every other malformed shape — never throw. */
    @Test
    fun aCellWithNoConfigAtAllDoesNotVoice() {
        val cell = WireCell(widget = "stream_list", config = null)
        val screen = screen("a", mapOf("activity" to "bells"), cell)
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    // --- activityVoice: widget scope ---

    @Test
    fun tableWidgetCarries() {
        val screen = screen("a", mapOf("activity" to "8bit"), streamCell(widget = "table", feed = "feed_1", chimeActivity = true))
        assertEquals("8bit", activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    @Test
    fun anOptedInAlertFeedDoesNotCount() {
        val cell = WireCell(
            widget = "alert_feed",
            config = JsonObject(mapOf("feed" to JsonPrimitive("feed_1"), "chime_activity" to JsonPrimitive(true))),
        )
        val screen = screen("a", mapOf("activity" to "bells"), cell)
        assertNull(
            "widget scope is stream_list/table only, even if some other widget happened to carry the same keys",
            activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")),
        )
    }

    @Test
    fun noOptedInCellAnywhereYieldsNull() {
        val screen = screen("a", mapOf("activity" to "bells"))
        assertNull(activityVoice(listOf(screen), activeScreenId = null, pushedFeedIds = setOf("feed_1")))
    }

    // --- activityTickAllowed: drop-not-defer cooldown ---

    @Test
    fun deniesATickInsideTheGap() {
        assertFalse(activityTickAllowed(nowMs = 1_000L, lastTickAtMs = 0L))
    }

    @Test
    fun deniesATickJustUnderTheGap() {
        assertFalse(activityTickAllowed(nowMs = 2_499L, lastTickAtMs = 0L, cooldownMs = 2500))
    }

    @Test
    fun allowsATickExactlyAtTheGap() {
        assertTrue(activityTickAllowed(nowMs = 2_500L, lastTickAtMs = 0L, cooldownMs = 2500))
    }

    @Test
    fun allowsATickPastTheGap() {
        assertTrue(activityTickAllowed(nowMs = 5_000L, lastTickAtMs = 0L, cooldownMs = 2500))
    }
}
