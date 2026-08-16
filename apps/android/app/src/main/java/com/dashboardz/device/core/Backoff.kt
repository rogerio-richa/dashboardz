package com.dashboardz.device.core

/**
 * Exponential backoff with jitter, 1 s → 60 s (documented contract).
 *
 * The jitter band is 50–100% of the current ceiling. Without it, every device on a site
 * reconnects in lockstep the moment the hub returns.
 */
class Backoff(
    private val baseMs: Long = 1_000,
    private val maxMs: Long = 60_000,
    private val random: () -> Double = { Math.random() },
) {
    private var attempt = 0

    fun reset() {
        attempt = 0
    }

    fun nextDelayMs(): Long {
        // attempt is clamped before shifting so the shift can never overflow Long.
        val ceiling = (baseMs shl attempt).coerceAtMost(maxMs)
        if (attempt < 30) attempt++
        return (ceiling * (0.5 + 0.5 * random())).toLong().coerceAtLeast(1)
    }
}

internal fun stripTrailingSlashes(s: String) = s.trimEnd('/')

/** Accepts what a human types into the pairing form and makes it a usable base URL. */
fun normalizeHubUrl(input: String): String {
    val trimmed = input.trim()
    val withScheme =
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed
        else "http://$trimmed"
    return stripTrailingSlashes(withScheme)
}

fun wsUrl(hubUrl: String): String {
    val base = stripTrailingSlashes(hubUrl)
    val ws = when {
        base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
        base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
        else -> "ws://$base"
    }
    return "$ws/ws/device"
}

fun pairUrl(hubUrl: String): String = stripTrailingSlashes(hubUrl) + "/api/pair"

/** Device-token image fetch endpoint (image-feed behavior interface contract): `GET <hub>/api/feeds/:id/image`. */

/**
 * Age of an alert, computed against hub time. Callers pass
 * `serverNow = System.currentTimeMillis() + state.serverOffsetMs` — never the raw device clock,
 * because the target hardware is old phones whose clocks drift.
 */
fun ageLabel(updatedAt: Long, serverNow: Long): String {
    val seconds = ((serverNow - updatedAt) / 1000).coerceAtLeast(0)
    return when {
        seconds < 60 -> "${seconds}s"
        seconds < 3600 -> "${seconds / 60}m"
        else -> "${seconds / 3600}h"
    }
}
