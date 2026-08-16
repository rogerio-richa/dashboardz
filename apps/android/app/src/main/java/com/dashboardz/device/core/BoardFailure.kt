package com.dashboardz.device.core

/**
 * What the board's WebView reported when its load died, and how that becomes something a human
 * standing in front of a wall panel can act on.
 *
 * Pure and JVM-testable on purpose. This decides what the panel says when it has otherwise gone
 * black, so it is exactly the code that must not be verifiable only by holding a tablet.
 *
 * Written after the 2026-08-27 blackout, where the hub host's DHCP lease moved and the panel,
 * still pinned to the old address, showed nothing at all for hours.
 */
data class BoardError(
    val mainFrame: Boolean,
    val urlPath: String?,
    val code: Int,
    val description: String?,
)

/**
 * Whether this failure kills the board.
 *
 * The main frame, or any asset under `/device`: the page loads as a JS module graph, so a dead
 * device.js leaves the splash with no JS to recover itself. An unrelated fetch failing (an image
 * feed, a favicon) must never raise the failure surface over a board that is rendering fine.
 */
fun isFatalBoardError(mainFrame: Boolean, urlPath: String?): Boolean =
    mainFrame || urlPath?.startsWith("/device") == true

/** The four lines the failure card shows. Every field is already resolved to display text. */
data class BoardDiagnosis(
    val hubUrl: String,
    val error: String,
    val link: String,
    val panel: String,
)

/**
 * Resolve whatever is known into something displayable.
 *
 * Every field degrades to a placeholder rather than blocking: the hub is unreachable by
 * definition here, so a card that refused to render without hub data would reproduce the very
 * blackout it exists to replace.
 */
fun diagnose(
    hubUrl: String?,
    error: BoardError?,
    link: String,
    panelIp: String?,
): BoardDiagnosis = BoardDiagnosis(
    hubUrl = hubUrl?.takeIf { it.isNotBlank() } ?: "not set",
    error = error?.description?.takeIf { it.isNotBlank() }
        ?: error?.let { "error ${it.code}" }
        ?: "unknown",
    link = link,
    panel = panelIp?.takeIf { it.isNotBlank() } ?: "unknown",
)
