package com.dashboardz.device.alarm

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import com.dashboardz.device.core.AlarmEscalation
import com.dashboardz.device.store.Settings
import java.io.File

/**
 * Alarm-grade audio for critical takeovers.
 *
 * STREAM_ALARM is the whole point: it is the one stream that plays through Do Not Disturb,
 * which is exactly the situation this product exists for (a phone on a nightstand at 3am).
 *
 * Two voices live here, and the second one degrades into the first:
 *  - **Programmatic** ([ToneGenerator]): always available, needs no files, no network and no
 *    disk. This is the `classic` family AND the universal fallback — every single file path
 *    below falls back to it rather than to silence.
 *  - **Sampled** ([SoundPool]): the downloaded family files handed over by [setSounds]. An
 *    event only ever plays from a sample once its `load()` has actually reported success;
 *    until then (and forever, if the load fails) that event stays programmatic.
 *
 * The `AudioAttributes` of a SoundPool are fixed **per pool**, not per play() call, so there are
 * two pools: the alarm-usage one (critical/warn/info and the PLAY_SOUND audition — everything
 * that must survive Do Not Disturb) and the notification-usage one (the offline beep, which is a
 * courtesy and must NOT punch through DND).
 */
class AlarmPlayer(
    private val context: Context,
    private val settings: Settings,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(AudioManager::class.java)

    private var tone: ToneGenerator? = null
    private var startedAt = 0L
    private var running = false
    private var previousAlarmVolume: Int? = null

    // A stored reference (rather than `::releaseTone` at each call site, which creates a new
    // function object every time) so a pending delayed release can actually be cancelled.
    // Without this, chime()/offlineBeep()'s postDelayed(::releaseTone, ...) leaves a callback in
    // flight that handler.removeCallbacks(::releaseTone) can never match — so an offline beep
    // that fires just before a critical alarm starts would still release the *alarm's* tone out
    // from under it 600-700ms later.
    private val releaseToneCallback = Runnable { releaseTone() }

    /**
     * Sampled playback state. Every field here is touched on the main thread only: [setSounds]
     * and [chime] run from Compose effects, [playBeep] from the main-looper beat, [playOnce]
     * hops onto [handler] before it touches anything (it is invoked from the WebSocket thread),
     * and SoundPool's load callbacks are delivered on the thread that built the pool — the main
     * thread, since this object is constructed in `MainActivity.onCreate`. So none of these maps
     * needs synchronization, and the shared [tone] field keeps its existing single-thread
     * discipline.
     */
    // 4 streams, not 2: mid-alarm the beat's previous tick can still be sounding while the next
    // one starts, and an audition can land on top of both. Two would have made that transient
    // over-subscription evict a beat — on the one path that must never lose a sound.
    private val alarmPool = runCatching {
        SoundPool.Builder().setMaxStreams(4).setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        ).build()
    }.getOrNull()

    private val notifPool = runCatching {
        SoundPool.Builder().setMaxStreams(1).setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        ).build()
    }.getOrNull()

    /** event → soundId, populated ONLY once the load listener reports success (status 0). */
    private val ready = mutableMapOf<String, Int>()

    // soundId → event, per pool: SoundPool ids are allocated per pool and DO collide across two
    // pools, so one shared map would let a notification load complete and claim an alarm event.
    private val alarmPending = mutableMapOf<Int, String>()
    private val notifPending = mutableMapOf<Int, String>()

    // Transient audition loads (PLAY_SOUND), played once then unloaded. Per pool, for the same
    // id-collision reason as the pending maps: an `offline` audition loads into notifPool.
    private val alarmAuditions = mutableSetOf<Int>()
    private val notifAuditions = mutableSetOf<Int>()

    /**
     * event → the file this player is currently holding loaded (or has a load in flight for).
     * [setSounds] diffs its argument against this **per event**, so an event whose file has not
     * changed is never unloaded and reloaded. That is what keeps a working `ready["critical"]`
     * playing straight through a reconnect, a tab switch, or a sibling event's retry: a reload
     * would leave the beat on the programmatic voice for as long as the load took, and the one
     * moment this is most likely to be re-evaluated is exactly when an alarm is sounding.
     *
     * An event whose load FAILS is removed from here by [onSampleLoaded] even though its file is
     * still in the map the caller passed. Otherwise a failed load would be permanent: the event
     * is gone from [ready], the next identical `setSounds` sees no difference, and the device
     * beeps programmatically until the process restarts. Removing it means the next call — which
     * a reconnect now guarantees, see MainActivity's sounds effect — diffs that ONE event as
     * missing and retries just it, leaving every other loaded sample untouched.
     *
     * Mutated in place rather than reassigned so that [setSounds] and a load callback can never
     * clobber each other's view of it, whatever order they run in.
     */
    private val loadedSpec = mutableMapOf<String, File>()

    /** The beat's current sampled stream, so silencing actually silences a long sample. */
    private var alarmStream = 0

    private val alarmLoadListener = SoundPool.OnLoadCompleteListener { _, sampleId, status ->
        onSampleLoaded(alarmPool, alarmPending, alarmAuditions, sampleId, status)
    }

    private val notifLoadListener = SoundPool.OnLoadCompleteListener { _, sampleId, status ->
        onSampleLoaded(notifPool, notifPending, notifAuditions, sampleId, status)
    }

    /** Shared by both pools — same rules, different pool, and the maps are already per pool. */
    private fun onSampleLoaded(
        pool: SoundPool?,
        pending: MutableMap<Int, String>,
        auditions: MutableSet<Int>,
        sampleId: Int,
        status: Int,
    ) {
        val event = pending.remove(sampleId)
        if (event != null) {
            if (status == 0) {
                ready[event] = sampleId
            } else {
                runCatching { pool?.unload(sampleId) }
                // Make the failure retryable rather than permanent — see loadedSpec's KDoc.
                // Only THIS event; every other loaded sample stays exactly where it is.
                loadedSpec.remove(event)
            }
            return
        }
        if (auditions.remove(sampleId)) {
            if (status == 0) {
                runCatching { pool?.play(sampleId, AUDITION_VOLUME, AUDITION_VOLUME, 1, 0, 1f) }
                // NOT unloaded inline: unload() frees the sample out from under any stream still
                // playing it, which would clip the audition to nothing. Give it a few seconds —
                // family sounds are ~1 s — then reclaim.
                handler.postDelayed({ runCatching { pool?.unload(sampleId) } }, AUDITION_UNLOAD_MS)
            } else {
                runCatching { pool?.unload(sampleId) }
                // Degrade, never silence: a corrupt or unreadable file still gets a beep.
                auditionBeep()
            }
        }
    }

    init {
        runCatching { alarmPool?.setOnLoadCompleteListener(alarmLoadListener) }
        runCatching { notifPool?.setOnLoadCompleteListener(notifLoadListener) }

        // A force-stop (or any other process death) mid-alarm skips stop()/restoreAlarmStream()
        // entirely, so a maxed alarm-stream volume can otherwise persist forever with no
        // recovery path. raiseAlarmStream() durably saves the previous value the moment it
        // raises the stream (see below); repair it here, once, at the next construction — i.e.
        // the next time this app is opened — and only clear the saved value once the repair
        // actually lands, so a failed attempt is retried on a later launch instead of forgotten.
        settings.savedAlarmVolume?.let { saved ->
            runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, saved, 0) }
                .onSuccess { settings.savedAlarmVolume = null }
        }
    }

    private val beat = object : Runnable {
        override fun run() {
            if (!running) return
            val elapsed = System.currentTimeMillis() - startedAt
            playBeep(AlarmEscalation.volumeAt(elapsed))
            handler.postDelayed(this, AlarmEscalation.intervalMsAt(elapsed))
        }
    }

    /**
     * The sound files for the screen that is actually on display, keyed by event
     * (`critical`/`warn`/`info`/`offline`). An event missing from [files] — because the screen
     * asked for `classic`, because nothing is cached yet, or because the hub is unreachable —
     * simply stays programmatic. So does an event whose file fails to load.
     *
     * Safe to call as often as the visible screen's sounds change: this is a **diff**, not a
     * reload. Only events whose file actually changed (or that are missing from [loadedSpec]
     * because their last load failed) are touched; every other loaded sample keeps playing. An
     * argument that matches what is already loaded does nothing at all.
     *
     * That granularity is the point. One persistently-broken event — a corrupt `warn` file, say —
     * must not cost the alarm its `critical` sample on every reconnect, and the reconnect is
     * precisely when this gets re-evaluated with an alarm possibly sounding.
     */
    fun setSounds(files: Map<String, File>) {
        // Removed, or pointing at a different file than the one we hold.
        val stale = loadedSpec.keys.filter { files[it] != loadedSpec[it] }.toList()
        // New, changed, or previously failed (removed from loadedSpec by the load listener).
        val fresh = files.filter { (event, file) -> loadedSpec[event] != file }.toList()
        if (stale.isEmpty() && fresh.isEmpty()) return

        for (event in stale) forget(event)

        for ((event, file) in fresh) {
            // A changed file also appears in `stale`, so its old sample is already gone; this
            // covers the retry case, where the event is absent from loadedSpec but may still
            // have a stale pending entry.
            if (event !in stale) forget(event)
            // Recorded BEFORE the load so that a load callback — however it is dispatched — is
            // always the last writer for this event, and a failure it reports cannot be undone
            // by this loop reinstating the entry afterwards.
            loadedSpec[event] = file
            val started = runCatching {
                if (!file.isFile) return@runCatching false
                val pool = poolFor(event) ?: return@runCatching false
                // load() returns 0 on immediate failure, and a non-zero id whose load is still
                // in flight otherwise — hence the pending map: nothing enters `ready` until the
                // listener confirms it.
                val id = pool.load(file.absolutePath, 1)
                if (id == 0) return@runCatching false
                pendingFor(event)[id] = event
                true
            }.getOrDefault(false)
            // Never even started (file vanished, no pool, load refused) — forget the intent so
            // the next call diffs this event as missing and tries again.
            if (!started) loadedSpec.remove(event)
        }
    }

    /**
     * Drop everything this player holds for one event: its loaded sample and any load still in
     * flight for it. The pending entry is removed rather than left to be ignored, so a completion
     * that lands afterwards cannot resurrect a sample nobody wants.
     */
    private fun forget(event: String) {
        val pool = poolFor(event)
        ready.remove(event)?.let { id -> runCatching { pool?.unload(id) } }
        val pending = pendingFor(event)
        for (id in pending.filterValues { it == event }.keys.toList()) {
            runCatching { pool?.unload(id) }
            pending.remove(id)
        }
        // The beat's current stream belongs to the sample just unloaded — stop it and forget the
        // id rather than leaving a dangling handle behind (SoundPool recycles stream ids).
        if (event == CRITICAL) stopAlarmStream()
        loadedSpec.remove(event)
    }

    fun startAlarm() {
        if (running) return
        running = true
        startedAt = System.currentTimeMillis()
        // Cancel any release still in flight from a chime()/offlineBeep() that fired moments
        // ago — otherwise it would land after the alarm's first tone is created and kill it.
        handler.removeCallbacks(releaseToneCallback)
        if (settings.forceAlarmVolume) raiseAlarmStream()
        handler.post(beat)
    }

    /**
     * warn-severity chime: audible, one shot, no takeover and no escalation (documented contract).
     *
     * [event] picks the voice — `warn` or `info`, since documented contract gives info its own sound when a
     * screen opts into hearing routine traffic. The default keeps every existing call site (and
     * its behaviour) exactly as it was.
     *
     * Resolution is strictly per event, with NO fallback to another event's sample: an event the
     * screen mapped to `classic` has no entry here, and borrowing (say) warn's bell for it would
     * override a choice the screen deliberately made. The programmatic chime below is the only
     * fallback, so nothing is ever silent. This matches the web board's `soundFor()`, which is
     * the other implementation.
     */
    fun chime(event: String = "warn") {
        // The sampled path deliberately does NOT touch `tone`: it has no shared state to protect,
        // so it cannot truncate an alarm beep the way the ToneGenerator path can (see
        // ChimeDecision's KDoc). Only the fallback runs the release dance.
        val sample = ready[event]
        if (sample != null &&
            runCatching { alarmPool?.play(sample, CHIME_VOLUME, CHIME_VOLUME, 1, 0, 1f) }
                .getOrNull().let { it != null && it != 0 }
        ) {
            return
        }

        releaseTone()
        runCatching {
            ToneGenerator(AudioManager.STREAM_ALARM, 70).also { generator ->
                tone = generator
                generator.startTone(ToneGenerator.TONE_PROP_BEEP, 250)
            }
        }
        handler.postDelayed(releaseToneCallback, 600)
    }

    /**
     * stream-activity contract stream-activity tick: a watched stream got new entries. Sound only — no card, no
     * takeover, no escalation — and deliberately the quietest, shortest thing this class plays.
     * It is ambient awareness, so it must read as a tick, never as an alert someone has to act on.
     *
     * The alarm pool, like every non-`offline` event (see [poolFor]): a wall panel's alarm stream
     * is where its sounds live, and giving activity its own usage would put it at the mercy of a
     * muted notification stream. Priority 0 rather than the 1 the beat/chime/audition use, though
     * — with four streams shared, an activity tick is the one sound here that SHOULD be evicted
     * when the pool is over-subscribed mid-alarm, not the beat.
     *
     * Volume/duration are fixed rather than escalating: nothing about this ever gets more urgent.
     *
     * Caller-side gating (a sounding alarm, the cooldown, whether anything is even opted in) lives
     * where the decision is — [com.dashboardz.device.core.activityVoice] and
     * [com.dashboardz.device.core.activityTickAllowed] via MainActivity. By the time this is
     * called, the tick has been decided; all that is left is which voice speaks it.
     *
     * [sampled] false forces the programmatic voice even when a file IS loaded. The one caller
     * that passes false is the family-mismatch case: [ready] holds the VISIBLE screen's `activity`
     * sample, but the tick may be voiced by a different (non-visible) carrying tab, and playing
     * the visible tab's file for it would speak a family nobody chose. See MainActivity's
     * activitySink for the whole v1 rule.
     *
     * Called from the WebSocket reader thread, so it hops onto the main handler first, exactly
     * like [playOnce]: everything it touches below — [ready], the shared [tone] field, [running] —
     * is main-thread-only state (see the sampled-playback-state KDoc above).
     *
     * **Its delayed release is identity-checked, and must stay that way.** The fallback path shares
     * the [tone] field with every other programmatic voice, and [chime] deliberately does NOT
     * cancel a pending release before building its own generator (frozen behaviour — do not add a
     * `removeCallbacks` there). Posting the shared [releaseToneCallback] here would therefore let a
     * tick reach forward and free a *chime's* generator: tick at T, warn chime at T+d (0 < d <
     * [ACTIVITY_RELEASE_MS]), release at T+250 kills a 250 ms chime after only (250−d) ms of audio
     * — at d ≈ 200 ms the warn is effectively inaudible. That is not a corner case but this
     * feature's own hot path: a stream push, then an alert about the same event a fraction of a
     * second later, on a default classic-voice panel. Checking `tone === generator` means the
     * release can only ever free the tone this call created; if anything else has since taken the
     * field (a chime, an offline beep, an alarm beat), the callback is a no-op and the newer,
     * more important sound plays out in full. Tick-vs-tick is already impossible — the 2.5 s
     * cooldown is ten times this delay — so a chime/beep is precisely what it protects.
     */
    fun activityTick(sampled: Boolean = true) {
        handler.post {
            val sample = if (sampled) ready[ACTIVITY] else null
            if (sample != null &&
                runCatching { alarmPool?.play(sample, ACTIVITY_VOLUME, ACTIVITY_VOLUME, 0, 0, 1f) }
                    .getOrNull().let { it != null && it != 0 }
            ) {
                return@post
            }

            // The programmatic voice — `classic`, an uncached file, a failed load, or the
            // family mismatch above. Degrade, never silence, exactly like every other path here.
            //
            // `running` guard, same reasoning as [auditionBeep]: this path shares the [tone] field
            // with the alarm beat, and an activity tick is even less important than an audition.
            // The sampled path above needs no such guard — it touches no shared state.
            // MainActivity suppresses ticks during an alarming takeover anyway; this closes the
            // window between a critical arriving and that suppression becoming observable, on the
            // one path that could truncate the alarm's own beep.
            if (running) return@post
            releaseTone()
            val generator = runCatching {
                // Quieter (40 vs the chime's 70) and shorter (120 ms vs 250) — audibly a tick.
                ToneGenerator(AudioManager.STREAM_ALARM, ACTIVITY_TONE_VOLUME).also {
                    tone = it
                    it.startTone(ToneGenerator.TONE_PROP_BEEP, ACTIVITY_TONE_MS)
                }
            }.getOrNull()
            // Proportionally sooner than the chime's 600 ms: the release only has to outlast this
            // tick's own 120 ms tone.
            //
            // An identity-checked release rather than the shared [releaseToneCallback], and this
            // is load-bearing (see below) — a construction that failed leaves nothing to release
            // at all, hence the null check.
            if (generator != null) {
                handler.postDelayed({ if (tone === generator) releaseTone() }, ACTIVITY_RELEASE_MS)
            }
        }
    }

    /** Optional local beep when the hub connection drops (documented contract, settings-gated). */
    fun offlineBeep() {
        if (!settings.offlineBeep) return

        val sample = ready[OFFLINE]
        if (sample != null &&
            runCatching { notifPool?.play(sample, OFFLINE_VOLUME, OFFLINE_VOLUME, 1, 0, 1f) }
                .getOrNull().let { it != null && it != 0 }
        ) {
            return
        }

        releaseTone()
        runCatching {
            ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60).also { generator ->
                tone = generator
                generator.startTone(ToneGenerator.TONE_PROP_NACK, 300)
            }
        }
        handler.postDelayed(releaseToneCallback, 700)
    }

    /**
     * One-shot audition for a hub PLAY_SOUND (the admin's "preview this family" button), at a
     * fixed moderate volume — this is a preview, not an alarm, and must never be the loudest
     * thing in the room.
     *
     * [file] null (or the `classic` family, which has no file at all) plays the programmatic
     * chime instead. Called from the WebSocket thread, so it hops onto the main handler first:
     * everything below — the shared [tone] field and the SoundPool bookkeeping — is main-thread
     * only.
     */
    fun playOnce(family: String, event: String, file: File?) {
        handler.post {
            if (family == CLASSIC || file == null || !runCatching { file.isFile }.getOrDefault(false)) {
                auditionBeep()
                return@post
            }
            // poolFor(event), not always the alarm pool: an `offline` audition must preview on
            // the notification usage it will really play on, or the preview pierces Do Not
            // Disturb when the thing being previewed never would.
            val pool = poolFor(event)
            if (pool == null) {
                auditionBeep()
                return@post
            }
            // A transient load rather than reusing `ready[event]`: the audition names its own
            // family, which is usually NOT the family the visible screen is playing.
            val id = runCatching { pool.load(file.absolutePath, 1) }.getOrDefault(0)
            if (id == 0) auditionBeep()
            else if (event == OFFLINE) notifAuditions += id
            else alarmAuditions += id
        }
    }

    fun stop() {
        running = false
        handler.removeCallbacks(beat)
        handler.removeCallbacks(releaseToneCallback)
        releaseTone()
        stopAlarmStream()
        restoreAlarmStream()
    }

    /**
     * Give the pools back. Deliberately NOT part of [stop] — stop() runs every time a takeover
     * clears, and the pools (with their loaded samples) must outlive that by a long way: the
     * next critical has to be able to sound instantly, not wait on a reload. Only the owner's
     * teardown calls this.
     */
    fun release() {
        stop()
        runCatching { alarmPool?.release() }
        runCatching { notifPool?.release() }
        ready.clear()
        alarmPending.clear()
        notifPending.clear()
        alarmAuditions.clear()
        notifAuditions.clear()
        loadedSpec.clear()
    }

    private fun playBeep(volume: Int) {
        // Defensive, same reasoning as startAlarm(): if a chime()/offlineBeep() release is ever
        // still pending here (there should not be one — startAlarm() already cleared it before
        // the beat loop began — but a future caller invoking chime()/offlineBeep() mid-alarm
        // would otherwise reintroduce the exact race this class exists to prevent), cancel it
        // before creating this tick's tone so it can never reach in and kill it.
        handler.removeCallbacks(releaseToneCallback)
        // ToneGenerator fixes its volume at construction, so escalating means rebuilding it.
        // Released even on the sampled path below: a beat that started programmatic (nothing
        // cached yet) and switches to a sample mid-alarm must not leave the last generator alive
        // and holding the stream until stop().
        releaseTone()

        // AlarmEscalation's curve is 0–100 (its own unit, pinned by AlarmEscalationTest and
        // unchanged); SoundPool wants 0f–1f. The /100f here is the ONLY new thing about it.
        val sample = ready[CRITICAL]
        if (sample != null) {
            val gain = (volume / 100f).coerceIn(0f, 1f)
            val stream = runCatching { alarmPool?.play(sample, gain, gain, 1, 0, 1f) }.getOrNull()
            if (stream != null && stream != 0) {
                // Stop the PREVIOUS tick's stream, not this one: a long sample overlapping the
                // next beat would otherwise stack up against maxStreams.
                stopAlarmStream()
                alarmStream = stream
                return
            }
        }

        // Falling back to the programmatic voice: stop and FORGET the previous tick's sample.
        // Leaving the id set would leave a dangling handle — SoundPool recycles stream ids, so a
        // later stopAlarmStream() could stop a chime or audition that inherited this number.
        stopAlarmStream()
        runCatching {
            ToneGenerator(AudioManager.STREAM_ALARM, volume).also { generator ->
                tone = generator
                generator.startTone(ToneGenerator.TONE_CDMA_HIGH_L, 400)
            }
        }
    }

    /** The programmatic audition/degrade beep. */
    private fun auditionBeep() {
        // Never while a critical is sounding: this shares the `tone` field with the alarm beat,
        // and an audition is the least important sound in the building. The sampled path above
        // has no such constraint — it touches no shared state.
        if (running) return
        releaseTone()
        runCatching {
            ToneGenerator(AudioManager.STREAM_ALARM, 70).also { generator ->
                tone = generator
                generator.startTone(ToneGenerator.TONE_PROP_BEEP, 250)
            }
        }
        handler.postDelayed(releaseToneCallback, 600)
    }

    private fun poolFor(event: String): SoundPool? = if (event == OFFLINE) notifPool else alarmPool

    /** The pending map belonging to [poolFor]'s pool — the two must always agree. */
    private fun pendingFor(event: String): MutableMap<Int, String> =
        if (event == OFFLINE) notifPending else alarmPending

    private fun stopAlarmStream() {
        val stream = alarmStream
        if (stream == 0) return
        alarmStream = 0
        runCatching { alarmPool?.stop(stream) }
    }

    private fun releaseTone() {
        runCatching { tone?.stopTone(); tone?.release() }
        tone = null
    }

    private fun raiseAlarmStream() {
        // A phone whose alarm stream was muted would otherwise take over the screen in total
        // silence. Remember the old value so we put the device back as we found it — durably,
        // not just in the in-memory field: stop() might never run (see the init block above), so
        // the persisted copy is the only thing that can undo this if the process dies first.
        runCatching {
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            val previous = audio.getStreamVolume(AudioManager.STREAM_ALARM)
            previousAlarmVolume = previous
            settings.savedAlarmVolume = previous
            audio.setStreamVolume(AudioManager.STREAM_ALARM, max, 0)
        }
    }

    private fun restoreAlarmStream() {
        val previous = previousAlarmVolume ?: return
        // Clear the saved value only after a successful restore — clearing it first would
        // discard the only record of the original volume if setStreamVolume throws, leaving no
        // way to repair it later (neither here nor from the init-block retry on next launch).
        runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0) }
            .onSuccess {
                previousAlarmVolume = null
                settings.savedAlarmVolume = null
            }
    }

    private companion object {
        const val CLASSIC = "classic"
        const val CRITICAL = "critical"
        const val OFFLINE = "offline"
        const val ACTIVITY = "activity"
        const val CHIME_VOLUME = 0.7f
        const val ACTIVITY_VOLUME = 0.4f
        // 40/120ms can be inaudible in a real room on the A05, so activity uses 60/180ms:
        // clearly noticeable, still visibly softer/shorter than the chime's 70/250ms.
        const val ACTIVITY_TONE_VOLUME = 60
        const val ACTIVITY_TONE_MS = 180
        const val ACTIVITY_RELEASE_MS = 300L
        const val OFFLINE_VOLUME = 0.6f
        const val AUDITION_VOLUME = 0.6f
        const val AUDITION_UNLOAD_MS = 5_000L
    }
}
