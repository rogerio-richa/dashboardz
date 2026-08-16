package com.dashboardz.device.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R
import com.dashboardz.device.core.displayHubAddress
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

internal val CardColor = Color(0xFF151821)
internal val DividerColor = Color(0xFF232733)
internal val OkColor = Color(0xFF3FB950)

/** Two columns from this width up (landscape tablets); one centred column below it. */
private val TWO_COLUMN_MIN = 840.dp

@Composable
fun SettingsScreen(
    settings: Settings,
    deviceName: String,
    grants: GrantStatus,
    onClose: () -> Unit,
    onRePair: () -> Unit,
    /**
     * Persist + reconnect to a new hub address. The device token stays: this is for the hub
     * MOVING (new IP, new DNS name), not for a different hub, which is what unpair is for.
     * Caller normalizes (adds http:// when missing); a blank never reaches it (gated here).
     */
    onSaveHubUrl: (String) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenOverlaySettings: () -> Unit,
    onOpenOemBattery: () -> Unit,
    /** Whether the hub link is up right now, for the status line under the address. */
    connected: Boolean = false,
    appVersion: String = "",
    /**
     * Re-apply window display state (keep-on flag, brightness pin) after a display toggle, so
     * the change is visible the moment the switch flips, not on the next onResume.
     */
    onDisplayChanged: () -> Unit = {},
) {
    var alwaysOn by remember { mutableStateOf(settings.displayMode == DisplayMode.ALWAYS_ON) }
    var keepBright by remember { mutableStateOf(settings.keepFullBrightness) }
    var offlineBeep by remember { mutableStateOf(settings.offlineBeep) }
    var forceVolume by remember { mutableStateOf(settings.forceAlarmVolume) }
    var confirmUnpair by remember { mutableStateOf(false) }

    // Back closes settings instead of leaving the app.
    BackHandler(onBack = onClose)

    val hub: @Composable () -> Unit = {
        Section(stringResource(R.string.settings_section_hub)) {
            HubCard(settings.hubUrl, connected, onSaveHubUrl)
        }
    }
    val screen: @Composable () -> Unit = {
        Section(stringResource(R.string.settings_section_screen)) {
            SwitchRow(
                stringResource(R.string.settings_display_mode),
                stringResource(R.string.settings_display_mode_desc),
                alwaysOn,
            ) { checked ->
                alwaysOn = checked
                settings.displayMode = if (checked) DisplayMode.ALWAYS_ON else DisplayMode.SCREEN_OFF
                onDisplayChanged()
            }
            RowDivider()
            SwitchRow(
                stringResource(R.string.settings_keep_bright),
                stringResource(R.string.settings_keep_bright_desc),
                keepBright,
            ) { checked ->
                keepBright = checked
                settings.keepFullBrightness = checked
                onDisplayChanged()
            }
        }
    }
    val alerts: @Composable () -> Unit = {
        Section(stringResource(R.string.settings_section_alerts)) {
            SwitchRow(
                stringResource(R.string.settings_force_volume),
                stringResource(R.string.settings_force_volume_desc),
                forceVolume,
            ) { checked ->
                forceVolume = checked
                settings.forceAlarmVolume = checked
            }
            RowDivider()
            SwitchRow(
                stringResource(R.string.settings_offline_beep),
                stringResource(R.string.settings_offline_beep_desc),
                offlineBeep,
            ) { checked ->
                offlineBeep = checked
                settings.offlineBeep = checked
            }
        }
    }
    val permissions: @Composable () -> Unit = {
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
            RowDivider()
            ActionRow(
                stringResource(R.string.settings_oem_battery),
                stringResource(R.string.settings_oem_battery_desc),
            ) {
                OutlinedButton(onClick = onOpenOemBattery) { Text(stringResource(R.string.settings_open)) }
            }
        }
    }
    val device: @Composable () -> Unit = {
        Section(stringResource(R.string.settings_section_device)) {
            ActionRow(
                stringResource(R.string.settings_unpair_title),
                stringResource(R.string.settings_unpair_desc),
            ) {
                OutlinedButton(
                    onClick = { confirmUnpair = true },
                    border = BorderStroke(1.dp, Palette.critical.copy(alpha = 0.6f)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.critical),
                ) { Text(stringResource(R.string.settings_repair)) }
            }
        }
    }

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .safeDrawingPadding()
            .imePadding(),
    ) {
        val wide = maxWidth >= TWO_COLUMN_MIN
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = if (wide) 1040.dp else 640.dp).fillMaxWidth()) {
                Header(deviceName, onClose)
                if (wide) {
                    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        Column(Modifier.weight(1f)) { hub(); screen(); alerts() }
                        Column(Modifier.weight(1f)) { permissions(); device() }
                    }
                } else {
                    hub(); screen(); alerts(); permissions(); device()
                }
                if (appVersion.isNotEmpty()) {
                    Text(
                        text = stringResource(R.string.settings_version, appVersion),
                        color = Palette.dim,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 8.dp),
                    )
                }
            }
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            containerColor = CardColor,
            title = { Text(stringResource(R.string.settings_unpair_confirm_title), color = Palette.text) },
            text = { Text(stringResource(R.string.settings_unpair_confirm_body), color = Palette.body) },
            confirmButton = {
                Button(
                    onClick = { confirmUnpair = false; onRePair() },
                    colors = ButtonDefaults.buttonColors(containerColor = Palette.critical, contentColor = Palette.text),
                ) { Text(stringResource(R.string.settings_repair)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnpair = false }) { Text(stringResource(R.string.settings_hub_cancel)) }
            },
        )
    }
}

