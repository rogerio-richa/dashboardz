package com.dashboardz.device.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CapacityTest {

    @Test
    fun portraitFitsMoreCardsThanLandscapeAtTheSameHeight() {
        // Landscape gives the alert column only ~62% of the width but the clock eats no
        // vertical space, so the difference comes from the card area, not the screen size.
        assertTrue(cardCapacity(isLandscape = false, heightDp = 800) >= 3)
        assertEquals(2, cardCapacity(isLandscape = true, heightDp = 400))
    }

    @Test
    fun tallScreensShowMoreCards() {
        val short = cardCapacity(isLandscape = false, heightDp = 480)
        val tall = cardCapacity(isLandscape = false, heightDp = 1000)
        assertTrue("a taller screen must not show fewer cards", tall > short)
    }

    @Test
    fun alwaysShowsAtLeastOneCard() {
        // A tiny or oddly-reported screen must still render something rather than
        // collapsing every alert into chips.
        assertEquals(1, cardCapacity(isLandscape = false, heightDp = 0))
        assertEquals(1, cardCapacity(isLandscape = true, heightDp = 100))
    }
}
