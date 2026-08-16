package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireAlert
import com.dashboardz.device.protocol.WireScreen
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * `warn` chimes once without taking over the screen, unless the sender opted out. `info` is silent
 * unless the screen it is showing asks for it (`alert_feed.sound_info`) — a sender cannot make an
 * info alert audible, because one integration deciding a whole house should beep for routine
 * traffic is how that goes wrong. `critical` never chimes; it has its own escalating alarm.
 * Whatever chimes, chimes exactly once per alert id.
 *
 * Exactly-once is guaranteed by id-set membership, not by anything time- or composition-based:
 * the caller remembers [ChimeDecision.nextChimed] across calls (see MainActivity's
 * `chimedAlertIds` field, a plain instance field — not `remember`ed Compose state — so it
 * survives recomposition, the 1-second clock tick, and rotation, since MainActivity itself is
 * not recreated for those per its manifest `android:configChanges`). A reconnect that redelivers
 * the same alert in a fresh `STATE` keeps the same alert id, so it is still present in
 * `alreadyChimed` and is correctly not re-chimed. An id that is no longer present (removed,
 * expired, or dropped by a resync) is pruned rather than remembered forever.
 *
 * [suppressed] must be true whenever a critical's own alarm is actively sounding:
 * `AlarmPlayer` shares one `ToneGenerator` field across its alarm beat, its chime and its offline
 * beep, so calling `chime()` while the alarm beat is using that field would truncate the alarm's
 * current tone (the same hazard `offlineBeep()`'s existing suppression in MainActivity guards
 * against). When suppressed, nothing chimes and nothing is newly marked as chimed — a chime that
 * arrives mid-alarm is deferred, not dropped, and becomes eligible again the next time this is
 * evaluated (e.g. once the critical is silenced or dismissed).
 */
data class ChimeDecision(
    /**
     * Ids newly eligible to chime in this evaluation — a **set**, not a queue or a count. The
     * caller must play exactly **one** chime tone whenever this is non-empty, never one per id:
     * see [playCollapsedChime]. [AlarmPlayer][com.dashboardz.device.alarm.AlarmPlayer] shares a
     * single `ToneGenerator` field across its alarm beat, chime and offline beep, so calling
     * `chime()` once per id here would have each call's `releaseTone()` stop and release the
     * previous call's tone microseconds after it started — only the last id's tone would be
     * audible, even though every id in this set is unconditionally folded into [nextChimed] as
     * if it had genuinely sounded, permanently losing the cue for the rest. A batch of ids
     * appearing together in one evaluation (e.g. a reconnect resync's `STATE` carrying several
     * newly-visible `sound:true` alerts at once) is one event for a human, not one per alert, so
     * collapsing to a single tone is not just a workaround for the shared-`ToneGenerator` hazard
     * — it is the correct behaviour on its own terms.
     */
    val toChime: Set<String>,
    val nextChimed: Set<String>,
)

/**
 * Plays [chime] at most once, regardless of how many ids [toChime] contains — the caller-side
 * half of [ChimeDecision.toChime]'s contract. Do not replace this with `toChime.forEach { chime() }`;
 * that was the exact defect this function exists to prevent (see [ChimeDecision.toChime]'s doc).
 * Do not stagger or serialize multiple calls either — that reintroduces the same shared-tone
 * hazard on a delay instead of removing it.
 */
fun playCollapsedChime(toChime: Set<String>, chime: () -> Unit) {
    if (toChime.isNotEmpty()) chime()
}

/**
 * @param soundInfo the screen's `alert_feed.sound_info`. Info alerts are silent everywhere unless
 *   the screen this device is showing asks for them: the hub refuses to put `sound` on an info
 *   alert at all, so a sender cannot make one audible, and this is the only switch that can.
 *   Whether a room wants a noise for routine traffic is the room's decision, and the default is no.
 */
fun decideChimes(
    alerts: List<WireAlert>,
    alreadyChimed: Set<String>,
    suppressed: Boolean,
    soundInfo: Boolean = false,
): ChimeDecision {
    val presentIds = alerts.mapTo(mutableSetOf()) { it.id }
    val surviving = alreadyChimed intersect presentIds
    if (suppressed) return ChimeDecision(toChime = emptySet(), nextChimed = surviving)

    val sounding = alerts
        .asSequence()
        .filter { audible(it, soundInfo) }
        .mapTo(mutableSetOf()) { it.id }

    return ChimeDecision(toChime = sounding - alreadyChimed, nextChimed = surviving + sounding)
}

/**
 * A critical never chimes — it has its own escalating alarm, and a chime on top would truncate it.
 * A warn chimes when the sender asked (the default). An info chimes only when the screen opted in,
 * and its own `sound` flag is ignored: the hub always stores it false, and honouring it here would
 * quietly re-open the door this rule exists to close.
 */
private fun audible(alert: WireAlert, soundInfo: Boolean): Boolean = when (Severity.from(alert.severity)) {
    Severity.CRITICAL -> false
    Severity.INFO -> soundInfo
    else -> alert.sound
}

/**
 * Whether the screen currently on this device asks to hear routine traffic.
 *
 * Read off the alert_feed cell's `sound_info`, defaulting to false for every shape of missing: no
 * screen, no alert_feed on it, no key, or a value that is not a boolean. A screen carrying more
 * than one alert feed is audible if any of them asks — the quieter reading would make adding a
 * second, narrower feed silently switch the first one off.
 */
fun screenChimesInfo(screen: WireScreen?): Boolean =
    screen?.grid?.cells.orEmpty()
        .filter { it.widget == "alert_feed" }
        .any { cell ->
            runCatching { cell.config?.get("sound_info")?.jsonPrimitive?.booleanOrNull }.getOrNull() == true
        }
