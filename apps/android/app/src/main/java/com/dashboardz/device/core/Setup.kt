package com.dashboardz.device.core

/**
 * Whether the one-time post-pairing setup checklist should show: request grants at device
 * setup, don't make the user dig). It shows while something is actually missing and the operator
 * has never dismissed it; both grants already held means there is nothing to walk through, and
 * Done is permanent — the grants stay reachable from settings, but a wall panel must not greet
 * every reboot with a checklist.
 */
fun needsSetupWalkthrough(setupDone: Boolean, batteryExempt: Boolean, overlay: Boolean): Boolean =
    !setupDone && !(batteryExempt && overlay)
