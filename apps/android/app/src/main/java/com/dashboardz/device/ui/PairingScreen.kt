package com.dashboardz.device.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R

@Composable
fun PairingScreen(
    initialHubUrl: String?,
    initialCode: String,
    error: String?,
    /** Changes on every submit, so a repeated identical error is shown again. */
    errorKey: Int,
    busy: Boolean,
    onScan: () -> Unit,
    onPair: (hubUrl: String, code: String) -> Unit,
) {
    var hubUrl by remember(initialHubUrl) { mutableStateOf(initialHubUrl.orEmpty()) }
    var code by remember(initialCode) { mutableStateOf(initialCode) }

    // Re-seeded whenever a fresh error arrives. Keyed on errorKey as well as the text: an instant
    // failure (a malformed code) can replace the submit's null before a frame renders, so the
    // text alone may not change between attempts. Editing either field clears it locally so a
    // stale failure message doesn't linger while the operator is mid-correction.
    var shownError by remember(error, errorKey) { mutableStateOf(error) }

    val focus = LocalFocusManager.current
    val canPair = !busy && hubUrl.isNotBlank() && code.isNotBlank()

    // Scrolls, and pads for the keyboard: on a small or landscape screen the code field, the Pair
    // button and the hint must stay reachable while typing.
    Column(
        Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // A form column of readable width, centred: on a tablet the fields would otherwise span
      // the whole screen.
      Column(Modifier.widthIn(max = 520.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Image(
            painter = painterResource(R.drawable.ic_bolt),
            contentDescription = null,
            modifier = Modifier.size(56.dp).padding(bottom = 12.dp),
        )
        Text(
            text = stringResource(R.string.brand_name),
            color = Palette.text,
            fontSize = 34.sp,
            fontWeight = FontWeight.Light,
        )
        Text(
            text = stringResource(R.string.pair_title),
            color = Palette.body,
            fontSize = 17.sp,
            modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
        )

        OutlinedTextField(
            value = hubUrl,
            onValueChange = { hubUrl = it; shownError = null },
            label = { Text(stringResource(R.string.pair_hub_url)) },
            placeholder = { Text(stringResource(R.string.pair_hub_placeholder)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = code,
            onValueChange = { code = it.uppercase(); shownError = null },
            label = { Text(stringResource(R.string.pair_code)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = {
                focus.clearFocus()
                if (canPair) onPair(hubUrl, code)
            }),
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )

        shownError?.let {
            Text(
                text = it,
                color = Palette.errorText,
                fontSize = 15.sp,
                lineHeight = 21.sp,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
        }

        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onScan, enabled = !busy, modifier = Modifier.weight(1f)) {
                Icon(painterResource(R.drawable.ic_qr_scan), contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.pair_scan))
            }
            Button(
                onClick = { onPair(hubUrl, code) },
                enabled = canPair,
                modifier = Modifier.weight(1f),
            ) {
                Icon(painterResource(R.drawable.ic_link), contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(if (busy) R.string.pair_working else R.string.pair_submit))
            }
        }

        Text(
            text = stringResource(R.string.pair_hint),
            color = Palette.body,
            fontSize = 14.sp,
            lineHeight = 21.sp,
            modifier = Modifier.padding(top = 20.dp),
        )
      }
    }
}
