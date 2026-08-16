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

    private fun errorOf(result: Result<PairResult>): PairError =
        (result.exceptionOrNull() as PairException).error

    @Test
    fun aRejectedCodeIsABadCodeNotTheHubsRawWording() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"invalid or expired code"}"""))
        assertEquals(PairError.BadCode, errorOf(PairApi(OkHttpClient()).pair(hubUrl(), "BADBAD")))
    }

    @Test
    fun aMalformedCodeNeverReachesTheNetwork() {
        val api = PairApi(OkHttpClient())
        assertEquals(PairError.MalformedCode, errorOf(api.pair(hubUrl(), "AB")))
        assertEquals(PairError.MalformedCode, errorOf(api.pair(hubUrl(), "ABC12!")))
        // The hub's alphabet (hub/src/db/devices.ts) has no 0, 1, I or O: a code containing one
        // was mistyped, and saying so beats a round trip that answers "invalid or expired".
        assertEquals(PairError.MalformedCode, errorOf(api.pair(hubUrl(), "ABC123")))
        assertEquals(PairError.MalformedCode, errorOf(api.pair(hubUrl(), "K7MOQX")))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun spacesAndDashesInATypedCodeAreIgnored() {
        server.enqueue(MockResponse().setBody("""{"device_id":"d","device_token":"t","hub_name":"h"}"""))
        assertTrue(PairApi(OkHttpClient()).pair(hubUrl(), " k7m-2qx ").isSuccess)
        assertEquals("""{"code":"K7M2QX"}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun anUnreachableHubNamesTheAddress() {
        val port = server.port
        server.shutdown()
        val error = errorOf(PairApi(OkHttpClient()).pair("http://127.0.0.1:$port", "K7M2QX"))
        assertEquals(PairError.Unreachable("127.0.0.1:$port"), error)
        server = MockWebServer().also { it.start() }
    }

    @Test
    fun anUnknownHostnameIsReportedAsSuch() {
        val error = errorOf(PairApi(OkHttpClient()).pair("http://no-such-hub.invalid:8484", "K7M2QX"))
        assertEquals(PairError.UnknownHost("no-such-hub.invalid:8484"), error)
    }

    @Test
    fun aServerThatIsNotAHubIsNotBlamedOnTheCode() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html>router login</html>"))
        assertEquals(PairError.NotAHub("${server.hostName}:${server.port}"), errorOf(PairApi(OkHttpClient()).pair(hubUrl(), "K7M2QX")))
        server.enqueue(MockResponse().setResponseCode(404).setBody("<html>not found</html>"))
        assertEquals(PairError.NotAHub("${server.hostName}:${server.port}"), errorOf(PairApi(OkHttpClient()).pair(hubUrl(), "K7M2QX")))
    }

    @Test
    fun aHubFailureCarriesTheStatus() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"boom"}"""))
        assertEquals(PairError.HubError(503), errorOf(PairApi(OkHttpClient()).pair(hubUrl(), "K7M2QX")))
    }

    @Test
    fun aHubThatNeverAnswersTimesOutInsteadOfHangingForever() {
        server.enqueue(MockResponse().setHeadersDelay(5, java.util.concurrent.TimeUnit.SECONDS))
        // The shared client has readTimeout(0) for the WebSocket; pairing must not inherit that.
        val shared = OkHttpClient.Builder().readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS).build()
        val api = PairApi(shared, timeoutMs = 500)
        assertEquals(PairError.Timeout("${server.hostName}:${server.port}"), errorOf(api.pair(hubUrl(), "K7M2QX")))
    }

    @Test
    fun anAddressThatIsNotAUrlIsABadAddress() {
        assertEquals(PairError.BadAddress, errorOf(PairApi(OkHttpClient()).pair("http://exa mple:8484", "K7M2QX")))
    }

    @Test
    fun loopbackHubsAreRecognised() {
        listOf(
            "http://localhost:8484", "http://LOCALHOST", "http://127.0.0.1:8484",
            "http://127.1.2.3", "http://[::1]:8484", "http://0.0.0.0:8484",
        ).forEach { assertTrue(it, isLoopbackHub(it)) }
        listOf("http://192.168.1.20:8484", "https://hub.example.com", "http://10.0.2.2:8484")
            .forEach { assertTrue(it, !isLoopbackHub(it)) }
    }

    @Test
    fun hostLabelKeepsThePortAndDropsTheScheme() {
        assertEquals("192.168.1.20:8484", hostLabel("http://192.168.1.20:8484/"))
        assertEquals("hub.example.com", hostLabel("https://hub.example.com"))
    }
}
