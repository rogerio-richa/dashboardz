package com.dashboardz.device.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R
import kotlinx.coroutines.delay

/**
 * A pill at the top of the board (clear of tab bars, which sit at the bottom), shown once per install, saying how settings open. The
 * two-finger swipe is the only way in and nothing else on a healthy board hints at it.
 * Touch-transparent (no click handling), so the board underneath keeps working.
 */
@Composable
fun GestureHint(onShown: () -> Unit, durationMs: Long = 8_000) {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(1_500) // let the board paint first
        visible = true
        onShown()
        delay(durationMs)
        visible = false
    }
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(visible = visible, enter = fadeIn(), exit = fadeOut()) {
            Text(
                stringResource(R.string.board_gesture_hint),
                color = Palette.text,
                fontSize = 16.sp,
                modifier = Modifier
                    .padding(top = 24.dp)
                    .background(Color(0xE6151821), RoundedCornerShape(24.dp))
                    .padding(horizontal = 24.dp, vertical = 12.dp),
            )
        }
    }
}
