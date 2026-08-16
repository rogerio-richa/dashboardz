package com.dashboardz.device.service

import com.dashboardz.device.core.Backoff
import com.dashboardz.device.core.DeviceState
import com.dashboardz.device.core.reduce
import com.dashboardz.device.net.CloseReason
import com.dashboardz.device.net.DeviceClientListener
import com.dashboardz.device.protocol.Ack
import com.dashboardz.device.protocol.AlertAddMsg
import com.dashboardz.device.protocol.ClientMsg
import com.dashboardz.device.protocol.Codec
import com.dashboardz.device.protocol.DataMsg
import com.dashboardz.device.protocol.Hello
import com.dashboardz.device.protocol.Health
import com.dashboardz.device.protocol.PlaySoundMsg
import com.dashboardz.device.protocol.ServerMsg
import com.dashboardz.device.protocol.StateAck
import com.dashboardz.device.protocol.StateMsg
import com.dashboardz.device.protocol.Tab
import com.dashboardz.device.protocol.Tap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class Link {
    CONNECTING,
    ONLINE,
    OFFLINE,

    /** Hub rejected our token (4001). Only re-pairing fixes this. */
    NEEDS_PAIRING,

    /** Another device connected with this device's token (4000). */
    REPLACED,
}

data class ConnectionState(
    val link: Link = Link.OFFLINE,
    val device: DeviceState = DeviceState(),
)

/** Seam over DeviceClient so reconnect timing is testable without real sockets. */
interface Transport {
    fun connect(hubUrl: String, token: String, listener: DeviceClientListener)
    fun send(msg: ClientMsg)
    /** Already-validated text, forwarded unchanged. See DeviceController.sendFromBoard. */
    fun sendRaw(text: String) = Unit
    fun disconnect()
}

/**
 * Owns the connection lifecycle and the single source of truth the UI renders.
 *
 * @param schedule runs an action after a delay; the Android shell backs this with a Handler.
 * @param onTokenRejected invoked when the hub says our token is dead, so the shell can wipe it.
 */
