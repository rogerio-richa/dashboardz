package com.dashboardz.device.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.dashboardz.device.R
import com.dashboardz.device.container
import com.dashboardz.device.core.batteryPercent
import com.dashboardz.device.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps the hub connection alive for as long as the device is on. Deliberately a shell:
 * every decision about reconnecting, acking or merging state lives in DeviceController.
 */
class DeviceService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent != null) pushHealth(intent)
        }
    }

    private val periodicHealth = object : Runnable {
        override fun run() {
            registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.let(::pushHealth)
            handler.postDelayed(this, HEALTH_INTERVAL_MS)
        }
    }

    /**
     * Wifi coming back found the app sitting out the tail of a 60 s backoff — "offline"
     * for up to a minute on a network that worked. The platform knows the instant a default
     * network exists; route that instant at the controller, which decides whether it matters
     * (retryNow() is a no-op unless it is actually OFFLINE). Posted to the main handler because
     * ConnectivityManager delivers on its own thread and the controller's state machine — like
     * every other caller it has — runs on main.
     */
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            handler.post { container.controller.retryNow() }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startInForeground()
        registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        handler.postDelayed(periodicHealth, HEALTH_INTERVAL_MS)
        observeCriticals()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            connectivity.registerDefaultNetworkCallback(networkCallback)
        } else {
            // minSdk 23: the default-network variant is API 24+. An INTERNET-capable request is
            // the closest equivalent — slightly chattier (per-network, not just the default),
            // which retryNow()'s OFFLINE guard absorbs.
            connectivity.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                networkCallback,
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val settings = container.settings
        val hubUrl = settings.hubUrl
        val token = settings.deviceToken
        if (hubUrl != null && token != null) {
            container.controller.start(hubUrl, token)
        } else {
            // Nothing to connect to yet; the pairing screen will start us again once paired.
            stopSelf(startId)
        }
        // Restart if the OS kills us: an alerting device that quietly stopped listening is
        // the worst possible failure for this product.
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(periodicHealth)
        runCatching { unregisterReceiver(batteryReceiver) }
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        // The critical notification is posted with setOngoing(true)/setAutoCancel(false) via a
        // plain notify() (it is not the foreground notification), so it outlives the service
        // unless explicitly cancelled here — otherwise unpairing or any stop while a critical is
        // unsilenced leaves a permanent, non-swipeable entry in the shade.
        cancelCriticalNotification()
        container.controller.stop()
        scope.cancel()
        super.onDestroy()
    }

    /**
     * A critical must reach the glass even if the user has wandered off into another app, or
     * the screen is off entirely.
     *
     * `startActivity` alone is not enough: background activity starts are restricted from
     * Android 10, and on API 34 a running foreground service is *not* an exempt caller once it
     * has no visible window (confirmed on-device: `ActivityTaskManager: Background activity
     * launch blocked ... callingUidHasAnyVisibleWindow: false; callingUidProcState:
     * FOREGROUND_SERVICE ... result code=3`). It is kept anyway as a best-effort first attempt —
     * it genuinely works when the app already has a visible window (e.g. resuming from another
     * app) and costs nothing when it doesn't.
     *
     * The mechanism the platform actually sanctions for this is a full-screen-intent
     * notification (see [postCriticalNotification]): a HIGH-importance notification whose
     * `setFullScreenIntent` the OS is allowed to launch even from the background, which is what
     * brings [MainActivity] forward (and, via its Compose tree, wakes the display and starts the
     * alarm) when the phone is asleep.
     *
     * `distinctUntilChanged()` on the derived boolean means this only fires on a false→true
     * edge, not on every state emission where a critical happens to still be unsilenced
     * (health reports every 15 minutes, unrelated alerts updating, etc. would otherwise re-fire
     * it on each tick). `launchMode="singleTask"` already stops duplicate activities from
     * stacking up, so the redundant `startActivity` calls were wasted work rather than a
     * correctness bug — this just stops doing that work. On the false edge (no unsilenced
     * critical remains — silenced, dismissed, or the connection resynced it away) the critical
     * notification is cancelled so it doesn't linger.
     */
    private fun observeCriticals() {
        scope.launch {
            container.controller.state
                .map { state ->
                    state.device.alerts.any { it.severity == "critical" && it.id !in state.device.silenced }
                }
                .distinctUntilChanged()
                .collect { hasUnsilencedCritical ->
                    if (hasUnsilencedCritical) {
                        startActivity(
                            Intent(this@DeviceService, MainActivity::class.java).addFlags(
                                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
                            ),
                        )
                        postCriticalNotification()
                    } else {
                        cancelCriticalNotification()
                    }
                }
        }
    }

    /**
     * The sanctioned way to bring an activity forward from the background on modern Android:
     * post a HIGH-importance notification with a full-screen intent. Deliberately a separate
     * channel from [CHANNEL_ID] — that one is LOW-importance by legal necessity (the foreground
     * service notification) and must never carry the urgency of an actual critical alert.
     */
    private fun postCriticalNotification() {
        val manager = getSystemService(NotificationManager::class.java)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CRITICAL_CHANNEL_ID,
                    getString(R.string.critical_channel_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { setShowBadge(false) },
            )
        }

        val fullScreenIntent = PendingIntent.getActivity(
            this,
            FULL_SCREEN_REQUEST_CODE,
            Intent(this, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
            ),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CRITICAL_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        builder
            .setContentTitle(getString(R.string.critical_notification_title))
            .setContentText(getString(R.string.critical_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(fullScreenIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .setOngoing(true)
            .setAutoCancel(false)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Below O, importance comes from the notification itself (there is no channel to
            // carry it); PRIORITY_HIGH is deprecated only because IMPORTANCE_HIGH on the
            // channel supersedes it from O onward, which this branch does not reach.
            @Suppress("DEPRECATION")
            builder.setPriority(Notification.PRIORITY_HIGH)
        }

        // The OS can withhold USE_FULL_SCREEN_INTENT silently (it is auto-granted at install for
        // apps targeting <= 33, but on 34+ the user can revoke it, and some OEMs default it off).
        // If it has been withheld, this notification will show as a heads-up at best — it will
        // NOT wake a sleeping screen — so this must be reported rather than assumed to have
        // worked, and the notification offers a direct way to grant it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && !manager.canUseFullScreenIntent()) {
            Log.w(
                TAG,
                "canUseFullScreenIntent() = false for $packageName: the OS has withheld the " +
                    "full-screen-intent permission, so this critical will NOT wake a sleeping " +
                    "screen — it will only appear as a heads-up notification if the phone is " +
                    "already awake.",
            )
            val manageIntent = PendingIntent.getActivity(
                this,
                MANAGE_FSI_REQUEST_CODE,
                Intent(
                    Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    Uri.fromParts("package", packageName, null),
                ),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.stat_sys_warning),
                    getString(R.string.enable_full_screen_alerts),
                    manageIntent,
                ).build(),
            )
        }

        manager.notify(CRITICAL_NOTIFICATION_ID, builder.build())
    }

    private fun cancelCriticalNotification() {
        getSystemService(NotificationManager::class.java).cancel(CRITICAL_NOTIFICATION_ID)
    }

    private fun pushHealth(batteryIntent: Intent) {
        val level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        container.controller.reportHealth(batteryPercent(level, scale), charging)
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.service_channel_name),
                    // LOW: this notification is a legal requirement for a foreground service,
                    // not something anyone should be interrupted by. The alarm is separate.
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { setShowBadge(false) },
            )
        }

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val notification: Notification = builder
            .setContentTitle(getString(R.string.service_notification_title))
            .setContentText(getString(R.string.service_notification_text))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(open)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "DeviceService"
        private const val CHANNEL_ID = "device_service"
        private const val NOTIFICATION_ID = 1
        private const val CRITICAL_CHANNEL_ID = "device_critical"
        private const val CRITICAL_NOTIFICATION_ID = 2
        private const val FULL_SCREEN_REQUEST_CODE = 1
        private const val MANAGE_FSI_REQUEST_CODE = 2
        private const val HEALTH_INTERVAL_MS = 15 * 60 * 1000L   // documented contract: every 15 minutes

        fun start(context: Context) {
            val intent = Intent(context, DeviceService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DeviceService::class.java))
        }
    }
}
