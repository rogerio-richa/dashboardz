package com.dashboardz.device.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R

/**
 * The one-time post-pairing checklist: requests the two grants at device setup instead of
 * stacking two unexplained system dialogs. Each row says what the grant is for. Continue never
 * blocks: every grant stays reachable from settings, and the rows show live state because the
 * grant flows bounce through system screens and come back (the activity re-reads grants in
 * onResume). Same cards and rows as SettingsScreen, so the two read as one product.
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
            .padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(Modifier.widthIn(max = 560.dp).fillMaxWidth()) {
            Text(
                text = stringResource(R.string.setup_title),
                color = Palette.text,
                fontSize = 28.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = stringResource(R.string.setup_intro),
                color = Palette.body,
                fontSize = 15.sp,
                lineHeight = 22.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
            Section(stringResource(R.string.settings_grants_title)) {
                GrantRow(
                    stringResource(R.string.settings_battery_exempt),
                    stringResource(R.string.settings_battery_exempt_desc),
                    grants.batteryExempt,
                    onRequestBatteryExemption,
                )
                RowDivider()
                GrantRow(
                    stringResource(R.string.settings_overlay),
                    stringResource(R.string.settings_overlay_desc),
                    grants.overlay,
                    onOpenOverlaySettings,
                )
            }
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth().padding(top = 28.dp)) {
                Text(stringResource(R.string.setup_done), fontSize = 16.sp)
            }
        }
    }
}
