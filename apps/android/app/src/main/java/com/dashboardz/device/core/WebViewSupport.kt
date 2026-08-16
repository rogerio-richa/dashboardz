package com.dashboardz.device.core

/**
 * Oldest Chromium WebView the board runs on. hub/static/device uses optional chaining (`?.`) and
 * nullish coalescing (`??`), both Chromium 80. Raise this when the board starts using newer syntax.
 */
const val MIN_WEBVIEW_MAJOR = 80

private val CHROME_VERSION = Regex("""Chrome/(\d+)""")

/** Chromium major version from a WebView user agent, or null when it can't be read. */
fun webViewMajor(userAgent: String?): Int? =
    CHROME_VERSION.find(userAgent.orEmpty())?.groupValues?.get(1)?.toIntOrNull()

/** Only a version we could read and that is below the floor counts as too old. */
fun webViewTooOld(major: Int?): Boolean = major != null && major < MIN_WEBVIEW_MAJOR
