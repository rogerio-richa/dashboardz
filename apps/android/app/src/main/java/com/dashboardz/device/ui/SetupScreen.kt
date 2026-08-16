package com.dashboardz.device.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R

/**
 * The one-time post-pairing checklist requests grants at device setup, so the user does not
 * dig). One screen, two rows, each saying what breaks without the grant — instead of two
 * unexplained system dialogs stacked back-to-back. Done never blocks: every grant stays
 * reachable from settings, and the rows show live state because the grant flows bounce through
 * system screens and come back (the activity re-reads grants in onResume).
 */
@Composable
fun SetupScreen(
    grants: GrantStatus,
    onRequestBatteryExemption: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
    onDone: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(28.dp),
    ) {
        Text(
            text = stringResource(R.string.setup_title),
            color = Palette.text,
            fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = stringResource(R.string.setup_intro),
            color = Palette.dim,
            fontSize = 14.sp,
            modifier = Modifier.padding(top = 8.dp),
        )
        SetupGrantRow(
            label = stringResource(R.string.setup_battery_label),
            why = stringResource(R.string.setup_battery_why),
            granted = grants.batteryExempt,
            onClick = onRequestBatteryExemption,
        )
        SetupGrantRow(
            label = stringResource(R.string.setup_overlay_label),
            why = stringResource(R.string.setup_overlay_why),
            granted = grants.overlay,
            onClick = onOpenOverlaySettings,
        )
        TextButton(onClick = onDone, modifier = Modifier.padding(top = 24.dp)) {
            Text(stringResource(R.string.setup_done), color = Palette.text, fontSize = 16.sp)
        }
    }
}

@Composable
private fun SetupGrantRow(label: String, why: String, granted: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 24.dp)
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = label, color = Palette.text, fontSize = 16.sp, modifier = Modifier.weight(1f))
            Text(
                text = stringResource(if (granted) R.string.settings_granted else R.string.settings_needed),
                color = if (granted) Palette.dim else Palette.critical,
                fontSize = 13.sp,
            )
        }
        Text(text = why, color = Palette.dim, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
    }
}
