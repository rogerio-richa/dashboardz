package com.dashboardz.device.sounds

import android.util.Log
import com.dashboardz.device.core.soundFileName
import com.dashboardz.device.core.soundUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Thin Android/IO shell around the pure naming/URL logic in core/SoundKeys.kt. Untested by
 * design (house pattern: no Robolectric/instrumented harness in this project — see
 * core/Options.kt's KDoc); every operation is wrapped in runCatching so a failed download or a
 * wiped cache dir just leaves the ToneGenerator fallback playing — nothing here throws out.
 */
class SoundStore(private val dir: File, private val http: OkHttpClient) {

    /** Existing cached file for this family/event/rev, or null. NEVER downloads. */
    fun fileFor(family: String, event: String, rev: Long): File? = runCatching {
        soundFileName(family, event, rev)?.let { File(dir, it) }?.takeIf { it.isFile }
    }.getOrNull()

    /**
     * Blocking. Downloads whatever in [wanted] isn't already cached at [rev] — via `<name>.tmp`
     * then `renameTo` so a torn download never becomes visible as a playable file — then prunes
     * any cached `*.wav` that isn't for the current [rev], plus any leftover `*.tmp`. One
     * family/event failing (bad name, network error, non-2xx) doesn't stop the rest.
     *
     * `@Synchronized`: concurrent calls serialize on this instance rather than racing to write
     * the same `<name>.tmp` path. The caller (a Compose `LaunchedEffect`) can retrigger for
     * reasons unrelated to sounds; Compose cancels the coroutine, but the blocking OkHttp call
     * inside doesn't observe that cancellation and keeps running to its timeout, so an old and a
     * new `sync()` genuinely overlap in practice. Once serialized, the existing `target.isFile`
     * check re-runs under the lock, so a stale call that lost the race simply finds the file the
     * winner already wrote and skips it — no extra bookkeeping needed.
     *
     * A `.tmp` can outlive its download if the process dies mid-copy (the `finally` that deletes
     * it never runs). Any `.tmp` still on disk once the prune step is reached is safe to delete:
     * inside this `@Synchronized` call every download above has already reached its own `finally`
     * (so it isn't mid-write), and no OTHER `sync()` can be concurrently writing one either — the
     * lock rules that out. So a leftover `.tmp` here is always an orphan from a past run, not a
     * live one.
     */
    @Synchronized
    fun sync(hubUrl: String, wanted: Set<Pair<String, String>>, rev: Long) {
        runCatching {
            // The shared OkHttpClient has no timeouts (it's tuned for the device WebSocket), so
            // a plain GET on it could hang forever — every download gets its own bounded client.
            val client = http.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()

            for ((family, event) in wanted) {
                runCatching {
                    val name = soundFileName(family, event, rev) ?: return@runCatching
                    val target = File(dir, name)
                    if (target.isFile) return@runCatching

                    val tmp = File(dir, "$name.tmp")
                    try {
                        val request = Request.Builder().url(soundUrl(hubUrl, family, event, rev)).build()
                        client.newCall(request).execute().use { response ->
                            if (!response.isSuccessful) return@runCatching
                            val body = response.body ?: return@runCatching
                            tmp.outputStream().use { out -> body.byteStream().copyTo(out) }
                        }
                        if (!tmp.renameTo(target)) {
                            Log.w(TAG, "renameTo failed for $name — leaving classic/ToneGenerator fallback in place")
                        }
                    } finally {
                        // No-op if renameTo already moved it away; cleans up a torn download.
                        tmp.delete()
                    }
                }
            }

            val keep = "-$rev.wav"
            dir.listFiles()?.forEach { f ->
                if (!f.isFile) return@forEach
                val stale = f.name.endsWith(".wav") && !f.name.endsWith(keep)
                val orphanedTmp = f.name.endsWith(".tmp")
                if (stale || orphanedTmp) f.delete()
            }
        }
    }

    private companion object {
        const val TAG = "SoundStore"
    }
}
