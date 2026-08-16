package com.dashboardz.device.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.dashboardz.device.container

/** A wall panel must come back by itself after a power cut — nobody is going to tap the icon. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON"
        ) {
            return
        }
        if (context.container.settings.isPaired) DeviceService.start(context)
    }
}
