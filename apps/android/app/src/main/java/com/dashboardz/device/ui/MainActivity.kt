package com.dashboardz.device.ui

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration as ComposeViewConfiguration
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dashboardz.device.R
import com.dashboardz.device.alarm.AlarmPlayer
import com.dashboardz.device.container
import com.dashboardz.device.core.activityTickAllowed
import com.dashboardz.device.core.activityVoice
import com.dashboardz.device.core.decideChimes
import com.dashboardz.device.core.screenChimesInfo
import com.dashboardz.device.core.displayModel
import com.dashboardz.device.core.needsSetupWalkthrough
import com.dashboardz.device.core.normalizeHubUrl
import com.dashboardz.device.core.playCollapsedChime
import com.dashboardz.device.core.Severity
import com.dashboardz.device.core.BoardError
import com.dashboardz.device.core.diagnose
import com.dashboardz.device.core.TwoFingerSwipeDown
import com.dashboardz.device.core.visibleScreen
import com.dashboardz.device.core.wantedSounds
import com.dashboardz.device.net.parsePairPayload
import com.dashboardz.device.protocol.WireAlert
import com.dashboardz.device.service.Link
import com.dashboardz.device.service.DeviceService
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.dashboardz.device.store.DisplayMode
import com.dashboardz.device.store.NavBars
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * portrait → SENSOR_PORTRAIT; landscape and anything unknown → SENSOR_LANDSCAPE (degrade, never
 * crash).
 *
 * The SENSOR_ variants, not the plain ones. `SCREEN_ORIENTATION_LANDSCAPE` pins ONE landscape
 * direction, so a panel mounted the other way round — or a phone simply turned end-for-end —
 * showed the board upside down with no way to correct it. The SENSOR_ variants still forbid the
 * axis the operator did not choose (a landscape board never becomes portrait) while letting the
 * device settle into whichever of the two 180°-opposed rotations it is physically in.
 *
 * Fixed orientation prevents a board from reflowing between portrait and landscape without dictating
 * which physical end is up.
 */
// How long the bars stay up after a tap in ON_TAP mode: long enough to reach one, short enough
// that a wall panel returns to being a board on its own.
private const val BARS_VISIBLE_MS = 4_000L

/**
 * The wire's nav-bar mode, or RESPECTED for anything this build does not recognise — an unassigned
 * device, a hub that predates the field, or a NEWER hub naming a mode this app has never heard of.
 * Degrading to "show the bars" is the only safe direction: it can never strand an operator on a
 * panel with no way out of the app.
 */
internal fun navBarsOf(wire: String?): NavBars = when (wire) {
    "hidden" -> NavBars.HIDDEN
    "on_tap" -> NavBars.ON_TAP
    else -> NavBars.RESPECTED
}

internal fun orientationFlag(orientation: String): Int =
    if (orientation == "portrait") ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
    else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

class MainActivity : ComponentActivity() {

    private lateinit var waker: ScreenWaker
    private lateinit var alarm: AlarmPlayer

    /**
     * Which surface is showing — hoisted out of composition (it was `remember`ed inside
     * setContent) because dispatchTouchEvent now needs to write it: the two-finger swipe-down
     * is the ONLY route into settings since the Compose board's status strip — the old entry
     * point — went with the board. Snapshot state, so composition reacts exactly as before.
     */
    private var surface by mutableStateOf(Surface.PAIRING)

    /** See [TwoFingerSwipeDown] for why two fingers. Threshold set in onCreate (needs density). */
    private var settingsSwipe = TwoFingerSwipeDown(Float.MAX_VALUE)

    /**
     * The board's live fatal failure, if any. Hoisted beside [surface] for the same reason it is:
     * written from a WebView callback outside composition, read by the `when` below.
     */
    private var boardError by mutableStateOf<BoardError?>(null)

    /** Retry button clicks, as a monotonic trigger the BoardWebView effect keys on. */
    private var boardRetry by mutableStateOf(0)

    /**
     * Whether the owner silenced the offline beep for the current failure. Cleared when the board
     * recovers, so the next real outage is audible again.
     */
    private var failureMuted by mutableStateOf(false)

    /**
     * Live results of the OS grant checks the settings screen shows. Re-read in onResume — the
     * grant flows bounce through system screens and come back, and the row must show the new
     * truth without needing to close and reopen settings.
     */
    private var grants by mutableStateOf(GrantStatus(batteryExempt = true, overlay = true))

