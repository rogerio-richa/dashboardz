package com.dashboardz.device.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R

@Composable
fun PairingScreen(
    initialHubUrl: String?,
    initialCode: String,
    error: String?,
    busy: Boolean,
    onScan: () -> Unit,
    onPair: (hubUrl: String, code: String) -> Unit,
) {
    var hubUrl by remember(initialHubUrl) { mutableStateOf(initialHubUrl.orEmpty()) }
    var code by remember(initialCode) { mutableStateOf(initialCode) }

    // Re-seeded from `error` whenever a fresh one arrives (a submit always clears it to null
    // first, so a new failure is always a key change even if the message text repeats). Editing
    // either field clears it locally so a stale failure message doesn't linger while the operator
    // is mid-correction.
    var shownError by remember(error) { mutableStateOf(error) }

    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .safeDrawingPadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.brand_name),
            color = Palette.text,
            fontSize = 34.sp,
            fontWeight = FontWeight.Light,
        )
        Text(
            text = stringResource(R.string.pair_title),
            color = Palette.dim,
            fontSize = 16.sp,
            modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
        )

        OutlinedTextField(
            value = hubUrl,
            onValueChange = { hubUrl = it; shownError = null },
            label = { Text(stringResource(R.string.pair_hub_url)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = code,
            onValueChange = { code = it.uppercase(); shownError = null },
            label = { Text(stringResource(R.string.pair_code)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )

        shownError?.let {
            Text(
                text = it,
                color = Palette.critical,
                fontSize = 13.sp,
                modifier = Modifier.padding(top = 10.dp),
            )
        }

        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onScan, enabled = !busy, modifier = Modifier.weight(1f)) {
                Text(stringResource(R.string.pair_scan))
            }
            Button(
                onClick = { onPair(hubUrl, code) },
                enabled = !busy && hubUrl.isNotBlank() && code.isNotBlank(),
                modifier = Modifier.weight(1f),
            ) {
                Text(stringResource(if (busy) R.string.pair_working else R.string.pair_submit))
            }
        }

        Text(
            text = stringResource(R.string.pair_hint),
            color = Palette.dim,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 18.dp),
        )
    }
}
