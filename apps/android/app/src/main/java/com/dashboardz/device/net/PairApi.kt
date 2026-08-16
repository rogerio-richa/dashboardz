package com.dashboardz.device.net

import com.dashboardz.device.core.normalizeHubUrl
import com.dashboardz.device.core.pairUrl
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

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

@Serializable
private data class ErrorResponse(val error: String? = null)

private val json = Json { ignoreUnknownKeys = true }

private val CODE_REGEX = Regex("^[A-Z2-9]{6}$")

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

class PairApi(private val http: OkHttpClient) {

    fun pair(hubUrl: String, code: String): Result<PairResult> = try {
        val body = """{"code":"${code.uppercase()}"}"""
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(pairUrl(hubUrl)).post(body).build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.isSuccessful) {
                val parsed = json.decodeFromString<PairResponse>(text)
                Result.success(
                    PairResult(
                        deviceId = parsed.device_id,
                        deviceToken = parsed.device_token,
                        hubName = parsed.hub_name,
                    ),
                )
            } else {
                // Prefer the hub's own wording ("invalid or expired code") over a status code.
                val message = try {
                    json.decodeFromString<ErrorResponse>(text).error
                } catch (_: Exception) {
                    null
                } ?: "pairing failed (HTTP ${response.code})"
                Result.failure(IllegalStateException(message))
            }
        }
    } catch (e: Exception) {
        Result.failure(e)
    }
}