    /**
     * The takeover currently on screen: a swapped-in critical restarts the alarm decision, and
     * any hardware key routes to silencing this id — even for a sound:false critical, since the
     * two-stage dismiss protection (documented contract) applies to every takeover, not just alarming ones.
     */
    private var alarmingFor: String? = null

    /**
     * Ids already chimed for (documented contract): a non-critical `sound:true` alert chimes once
     * when it first appears, never again for the same id — see [decideChimes] for exactly-once
     * reasoning. A plain instance field for the same reason as [alarmingFor]: MainActivity is not
     * recreated on rotation (see the manifest's `android:configChanges` on this activity), so
     * `remember`ed Compose state is unnecessary and this survives exactly the events it needs to.
     */
    private var chimedAlertIds: Set<String> = emptySet()

    /**
     * When the last stream-activity tick actually PLAYED (stream-activity contract's drop-not-defer cooldown). A plain
     * instance field, like [chimedAlertIds] — device-local, in-memory and deliberately unpersisted:
     * a process restart may tick once early, which the design accepts.
     *
     * `@Volatile` because, unlike [chimedAlertIds], this one is touched from the WebSocket reader
     * thread (see the activitySink wiring in onCreate), and that thread is not the same one across
     * a reconnect. Without it a stale read could let one extra tick through — harmless, but the
     * fix costs nothing.
     */
    @Volatile
    private var lastActivityTickAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        waker = ScreenWaker(this)
        alarm = AlarmPlayer(this, container.settings)

        // PLAY_SOUND audition (alert-sound contract): the hub's "preview this family" push. Wired here rather than
        // reduced into DeviceState — see DeviceController.playSoundSink for why a one-shot cue is
        // not state. Invoked from the socket thread, so it reads the controller's live state the
        // same way dispatchTouchEvent does (there is no composition around it) and hands off to
        // AlarmPlayer, which hops to the main thread itself.
        //
        // A family with no cached file — which is any family this device's screens do not
        // currently use, since SoundStore.fileFor never downloads — auditions as the programmatic
        // beep rather than as silence.
        //
        // runCatching around the whole body: this runs on the WebSocket reader thread, where an
        // escaping exception fails the socket and costs a reconnect. An audition is the least
        // important thing this app does; it must not be able to drop the link that carries the
        // alerts.
        container.controller.playSoundSink = { family, event ->
            runCatching {
                val rev = visibleScreen(container.controller.state.value.device)?.sounds_rev
                alarm.playOnce(
                    family,
                    event,
                    if (family == "classic" || rev == null) null
                    else container.soundStore.fileFor(family, event, rev),
                )
            }
        }

        // Stream-activity ticks (stream-activity contract): a soft sound when a watched stream gets new entries. Wired
        // here for the same reasons as playSoundSink above — a one-shot cue, not state — and
        // invoked from the socket thread on every live (non-snapshot) DATA push, so it reads the
        // controller's live state directly rather than through composition.
        //
        // runCatching around the whole body, again like playSoundSink: an escaping exception on
        // the WebSocket reader thread fails the socket and costs a reconnect. A tick is the least
        // important sound this app makes; it must never be able to drop the link that carries the
        // alerts. (DeviceController wraps the invoke too — this cue sits in front of the DATA
        // fold.)
        container.controller.activitySink = { feedIds ->
            runCatching {
                // Cheapest gate first. This runs on the WebSocket reader thread for EVERY live
                // push — a chatty stream's whole point — and the cooldown discards most of them,
                // so it is checked before sorting the alert list (displayModel) or scanning every
                // screen's cells (activityVoice). Semantically identical to testing it last: none
                // of the three gates has a side effect, and the stamp below still only happens on
                // the branch that actually plays.
                val now = System.currentTimeMillis()
                if (!activityTickAllowed(now, lastActivityTickAt)) return@runCatching
                val device = container.controller.state.value.device
                // The same takeover read the chime effect uses, and the same suppression rule:
                // nothing soft plays over a critical that is actually sounding. Capacity 0 is
                // safe — it only splits cards from chips, and `takeover` is capacity-independent.
                val suppressed = displayModel(device, 0).takeover?.sound == true
                val family = activityVoice(device.screens, device.activeScreenId, feedIds)
                if (family != null && !suppressed) {
                    // Stamped ONLY on the branch that actually plays (see activityTickAllowed's
                    // KDoc): a push nothing carries, or one suppressed by an alarm, must not arm
                    // the cooldown against the NEXT genuinely qualifying push.
                    lastActivityTickAt = now
                    // v1 playback rule. AlarmPlayer's loaded samples are keyed to the VISIBLE
                    // screen (setSounds), but stream-activity contract's voice may come from a non-visible carrying
                    // tab — so the file is only the right sound when the chosen family IS the
                    // visible screen's own activity family. Anything else (a different family, or
                    // that family's file not cached/loaded) takes the programmatic soft beep
                    // inside AlarmPlayer: a carrier voice we do not hold degrades to a tick,
                    // never to silence. `?: "classic"` mirrors activityVoice's sparse-map default
                    // so an omitted key compares as the classic voice on both sides.
                    val visibleFamily = visibleScreen(device)?.sounds?.get("activity") ?: "classic"
                    // AlarmPlayer hops to the main looper itself (like playOnce) — this is the
                    // socket thread.
                    alarm.activityTick(sampled = family == visibleFamily)
                }
            }
        }

