package com.dashboardz.device.core

/**
 * Whether the board WebView needs a reload after its own load died.
 *
 * The shell owns the socket and reconnects itself, but a board load that fails while offline can
 * leave a connected panel rendering black. This gate remembers that the board's own load died and
 * decides when to try again.
 *
 * There are two triggers, and both are needed:
 *
 * - [reloadNeeded], the fast path: the link's ONLINE transition, the same signal that clears the
 *   OFFLINE banner.
 * - [retryDue], the safety net: a backoff timer that does not care about link state at all.
 *
 * "The board's own load" means the main frame OR any asset under /device: the page loads as a JS
 * module graph, so a dead device.js is as fatal as a dead page (the splash has no JS to recover
 * itself). An unrelated fetch failing (an image feed, a favicon) must never bounce a healthy
 * board. That rule lives in [isFatalBoardError], shared with the failure surface.
 */
class BoardReloadGate(
    /** Injectable so the retry schedule is testable without a clock. */
    private val backoff: Backoff = Backoff(baseMs = 2_000, maxMs = 60_000),
) {
    private var dead = false
    private var nextRetryAtMs: Long? = null

    /** A new load attempt is underway (onPageStarted) — including the reload this gate asked for. */
    fun onLoadStarted() {
        dead = false
        nextRetryAtMs = null
        backoff.reset()
    }

    fun onLoadError(mainFrame: Boolean, urlPath: String?) {
        if (isFatalBoardError(mainFrame, urlPath)) dead = true
    }

    /**
     * The fast path, unchanged: the link's ONLINE transition is the immediate retry signal.
     * Deliberately still false while offline, because [retryDue] now owns that case.
     */
    fun reloadNeeded(online: Boolean): Boolean = online && dead

    /**
     * The safety net, independent of link state.
     *
     * The original gate retried ONLY on an OFFLINE to ONLINE transition, reasoning that reloading
     * while offline would "eat the one retry". That is right for a single retry and wrong for a
     * periodic one, and it is why the 2026-08-27 blackout was permanent: the panel's hub_url
     * pointed at an address that refused the port, so the socket never reached ONLINE and the only
     * retry trigger could never fire. The panel stayed black for hours while beeping.
     *
     * Under a backoff there is no single retry to spend, and this is the only path by which a
     * panel with a stale hub address heals itself once the hub is reachable again.
     *
     * Arms on the first poll after death rather than inside [onLoadError], so the caller supplies
     * the clock and this class stays pure.
     */
    fun retryDue(nowMs: Long): Boolean {
        if (!dead) return false
        val due = nextRetryAtMs
        if (due == null) {
            nextRetryAtMs = nowMs + backoff.nextDelayMs()
            return false
        }
        if (nowMs < due) return false
        nextRetryAtMs = nowMs + backoff.nextDelayMs()
        return true
    }
}
