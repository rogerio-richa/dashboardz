package com.dashboardz.device.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashboardz.device.R
import com.dashboardz.device.core.renderableOptions
import com.dashboardz.device.protocol.WireAlert
import com.dashboardz.device.protocol.WireOption
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

/**
 * Full-screen critical takeover (documented contract), two-stage by design:
 *  - a tap anywhere silences the alarm but leaves the card up, so someone half-awake cannot
 *    make a critical alert disappear by fumbling at the screen;
 *  - only a deliberate 1-second hold on the Dismiss button clears it.
 *
 * Answer options are deliberately single taps, not holds: the two-stage guarantee protects
 * *dismissal* (making an alert vanish unanswered), whereas answering is the productive action
 * the sender is waiting on. [onAnswer] receives the tapped option id.
 */
@Composable
fun TakeoverScreen(
    alert: WireAlert,
    extraCriticalCount: Int,
    onSilence: () -> Unit,
    onAnswer: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Palette.takeoverBg)
            .border(6.dp, Palette.critical)
            // Any tap that is not on the Dismiss button silences.
            .pointerInput(alert.id) { detectTapGestures(onTap = { onSilence() }) },
    ) {
        // safeDrawingPadding() before the 28dp content padding (layout constraint, minimal — layout behavior owns
        // the scroll restructure): the outer Box's background/border above stays full-bleed to
        // the physical edges while this inner content clears system bars.
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(28.dp),
            verticalArrangement = Arrangement.Top,
        ) {
            val meta = buildString {
                append(stringResource(R.string.critical))
                append(" · ")
                append(alert.sender.name.uppercase())
                append(" · ")
                append(timeFormat.format(Date(alert.updated_at)))
                if (extraCriticalCount > 0) {
                    append(" · ")
                    append(stringResource(R.string.extra_criticals, extraCriticalCount))
                }
            }

            // Everything except the hint and the hold button scrolls; the dismiss affordance is
            // pinned and always reachable no matter how long the body or how many options
            // The parent Box's tap-to-silence still covers this region —
            // verticalScroll consumes drags, not taps, and the hold button keeps its own
            // combinedClickable arbitration (see the existing comments below in this file).
            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
            ) {
                Text(text = meta, color = Palette.takeoverMeta, fontSize = 14.sp, letterSpacing = 2.sp)

                Text(
                    text = alert.title,
                    color = Palette.text,
                    fontSize = 34.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 12.dp),
                )

                alert.body?.takeIf { it.isNotBlank() }?.let { body ->
                    Text(
                        text = body,
                        color = Palette.takeoverBody,
                        fontSize = 18.sp,
                        modifier = Modifier.padding(top = 10.dp),
                    )
                }

                // Options sit above the hold-to-dismiss button; empty renders nothing (the gate
                // lives in renderableOptions, see core/Options.kt).
                renderableOptions(alert).forEach { option ->
                    OptionButton(alertId = alert.id, option = option, onAnswer = onAnswer)
                }
            }

            Text(
                text = stringResource(R.string.tap_to_silence),
                color = Palette.takeoverMeta,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            )

            HoldToDismissButton(alertId = alert.id, onDismiss = onDismiss)
        }
    }
}

@Composable
private fun OptionButton(alertId: String, option: WireOption, onAnswer: (String) -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            // Spacing between stacked options lives *outside* the button surface — applied
            // before clip/background/clickable so it is a margin, not dead touch area inside.
            .padding(bottom = 10.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.card)
            // Same arbitration reasoning as HoldToDismissButton below: a foundation clickable
            // (not a nested pointerInput/detectTapGestures) consumes the tap, so the parent
            // Box's full-screen detectTapGestures(onTap = onSilence) does not also fire for a
            // tap that landed on an option. indication = null because the default ripple is an
            // animation, and this project forbids animation outright.
            .clickable(
                interactionSource = remember(alertId, option.id) { MutableInteractionSource() },
                indication = null,
                onClick = { onAnswer(option.id) },
            )
            // Padding after the gesture modifier so the whole visible rectangle is tappable.
            .padding(vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = option.label,
            color = Palette.text,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun HoldToDismissButton(alertId: String, onDismiss: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.critical)
            // combinedClickable (not a nested pointerInput/detectTapGestures) so this button's
            // gesture detector wins arbitration against the parent Box's own full-screen
            // detectTapGestures(onTap = onSilence) — two independent pointerInput blocks
            // covering the same touch stream is what made the previous long-press never fire.
            // indication = null: the default ripple is an animation, and this project forbids
            // animation outright (bedside screens shouldn't animate at night). onClick is a
            // deliberate no-op, same rationale as before: a short press must do nothing at all,
            // neither silencing (which would defeat the two-stage guarantee) nor dismissing.
            .combinedClickable(
                interactionSource = remember(alertId) { MutableInteractionSource() },
                indication = null,
                onClick = { },
                onLongClick = onDismiss,
            )
            // Padding placed *after* the gesture modifier so the whole visible red rectangle —
            // including this padding band — is part of the pressable/clickable region. Applied
            // before, as it previously was, it shrank the touch target to exclude the padding.
            .padding(vertical = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.hold_to_dismiss),
            color = Palette.text,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}
