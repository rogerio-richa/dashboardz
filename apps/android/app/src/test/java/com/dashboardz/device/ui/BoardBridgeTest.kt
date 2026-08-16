package com.dashboardz.device.ui

import android.webkit.JavascriptInterface
import com.dashboardz.device.core.Backoff
import com.dashboardz.device.protocol.ClientMsg
import com.dashboardz.device.net.DeviceClientListener
import com.dashboardz.device.service.DeviceController
import com.dashboardz.device.service.Transport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shell tells the hosted page when it owns the takeover/alarm surface, so the page yields its
 * own `#takeover` and avoids double-beeping
 * alongside the native TakeoverScreen. `ownsTakeover()` is the method device.js's
 * `hostOwnsTakeover()` looks for on `__dashboardzHost` — see device-core.mjs's
 * `yieldTakeoverToHost` for the paired web-side logic.
 */
class BoardBridgeTest {

    private class FakeTransport : Transport {
        override fun connect(hubUrl: String, token: String, listener: DeviceClientListener) {}
        override fun send(msg: ClientMsg) {}
        override fun disconnect() {}
    }

    private fun bridge(): BoardBridge {
        val controller = DeviceController(
            transport = FakeTransport(),
            backoff = Backoff(),
            clock = { 0L },
            schedule = { _, _ -> },
            onTokenRejected = {},
        )
        return BoardBridge(controller, onReady = {}, deviceToken = { null })
    }

    @Test
    fun `the shell always declares that it owns the takeover surface`() {
        assertTrue(bridge().ownsTakeover())
    }

    /**
     * Same discipline as its siblings `send`/`token`/`ready`: without `@JavascriptInterface` the
     * WebView never exposes the method to the page at all, so the page's own
     * `typeof host.ownsTakeover === 'function'` check would silently see nothing and this shell
     * would (correctly, but for the wrong reason) fall back to the old-shell behaviour forever.
     */
    @Test
    fun `ownsTakeover is annotated for the WebView bridge, like its siblings`() {
        val method = BoardBridge::class.java.getMethod("ownsTakeover")
        assertEquals(Boolean::class.javaPrimitiveType, method.returnType)
        assertTrue(method.isAnnotationPresent(JavascriptInterface::class.java))
    }
}
