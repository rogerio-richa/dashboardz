package com.dashboardz.device.store

import android.content.Context
import android.content.SharedPreferences

/**
 * What the system status/navigation bars do while the BOARD is showing.
 *
 * Only the board — pairing and settings always show them, or an operator can get stuck with no way
 * out of the app. The takeover keeps whatever the board had: its own dismiss control is on screen
 * (native takeover boundary keeps that screen native), so hiding the system bars never hides the way to acknowledge an
 * alarm.
 */
/**
 * Set by the SCREEN since hub schema v16, not by this handset. The enum stays because the app has
 * to act on it; the stored preference and settings row control whether the wall panel is full-bleed.
 */
enum class NavBars {
    /** Immersive: the board owns the whole panel. The wall-mount case. */
    HIDDEN,

    /** Today's behaviour — the board lays out inside the system insets. */
    RESPECTED,

    /** Hidden, but a tap brings them back briefly. Handheld use without losing the glass. */
    ON_TAP,
}

enum class DisplayMode {
    /** Screen stays on, dimmed when idle. The wall-panel case. */
    ALWAYS_ON,

    /** Screen sleeps normally; the service keeps listening and a critical still wakes it. */
    SCREEN_OFF,
}

interface Settings {
    var hubUrl: String?
    var deviceToken: String?
    var deviceId: String?
    var displayMode: DisplayMode
    /**
     * Pin the window to full brightness while the board idles (off by default). The default keeps
     * rule — the system slider owns idle brightness — and this is the
     * operator explicitly overriding it for a wall panel that must never dim. Takeovers already
     * force full brightness either way.
     */
    var keepFullBrightness: Boolean
    var offlineBeep: Boolean
    var forceAlarmVolume: Boolean

    /**
     * The device's last-known orientation from STATE, persisted so a relaunch can lock the
     * activity's requested orientation correctly before the socket reconnects and a fresh STATE
     * arrives. Defaults to "landscape" — the same default DeviceState.orientation uses — so a
     * never-paired device locks the same way it would once paired.
     */
    var orientation: String

    /**
     * A durable copy of the device's alarm-stream volume from just before AlarmPlayer raised it
     * to maximum, so it can be repaired even if the process dies (e.g. a force-stop mid-alarm,
     * the single most likely thing a user does to a screaming phone at 3am) before
     * AlarmPlayer.stop()'s in-memory-only restore ever runs. Null means there is nothing pending
     * to restore.
     */
    var savedAlarmVolume: Int?

    /**
     * The post-pairing grants checklist was dismissed (setup walkthrough). Permanent once
     * true — the grants stay reachable from settings — and deliberately NOT cleared by
     * clearPairing(): the grants belong to the installed app on this physical device, so a
     * re-pair to another hub has nothing new to walk through.
     */
    var setupDone: Boolean

    val isPaired: Boolean get() = hubUrl != null && deviceToken != null

    fun clearPairing()
}

class PrefsSettings(context: Context) : Settings {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("dashboardz", Context.MODE_PRIVATE)

    private fun string(key: String) = prefs.getString(key, null)
    private fun put(key: String, value: String?) = prefs.edit().putString(key, value).apply()

    override var hubUrl: String?
        get() = string("hub_url")
        set(value) = put("hub_url", value)

    override var deviceToken: String?
        get() = string("device_token")
        set(value) = put("device_token", value)

    override var deviceId: String?
        get() = string("device_id")
        set(value) = put("device_id", value)

    override var displayMode: DisplayMode
        get() = when (string("display_mode")) {
            "SCREEN_OFF" -> DisplayMode.SCREEN_OFF
            else -> DisplayMode.ALWAYS_ON
        }
        set(value) = put("display_mode", value.name)

    override var orientation: String
        get() = string("orientation") ?: "landscape"
        set(value) = put("orientation", value)

    override var keepFullBrightness: Boolean
        get() = prefs.getBoolean("keep_full_brightness", false)
        set(value) = prefs.edit().putBoolean("keep_full_brightness", value).apply()

    override var setupDone: Boolean
        get() = prefs.getBoolean("setup_done", false)
        set(value) = prefs.edit().putBoolean("setup_done", value).apply()

    override var offlineBeep: Boolean
        get() = prefs.getBoolean("offline_beep", false)
        set(value) = prefs.edit().putBoolean("offline_beep", value).apply()

    override var forceAlarmVolume: Boolean
        get() = prefs.getBoolean("force_alarm_volume", true)
        set(value) = prefs.edit().putBoolean("force_alarm_volume", value).apply()

    override var savedAlarmVolume: Int?
        get() = if (prefs.contains("saved_alarm_volume")) {
            prefs.getInt("saved_alarm_volume", 0)
        } else {
            null
        }
        set(value) {
            val edit = prefs.edit()
            if (value == null) edit.remove("saved_alarm_volume") else edit.putInt("saved_alarm_volume", value)
            edit.apply()
        }

    override fun clearPairing() {
        prefs.edit().remove("hub_url").remove("device_token").remove("device_id").apply()
    }
}
