package com.dashboardz.device.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R
import com.dashboardz.device.core.MIN_WEBVIEW_MAJOR

/**
 * Shown instead of the board when the device's WebView is older than the board can run on
 * (core/WebViewSupport.kt). Without it an old phone that never updated its WebView fails to parse
 * the board's JavaScript and sits on a blank splash with no explanation.
 */
@Composable
fun OldWebViewScreen(installedMajor: Int, onUpdate: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(stringResource(R.string.webview_old_title), color = Palette.text, fontSize = 28.sp)
        Text(
            stringResource(R.string.webview_old_body, installedMajor, MIN_WEBVIEW_MAJOR),
            color = Palette.body,
            fontSize = 16.sp,
            modifier = Modifier.padding(top = 16.dp),
        )
        Button(onClick = onUpdate, modifier = Modifier.padding(top = 24.dp)) {
            Text(stringResource(R.string.webview_old_update))
        }
        Text(
            stringResource(R.string.failure_tip),
            color = Palette.dim,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}
