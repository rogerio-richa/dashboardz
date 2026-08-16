package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireCell
import com.dashboardz.device.protocol.WireGrid
import com.dashboardz.device.protocol.WireScreen
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun screen(vararg cells: WireCell) =
    WireScreen(id = "lay_1", name = "Kitchen", grid = WireGrid(cells.toList()))

private fun alertFeed(soundInfo: Boolean?) = WireCell(
    widget = "alert_feed",
    config = JsonObject(buildMap {
        put("min_severity", JsonPrimitive("info"))
        if (soundInfo != null) put("sound_info", JsonPrimitive(soundInfo))
    }),
)

class ChimeTest {

    @Test
    fun chimesANewSoundingNonCriticalAlertOnce() {
        val decision = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = emptySet(),
            suppressed = false,
        )
        assertEquals(setOf("w1"), decision.toChime)
        assertEquals(setOf("w1"), decision.nextChimed)
    }

    @Test
    fun doesNotRechimeAnAlertAlreadyChimed() {
        // Same alert still present, same id already in the caller's memory: this is what
        // guarantees no re-chime on recomposition, the clock tick, rotation, or a reconnect that
        // redelivers the same alert id in a fresh STATE.
        val decision = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = setOf("w1"),
            suppressed = false,
        )
        assertTrue("must not re-chime an id already chimed", decision.toChime.isEmpty())
        assertEquals(setOf("w1"), decision.nextChimed)
    }

    @Test
    fun neverChimesWithoutSoundTrue() {
        val decision = decideChimes(
            alerts = listOf(alert("i1", "info", sound = false), alert("w1", "warn", sound = false)),
            alreadyChimed = emptySet(),
            suppressed = false,
        )
        assertTrue(decision.toChime.isEmpty())
        assertTrue(decision.nextChimed.isEmpty())
    }

    @Test
    fun neverChimesACriticalEvenWithSoundTrue() {
        // Criticals keep their own takeover-alarm path; this is only for non-criticals.
        val decision = decideChimes(
            alerts = listOf(alert("c1", "critical", sound = true)),
            alreadyChimed = emptySet(),
            suppressed = false,
        )
        assertTrue(decision.toChime.isEmpty())
        assertTrue(decision.nextChimed.isEmpty())
    }

    @Test
    fun pruneIdsNoLongerPresent() {
        val decision = decideChimes(alerts = emptyList(), alreadyChimed = setOf("gone"), suppressed = false)
        assertTrue(decision.nextChimed.isEmpty())
    }

    @Test
    fun anIdThatDisappearsAndReappearsChimesAgain() {
        // Step 1: chimes once.
        var decision = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = emptySet(),
            suppressed = false,
        )
        var chimed = decision.nextChimed
        assertEquals(setOf("w1"), decision.toChime)

        // Step 2: alert removed (dismissed/expired) — id is pruned from memory.
        decision = decideChimes(alerts = emptyList(), alreadyChimed = chimed, suppressed = false)
        chimed = decision.nextChimed
        assertTrue(chimed.isEmpty())

        // Step 3: an unrelated later alert reuses the same id — chimes again, since as far as
        // this policy can tell, it is a fresh occurrence.
        decision = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = chimed,
            suppressed = false,
        )
        assertEquals(setOf("w1"), decision.toChime)
    }

    @Test
    fun suppressedDefersRatherThanDropsANewChime() {
        // A critical's alarm is sounding: must not touch AlarmPlayer's shared ToneGenerator.
        val suppressedDecision = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = emptySet(),
            suppressed = true,
        )
        assertTrue("must not chime while a critical alarm is sounding", suppressedDecision.toChime.isEmpty())
        assertTrue("must not be marked chimed if it never actually chimed", suppressedDecision.nextChimed.isEmpty())

        // Once the critical alarm ends, the same still-present warn becomes eligible.
        val followUp = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = suppressedDecision.nextChimed,
            suppressed = false,
        )
        assertEquals(setOf("w1"), followUp.toChime)
    }

    @Test
    fun suppressionStillPrunesIdsNoLongerPresent() {
        val decision = decideChimes(alerts = emptyList(), alreadyChimed = setOf("old"), suppressed = true)
        assertTrue(decision.nextChimed.isEmpty())
    }

    /**
     * One evaluation, every combination. An info alert cannot chime from its own `sound` flag:
     * a sender does not decide whether a room makes routine noise. Only the screen's setting can
     * promote info.
     */
    @Test
    fun handlesAMixOfSeveritiesAndSoundFlagsInOneEvaluation() {
        val mixed = listOf(
            alert("c1", "critical", sound = true),
            alert("w1", "warn", sound = true),
            alert("w2", "warn", sound = false),
            alert("i1", "info", sound = true),
            alert("i2", "info", sound = false),
        )

        val quiet = decideChimes(mixed, alreadyChimed = emptySet(), suppressed = false, soundInfo = false)
        assertEquals(setOf("w1"), quiet.toChime)
        assertEquals(setOf("w1"), quiet.nextChimed)

        val opted = decideChimes(mixed, alreadyChimed = emptySet(), suppressed = false, soundInfo = true)
        assertEquals(setOf("w1", "i1", "i2"), opted.toChime)
    }

    // playCollapsedChime is the caller-side half of decideChimes' contract. The helper's returned
    // sets are correct; the caller must collapse decision.toChime into one tone because
    // `toChime.forEach { alarm.chime() }` plays one tone
    // per id, and since AlarmPlayer's chime() begins with releaseTone() on a field shared with
    // its alarm beat and offline beep, each iteration killed the previous one's tone microseconds
    // into its 250ms duration. Only the last id's tone was ever audible, yet every id still
    // landed in chimedAlertIds as if it had genuinely chimed — a silent, permanent loss of the
    // cue for the rest of the batch. These tests pin the invariant: exactly one call for a non-empty
    // batch of any size, zero for an empty one.

    @Test
    fun collapsesABatchOfSeveralIdsIntoExactlyOneChimeCall() {
        var calls = 0
        playCollapsedChime(setOf("w1", "w2", "w3")) { calls++ }
        assertEquals("a batch of ids must play exactly one tone, not one per id", 1, calls)
    }

    @Test
    fun playsExactlyOneChimeForASingleId() {
        var calls = 0
        playCollapsedChime(setOf("w1")) { calls++ }
        assertEquals(1, calls)
    }

    @Test
    fun playsNoChimeForAnEmptyBatch() {
        var calls = 0
        playCollapsedChime(emptySet()) { calls++ }
        assertEquals(0, calls)
    }

    // Info audibility belongs to the room, not to the sender. The hub refuses to put `sound` on an
    // info alert at all, so the only switch is the screen's own alert_feed — and it is off unless
    // somebody standing in that room turns it on.

    @Test
    fun staysSilentForAnInfoAlertWhenTheScreenHasNotAskedForOne() {
        val decision = decideChimes(
            alerts = listOf(alert("i1", "info", sound = false)),
            alreadyChimed = emptySet(),
            suppressed = false,
            soundInfo = false,
        )
        assertTrue("info must be silent by default", decision.toChime.isEmpty())
    }

    @Test
    fun chimesAnInfoAlertOnlyWhenTheScreenAsksForIt() {
        val decision = decideChimes(
            alerts = listOf(alert("i1", "info", sound = false)),
            alreadyChimed = emptySet(),
            suppressed = false,
            soundInfo = true,
        )
        assertEquals(setOf("i1"), decision.toChime)
    }

    /**
     * The hub always stores `sound = false` on an info alert, but a hub that has not been upgraded
     * yet — or anything else putting frames on this wire — must not be able to talk this device
     * into beeping. The severity decides, not the flag.
     */
    @Test
    fun ignoresASoundFlagArrivingOnAnInfoAlert() {
        val decision = decideChimes(
            alerts = listOf(alert("i1", "info", sound = true)),
            alreadyChimed = emptySet(),
            suppressed = false,
            soundInfo = false,
        )
        assertTrue("a sender must not be able to make info audible", decision.toChime.isEmpty())
    }

    @Test
    fun leavesWarnAudibleRegardlessOfTheInfoSetting() {
        val decision = decideChimes(
            alerts = listOf(alert("w1", "warn", sound = true)),
            alreadyChimed = emptySet(),
            suppressed = false,
            soundInfo = false,
        )
        assertEquals(setOf("w1"), decision.toChime)
    }

    @Test
    fun readsTheSettingOffTheScreensAlertFeed() {
        assertTrue(screenChimesInfo(screen(alertFeed(soundInfo = true))))
        assertFalse(screenChimesInfo(screen(alertFeed(soundInfo = false))))
    }

    /** Every shape of "not configured" means silence, including no screen at all. */
    @Test
    fun defaultsToSilenceWhenTheScreenSaysNothingAboutIt() {
        assertFalse(screenChimesInfo(null))
        assertFalse(screenChimesInfo(screen()))
        assertFalse(screenChimesInfo(screen(alertFeed(soundInfo = null))))
        assertFalse(screenChimesInfo(screen(WireCell(widget = "clock", config = null))))
        // A non-boolean where a boolean belongs is a malformed screen, not consent.
        assertFalse(screenChimesInfo(screen(WireCell(
            widget = "alert_feed",
            config = JsonObject(mapOf("sound_info" to JsonPrimitive("yes"))),
        ))))
    }

    /**
     * A second, narrower alert feed must not silence the one that asked. Adding a widget should
     * never quietly turn a setting off somewhere else on the same screen.
     */
    @Test
    fun anyAlertFeedAskingIsEnough() {
        assertTrue(screenChimesInfo(screen(alertFeed(soundInfo = false), alertFeed(soundInfo = true))))
    }
}
