package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireScreen

// Family/event names become path segments and on-disk filenames, so they're validated hard
// against a closed charset — no dots, slashes, or case that could escape the sounds dir or
// collide across platforms. Events are exactly the five the hub ever sends (alert sounds,
// extended by stream-activity contract stream-activity sounds with `activity`, appended last).
private val NAME = Regex("[a-z0-9_]{1,40}")
private val EVENTS = setOf("critical", "warn", "info", "offline", "activity")

/** On-disk name for a cached family/event file, keyed by manifest rev so a re-upload can't
 *  collide with a stale cached copy. Null on anything that fails validation — callers never
 *  see a hostile family/event turn into a path. */
fun soundFileName(family: String, event: String, rev: Long): String? {
    if (!NAME.matches(family)) return null
    if (event !in EVENTS) return null
    if (rev < 0) return null
    return "$family-$event-$rev.wav"
}

/** The hub's unauthenticated static sound route (same `stripTrailingSlashes` convention as
 *  `pairUrl`/`wsUrl` in Backoff.kt). */
fun soundUrl(hubUrl: String, family: String, event: String, rev: Long): String =
    "${stripTrailingSlashes(hubUrl)}/sounds/$family/$event.wav?rev=$rev"

/** Union of every (family, event) a screen's `sounds` map asks for, across all screens,
 *  excluding `classic` — that voice is programmatic (ToneGenerator), never a file to fetch. */
fun wantedSounds(screens: List<WireScreen>): Set<Pair<String, String>> =
    screens.flatMap { screen ->
        screen.sounds.orEmpty().mapNotNull { (event, family) ->
            if (family == "classic") null else family to event
        }
    }.toSet()
