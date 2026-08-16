package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireOption
import org.junit.Assert.assertEquals
import org.junit.Test

class OptionsTest {

    @Test
    fun absentOptionsRenderNoButtons() {
        assertEquals(emptyList<WireOption>(), renderableOptions(alert("a", options = null)))
    }

    @Test
    fun emptyOptionsRenderNoButtons() {
        // Wire-distinct from absent (see CodecTest), but for rendering both mean "no buttons".
        assertEquals(emptyList<WireOption>(), renderableOptions(alert("a", options = emptyList())))
    }

    @Test
    fun optionsRenderExactlyAsSentAndInWireOrder() {
        val opts = listOf(WireOption("taken", "Taken"), WireOption("skip", "Skip today"))
        assertEquals(opts, renderableOptions(alert("a", options = opts)))
    }
}
