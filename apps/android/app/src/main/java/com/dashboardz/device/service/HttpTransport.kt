package com.dashboardz.device.service

import com.dashboardz.device.net.DeviceClient
import com.dashboardz.device.net.DeviceClientListener
import com.dashboardz.device.protocol.WireViewport
import com.dashboardz.device.protocol.ClientMsg
import okhttp3.OkHttpClient

/** Adapts the real WebSocket client to the Transport seam the controller depends on. */
class HttpTransport(
    http: OkHttpClient,
    appVersion: String,
    viewport: () -> WireViewport? = { null },
) : Transport {

    private val client = DeviceClient(http, appVersion, viewport)

    override fun connect(hubUrl: String, token: String, listener: DeviceClientListener) =
        client.connect(hubUrl, token, listener)

    override fun send(msg: ClientMsg) = client.send(msg)

    override fun sendRaw(text: String) = client.sendRaw(text)

    override fun disconnect() = client.disconnect()
}
