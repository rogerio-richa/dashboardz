package com.dashboardz.device.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
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
    /** Readable red for error sentences on Palette.bg (critical is a status colour, too dark for text). */
    val errorText = Color(0xFFFF8A8A)
    val takeoverBg = Color(0xFF2A080C)
    val takeoverMeta = Color(0xFFFF8A90)
    val takeoverBody = Color(0xFFFFB4B8)
}

/**
 * Material3 colors derived from Palette. Every screen paints Palette.bg itself, so without this
 * scheme Compose falls back to its default LIGHT scheme and components that read the theme
 * (OutlinedTextField's typed text, labels, cursor, Switch tracks) draw near-black on near-black.
 * ThemeContrastTest pins the readable pairs.
 */
val DashboardzColors: ColorScheme = darkColorScheme(
    primary = Palette.info,
    onPrimary = Palette.bg,
    secondary = Palette.info,
    onSecondary = Palette.bg,
    background = Palette.bg,
    onBackground = Palette.text,
    surface = Palette.bg,
    onSurface = Palette.text,
    surfaceVariant = Palette.card,
    onSurfaceVariant = Palette.body,
    outline = Palette.dim,
    // OutlinedButton draws its border in outlineVariant; Palette.card made "Scan QR" invisible.
    outlineVariant = Color(0xFF3A3F4D),
    error = Palette.critical,
    onError = Palette.text,
)

/** Wrap all Compose content in this so Material3 components match the app's dark palette. */
@Composable
fun DashboardzTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DashboardzColors, content = content)
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
