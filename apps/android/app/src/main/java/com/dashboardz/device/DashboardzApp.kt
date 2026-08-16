package com.dashboardz.device

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.dashboardz.device.core.Backoff
import com.dashboardz.device.net.PairApi
import com.dashboardz.device.service.DeviceController
import com.dashboardz.device.protocol.WireViewport
import com.dashboardz.device.service.HttpTransport
import com.dashboardz.device.sounds.SoundStore
import com.dashboardz.device.store.PrefsSettings
import com.dashboardz.device.store.Settings
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Hand-rolled dependency container. A DI framework would be another dependency to justify
 * on a build that is deliberately lean enough to stay F-Droid-able.
 */
class AppContainer(private val context: Context) {

    val settings: Settings = PrefsSettings(context)

    val http: OkHttpClient = OkHttpClient.Builder()
        // The hub pings every 30 s; OkHttp answers those automatically. This client-side ping
        // is what detects a silently dead link (a NAT dropping the connection, Wi-Fi sleeping)
        // rather than waiting forever on a socket that will never deliver anything again.
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)   // a WebSocket is legitimately idle for hours
        .build()

    val pairApi = PairApi(http)

    val soundStore = SoundStore(File(context.filesDir, "sounds").apply { mkdirs() }, http)

    private val mainHandler = Handler(Looper.getMainLooper())

    val controller = DeviceController(
        // The board's own box, in CSS pixels. Read at HELLO time so a rotation between
        // connections is reported correctly. Compose's dp IS the CSS px unit here — both are
        // density-independent — so this is a divide by density, not by any Android-specific scale.
        transport = HttpTransport(http, BuildConfig.APP_VERSION) {
            val metrics = context.resources.displayMetrics
            val density: Float = if (metrics.density > 0f) metrics.density else 1f
            WireViewport(
                w = (metrics.widthPixels / density).toInt(),
                h = (metrics.heightPixels / density).toInt(),
                dpr = density,
            )
        },
        backoff = Backoff(),
        clock = { System.currentTimeMillis() },
        schedule = { delayMs, action -> mainHandler.postDelayed(action, delayMs) },
        onTokenRejected = { settings.clearPairing() },
    )
}

class DashboardzApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

/** Convenience accessor used by activities and the service. */
val Context.container: AppContainer
    get() = (applicationContext as DashboardzApp).container
