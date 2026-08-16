package com.dashboardz.device.service

import com.dashboardz.device.core.Backoff
import com.dashboardz.device.net.DeviceClientListener
import com.dashboardz.device.protocol.ClientMsg
import com.dashboardz.device.protocol.Codec
import com.dashboardz.device.protocol.Hello
import com.dashboardz.device.protocol.Tap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The board bridge boundary (native takeover boundary / the WebView swap).
 *
 * A hosted renderer must see hub frames VERBATIM — re-encoding our decoded form would make the
 * page render from a second, subtly different wire shape, which is the twin drift the swap exists
 * to remove. In the other direction the page is a less trusted surface than native code, so what
 * it emits is validated against the protocol before it reaches the wire.
 */
class BoardBridgeTest {

    private class FakeTransport : Transport {
        val sent = mutableListOf<ClientMsg>()
        var listener: DeviceClientListener? = null
        override fun connect(hubUrl: String, token: String, listener: DeviceClientListener) {
            this.listener = listener
        }
        val rawSent = mutableListOf<String>()
        override fun send(msg: ClientMsg) { sent += msg }
        override fun sendRaw(text: String) { rawSent += text }
        override fun disconnect() { listener = null }
    }

    private fun controller(t: FakeTransport) = DeviceController(
        transport = t,
        backoff = Backoff(),
        clock = { 0L },
        schedule = { _, _ -> },
        onTokenRejected = {},
    )

    @Test
    fun `raw frames reach the board sink exactly as they arrived`() {
        val t = FakeTransport()
        val c = controller(t)
        val seen = mutableListOf<String>()
        c.boardSink = { seen += it }
        c.start("http://hub", "tok")

        val frame = """{"type":"DATA","server_time":7,"feeds":{},"snapshot":true}"""
        t.listener?.onRaw(frame)

        assertEquals(listOf(frame), seen)
    }

    /**
     * Unconditional: a frame this build cannot decode may still be one a newer page understands,
     * and forwarding is how a board stays useful against a hub ahead of its shell.
     */
    @Test
    fun `a frame this build cannot decode is still forwarded`() {
        val t = FakeTransport()
        val c = controller(t)
        val seen = mutableListOf<String>()
        c.boardSink = { seen += it }
        c.start("http://hub", "tok")

        val future = """{"type":"SOMETHING_NEW","x":1}"""
        assertNull("premise: this build cannot decode it", Codec.decodeServer(future))
        t.listener?.onRaw(future)

        assertEquals(listOf(future), seen)
    }

    @Test
    fun `a valid message from the board reaches the hub, byte for byte`() {
        val t = FakeTransport()
        val c = controller(t)
        c.start("http://hub", "tok")

        val frame = """{"type":"TAP","id":"alr_1","action":"dismiss"}"""
        assertTrue(c.sendFromBoard(frame))
        assertEquals(frame, t.rawSent.last())
    }

    /**
     * THE REGRESSION THIS EXISTS FOR. Validating by decoding and then RE-ENCODING silently erases
     * every field this build's model does not know. A page reporting HEALTH.viewport had it
     * stripped, because Health here is (battery, charging) — so the hub never learned the WebView's
     * real box and the editor kept designing against a stale one. Nothing failed; it just did not
     * happen.
     *
     * Decoding still rejects junk and unknown types. It simply no longer rewrites what passes.
     */
    @Test
    fun `a field this build does not model survives the crossing`() {
        val t = FakeTransport()
        val c = controller(t)
        c.start("http://hub", "tok")

        val frame = """{"type":"HEALTH","battery":80,"viewport":{"w":853,"h":384,"dpr":1.875}}"""
        assertTrue(c.sendFromBoard(frame))
        assertTrue("viewport must reach the hub", t.rawSent.last().contains("viewport"))
        assertTrue(t.rawSent.last().contains("853"))
    }

    /** Junk is dropped at this boundary rather than put on the wire. */
    @Test
    fun `junk from the board never reaches the hub`() {
        val t = FakeTransport()
        val c = controller(t)
        c.start("http://hub", "tok")
        val before = t.sent.size

        assertFalse(c.sendFromBoard("not json at all"))
        assertFalse(c.sendFromBoard("""{"type":"NOPE"}"""))
        assertFalse(c.sendFromBoard(""))
        assertEquals(before, t.sent.size)
        assertEquals(0, t.rawSent.size)
    }

    /**
     * HELLO carries the device token and establishes the socket's identity. A renderer must never
     * be able to re-issue it — that is the shell's handshake, not the page's business.
     */
    @Test
    fun `the board cannot re-issue HELLO`() {
        val t = FakeTransport()
        val c = controller(t)
        c.start("http://hub", "tok")
        val before = t.sent.size

        val hello = Codec.encode(Hello(token = "stolen", caps = com.dashboardz.device.protocol.WireCaps(app_version = "0.1")))
        assertFalse(c.sendFromBoard(hello))
        assertEquals(before, t.sent.size)
        assertEquals(0, t.rawSent.size)
    }

    /** Nothing hosting: the sink is null and the decoded path is completely unaffected. */
    @Test
    fun `no sink means no behaviour change at all`() {
        val t = FakeTransport()
        val c = controller(t)
        c.start("http://hub", "tok")
        t.listener?.onRaw("""{"type":"DATA","server_time":1,"feeds":{}}""")
        // Nothing thrown, nothing sent as a side effect of forwarding.
        assertTrue(t.sent.all { it !is Tap })
    }
}
