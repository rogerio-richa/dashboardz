package com.dashboardz.device.core

import com.dashboardz.device.protocol.AlertAddMsg
import com.dashboardz.device.protocol.AlertRemoveMsg
import com.dashboardz.device.protocol.DataMsg
import com.dashboardz.device.protocol.PlaySoundMsg
import com.dashboardz.device.protocol.ServerMsg
import com.dashboardz.device.protocol.StateMsg
import com.dashboardz.device.protocol.WireAlert
import com.dashboardz.device.protocol.WireFeed
import com.dashboardz.device.protocol.WireScreen

/**
 * Everything the UI renders. The app holds no durable alert state of its own: a reconnect
 * replaces this wholesale from the hub's STATE.
 */
data class DeviceState(
    val alerts: List<WireAlert> = emptyList(),
    val silenced: Set<String> = emptySet(),
    val deviceName: String = "",
    /** hubNow - deviceNow. Add to a device timestamp to get hub time. */
    val serverOffsetMs: Long = 0,
    val screen: WireScreen? = null,
    val orientation: String = "landscape",
    val navBars: String = "respected",
    val rev: Long = 0,
    val feeds: Map<String, WireFeed> = emptyMap(),
    // The full tab set (design: multi-screen tabs). Falls back to listOfNotNull(screen) on a hub
    // that predates `screens`, so `visibleScreen` below always has a single-element list to work
    // with rather than an empty one on an otherwise-normal STATE.
    val screens: List<WireScreen> = emptyList(),
    // The last TAB the board sent (DeviceController.sendFromBoard) — which tab is actually on
    // screen, as opposed to `screen`/`screens[0]`, which is just the hub's default. Reset to null
    // whenever its screen is no longer present in a fresh STATE (see the STATE branch below), so a
    // stale id never survives a layout change out from under it; `visibleScreen` then falls back
    // to the first screen exactly as it does before any TAB has ever arrived.
    val activeScreenId: String? = null,
)

/**
 * The screen actually on screen right now: the board's last TAB if that screen still exists,
 * otherwise the first of the tab set (mirrors the hub's own default-to-first-tab rule). Pure
 * lookup — no fallback of its own beyond `screens.firstOrNull()`, so an empty tab set (STATE not
 * yet applied) correctly answers null.
 */
fun visibleScreen(state: DeviceState): WireScreen? =
    state.screens.find { it.id == state.activeScreenId } ?: state.screens.firstOrNull()

fun reduce(state: DeviceState, msg: ServerMsg, deviceNow: Long): DeviceState = when (msg) {
    is StateMsg -> {
        val screens = msg.screens ?: listOfNotNull(msg.screen)
        DeviceState(
            alerts = msg.alerts,
            // Seed from the per-alert flags so a silenced critical stays quiet across a reconnect.
            silenced = msg.alerts.filter { it.silenced }.map { it.id }.toSet(),
            deviceName = msg.device.name,
            serverOffsetMs = msg.server_time - deviceNow,
            screen = msg.screen,
            orientation = msg.device.orientation,
            navBars = msg.device.nav_bars,
            rev = msg.rev,
            // Feed data arrives on the separate DATA stream and MUST survive a STATE replace, else
            // every layout push blanks every data widget until the next DATA tick.
            feeds = state.feeds,
            screens = screens,
            // Carried over from the PREVIOUS state, not reset to null unconditionally: a STATE
            // replace (e.g. a routine layout edit) must not silently snap the visible tab back to
            // the first one. It only resets when the tab it names has actually disappeared.
            activeScreenId = state.activeScreenId?.takeIf { id -> screens.any { it.id == id } },
        )
    }

    is AlertAddMsg -> state.copy(
        alerts = state.alerts.filterNot { it.id == msg.alert.id } + msg.alert,
        // An ALERT_ADD is also how a dedup update arrives. New information means the user's
        // earlier "silence" no longer applies — clearing this is what makes it re-alarm.
        silenced = state.silenced - msg.alert.id,
    )

    is AlertRemoveMsg -> state.copy(
        alerts = state.alerts.filterNot { it.id == msg.id },
        silenced = state.silenced - msg.id,
    )

    // Snapshots REPLACE the map wholesale (a deleted feed's entry must drop out — delete
    // ⇒ "feed missing" placeholder). A single-feed push (snapshot = false) merges per-entry so an
    // update to one feed doesn't blank out every other feed on screen.
    is DataMsg -> state.copy(
        feeds = if (msg.snapshot) msg.feeds else state.feeds + msg.feeds,
        serverOffsetMs = msg.server_time - deviceNow,
    )

    // Transient: a one-shot cue, not state to fold in. It is handled by a controller-side sink
    // (sound state), never here — there is nothing about "a sound just played" that belongs in
    // DeviceState.
    is PlaySoundMsg -> state
}
