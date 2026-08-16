package com.dashboardz.device.net

import com.dashboardz.device.core.wsUrl
import com.dashboardz.device.protocol.ClientMsg
import com.dashboardz.device.protocol.Codec
import com.dashboardz.device.protocol.Hello
import com.dashboardz.device.protocol.ServerMsg
import com.dashboardz.device.protocol.WireCaps
import com.dashboardz.device.protocol.WireViewport
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Why the socket went away. Drives whether the caller retries, and what the user is told. */
enum class CloseReason {
    /** Unreachable hub, dropped Wi-Fi, server restart. Retry with backoff. */
    NETWORK,

    /** 4001: token invalid or revoked. Wipe the token and show re-pair — retrying is pointless. */
    AUTH_FAILED,

    /** 4000: another client connected with this device's token. Stop; two devices would fight. */
    REPLACED,

    /** 4002: we failed to HELLO within 5 s. Retry normally. */
    HELLO_TIMEOUT,
}

interface DeviceClientListener {
    fun onOpen()
    fun onMessage(msg: ServerMsg)
    fun onClosed(reason: CloseReason)

    /**
     * The frame exactly as it arrived, delivered BEFORE decoding and regardless of whether it
     * decodes at all.
     *
     * A hosted renderer (the WebView board) has to see hub JSON verbatim: re-encoding our decoded
     * form would make the page render from a second, subtly different wire shape, which is exactly
     * the twin drift the swap exists to remove. Default no-op so the many listeners that only care
     * about typed messages are untouched.
     */
    fun onRaw(text: String) {}
}

/**
 * One WebSocket connection to the hub. Deliberately has no retry policy of its own —
 * reconnect scheduling lives in DeviceController so it can be tested without real sockets.
 */
class DeviceClient(
    private val http: OkHttpClient,
    private val appVersion: String,
    /**
     * The box the board is drawn into, read at HELLO time rather than at construction: a handset
     * rotates and a window resizes, so the value must be current for THIS connection.
     * Null when the shell cannot measure yet — the hub then keeps whatever was last reported.
     */
    private val viewport: () -> WireViewport? = { null },
) {
    private var socket: WebSocket? = null

    fun connect(hubUrl: String, token: String, listener: DeviceClientListener) {
        disconnect()
        val request = Request.Builder().url(wsUrl(hubUrl)).build()
        socket = http.newWebSocket(
            request,
            object : WebSocketListener() {
                // Guards against reporting a close twice (onClosing then onFailure, say):
                // the controller would otherwise schedule two overlapping reconnects.
                private var notified = false

                private fun finish(reason: CloseReason) {
                    if (notified) return
                    notified = true
                    listener.onClosed(reason)
                }

                override fun onOpen(webSocket: WebSocket, response: Response) {
                    listener.onOpen()
                    // The hub closes with 4002 if HELLO does not arrive within 5 s.
                    webSocket.send(
                        Codec.encode(
                            Hello(
                                token = token,
                                caps = WireCaps(app_version = appVersion, viewport = viewport()),
                            ),
                        ),
                    )
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    // Verbatim first, and unconditionally: a frame this build cannot decode may
                    // still be one a newer page understands, and forwarding is how a board stays
                    // useful against a hub ahead of its shell.
                    listener.onRaw(text)
                    // Codec returns null for junk; dropping the frame keeps the socket alive.
                    Codec.decodeServer(text)?.let(listener::onMessage)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    finish(reasonFor(code))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    finish(reasonFor(code))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    finish(CloseReason.NETWORK)
                }
            },
        )
    }

    /**
     * Send text the caller has already validated, byte for byte.
     *
     * Decoding and RE-ENCODING at a trust boundary silently erases every field this build's model
     * does not know: a page reporting `HEALTH.viewport` had it stripped, because Health here is
     * (battery, charging). The inbound direction forwards raw for the same reason — a message a
     * newer page and a newer hub both understand must not be narrowed by the shell in between.
     */
    fun sendRaw(text: String) {
        socket?.send(text)
    }

    fun send(msg: ClientMsg) {
        socket?.send(Codec.encode(msg))
    }

    fun disconnect() {
        socket?.close(1000, null)
        socket = null
    }

    private fun reasonFor(code: Int): CloseReason = when (code) {
        4000 -> CloseReason.REPLACED
        4001 -> CloseReason.AUTH_FAILED
        4002 -> CloseReason.HELLO_TIMEOUT
        else -> CloseReason.NETWORK
    }
}
