package com.dashboardz.device.ui

import androidx.compose.ui.graphics.Color

/**
 * Matched to hub/static/device/index.html so the Android kiosk and the browser fallback
 * screen read as the same product. Dark and OLED-friendly (documented contract).
 */
object Palette {
    val bg = Color(0xFF0B0D12)
    val card = Color(0xFF12141C)
    val cardWarn = Color(0xFF141826)
    val cardCritical = Color(0xFF1A1216)
    val text = Color(0xFFE6E9F0)
    val body = Color(0xFFA8ADBD)
    val dim = Color(0xFF8A90A0)
    val info = Color(0xFF4A90D9)
    val warn = Color(0xFFF0A020)
    val critical = Color(0xFFE0323C)
    val takeoverBg = Color(0xFF2A080C)
    val takeoverMeta = Color(0xFFFF8A90)
    val takeoverBody = Color(0xFFFFB4B8)
}

private const val CARD_HEIGHT_DP = 132
private const val PORTRAIT_CHROME_DP = 300   // clock stack + date + status strip
private const val LANDSCAPE_CHROME_DP = 60   // status strip only; the clock is beside the cards

/**
 * How many full cards fit before the rest collapse into "+N more" chips (documented contract).
 * Pure arithmetic so the overflow boundary is testable without rendering anything.
 */
fun cardCapacity(isLandscape: Boolean, heightDp: Int): Int {
    val chrome = if (isLandscape) LANDSCAPE_CHROME_DP else PORTRAIT_CHROME_DP
    val usable = heightDp - chrome
    return (usable / CARD_HEIGHT_DP).coerceAtLeast(1)
}
