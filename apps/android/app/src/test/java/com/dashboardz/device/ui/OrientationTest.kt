package com.dashboardz.device.ui

import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import com.dashboardz.device.store.NavBars
import org.junit.Test

class OrientationTest {
    @Test fun portraitMapsToPortraitFlag() =
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, orientationFlag("portrait"))

    @Test fun landscapeAndUnknownMapToLandscape() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, orientationFlag("landscape"))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, orientationFlag("mystery"))
    }
}

/**
 * The system bars follow the SCREEN since hub schema v16, so a screen's layout controls whether
 * the wall panel is full-bleed rather than requiring a handset preference.
 *
 * Everything unrecognised degrades to RESPECTED, and that direction is the whole point: an
 * unassigned device, a hub that predates the field, or a newer hub naming a mode this build has
 * never heard of must all end up SHOWING the bars. Guessing "hidden" would strand an operator on a
 * panel with no way out of the app.
 */
class NavBarsTest {
    @Test fun hiddenIsCarriedThrough() = assertEquals(NavBars.HIDDEN, navBarsOf("hidden"))
    @Test fun onTapIsCarriedThrough() = assertEquals(NavBars.ON_TAP, navBarsOf("on_tap"))
    @Test fun respectedIsCarriedThrough() = assertEquals(NavBars.RESPECTED, navBarsOf("respected"))

    @Test fun anUnassignedDeviceShowsItsBars() = assertEquals(NavBars.RESPECTED, navBarsOf(null))

    @Test fun aModeThisBuildHasNeverHeardOfShowsItsBars() =
        assertEquals(NavBars.RESPECTED, navBarsOf("immersive_sticky_v2"))

    @Test fun anEmptyStringIsNotAMode() = assertEquals(NavBars.RESPECTED, navBarsOf(""))
}
