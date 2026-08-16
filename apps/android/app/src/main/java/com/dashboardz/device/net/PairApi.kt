package com.dashboardz.device.net

import com.dashboardz.device.core.normalizeHubUrl
import com.dashboardz.device.core.pairUrl
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.InterruptedIOException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

data class PairPayload(val hubUrl: String?, val code: String)

data class PairResult(val deviceId: String, val deviceToken: String, val hubName: String)

@Serializable
private data class QrPayload(val hub: String? = null, val code: String? = null)

@Serializable
private data class PairResponse(
    val device_id: String,
    val device_token: String,
    val hub_name: String,
)

/**
 * Why a pairing attempt failed, classified so the screen can say what to do next instead of
 * showing an exception message ("Failed to connect to /10.0.2.2:9999", AJV's
 * "body/code must NOT have fewer than 6 characters"). `host` is [hostLabel] of the hub address.
 */
sealed interface PairError {
    /** Nothing answered at that address: hub not running, wrong IP or port, different network. */
    data class Unreachable(val host: String) : PairError
    /** The name in the address doesn't resolve. */
    data class UnknownHost(val host: String) : PairError
    /** Something accepted the connection but never answered. */
    data class Timeout(val host: String) : PairError
    /** HTTPS handshake failed, typically an untrusted certificate on an old Android. */
    data class Tls(val host: String) : PairError
    /** The hub rejected the code: wrong, already used, or expired. */
    data object BadCode : PairError
    /** Not a possible code (wrong length, or 0/1/I/O); caught before any network call. */
    data object MalformedCode : PairError
    /** A web server answered, but not a Dashboardz hub (router page, wrong port). */
    data class NotAHub(val host: String) : PairError
    /** The hub itself failed. */
    data class HubError(val status: Int) : PairError
    /** The address can't be parsed as a URL. */
    data object BadAddress : PairError
    data object Unknown : PairError
}

class PairException(val error: PairError) : Exception(error.toString())

/** `host[:port]` of a hub URL for messages, e.g. "192.168.1.20:8484"; the raw text if unparseable. */
fun hostLabel(hubUrl: String): String {
    val url = normalizeHubUrl(hubUrl).toHttpUrlOrNull() ?: return hubUrl.trim()
    val defaultPort = if (url.isHttps) 443 else 80
    val host = if (url.host.contains(':')) "[${url.host}]" else url.host
    return if (url.port == defaultPort) host else "$host:${url.port}"
}

/**
 * True when a hub address can only ever mean "this same device": what a hub run without
 * PUBLIC_URL puts in its pairing QR (`http://localhost:8484`). A phone that pairs to it is talking
 * to itself, so the app refuses it with an explanation instead of failing to connect.
 */
fun isLoopbackHub(hubUrl: String): Boolean {
    val host = normalizeHubUrl(hubUrl).toHttpUrlOrNull()?.host?.lowercase() ?: return false
    return host == "localhost" || host.endsWith(".localhost") || host.startsWith("127.") ||
        host == "::1" || host == "0:0:0:0:0:0:0:1" || host == "0.0.0.0"
}

@Serializable
private data class ErrorResponse(val error: String? = null)

private val json = Json { ignoreUnknownKeys = true }

// The hub's alphabet (hub/src/db/devices.ts CODE_ALPHABET): no 0, 1, I or O, so they can't be
// confused when read off a screen.
private val CODE_REGEX = Regex("^[A-HJ-NP-Z2-9]{6}$")

/** A typed code with spaces or dashes ("K7M 2QX", "K7M-2QX") means the same code. */
private fun cleanCode(code: String): String = code.filterNot { it.isWhitespace() || it == '-' }.uppercase()

/**
 * Understands the three things a scan or a paste can plausibly be:
 *  - the admin UI's QR JSON, `{"hub": "...", "code": "..."}` (hub/admin/src/pages/Devices.tsx)
 *  - a bare hub URL (user pointed the scanner at a URL, or typed one)
 *  - a bare 6-character pairing code
 */
fun parsePairPayload(scanned: String): PairPayload? {
    val text = scanned.trim()
    if (text.isEmpty()) return null

    if (text.startsWith("{")) {
        val parsed = try {
            json.decodeFromString<QrPayload>(text)
        } catch (_: Exception) {
            return null
        }
        val code = parsed.code?.trim()?.uppercase()
        val hub = parsed.hub?.takeIf { it.isNotBlank() }?.let(::normalizeHubUrl)
        if (code == null && hub == null) return null
        return PairPayload(hubUrl = hub, code = code ?: "")
    }

    if (text.startsWith("http://") || text.startsWith("https://")) {
        return PairPayload(hubUrl = normalizeHubUrl(text), code = "")
    }

    val upper = text.uppercase()
    if (CODE_REGEX.matches(upper)) return PairPayload(hubUrl = null, code = upper)

    return null
}

class PairApi(http: OkHttpClient, timeoutMs: Long = 20_000) {

    // The shared client has readTimeout(0) because a WebSocket is legitimately idle for hours.
    // A pairing POST is not: bound it so a half-open hub can't leave "Pairing..." spinning forever.
    private val client = http.newBuilder()
        .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .build()

    fun pair(hubUrl: String, code: String): Result<PairResult> {
        val upper = cleanCode(code)
        if (!CODE_REGEX.matches(upper)) return fail(PairError.MalformedCode)
        val host = hostLabel(hubUrl)
        val url = pairUrl(hubUrl).toHttpUrlOrNull() ?: return fail(PairError.BadAddress)

        val body = """{"code":"$upper"}""".toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(url).post(body).build()

        return try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                val hubError = try { json.decodeFromString<ErrorResponse>(text).error } catch (_: Exception) { null }
                when {
                    response.isSuccessful -> {
                        val parsed = try {
                            json.decodeFromString<PairResponse>(text)
                        } catch (_: Exception) {
                            return fail(PairError.NotAHub(host))
                        }
                        Result.success(PairResult(parsed.device_id, parsed.device_token, parsed.hub_name))
                    }
                    response.code == 400 && hubError != null -> fail(PairError.BadCode)
                    response.code >= 500 -> fail(PairError.HubError(response.code))
                    hubError == null -> fail(PairError.NotAHub(host))
                    else -> fail(PairError.HubError(response.code))
                }
            }
        } catch (e: Exception) {
            fail(classify(e, host))
        }
    }

    private fun classify(e: Exception, host: String): PairError = when (e) {
        is UnknownHostException -> PairError.UnknownHost(host)
        is SSLException -> PairError.Tls(host)
        // SocketTimeoutException, and callTimeout's InterruptedIOException, both land here.
        is InterruptedIOException -> PairError.Timeout(host)
        is IOException -> PairError.Unreachable(host)
        is IllegalArgumentException -> PairError.BadAddress
        else -> PairError.Unknown
    }

    private fun fail(error: PairError): Result<PairResult> = Result.failure(PairException(error))
}
