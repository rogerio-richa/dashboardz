package com.dashboardz.device.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R
import com.dashboardz.device.core.BoardDiagnosis
import java.net.NetworkInterface

/**
 * What the panel shows instead of black when the board cannot load.
 *
 * Replaces the 2026-08-27 failure mode exactly: a wall panel that was completely black, with no
 * statement of what was wrong and no reachable control, for hours. The hub host's DHCP lease had
 * moved and the panel was still pinned to the old address. Every line on this screen exists
 * because its absence cost real time that morning.
 *
 * Renders BELOW the takeover in MainActivity's `when`, so a critical alert always covers it. A
 * diagnostic must never be able to shadow the 3am wake path.
 */
@Composable
fun FailureScreen(
    diagnosis: BoardDiagnosis,
    muted: Boolean,
    onRetry: () -> Unit,
    onSettings: () -> Unit,
    onMute: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF1A1A1A))
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.failure_title),
            color = Color.White,
            fontSize = 34.sp,
        )
        Column(modifier = Modifier.padding(top = 24.dp)) {
            DiagnosisRow(stringResource(R.string.failure_hub), diagnosis.hubUrl)
            DiagnosisRow(stringResource(R.string.failure_error), diagnosis.error)
            DiagnosisRow(stringResource(R.string.failure_link), diagnosis.link)
            // Shown next to the hub address on purpose: a subnet or lease mismatch, which is
            // exactly what caused the 2026-08-27 outage, becomes visible at a glance.
            DiagnosisRow(stringResource(R.string.failure_panel), diagnosis.panel)
        }
        Row(
            modifier = Modifier.padding(top = 32.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Button(onClick = onRetry) { Text(stringResource(R.string.failure_retry)) }
            Button(onClick = onSettings) { Text(stringResource(R.string.failure_settings)) }
            OutlinedButton(onClick = onMute) {
                Text(
                    stringResource(
                        if (muted) R.string.failure_muted else R.string.failure_mute,
                    ),
                )
            }
        }
        // The gesture is otherwise undiscoverable, and it is the only route into settings from the
        // board. This line is the cheapest part of this screen and would on its own have ended the
        // outage in seconds.
        Text(
            text = stringResource(R.string.failure_tip),
            color = Color(0xFF9E9E9E),
            fontSize = 14.sp,
            modifier = Modifier.padding(top = 28.dp),
        )
    }
}

@Composable
private fun DiagnosisRow(label: String, value: String) {
    Row(
        modifier = Modifier.padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = Color(0xFF9E9E9E),
            fontSize = 18.sp,
            modifier = Modifier.width(180.dp),
        )
        Text(text = value, color = Color.White, fontSize = 18.sp)
    }
}

/**
 * The panel's own IPv4 address on its active interface.
 *
 * Read from NetworkInterface rather than WifiManager deliberately: the SSID would be the more
 * natural thing to show beside it, but reading the SSID requires ACCESS_FINE_LOCATION, and adding
 * a location permission prompt to a wall panel to render one diagnostic string is a bad trade.
 * The IP alone still exposes the subnet, which is what actually diagnoses this class of failure.
 */
fun localIpAddress(): String? = runCatching {
    NetworkInterface.getNetworkInterfaces().asSequence()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.asSequence() }
        .firstOrNull { !it.isLoopbackAddress && it.hostAddress?.contains(':') == false }
        ?.hostAddress
}.getOrNull()