class DeviceController(
    private val transport: Transport,
    private val backoff: Backoff,
    private val clock: () -> Long,
    private val schedule: (Long, () -> Unit) -> Unit,
    private val onTokenRejected: () -> Unit,
) {
    private val _state = MutableStateFlow(ConnectionState())
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private var hubUrl: String? = null
    private var token: String? = null
    private var running = false

    /**
     * Bumped every time we open a new connection (including a repeat `start()` on top of a
     * still-live one). `DeviceClient.connect()` closes any prior socket but does not cancel
     * that socket's own `WebSocketListener` — a late `onOpen`/`onMessage`/`onClosed` from a
     * superseded connection can still land on us. Each listener closes over the epoch it was
     * created for, so a stale callback fails the `myEpoch != epoch` check and is dropped rather
     * than being mistaken for the current connection.
     */
    private var epoch = 0

    /**
     * The takeover alert whose "displayed" ACK we have already sent. Tracked per takeover so
     * that when one critical is dismissed and the next slides in, the new one is acked too.
     */
    private var displayedAckId: String? = null

    /**
     * Where raw hub frames go so a hosted board can render them (native takeover boundary / the WebView swap).
     *
     * Null when nothing is hosting, which is every existing caller. The board is a SECOND consumer
     * of the same frames -- the alarm decision still runs natively off the decoded form, and must,
     * because a wedged or blank WebView may never render at all.
     */
    var boardSink: ((String) -> Unit)? = null

    /**
     * Where a hub PLAY_SOUND goes (the admin's "preview this family" button).
     *
     * A sink rather than reduced state, for the same reason `reduce` treats PLAY_SOUND as a
     * no-op: "a sound just played" is a one-shot cue with nothing durable about it, and folding
     * it into DeviceState would make every replay of that state re-trigger it. Null when nothing
     * can play (no activity in the foreground), which is the correct behaviour for an audition —
     * it is a UI affordance, not an alert.
     */
    var playSoundSink: ((family: String, event: String) -> Unit)? = null

    /**
     * Where a live stream push goes (stream-activity contract's activity tick), carrying the ids of every feed the push
     * touched — unfiltered. Which of those anyone actually opted in to, which screen voices the
     * tick, and whether a cooldown or a sounding alarm swallows it are all the sink's business
     * (`activityVoice`/`activityTickAllowed`); the controller only reports what arrived.
     *
     * A sink rather than reduced state for the same reason as [playSoundSink]: "a stream just got
     * new entries" is a one-shot cue with nothing durable about it, and the DATA fold is about the
     * feeds themselves.
     *
     * Invoked ONLY for a non-snapshot DATA carrying at least one feed. A snapshot is a reconnect
     * resync — the same rows arriving again, not new activity — and ticking on one would mean a
     * flaky link chirps at every reconnect; this is the identical rule the alert chimes follow
     * (and the identical guard the web board applies, `device.js` `maybePlayActivityTick`).
     */
    var activitySink: ((pushedFeedIds: Set<String>) -> Unit)? = null

    // The last STATE and the last DATA snapshot, verbatim. A hosted page loads long after the
    // socket did — the frames that built the current board are already gone — so without a replay
    // it would sit blank until the hub happened to say something. Snapshots only: a per-feed DATA
    // push is meaningless without the STATE that defines the cells it belongs to.
    private var lastStateFrame: String? = null
    private var lastDataFrame: String? = null
    // Set by onRaw immediately before onMessage decodes the SAME frame; that ordering is part of
    // DeviceClientListener's documented contract and is pinned by BoardBridgeTest.
    private var currentRaw: String? = null

    /**
     * Bring a freshly-loaded board up to the current state, in the order the hub itself would have
     * sent them: the screen definition first, then the data that fills it.
     */
    fun replayToBoard() {
        val sink = boardSink ?: return
        lastStateFrame?.let(sink)
        lastDataFrame?.let(sink)
    }

    /**
     * A message the hosted board wants sent to the hub.
     *
     * Decoded through Codec.decodeClient rather than forwarded as text: the page is a less trusted
     * surface, and this way it can only emit messages the protocol defines. Junk is dropped here
     * rather than put on the wire. Returns whether it was accepted, so a caller can log a rejection
     * instead of wondering why an ACK never arrived.
     */
    fun sendFromBoard(text: String): Boolean {
        val msg = Codec.decodeClient(text) ?: return false
        // HELLO is the shell's own handshake and carries the device token. A page must never be
        // able to re-issue it — that is the socket's identity, not the renderer's business.
        if (msg is Hello) return false
        if (!running) return false
        // The board is the one place a tab switch actually happens (tab switching lives entirely
        // in the WebView) — mirror it into native state here so chime/sound decisions can read which
        // screen is actually visible instead of always using the hub's default tab.
        // The hub remains the source of truth for whether the switch is valid; this is purely a
        // local mirror of what the board just told it, same trust boundary as everything else in
        // this method.
        if (msg is Tab) {
            _state.value = _state.value.copy(
                device = _state.value.device.copy(activeScreenId = msg.screen_id),
            )
        }
        // VALIDATE by decoding, then forward the ORIGINAL text. Re-encoding `msg` would narrow the
        // message to whatever this build's model knows: a page reporting HEALTH.viewport had it
        // silently dropped, because Health here is (battery, charging). Decoding still rejects junk
        // and unknown types, so the boundary holds — it just no longer rewrites what passes.
        transport.sendRaw(text)
        return true
    }

    private fun listenerFor(myEpoch: Int) = object : DeviceClientListener {
        override fun onRaw(text: String) {
            if (!running || myEpoch != epoch) return
            currentRaw = text
            boardSink?.invoke(text)
        }

        override fun onOpen() {
            if (!running || myEpoch != epoch) return
            _state.value = _state.value.copy(link = Link.CONNECTING)
        }

        override fun onMessage(msg: ServerMsg) {
            if (!running || myEpoch != epoch) return
            // Handled entirely here and returned: PLAY_SOUND carries no state (reduce is a
            // deliberate no-op for it), so folding it through the _state.value assignment below
            // would republish an unchanged ConnectionState and wake every collector for nothing.
            if (msg is PlaySoundMsg) {
                playSoundSink?.invoke(msg.family, msg.event)
                return
            }
            if (msg is StateMsg) {
                // A full STATE means the link genuinely works; only now is it safe to reset
                // the backoff. Resetting on onOpen would spin if the hub closed us right after.
                backoff.reset()
                displayedAckId = null
                lastStateFrame = currentRaw
            }
            if (msg is DataMsg && msg.snapshot) lastDataFrame = currentRaw
            // stream-activity contract activity tick. A live push only (see activitySink), and only one with feeds in
            // it — an empty DATA carries no activity to report. The DATA fold below is deliberately
            // untouched by this: the tick is a cue about the push, not part of what it means.
            //
            // runCatching, unlike playSoundSink's bare invoke: that one returns immediately after
            // the sink, so a throwing sink costs only the socket, whereas a throw HERE would also
            // skip the fold and lose the feed data this frame carried — on the reader thread of
            // the connection that carries the alerts. The production sink guards its own body too
            // (MainActivity); this is the belt to that pair of braces.
            if (msg is DataMsg && !msg.snapshot && msg.feeds.isNotEmpty()) {
                runCatching { activitySink?.invoke(msg.feeds.keys.toSet()) }
            }
            if (msg is AlertAddMsg) {
                transport.send(Ack(id = msg.alert.id, stage = "delivered"))
            }
            _state.value = ConnectionState(
                link = if (msg is StateMsg) Link.ONLINE else _state.value.link,
                device = reduce(_state.value.device, msg, clock()),
            )
            if (msg is StateMsg) {
                // STATE_ACK goes AFTER the state is applied — it is a receipt for what this
                // device now renders, not for what arrived (design: STATE acknowledgment).
                // screen_id falls back to the single-screen field for a hub that predates
                // `screens`; screen_ids is the honest set-ack and stays null on that same hub.
                transport.send(
                    StateAck(
                        rev = msg.rev,
                        screen_id = msg.screens?.firstOrNull()?.id ?: msg.screen?.id,
                        screen_ids = msg.screens?.map { it.id },
                    ),
                )
            }
        }

        override fun onClosed(reason: CloseReason) {
            if (!running || myEpoch != epoch) return
            when (reason) {
                CloseReason.AUTH_FAILED -> {
                    running = false
                    _state.value = _state.value.copy(link = Link.NEEDS_PAIRING)
                    onTokenRejected()
                }

                CloseReason.REPLACED -> {
                    // Retrying here would start a reconnect war with the other device.
                    running = false
                    _state.value = _state.value.copy(link = Link.REPLACED)
                }

                CloseReason.NETWORK, CloseReason.HELLO_TIMEOUT -> {
                    _state.value = _state.value.copy(link = Link.OFFLINE)
                    val delay = backoff.nextDelayMs()
                    // Guarded on OFFLINE at fire time, not just `running`: retryNow() can
                    // reconnect ahead of this timer, and `schedule` has no cancel — an unguarded
                    // stale timer would then call openConnection() over the LIVE socket, bumping
                    // the epoch and orphaning a connection that was working fine.
                    schedule(delay) { if (running && _state.value.link == Link.OFFLINE) openConnection() }
                }
            }
        }
    }

    fun start(hubUrl: String, token: String) {
        this.hubUrl = hubUrl
        this.token = token
        running = true
        backoff.reset()
        openConnection()
    }

    fun stop() {
        running = false
        transport.disconnect()
        _state.value = _state.value.copy(link = Link.OFFLINE)
    }

    /**
     * Collapse the backoff wait because the platform just said a network became available:
     * wifi returning found the app sitting out a 60 s backoff, "offline" on a working network).
     * Only meaningful while OFFLINE: while CONNECTING it would race the attempt already in
     * flight, and while ONLINE it would bump the epoch and orphan a healthy socket. The backoff
     * resets too — a NEW network deserves the fast ladder from the bottom, not the dead
     * network's accumulated ceiling. The pending scheduled retry is not cancelled (schedule has
     * no cancel); it guards on OFFLINE at fire time and so no-ops once this connects.
     */
    fun retryNow() {
        if (!running || _state.value.link != Link.OFFLINE) return
        backoff.reset()
        openConnection()
    }

    private fun openConnection() {
        val url = hubUrl ?: return
        val tok = token ?: return
        epoch++
        _state.value = _state.value.copy(link = Link.CONNECTING)
        transport.connect(url, tok, listenerFor(epoch))
    }

    /** Called by the takeover surface once it is actually on screen. Idempotent per alert. */
    fun onTakeoverDisplayed(alertId: String) {
        if (displayedAckId == alertId) return
        displayedAckId = alertId
        transport.send(Ack(id = alertId, stage = "displayed"))
    }

    fun tap(alertId: String, action: String) {
        transport.send(Tap(id = alertId, action = action))
        if (action == "silence") {
            // Silence locally at once. Waiting for the hub to echo anything back would leave
            // the alarm sounding for the length of a network round-trip.
            _state.value = _state.value.copy(
                device = _state.value.device.copy(
                    silenced = _state.value.device.silenced + alertId,
                ),
            )
        }
    }

    /**
     * Answer tap: no local state change on purpose. The hub validates the option id against the
     * alert's options and confirms with ALERT_REMOVE (reason "dismissed") — removal comes from
     * that echo, exactly as it does for a dismiss tap, never from guessing locally.
     */
    fun answer(alertId: String, optionId: String) {
        transport.send(Tap(id = alertId, action = "answer", option_id = optionId))
    }

    fun reportHealth(battery: Int?, charging: Boolean?) {
        transport.send(Health(battery = battery, charging = charging))
    }
}