        // Show over the lock screen and turn the display on when this activity comes forward.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
            )
        }

        if (container.settings.isPaired) DeviceService.start(this)

        grants = grantStatus()
        surface = when {
            !container.settings.isPaired -> Surface.PAIRING
            // A paired device whose checklist was never dismissed (killed mid-setup, or updated
            // from a build that predates it) resumes at the checklist, not around it.
            needsSetupWalkthrough(container.settings.setupDone, grants.batteryExempt, grants.overlay) -> Surface.SETUP
            else -> Surface.SCREEN
        }
        // ~1 cm of travel before settings opens: deliberate enough that resting two fingers on a
        // wall panel doesn't trigger it, short enough to discover by trying.
        settingsSwipe = TwoFingerSwipeDown(thresholdPx = 96 * resources.displayMetrics.density)

        // Fixed orientation (fixed-orientation rule): lock from whatever was persisted last before the first frame
        // even renders, so a cold-started device never shows a rotatable frame while the socket
        // is still connecting. The LaunchedEffect below re-applies this once STATE arrives, in
        // case the hub's configured orientation differs from what was last persisted.
        requestedOrientation = orientationFlag(container.settings.orientation)

        setContent {
            val state by container.controller.state.collectAsStateWithLifecycle()

            // Fixed orientation (fixed-orientation rule): the enrollment-configured value arrives in STATE; lock to
            // it and persist so the next cold start locks before the socket even connects.
            //
            // Guarded on state.link == Link.ONLINE: DeviceState.orientation
            // defaults to "landscape" (core/Reducer.kt) before any STATE has actually been
            // applied, and Link only reaches ONLINE once the controller applies a real STATE
            // message — so without this guard, a device that persisted "portrait" from a prior
            // session would have this effect fire at first composition against the *default*
            // value and overwrite the persisted "portrait" with "landscape": a visible flip, and
            // — if the process died before the real STATE arrived — a corrupted Settings value
            // that would mis-lock the *next* cold start too. Gating on ONLINE means this effect
            // only ever writes a value that came from the hub, never the reducer's placeholder.
            LaunchedEffect(state.link, state.device.orientation) {
                if (state.link == Link.ONLINE) {
                    container.settings.orientation = state.device.orientation
                    requestedOrientation = orientationFlag(state.device.orientation)
                }
            }

            // POST_NOTIFICATIONS is a runtime-requested permission from API 33 onward — merely
            // declaring it in the manifest does not grant it. Without it, every notification this
            // app posts is silently dropped by the OS, including the foreground-service
            // notification and (critically) DeviceService's full-screen-intent notification that
            // wakes the screen for an unattended critical. Request it once, up front, so it is
            // already granted by the time a real critical arrives; a denial is reported by
            // DeviceService (via canUseFullScreenIntent()) rather than assumed away.
            val notificationPermissionLauncher = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission(),
            ) { }
            LaunchedEffect(Unit) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }

            // Time-derived board text is rendered by the WebView, whose page loop owns its tick;
            // native takeover draws none. A 1 Hz recomposition of the whole activity would waste
            // work on a panel that stays up for weeks.
            val isLandscape = LocalConfiguration.current.screenWidthDp >
                LocalConfiguration.current.screenHeightDp
            val model = displayModel(
                state.device,
                cardCapacity(isLandscape, LocalConfiguration.current.screenHeightDp),
            )
            val takeover = model.takeover

            LaunchedEffect(takeover?.id, state.link) {
                applyTakeoverEffects(takeover)
                // Correction 2: AlarmPlayer shares a single ToneGenerator field across
                // playBeep/chime/offlineBeep, and offlineBeep's delayed releaseTone() frees
                // whatever tone is current — so firing it while a critical alarm with
                // sound:true is sounding would truncate the alarm's own beep. Suppress it
                // whenever that is the case.
                // failureMuted is the failure card's Mute button. The beep repeats every 8 to 18
                // seconds and, while the board was down, had no reachable off switch at all.
                if (state.link != Link.ONLINE && takeover?.sound != true && !failureMuted) {
                    alarm.offlineBeep()
                }
            }

            // Documented contract: "`warn` chimes (if `sound`) without takeover; `info` is
            // silent unless `sound:true`" was implemented in AlarmPlayer.chime() but never wired
            // up anywhere. Keyed on `state` (not `state.device.alerts`) so this also re-evaluates
            // on every tap/reconnect, including a silence/dismiss that ends a critical alarm —
            // which is what lets a chime deferred by `suppressed` (see decideChimes) get picked
            // up again afterward, without ever touching AlarmPlayer's shared ToneGenerator while
            // the alarm is actually sounding.
            //
            // playCollapsedChime (not `decision.toChime.forEach { alarm.chime() }`): a batch of
            // ids newly eligible to chime in one evaluation — e.g. a reconnect resync's STATE
            // carrying several newly-visible sound:true alerts at once — must play exactly one
            // tone, not one per id. AlarmPlayer shares a single ToneGenerator field across its
            // alarm beat, chime and offline beep, so one call per id would have each call's
            // releaseTone() truncate the previous call's tone microseconds in; only the last
            // would be audible even though every id is still recorded in chimedAlertIds below,
            // silently losing the cue for the rest. See ChimeDecision.toChime's doc.
            LaunchedEffect(state) {
                val decision = decideChimes(
                    alerts = state.device.alerts,
                    alreadyChimed = chimedAlertIds,
                    suppressed = takeover?.sound == true,
                    soundInfo = screenChimesInfo(visibleScreen(state.device)),
                )
                chimedAlertIds = decision.nextChimed
                // Which voice the single collapsed chime speaks in (alert-sound contract): info gets its own sound
                // when a screen opts into hearing routine traffic, but a batch that contains ANY
                // warn is a warn — the louder meaning wins, and the batch is still exactly one
                // chime either way (see playCollapsedChime). An id whose alert has since vanished
                // from the list simply doesn't vote. Severity.from, not a raw string compare, so
                // an unrecognised severity lands on info exactly as decideChimes reads it.
                val hasWarn = decision.toChime.any { id ->
                    state.device.alerts.firstOrNull { it.id == id }
                        ?.let { Severity.from(it.severity) == Severity.WARN } == true
                }
                playCollapsedChime(decision.toChime) { alarm.chime(if (hasWarn) "warn" else "info") }
            }

            /**
             * Alert-sound families (alert-sound contract). Keyed on the VISIBLE screen's sounds/rev — a tab switch
             * re-points the alarm at that tab's voices — plus the whole screens list, because the
             * download set spans every tab (a background tab's critical must be ready the instant
             * someone switches to it, not fetched at 3am over a hub that may be gone).
             *
             * Both halves degrade to the programmatic voice rather than to silence: `sync` is
             * best-effort and swallows its own failures, and `setSounds` only ever receives events
             * whose files are genuinely on disk right now. An unpaired device (no hub URL), a hub
             * that predates alert sounds (no `sounds_rev`), or a STATE not yet applied (no
             * screens) all land on an empty map, which is exactly today's behaviour.
             *
             * `state.link` is a key so that a RECONNECT re-syncs. Without it a device that was
             * offline (or hit a 404, or lost a `renameTo`) during its first sync would keep the
             * classic beeps for the life of the process: a reconnect re-delivers a structurally
             * identical STATE, so every other key here compares equal and the effect never runs
             * again. This is the one thing standing between a transient network failure at boot
             * and a panel that quietly never gets its alarm sound back.
             *
             * The download is then gated on ONLINE, not merely keyed on the link. During an
             * outage the controller cycles OFFLINE → CONNECTING → OFFLINE on a backoff that
             * starts at a second or two, and `sync` is blocking, `@Synchronized`, and gives every
             * still-missing file its own 15 s call timeout — it also does not observe the
             * coroutine cancellation that ends each relaunch. Ungated, a device that never
             * managed a clean sync (first boot, or the first launch after an upgrade — exactly
             * the case this retry exists for) would pile relaunches up behind that lock all
             * night. Gating means work happens only when there is a hub to talk to, while the
             * ONLINE transition still delivers the retry.
             */
            val visibleSounds = visibleScreen(state.device)?.sounds
            val soundsRev = visibleScreen(state.device)?.sounds_rev
            LaunchedEffect(visibleSounds, soundsRev, state.device.screens, state.link) {
                val files = withContext(Dispatchers.IO) {
                    if (soundsRev == null) return@withContext emptyMap<String, File>()
                    // Blocking downloads, hence Dispatchers.IO. Skipped when there is no hub URL
                    // or no live link, but the fileFor pass below still runs either way: a
                    // previous sync's cache stays playable while the hub is unreachable, which is
                    // the whole point of caching it.
                    val hub = container.settings.hubUrl
                    if (hub != null && state.link == Link.ONLINE) {
                        container.soundStore.sync(hub, wantedSounds(state.device.screens), soundsRev)
                    }
                    visibleSounds.orEmpty().mapNotNull { (event, family) ->
                        // `classic` is the programmatic voice — it has no file to look for.
                        if (family == "classic") null
                        else container.soundStore.fileFor(family, event, soundsRev)?.let { event to it }
                    }.toMap()
                }
                alarm.setSounds(files)
            }

            /**
             * The HUB decides what the system bars do (schema v17), against the device rather than
             * the screen: the same board is correct on a wall panel with no bars and on a handheld
             * that still needs its back gesture.
             */
            val navBars = navBarsOf(state.device.navBars)
            // Pairing and settings ALWAYS show the bars: an operator who cannot reach the back
            // gesture on a hidden-bars panel has no way out of the app. Keyed on navBars too, so a
            // STATE that changes the mode takes effect without leaving the screen.
            LaunchedEffect(surface, navBars) {
                applyNavBars(navBars, showAlways = surface != Surface.SCREEN)
            }
            var pairError by remember { mutableStateOf<String?>(null) }
            var pairBusy by remember { mutableStateOf(false) }
            var scannedHub by remember { mutableStateOf(container.settings.hubUrl) }
            var scannedCode by remember { mutableStateOf("") }
            val scope = rememberCoroutineScope()

            val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
                val contents = result.contents
                if (contents == null) {
                    // The user backed out of the scanner — not an error to blame them for.
                    return@rememberLauncherForActivityResult
                }
                val payload = parsePairPayload(contents)
                if (payload == null) {
                    pairError = getString(R.string.pair_scan_failed)
                } else {
                    payload.hubUrl?.let { scannedHub = it }
                    scannedCode = payload.code
                    pairError = null
                }
            }

            fun doPair(hubUrlInput: String, code: String) {
                pairBusy = true
                pairError = null
                scope.launch {
                    val hub = normalizeHubUrl(hubUrlInput)
                    // Network on IO, never on the main thread.
                    val result = withContext(Dispatchers.IO) { container.pairApi.pair(hub, code) }
                    pairBusy = false
                    result.fold(
                        onSuccess = { paired ->
                            container.settings.hubUrl = hub
                            container.settings.deviceToken = paired.deviceToken
                            container.settings.deviceId = paired.deviceId
                            DeviceService.start(this@MainActivity)
                            // Request at device setup, don't make the user dig:
                            // a fresh pair lands on the setup checklist while any grant is
                            // missing — explained rows instead of unexplained system dialogs.
                            // Both already held (a re-pair, usually) skips straight to the board.
                            grants = grantStatus()
                            surface = if (needsSetupWalkthrough(
                                    container.settings.setupDone, grants.batteryExempt, grants.overlay,
                                )
                            ) Surface.SETUP else Surface.SCREEN
                        },
                        onFailure = { pairError = it.message ?: getString(R.string.pair_failed) },
                    )
                }
            }

            // A token the hub rejected sends us straight back to pairing.
            LaunchedEffect(state.link) {
                if (state.link == Link.NEEDS_PAIRING) surface = Surface.PAIRING
            }

            when {
                surface == Surface.SETUP -> SetupScreen(
                    grants = grants,
                    onRequestBatteryExemption = ::requestBatteryExemption,
                    onOpenOverlaySettings = ::openOverlaySettings,
                    onDone = {
                        container.settings.setupDone = true
                        surface = Surface.SCREEN
                    },
                )

                surface == Surface.PAIRING -> PairingScreen(
                    initialHubUrl = scannedHub,
                    initialCode = scannedCode,
                    error = pairError,
                    busy = pairBusy,
                    onScan = { scanLauncher.launch(ScanOptions().setOrientationLocked(false)) },
                    onPair = ::doPair,
                )

                surface == Surface.SETTINGS -> SettingsScreen(
                    settings = container.settings,
                    deviceName = state.device.deviceName,
                    grants = grants,
                    // Same guard as onResume: never touch brightness/keep-on while a takeover
                    // holds them — its own clear path re-applies the idle state afterwards.
                    onDisplayChanged = { if (alarmingFor == null) applyIdleDisplayMode() },
                    onClose = { surface = Surface.SCREEN },
                    onRePair = {
                        DeviceService.stop(this@MainActivity)
                        container.controller.stop()
                        container.settings.clearPairing()
                        scannedCode = ""
                        surface = Surface.PAIRING
                    },
                    onSaveHubUrl = { input ->
                        // The hub MOVED (new IP, new DNS name) — same hub, same token, so no
                        // re-pair. Persist, then reconnect the native socket to the new address;
                        // the board branch below keys its WebView on hubUrl, so leaving settings
                        // loads the page from the new origin too.
                        val hub = normalizeHubUrl(input)
                        container.settings.hubUrl = hub
                        val tok = container.settings.deviceToken
                        if (tok != null) container.controller.start(hub, tok)
                    },
                    onRequestBatteryExemption = ::requestBatteryExemption,
                    onOpenOverlaySettings = ::openOverlaySettings,
                    onOpenOemBattery = ::openOemBatterySettings,
                )

                takeover != null -> {
                    // The hub's "displayed" ACK must only fire once the takeover is genuinely on
                    // screen — not merely computed, since pairing/settings can be showing instead
                    // while the alarm still sounds (see applyTakeoverEffects). Scoping this
                    // LaunchedEffect to this branch means it can only run when TakeoverScreen is
                    // actually composed, so the audit trail never claims a human saw an alert that
                    // was, in fact, silently escalating behind a settings screen.
                    LaunchedEffect(takeover.id) {
                        container.controller.onTakeoverDisplayed(takeover.id)
                    }

                    // documented contract asks for a deliberate 1 s hold; Compose's default is ~500 ms.
                    // remember() is load-bearing, not cosmetic. Without it a *new* anonymous
                    // ComposeViewConfiguration instance is built on every recomposition, and
                    // CompositionLocalProvider treats that as the ambient value changing, which
                    // invalidates everything downstream that reads LocalViewConfiguration
                    // mid-gesture — including combinedClickable's own long-press timer inside
                    // HoldToDismissButton. On-device that reset a hold roughly once a second, so
                    // it could never cross the 1 s threshold however long it was actually held.
                    // The per-second tick that triggered it retired with the Compose board,
                    // but this stays: any recomposition during a hold does the same damage, and
                    // `state` changes can still arrive mid-gesture.
                    val base = LocalViewConfiguration.current
                    val holdViewConfiguration = remember(base) {
                        object : ComposeViewConfiguration by base {
                            override val longPressTimeoutMillis: Long get() = 1_000
                        }
                    }
                    CompositionLocalProvider(LocalViewConfiguration provides holdViewConfiguration) {
                        TakeoverScreen(
                            alert = takeover,
                            extraCriticalCount = model.extraCriticalCount,
                            onSilence = { container.controller.tap(takeover.id, "silence") },
                            onAnswer = { optionId -> container.controller.answer(takeover.id, optionId) },
                            onDismiss = { container.controller.tap(takeover.id, "dismiss") },
                        )
                    }
                }

                // The board is the web renderer in a WebView, and now the only one. Note
                // where this sits in the `when` — BELOW the takeover branch, so a critical still
                // covers it with the native screen (native takeover boundary). Pairing and settings stay Compose; the
                // WebView only ever renders the board.
                else -> {
                    val hubUrl = container.settings.hubUrl
                    if (hubUrl != null) {
                        // key(hubUrl): AndroidView's factory runs once per composition identity,
                        // and the factory is where loadUrl happens — without the key, editing the
                        // hub address in settings would reconnect the socket but leave the
                        // WebView on the old origin's page forever.
                        androidx.compose.runtime.key(hubUrl) {
                            BoardWebView(
                                hubUrl = hubUrl,
                                controller = container.controller,
                                deviceToken = { container.settings.deviceToken },
                                onBoardError = { err ->
                                    boardError = err
                                    // A recovered board clears the mute, so the next real outage
                                    // is audible again.
                                    if (err == null) failureMuted = false
                                },
                                retryTrigger = boardRetry,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                        // Drawn OVER the WebView, but still inside the branch that sits BELOW the
                        // takeover: a critical alert covers this card exactly as it covers the
                        // board. The 3am wake path must never be shadowed by a diagnostic.
                        val err = boardError
                        if (err != null) {
                            FailureScreen(
                                diagnosis = diagnose(
                                    hubUrl = hubUrl,
                                    error = err,
                                    link = state.link.name,
                                    panelIp = localIpAddress(),
                                ),
                                muted = failureMuted,
                                onRetry = { boardRetry++ },
                                onSettings = {
                                    grants = grantStatus()
                                    surface = Surface.SETTINGS
                                },
                                onMute = { failureMuted = true },
                            )
                        }
                    } else {
                        // Unreachable in practice: hub URL and device token are written and
                        // cleared together, and an unpaired device is already forced onto the
                        // pairing surface by the NEEDS_PAIRING effect above. Recovering by
                        // re-pairing is still better than the blank screen that a missing board
                        // would otherwise be, now that there is no native board to fall back to.
                        LaunchedEffect(Unit) { surface = Surface.PAIRING }
                    }
                }
            }
        }
    }

    /**
     * ON_TAP: any touch reveals the system bars briefly.
     *
     * dispatchTouchEvent rather than a Compose modifier, because the board may be a WebView — it
     * consumes touches before Compose sees them, so a pointerInput on the composable would only
     * ever fire on the Compose renderer. Returning super() unchanged means the tap still reaches
     * whatever it was going to hit; this only observes.
     */
    override fun dispatchTouchEvent(ev: android.view.MotionEvent?): Boolean {
        if (ev?.action == android.view.MotionEvent.ACTION_DOWN &&
            navBarsOf(container.controller.state.value.device.navBars) == NavBars.ON_TAP
        ) {
            revealBarsBriefly()
        }
        // The settings gesture (see TwoFingerSwipeDown for the design). Observed here, like
        // ON_TAP above, because the board is a WebView that consumes touches before Compose sees
        // them. Only from the board surface: pairing and settings have their own buttons, and
        // firing while they show would make the gesture feel haunted. Allowed over a takeover —
        // the alarm keeps sounding (applyTakeoverEffects is surface-independent), and settings is
        // exactly where someone fixing a wrong hub address mid-alert-storm needs to get.
        if (ev != null && surface == Surface.SCREEN) {
            val ended = ev.actionMasked == MotionEvent.ACTION_UP ||
                ev.actionMasked == MotionEvent.ACTION_CANCEL
            var sumY = 0f
            for (i in 0 until ev.pointerCount) sumY += ev.getY(i)
            if (settingsSwipe.onEvent(ev.pointerCount, ended, sumY / ev.pointerCount)) {
                grants = grantStatus()
                surface = Surface.SETTINGS
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun grantStatus() = GrantStatus(
        batteryExempt = getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(packageName),
        overlay = android.provider.Settings.canDrawOverlays(this),
    )

    private fun openOverlaySettings() {
        startActivity(
            Intent(
                android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.fromParts("package", packageName, null),
            ),
        )
    }

    private fun requestBatteryExemption() {
        // The direct request dialog (declared in the manifest). Play would frown at this;
        // sideloaded wall panels are exactly its intended audience.
        runCatching {
            startActivity(
                Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                ),
            )
        }
    }

    /**
     * Best-effort deep link into the OEM's own battery manager — the layer ABOVE the standard
     * exemption, where Samsung's "put unused apps to sleep" lives (dontkillmyapp.com catalogues
     * these). Tries known screens, falls back to this app's details page, which every Android
     * has and from which the battery menu is one tap.
     */
    private fun openOemBatterySettings() {
        val candidates = listOf(
            Intent().setClassName("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
            Intent().setClassName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
            Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null),
            ),
        )
        for (intent in candidates) {
            if (runCatching { startActivity(intent) }.isSuccess) return
        }
    }

    /** Any hardware key silences an alarming takeover (documented contract), then is swallowed. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        val alarming = alarmingFor
        if (alarming != null) {
            container.controller.tap(alarming, "silence")
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /**
     * Correction 1: a critical with sound:false must still take over the screen — wake, max
     * brightness, keep-on — but silently. Only start the alarm when the takeover alert itself
     * asks for sound; the "one alarm per takeover id" guard below still applies so a re-render of
     * the same takeover never restarts it.
     *
     * This runs unconditionally whenever a takeover exists, regardless of which surface (screen,
     * pairing, settings) is actually composed: wake/brightness/alarm must never be silently
     * skipped just because someone is mid-keystroke re-pairing the device. The "displayed" ACK is
     * deliberately *not* sent from here — see the `LaunchedEffect` in the `takeover != null ->`
     * branch of the `when` in `setContent`, which only runs once `TakeoverScreen` is genuinely on
     * screen.
     */
    private fun applyTakeoverEffects(takeover: WireAlert?) {
        if (takeover != null) {
            waker.wake()
            setBrightness(1f)
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (alarmingFor != takeover.id) {
                alarmingFor = takeover.id
                alarm.stop()
                if (takeover.sound) alarm.startAlarm()
            }
        } else {
            alarmingFor = null
            alarm.stop()
            waker.release()
            applyIdleDisplayMode()
        }
    }

    /**
     * Idle NEVER overrides brightness — the system slider owns it.
     * ALWAYS_ON previously pinned 0.08f, which made Android report "brightness is controlled by
     * the application" and left the operator unable to change it; that was tolerable when the
     * idle view was a clock, but a data dashboard has to be readable. Display mode now controls
     * one thing only: whether the screen is allowed to sleep. Burn-in/power management is the
     * operator's call via the normal system controls.
     *
     * Critical takeovers still force full brightness in applyTakeoverEffects (waking someone is
     * the product's core promise); when the takeover clears, this restores system control.
     */
    private fun applyIdleDisplayMode() {
        // keepFullBrightness pins the window at max while the board idles — the operator's
        // explicit override of "the system slider owns idle brightness" default (see
        // Settings.keepFullBrightness). OFF keeps the historical behaviour exactly.
        setBrightness(
            if (container.settings.keepFullBrightness) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
            else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
        )
        when (container.settings.displayMode) {
            DisplayMode.ALWAYS_ON -> window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            DisplayMode.SCREEN_OFF -> window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    /**
     * System bars while the BOARD is showing.
     *
     * `showAlways` is passed for pairing and settings: an operator who cannot reach the back
     * gesture on a hidden-bars panel has no way out of the app, so those two surfaces always
     * show them regardless of the setting.
     *
     * Hiding changes the size of the box the board draws into — and the screen EDITOR now designs
     * against exactly that box. The WebView reports its own viewport on resize, so the hub
     * learns the new shape without anything extra here; a Compose board still reports the display
     * metrics it had at HELLO, which is the gap to close when the swap lands.
     */
    private fun applyNavBars(mode: NavBars, showAlways: Boolean) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        val bars = WindowInsetsCompat.Type.systemBars()
        if (showAlways || mode == NavBars.RESPECTED) {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            controller.show(bars)
            return
        }
        // Content extends under the bars so the board gets the whole panel without letterboxed
        // gaps.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // A swipe always brings them back transiently even in HIDDEN — refusing that would make a
        // mis-set panel unrecoverable without adb.
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(bars)
    }

    /** ON_TAP: reveal the bars, then let them retreat on their own. */
    private fun revealBarsBriefly() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.show(WindowInsetsCompat.Type.systemBars())
        window.decorView.postDelayed(
            {
                val mode = navBarsOf(container.controller.state.value.device.navBars)
                if (mode != NavBars.RESPECTED) applyNavBars(mode, false)
            },
            BARS_VISIBLE_MS,
        )
    }

    private fun setBrightness(value: Float) {
        window.attributes = window.attributes.apply { screenBrightness = value }
    }

    override fun onResume() {
        super.onResume()
        if (alarmingFor == null) applyIdleDisplayMode()
        // Re-applied on resume: another app, or the system itself, can leave the bars showing.
        applyNavBars(navBarsOf(container.controller.state.value.device.navBars), showAlways = false)
        // The grant flows bounce through system screens; coming back is when their answer exists.
        grants = grantStatus()
    }

    override fun onDestroy() {
        container.controller.playSoundSink = null
        container.controller.activitySink = null
        // release(), not just stop(): stop() runs on every takeover clear and deliberately keeps
        // the SoundPools (and their loaded samples) alive so the next critical sounds instantly.
        // This is the one place they are genuinely finished with.
        alarm.release()
        waker.release()
        super.onDestroy()
    }
}
