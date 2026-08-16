package com.dashboardz.device.core

/**
 * Converts the raw level/scale pair from ACTION_BATTERY_CHANGED into a percentage.
 * Returns null when the device reports "unknown" — the hub would rather have no reading
 * than a fabricated one.
 */
fun batteryPercent(level: Int, scale: Int): Int? {
    if (level < 0 || scale <= 0) return null
    return (level * 100 / scale).coerceIn(0, 100)
}
