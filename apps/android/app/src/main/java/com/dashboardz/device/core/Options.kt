package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireAlert
import com.dashboardz.device.protocol.WireOption

/**
 * The render gate for answer options: a card shows option buttons only when the alert carries
 * options, in exactly the order the hub sent them (≤4, hub-enforced — the app renders what it
 * gets). On the wire, absent (`null`) and empty (`[]`) are distinct values — see Wire.kt — but
 * for rendering both collapse to "nothing to answer, so no buttons". Centralised here rather
 * than inline in the composables so the gate is testable on the JVM (this project has no
 * instrumented-UI test harness; see documented contract): the UI just iterates whatever this returns, so an
 * empty result renders zero buttons with no separate visibility check to get wrong.
 */
fun renderableOptions(alert: WireAlert): List<WireOption> = alert.options.orEmpty()
