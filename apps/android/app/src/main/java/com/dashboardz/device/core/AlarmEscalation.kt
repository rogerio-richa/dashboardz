package com.dashboardz.device.core

/**
 * How a critical alarm ramps up (documented contract). Kept pure and separate from the audio code so
 * the curve is unit-testable — the browser fallback screen beeps at a constant rate, and this
 * escalation is precisely what the Android app adds.
 */
object AlarmEscalation {

    private const val RAMP_MS = 30_000L
    private const val START_VOLUME = 30
    private const val MAX_VOLUME = 100
    private const val START_INTERVAL_MS = 1_500L
    private const val MIN_INTERVAL_MS = 500L

    /** ToneGenerator volume, 0–100. Ramps 30 → 100 linearly over 30 s, then holds. */
    fun volumeAt(elapsedMs: Long): Int {
        val progress = progress(elapsedMs)
        return (START_VOLUME + (MAX_VOLUME - START_VOLUME) * progress).toInt()
    }

    /** Gap between beeps. Tightens 1500 ms → 500 ms over the same 30 s, then holds. */
    fun intervalMsAt(elapsedMs: Long): Long {
        val progress = progress(elapsedMs)
        return (START_INTERVAL_MS - (START_INTERVAL_MS - MIN_INTERVAL_MS) * progress).toLong()
    }

    private fun progress(elapsedMs: Long): Double =
        (elapsedMs.coerceAtLeast(0).toDouble() / RAMP_MS).coerceIn(0.0, 1.0)
}
