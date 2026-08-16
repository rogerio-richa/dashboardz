package com.dashboardz.device.net

import com.dashboardz.device.protocol.Ack
import com.dashboardz.device.protocol.ServerMsg
import com.dashboardz.device.protocol.StateMsg
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class DeviceClientTest {

    private lateinit var server: MockWebServer
    private val fromClient = LinkedBlockingQueue<String>()
    private val events = LinkedBlockingQueue<String>()
    private val received = LinkedBlockingQueue<ServerMsg>()

    private val listener = object : DeviceClientListener {
        override fun onOpen() { events.add("open") }
        override fun onMessage(msg: ServerMsg) { received.add(msg) }
        override fun onClosed(reason: CloseReason) { events.add("closed:$reason") }
    }

    private fun take(q: LinkedBlockingQueue<String>) =
        requireNotNull(q.poll(5, TimeUnit.SECONDS)) { "timed out waiting for an event" }

    /** Stands up a hub-shaped WS endpoint whose behaviour on first client message is `onHello`. */
    private fun hub(onHello: (WebSocket) -> Unit) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    fromClient.add(text)
                    onHello(webSocket)
                }

                // Echo a close initiated by the client so both sides complete the WS closing
                // handshake promptly. Without this, OkHttp leaves the connection open for up
                // to 60s (its cancel-after-close grace period) before forcing it shut, which
                // starves MockWebServer.shutdown()'s fixed 5s wait in tearDown() and makes
                // client-initiated-close tests flaky.
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }),
        )
    }

    private fun hubUrl() = "http://${server.hostName}:${server.port}"

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }

    @Test
    fun sendsHelloOnOpenAndDecodesState() {
        hub { ws ->
            ws.send(
                """{"type":"STATE","device":{"id":"scr_1","name":"bedside"},
                   "server_time":1785268000000,"alerts":[]}""".trimIndent(),
            )
        }
        val client = DeviceClient(OkHttpClient(), appVersion = "0.1")
        client.connect(hubUrl(), token = "dbz_c_tok", listener = listener)

        assertEquals("open", take(events))
        assertEquals(
            """{"type":"HELLO","token":"dbz_c_tok","caps":{"kind":"android","app_version":"0.1"}}""",
            take(fromClient),
        )
        val state = received.poll(5, TimeUnit.SECONDS) as StateMsg
        assertEquals("bedside", state.device.name)
        client.disconnect()
    }

    @Test
    fun mapsCloseCodeFourThousandOneToAuthFailed() {
        hub { ws -> ws.close(4001, "invalid token") }
        DeviceClient(OkHttpClient(), "0.1").connect(hubUrl(), "bad", listener)
        assertEquals("open", take(events))
        assertEquals("closed:${CloseReason.AUTH_FAILED}", take(events))
    }

    @Test
    fun mapsCloseCodeFourThousandToReplaced() {
        hub { ws -> ws.close(4000, "replaced") }
        DeviceClient(OkHttpClient(), "0.1").connect(hubUrl(), "tok", listener)
        assertEquals("open", take(events))
        assertEquals("closed:${CloseReason.REPLACED}", take(events))
    }

    @Test
    fun mapsEverythingElseToNetwork() {
        hub { ws -> ws.close(1011, "server error") }
        DeviceClient(OkHttpClient(), "0.1").connect(hubUrl(), "tok", listener)
        assertEquals("open", take(events))
        assertEquals("closed:${CloseReason.NETWORK}", take(events))
    }

    @Test
    fun mapsCloseCodeFourThousandTwoToHelloTimeout() {
        hub { ws -> ws.close(4002, "hello timeout") }
        DeviceClient(OkHttpClient(), "0.1").connect(hubUrl(), "tok", listener)
        assertEquals("open", take(events))
        assertEquals("closed:${CloseReason.HELLO_TIMEOUT}", take(events))
    }

    @Test
    fun hubInitiatedCloseReportsExactlyOnce() {
        // OkHttp delivers a hub-initiated close as onClosing() then onClosed(). The `notified`
        // guard inside DeviceClient must collapse those into a single onClosed() call to the
        // listener — the controller schedules a reconnect off that callback, and a duplicate would mean
        // two overlapping reconnects.
        hub { ws -> ws.close(4001, "invalid token") }
        DeviceClient(OkHttpClient(), "0.1").connect(hubUrl(), "bad", listener)
        assertEquals("open", take(events))
        assertEquals("closed:${CloseReason.AUTH_FAILED}", take(events))
        assertNull(events.poll(1, TimeUnit.SECONDS))
    }

    @Test
    fun reportsNetworkWhenTheHubIsUnreachable() {
        val dead = server.port
        server.shutdown()
        DeviceClient(OkHttpClient(), "0.1")
            .connect("http://${"127.0.0.1"}:$dead", "tok", listener)
        assertEquals("closed:${CloseReason.NETWORK}", take(events))
        server = MockWebServer().also { it.start() }   // so tearDown has something to close
    }

    @Test
    fun malformedFramesAreIgnoredWithoutKillingTheConnection() {
        hub { ws ->
            ws.send("this is not json")
            ws.send("""{"type":"WHAT_IS_THIS"}""")
            ws.send("""{"type":"ALERT_REMOVE","id":"alr_9","reason":"expired"}""")
        }
        val client = DeviceClient(OkHttpClient(), "0.1")
        client.connect(hubUrl(), "tok", listener)
        take(fromClient)
        // The two junk frames must be dropped and the good one still delivered.
        val msg = received.poll(5, TimeUnit.SECONDS)
        assertEquals("alr_9", (msg as com.dashboardz.device.protocol.AlertRemoveMsg).id)
        client.disconnect()
    }

    @Test
    fun sendEncodesClientMessages() {
        hub { }
        val client = DeviceClient(OkHttpClient(), "0.1")
        client.connect(hubUrl(), "tok", listener)
        take(fromClient)                       // the HELLO
        client.send(Ack(id = "alr_1", stage = "displayed"))
        assertEquals("""{"type":"ACK","id":"alr_1","stage":"displayed"}""", take(fromClient))
        client.disconnect()
    }
}
