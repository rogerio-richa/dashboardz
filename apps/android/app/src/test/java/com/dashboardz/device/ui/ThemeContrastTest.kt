package com.dashboardz.device.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app draws its own dark background (Palette.bg), so every Material3 component must take its
 * colors from a dark scheme built on Palette. Without one, Compose falls back to the default light
 * scheme and text fields type near-black text onto the near-black background (seen on a Galaxy
 * Tab S settings screen, 2026-11-17). These checks pin the WCAG contrast of the colors that
 * OutlinedTextField, Switch and TextButton actually read.
 */
class ThemeContrastTest {

    private fun contrast(a: Color, b: Color): Double {
        val la = a.luminance() + 0.05
        val lb = b.luminance() + 0.05
        return (maxOf(la, lb) / minOf(la, lb)).toDouble()
    }

    private fun assertContrast(name: String, fg: Color, bg: Color, min: Double) {
        val ratio = contrast(fg, bg)
        assertTrue("$name contrast %.2f < %.1f".format(ratio, min), ratio >= min)
    }

    private val scheme = DashboardzColors

    @Test fun typedTextIsReadableOnTheAppBackground() {
        assertContrast("onSurface/bg", scheme.onSurface, Palette.bg, 4.5)
        assertContrast("onSurface/surface", scheme.onSurface, scheme.surface, 4.5)
        assertContrast("onBackground/background", scheme.onBackground, scheme.background, 4.5)
    }

    @Test fun fieldLabelsAndPlaceholdersAreReadable() {
        assertContrast("onSurfaceVariant/bg", scheme.onSurfaceVariant, Palette.bg, 4.5)
    }

    @Test fun focusedBorderCursorAndOutlineAreVisible() {
        assertContrast("primary/bg", scheme.primary, Palette.bg, 3.0)
        assertContrast("outline/bg", scheme.outline, Palette.bg, 3.0)
    }

    @Test fun errorTextIsReadable() {
        assertContrast("error/bg", scheme.error, Palette.bg, 3.0)
        // Pairing errors are small running text the user has to read, not a status colour:
        // they get body-text contrast (Palette.critical alone was ~3.4:1 and hard to read).
        assertContrast("errorText/bg", Palette.errorText, Palette.bg, 7.0)
    }

    @Test fun helpTextUnderTheFormIsComfortablyReadable() {
        assertContrast("body/bg", Palette.body, Palette.bg, 7.0)
    }
}
