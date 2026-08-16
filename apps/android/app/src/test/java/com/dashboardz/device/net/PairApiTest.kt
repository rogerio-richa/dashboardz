package com.dashboardz.device.net

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PairApiTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }

    private fun hubUrl() = "http://${server.hostName}:${server.port}"

    @Test
    fun parsesTheAdminQrJson() {
        // Exactly what hub/admin/src/pages/Devices.tsx encodes into the QR image.
        val p = parsePairPayload("""{"hub":"http://10.0.2.2:8484","code":"K7M2QX"}""")
        assertEquals("http://10.0.2.2:8484", p?.hubUrl)
        assertEquals("K7M2QX", p?.code)
    }

    @Test
    fun parsesABareCodeAndABareUrl() {
        assertEquals("K7M2QX", parsePairPayload("k7m2qx")?.code)
        assertNull("a bare code carries no hub url", parsePairPayload("K7M2QX")?.hubUrl)

        val url = parsePairPayload("http://10.0.2.2:8484/")
        assertEquals("http://10.0.2.2:8484", url?.hubUrl)
        assertEquals("", url?.code)
    }

    @Test
    fun normalizesTheHubUrlInsideTheQrPayload() {
        val p = parsePairPayload("""{"hub":"10.0.2.2:8484/","code":"abc123"}""")
        assertEquals("http://10.0.2.2:8484", p?.hubUrl)
        assertEquals("ABC123", p?.code)
    }

    @Test
    fun returnsNullForRubbish() {
        assertNull(parsePairPayload(""))
        assertNull(parsePairPayload("   "))
        assertNull(parsePairPayload("{ not json"))
        assertNull(parsePairPayload("{\"unrelated\":1}"))
    }

    @Test
    fun pairsSuccessfully() {
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody("""{"device_id":"scr_1","device_token":"dbz_c_abc","hub_name":"Dashboardz"}"""),
        )
        val result = PairApi(OkHttpClient()).pair(hubUrl(), "K7M2QX")
        val value = result.getOrThrow()
        assertEquals("scr_1", value.deviceId)
        assertEquals("dbz_c_abc", value.deviceToken)
        assertEquals("Dashboardz", value.hubName)

        val request = server.takeRequest()
        assertEquals("/api/pair", request.path)
        assertEquals("POST", request.method)
        assertEquals("""{"code":"K7M2QX"}""", request.body.readUtf8())
    }

    @Test
    fun surfacesTheHubsErrorMessageOnRejection() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"invalid or expired code"}"""))
        val result = PairApi(OkHttpClient()).pair(hubUrl(), "BADBAD")
        assertTrue(result.isFailure)
        assertEquals("invalid or expired code", result.exceptionOrNull()?.message)
    }

    @Test
    fun failsCleanlyWhenTheHubIsUnreachable() {
        val port = server.port
        server.shutdown()
        val result = PairApi(OkHttpClient()).pair("http://127.0.0.1:$port", "K7M2QX")
        assertTrue(result.isFailure)
        server = MockWebServer().also { it.start() }
    }
}
