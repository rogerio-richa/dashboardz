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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R
import com.dashboardz.device.store.DisplayMode
import com.dashboardz.device.store.Settings

/**
 * The two OS grants that decide whether a wall panel actually behaves like one, surfaced with
 * their live state so "why didn't it wake me" is diagnosable from the panel itself.
 * Battery exemption is the load-bearing one: without it, Samsung-class doze parks wifi on an
 * unplugged panel and the board goes dark until someone walks over (observed on the A05).
 * Overlay is the kiosk takeover.
 */
data class GrantStatus(val batteryExempt: Boolean, val overlay: Boolean)

@Composable
fun SettingsScreen(
    settings: Settings,
    deviceName: String,
    grants: GrantStatus,
    onClose: () -> Unit,
    onRePair: () -> Unit,
    /**
     * Persist + reconnect to a new hub address (FR: "edit the dns/ip"). The device token stays —
     * this is for the hub MOVING (new IP, new DNS name), not for a different hub, which is what
     * re-pair below is for. Caller normalizes; a blank never reaches it (gated here).
     */
    onSaveHubUrl: (String) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
    onOpenOemBattery: () -> Unit,
    /**
     * Re-apply window display state (keep-on flag, brightness pin) after a display toggle — so
     * the change is visible the moment the switch flips, not on the next onResume. Default no-op
     * keeps existing callers/tests compiling.
     */
    onDisplayChanged: () -> Unit = {},
) {
    var alwaysOn by remember { mutableStateOf(settings.displayMode == DisplayMode.ALWAYS_ON) }
    var keepBright by remember { mutableStateOf(settings.keepFullBrightness) }
    var offlineBeep by remember { mutableStateOf(settings.offlineBeep) }
    var forceVolume by remember { mutableStateOf(settings.forceAlarmVolume) }
    var editingHub by remember { mutableStateOf(false) }
    var hubDraft by remember { mutableStateOf(settings.hubUrl.orEmpty()) }

    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .safeDrawingPadding()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                text = stringResource(R.string.settings_title),
                color = Palette.text,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
            )
            TextButton(onClick = onClose) {
                Text(stringResource(R.string.settings_close), color = Palette.dim)
            }
        }

        Text(
            text = stringResource(R.string.settings_device, deviceName),
            color = Palette.dim,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 8.dp),
        )

        // --- Hub address: shown always, editable on demand ---
        if (!editingHub) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.settings_hub, settings.hubUrl.orEmpty()),
                    color = Palette.dim,
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { hubDraft = settings.hubUrl.orEmpty(); editingHub = true }) {
                    Text(stringResource(R.string.settings_hub_change), color = Palette.text, fontSize = 13.sp)
                }
            }
        } else {
            OutlinedTextField(
                value = hubDraft,
                onValueChange = { hubDraft = it },
                singleLine = true,
                label = { Text(stringResource(R.string.pair_hub_url)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            Text(
                text = stringResource(R.string.settings_hub_hint),
                color = Palette.dim,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 4.dp),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { editingHub = false }) {
                    Text(stringResource(R.string.settings_hub_cancel), color = Palette.dim)
                }
                TextButton(
                    onClick = {
                        if (hubDraft.isNotBlank()) {
                            onSaveHubUrl(hubDraft.trim())
                            editingHub = false
                        }
                    },
                ) {
                    Text(stringResource(R.string.settings_hub_save), color = Palette.text)
                }
            }
        }

        SettingRow(stringResource(R.string.settings_display_mode), alwaysOn) { checked ->
            alwaysOn = checked
            settings.displayMode = if (checked) DisplayMode.ALWAYS_ON else DisplayMode.SCREEN_OFF
            onDisplayChanged()
        }
        SettingRow(stringResource(R.string.settings_keep_bright), keepBright) { checked ->
            keepBright = checked
            settings.keepFullBrightness = checked
            onDisplayChanged()
        }
        SettingRow(stringResource(R.string.settings_offline_beep), offlineBeep) { checked ->
            offlineBeep = checked
            settings.offlineBeep = checked
        }
        SettingRow(stringResource(R.string.settings_force_volume), forceVolume) { checked ->
            forceVolume = checked
            settings.forceAlarmVolume = checked
        }

        // --- OS grants ---
        Text(
            text = stringResource(R.string.settings_grants_title),
            color = Palette.text,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 28.dp),
        )
        GrantRow(
            label = stringResource(R.string.settings_battery_exempt),
            granted = grants.batteryExempt,
            onClick = onRequestBatteryExemption,
        )
        GrantRow(
            label = stringResource(R.string.settings_overlay),
            granted = grants.overlay,
            onClick = onOpenOverlaySettings,
        )
        Text(
            text = stringResource(R.string.settings_oem_battery),
            color = Palette.text,
            fontSize = 15.sp,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 16.dp)
                .clickable(onClick = onOpenOemBattery),
        )

        Text(
            text = stringResource(R.string.settings_repair),
            color = Palette.critical,
            fontSize = 15.sp,
            modifier = Modifier
                .padding(top = 28.dp)
                .clickable(onClick = onRePair),
        )

        Text(
            text = stringResource(R.string.settings_gesture_hint),
            color = Palette.dim,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}

@Composable
private fun SettingRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 20.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = label, color = Palette.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun GrantRow(label: String, granted: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 16.dp)
            .clickable(onClick = onClick),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = label, color = Palette.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Text(
            text = stringResource(if (granted) R.string.settings_granted else R.string.settings_needed),
            color = if (granted) Palette.dim else Palette.critical,
            fontSize = 13.sp,
        )
    }
}
