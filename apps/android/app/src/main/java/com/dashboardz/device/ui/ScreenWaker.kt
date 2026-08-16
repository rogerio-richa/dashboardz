package com.dashboardz.device.ui

import android.content.Context
import android.os.PowerManager

/**
 * Turns a dark screen on for a critical alert (acceptance check 1).
 *
 * The Activity's setShowWhenLocked/setTurnScreenOn only fire when the activity is being
 * brought to the front — on a kiosk the activity is usually already resumed with the display
 * merely asleep, and in that case nothing re-triggers them. A wake lock with
 * ACQUIRE_CAUSES_WAKEUP is what actually lights the panel in that situation. The flags are
 * deprecated but remain functional and are still the only reliable route on API 23+.
 */
class ScreenWaker(context: Context) {

    private val power = context.getSystemService(PowerManager::class.java)
    private var lock: PowerManager.WakeLock? = null

    @Suppress("DEPRECATION")
    fun wake() {
        if (lock?.isHeld == true) return
        lock = power.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                PowerManager.ACQUIRE_CAUSES_WAKEUP or
                PowerManager.ON_AFTER_RELEASE,
            "dashboardz:takeover",
        ).apply {
            setReferenceCounted(false)
            // Timeout is a safety net: a crash between wake() and release() must not pin the
            // display on until the battery dies.
            acquire(10 * 60 * 1000L)
        }
    }

    fun release() {
        runCatching { lock?.takeIf { it.isHeld }?.release() }
        lock = null
    }
}
