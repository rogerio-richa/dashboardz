package com.dashboardz.device.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayTest {

    @Test
    fun sortsBySeverityThenUpdatedAtDescending() {
        val sorted = sortAlerts(
            listOf(
                alert("i", "info", 9),
                alert("c-old", "critical", 1),
                alert("w", "warn", 5),
                alert("c-new", "critical", 7),
            ),
        )
        assertEquals(listOf("c-new", "c-old", "w", "i"), sorted.map { it.id })
    }

    @Test
    fun splitsCardsAndChipsByCapacity() {
        val state = DeviceState(
            alerts = listOf(alert("a", "warn", 3), alert("b", "warn", 2), alert("c", "info", 1)),
        )
        val vm = displayModel(state, capacity = 2)
        assertEquals(listOf("a", "b"), vm.cards.map { it.id })
        assertEquals(listOf("c"), vm.chips.map { it.id })
    }

    @Test
    fun takeoverIsTheNewestUnsilencedCritical() {
        val state = DeviceState(
            alerts = listOf(
                alert("c-old", "critical", 10),
                alert("c-silenced", "critical", 25),
                alert("c-new", "critical", 15),
                alert("w", "warn", 5),
            ),
            silenced = setOf("c-silenced"),
        )
        val vm = displayModel(state, capacity = 2)
        // Of the unsilenced criticals (c-old at 10, c-new at 15), c-new is newest and wins.
        assertEquals("c-new", vm.takeover?.id)
        // Three criticals total: c-old, c-silenced, c-new. Extra count = 3 - 1 = 2.
        assertEquals(2, vm.extraCriticalCount)
    }

    @Test
    fun noTakeoverWhenEveryCriticalIsSilencedOrNoneExist() {
        val allSilenced = DeviceState(
            alerts = listOf(alert("c1", "critical", 10)),
            silenced = setOf("c1"),
        )
        assertNull(displayModel(allSilenced, 3).takeover)

        val quiet = DeviceState(alerts = listOf(alert("i", "info", 1)))
        val vm = displayModel(quiet, 3)
        assertNull(vm.takeover)
        assertEquals(0, vm.extraCriticalCount)
        assertEquals(emptyList<String>(), vm.chips.map { it.id })
    }

    @Test
    fun unknownSeverityDegradesToInfoRatherThanCrashing() {
        assertEquals(Severity.INFO, Severity.from("wat"))
        val vm = displayModel(DeviceState(alerts = listOf(alert("x", "wat", 1))), 3)
        assertEquals(listOf("x"), vm.cards.map { it.id })
        assertNull(vm.takeover)
    }
}
