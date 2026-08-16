package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireCell
import com.dashboardz.device.protocol.WireScreen
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * stream-activity contract: stream activity ticks. A soft, no-card sound for "a watched stream got new entries" — the
 * sibling feature to [decideChimes]/[screenChimesInfo], same shape, one event further out.
 */

// Widget scope is stream_list/table only (the device behavior documented in cellSchema.ts
// stream-activity contract comments — chime_activity is only ever schema-valid on these two widgets).
private val ACTIVITY_WIDGETS = setOf("stream_list", "table")

/**
 * stream-activity contract — any-tab subscription (deliberate extension of alert-sound contract's visible-tab-only chime rule): unlike
 * alert routing, an opted-in cell belongs to a specific screen, so there is no ownership
 * ambiguity to resolve by restricting to the visible tab. If ANY of the device's screens carries
 * a `stream_list`/`table` cell with `chime_activity: true` bound (via its `feed` config key) to
 * one of [pushedFeedIds], the device ticks — visible or not.
 *
 * Voice pick: the visible screen ([activeScreenId]) wins if it is itself a carrier; otherwise the
 * first carrying screen in [screens] order. The winning screen's own `sounds["activity"]` is the
 * voice, defaulting to `"classic"` when that screen's resolved sounds map omits the key (sparse
 * sounds semantics, same as every other event).
 *
 * @return the family name to play, or null when no opted-in cell matches this push at all.
 */
fun activityVoice(screens: List<WireScreen>, activeScreenId: String?, pushedFeedIds: Set<String>): String? {
    val carriers = screens.filter { screenCarriesActivity(it, pushedFeedIds) }
    val carrier = carriers.find { it.id == activeScreenId } ?: carriers.firstOrNull() ?: return null
    return carrier.sounds?.get("activity") ?: "classic"
}

private fun screenCarriesActivity(screen: WireScreen, pushedFeedIds: Set<String>): Boolean =
    screen.grid.cells.any { cell ->
        cell.widget in ACTIVITY_WIDGETS && cellChimesActivity(cell) && cellFeedId(cell) in pushedFeedIds
    }

/** Same `runCatching`/`booleanOrNull` discipline as [screenChimesInfo]'s `sound_info` read: any
 *  shape of missing or malformed (absent key, non-boolean value, non-object config) reads as
 *  false, never as consent. */
private fun cellChimesActivity(cell: WireCell): Boolean =
    runCatching { cell.config?.get("chime_activity")?.jsonPrimitive?.booleanOrNull }.getOrNull() == true

/** The bound feed id off a stream widget's shared `feed` config key (cellSchema.ts's
 *  `bindProps.feed`). Null on anything malformed — a cell that fails to name a feed can never
 *  match a push, exactly like a cell that fails to opt in. Requires an actual JSON *string*:
 *  `contentOrNull` would silently stringify a non-string primitive (`5` -> `"5"`), which could
 *  then string-collide with a genuine feed id of `"5"` in [pushedFeedIds] — `isString` closes
 *  that instead of trusting the coercion. */
private fun cellFeedId(cell: WireCell): String? =
    runCatching { (cell.config?.get("feed") as? JsonPrimitive)?.takeIf { it.isString }?.content }.getOrNull()

/**
 * Drop-not-defer cooldown gate: a push landing inside the gap is dropped, not deferred.
 * Pure — the caller owns [lastTickAtMs] as device-local, in-memory, unpersisted state, and must
 * only advance it after a tick it actually decided to play, never for one this returned false for
 * and never merely for evaluating. Stamping on every evaluation (rather than only on an actual
 * play) would let a push that arrives during the gap silently reset the clock, extending the
 * cooldown indefinitely for a chatty stream instead of the intended fixed gap between real ticks.
 */
fun activityTickAllowed(nowMs: Long, lastTickAtMs: Long, cooldownMs: Long = 2500): Boolean =
    nowMs - lastTickAtMs >= cooldownMs
