package com.dashboardz.device.core

import com.dashboardz.device.protocol.WireAlert

enum class Severity(val rank: Int) {
    CRITICAL(0),
    WARN(1),
    INFO(2),
    ;

    companion object {
        /** Unknown values degrade to INFO: a future hub severity must not crash an old app. */
        fun from(value: String): Severity = when (value) {
            "critical" -> CRITICAL
            "warn" -> WARN
            else -> INFO
        }
    }
}

data class DisplayModel(
    val takeover: WireAlert?,
    val extraCriticalCount: Int,
    val cards: List<WireAlert>,
    val chips: List<WireAlert>,
)

/** documented contract stack order: severity first (critical > warn > info), then updated_at descending. */
fun sortAlerts(alerts: List<WireAlert>): List<WireAlert> =
    alerts.sortedWith(
        compareBy<WireAlert> { Severity.from(it.severity).rank }
            .thenByDescending { it.updated_at },
    )

fun displayModel(state: DeviceState, capacity: Int): DisplayModel {
    val sorted = sortAlerts(state.alerts)
    val criticals = sorted.filter { Severity.from(it.severity) == Severity.CRITICAL }
    return DisplayModel(
        takeover = criticals.filterNot { it.id in state.silenced }.maxByOrNull { it.updated_at },
        extraCriticalCount = (criticals.size - 1).coerceAtLeast(0),
        cards = sorted.take(capacity),
        chips = sorted.drop(capacity),
    )
}