@Composable
private fun Header(deviceName: String, onClose: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.settings_title),
                color = Palette.text,
                fontSize = 28.sp,
                fontWeight = FontWeight.SemiBold,
            )
            if (deviceName.isNotBlank()) {
                Text(deviceName, color = Palette.dim, fontSize = 14.sp, modifier = Modifier.padding(top = 2.dp))
            }
        }
        Button(onClick = onClose) { Text(stringResource(R.string.settings_close)) }
    }
}

@Composable
internal fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Text(
        title.uppercase(),
        color = Palette.dim,
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 1.sp,
        modifier = Modifier.padding(top = 24.dp, bottom = 8.dp, start = 4.dp),
    )
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(CardColor),
        content = content,
    )
}

@Composable
internal fun RowDivider() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(1.dp).background(DividerColor))
}

@Composable
internal fun RowText(title: String, description: String, modifier: Modifier) {
    Column(modifier) {
        Text(title, color = Palette.text, fontSize = 16.sp)
        Text(
            description,
            color = Palette.body,
            fontSize = 13.sp,
            lineHeight = 18.sp,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

@Composable
private fun SwitchRow(title: String, description: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowText(title, description, Modifier.weight(1f).padding(end = 16.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
internal fun ActionRow(title: String, description: String, action: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowText(title, description, Modifier.weight(1f).padding(end = 16.dp))
        action()
    }
}

@Composable
internal fun GrantRow(title: String, description: String, granted: Boolean, onClick: () -> Unit) {
    ActionRow(title, description) {
        if (granted) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(OkColor)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.settings_granted), color = Palette.body, fontSize = 14.sp)
            }
        } else {
            Button(onClick = onClick) { Text(stringResource(R.string.settings_allow)) }
        }
    }
}

@Composable
internal fun StatusDot(color: Color) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

@Composable
private fun HubCard(hubUrl: String?, connected: Boolean, onSave: (String) -> Unit) {
    var editing by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    val save = {
        if (draft.isNotBlank()) {
            onSave(draft.trim())
            editing = false
        }
    }

    Column(Modifier.padding(16.dp)) {
        if (!editing) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 16.dp)) {
                    Text(stringResource(R.string.settings_hub_label), color = Palette.body, fontSize = 13.sp)
                    Text(
                        displayHubAddress(hubUrl),
                        color = Palette.text,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                    Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(if (connected) OkColor else Palette.critical)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            stringResource(if (connected) R.string.settings_hub_connected else R.string.settings_hub_not_connected),
                            color = Palette.body,
                            fontSize = 13.sp,
                        )
                    }
                }
                OutlinedButton(onClick = { draft = displayHubAddress(hubUrl); editing = true }) {
                    Text(stringResource(R.string.settings_hub_change))
                }
            }
        } else {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                singleLine = true,
                label = { Text(stringResource(R.string.settings_hub_label)) },
                placeholder = { Text(stringResource(R.string.pair_hub_placeholder)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { save() }),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                stringResource(R.string.settings_hub_hint),
                color = Palette.body,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            ) {
                TextButton(onClick = { editing = false }) { Text(stringResource(R.string.settings_hub_cancel)) }
                Button(onClick = save, enabled = draft.isNotBlank()) { Text(stringResource(R.string.settings_hub_save)) }
            }
        }
    }
}
