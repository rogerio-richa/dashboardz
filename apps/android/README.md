# Dashboardz device (Android)

Kiosk app for the Dashboardz hub. Pairs to a hub, holds a WebSocket open, and turns a
spare Android phone or tablet into an alert device: a clock when things are quiet, detailed
cards when they aren't, and a full-screen alarm when something critical happens.

## Requirements

- Android 6.0 (API 23) or newer
- No Google Play Services — installable from an APK or F-Droid
- A reachable Dashboardz hub on the same network

## Build

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew :app:assembleRelease      # app/build/outputs/apk/release/
./gradlew :app:testDebugUnitTest    # JVM unit tests, no emulator needed
```

## Pair a device

1. In the hub admin UI (`http://<hub>:8484/admin`), choose **Add device** and give it a name.
2. Launch the app. Either scan the QR the admin UI shows, or type the hub address and the
   6-character code by hand.
3. The device appears in the hub's device list and starts receiving alerts.

Re-pairing later: **Settings → Unpair and pair again**. If the hub revokes the device, the
app returns to the pairing surface by itself.

## Settings

Open with a **two-finger swipe down** anywhere on the board (one-finger gestures belong to the
board itself — taps answer alerts, a one-finger drag scrolls a scrollable stream).

- **Hub address** — editable in place for when the hub's IP or DNS name changes. The device
  stays paired; only a *different* hub needs the unpair flow below.
- **Keep screen on** — always-on and dimmed when idle (wall-panel mode), or let the display
  sleep normally. A critical wakes the screen either way.
- **System permissions** — live grant state for the two that decide whether a wall panel
  behaves like one: *Ignore battery optimizations* (without it, aggressive OEM doze — Samsung
  especially — parks Wi-Fi when the panel runs on battery and the board silently goes dark)
  and *Display over other apps* (criticals take the screen even while another app is
  foregrounded). A fresh pair lands on a one-time setup checklist that explains and requests
  both; these rows are where they live afterwards. Plus a shortcut into the manufacturer's
  own battery manager, where "put unused apps to sleep" lives.
- **Beep when the hub connection drops** — off by default.
- **Force alarm volume to maximum for criticals** — on by default; the previous volume is
  restored when the alarm stops. The previous value is saved durably, not just in memory, so if
  the app is killed mid-alarm (e.g. a force-stop) before it can restore the volume itself, the
  device's alarm volume is repaired automatically the next time the app is opened.

## Sound (0.5)

Every alert event — critical alarm, warn chime, info chime, offline beep, and now stream activity
(below) — resolves to a **sound family** the hub ships (`classic`, `bells`, `8bit` at the time of
writing). A theme suggests a family per event, a screen can override it, and the hub folds theme ⊕
override ⊕ `classic` into a resolved map plus a revision number, pushed to the device on every
`STATE`. The device never picks a family itself — it just plays whichever one the hub already
resolved for the relevant screen (visible tab, for alerts and chimes — see below for the one event
that differs).

Sample files are cached under `filesDir/sounds/`, one file per `<family>-<event>-<rev>.wav`, so a
device that already has a revision plays it instantly rather than re-fetching it. A sync runs
whenever the visible screen's sound map or revision changes and the app is fully connected to the
hub; because a reconnect re-triggers it, a download that failed on one attempt is simply retried on
the next successful connect rather than needing its own backoff. Files from a superseded revision
are deleted once the new ones land, so the cache never grows without bound.

**Nothing here can produce silence.** `classic` carries no file at all — it's the same
`ToneGenerator` tone the app has always made — and every other family degrades to that same
ToneGenerator beep, per event, the moment its sample isn't loaded (not yet downloaded, a failed
fetch, a corrupt cache entry, or a hub too old to have sent a revision at all). Critical escalation
(the volume ramp and tightening beat interval) and the once-per-alert chime rules described below
are unchanged either way — only the tone source moves.

From the Screens page, an admin can push a one-shot **"Play this mix on `<device>`"** to an online
device: it loads the requested family/event onto whichever stream that event would really use
(alarm stream for critical/warn/info/activity, notification stream for offline), plays it once at a
fixed moderate volume, and unloads it a few seconds later. `classic`, or a family whose file the
device doesn't have, previews as the same programmatic beep the degrade path uses — muted while a
critical alarm is actually sounding, so a preview never fights the real thing for attention. The
loop now plays all five events, gap unchanged.

### Stream activity ticks

A fifth event, **`activity`**: a soft tick when a stream widget's watched feed gets new rows. Sound
only — no card, ever. It is opt-in per cell (`chime_activity` on a `stream_list` or `table` cell,
the exact sibling of `alert_feed`'s `sound_info`), and unlike every other event it is **any-tab**,
not visible-tab-only: if *any* of the device's tabs carries an opted-in cell whose bound feed just
got a non-snapshot `DATA` push, the device ticks — whether or not that tab is the one currently on
screen. Voice is the **carrying screen's** resolved `sounds.activity`: the visible tab's own voice
wins if the visible tab itself is a carrier, otherwise the first carrying tab in tab order (alert-sound contract's
visible-tab rule is unchanged for alerts and chimes — this is a deliberate extension for activity
alone, since an opted-in cell always belongs to exactly one screen and there's no ownership
ambiguity to resolve).

That resolution rule is the same on every device kind; playback of it is not. A browser board plays
whichever carrier's family it has prefetched, sampled or not. Android's v1 app is narrower: its
loaded samples are keyed to the **visible** screen, so a carrying tab's file only plays when its
family matches the visible screen's own `activity` family — any other carrier's voice degrades to
the generic soft programmatic beep, even when that family's file is already cached on-device.

One tick plays per qualifying push no matter how many feeds or rows it carries — same collapse rule
as a chime. `snapshot: true` pushes (reconnect resync) never tick. A device-local, in-memory,
unpersisted 2.5-second cooldown gates ticks: a push landing inside the gap is **dropped, not
deferred** — activity is ambient awareness, not a queue — and only a tick that actually plays
advances the cooldown clock, so pushes that arrive during the gap don't extend it. No tick plays
while a critical alarm is sounding; the tick loads into the same alarm pool a critical/warn/info
chime does (alarm-volume rule) and so obeys the alarm volume slider, which means it can be inaudible by design if
that slider is turned down. `classic.activity` is a single short, soft `ToneGenerator` beep,
quieter and shorter than the warn chime, same degrade-to-programmatic-tone story as every other
event above.

This event needs **app 0.5** (`versionCode 5`) to be audible on a panel — a 0.4 app receives the
`activity` key in `WireScreen.sounds` same as any additive wire field, and simply never looks it up.

## Behaviour worth knowing

- **One device per device token.** If a second device pairs with the same token, the first is
  disconnected with close code 4000 and stops retrying rather than fighting over the slot.
- **Critical alerts bypass Do Not Disturb** by using the alarm audio stream, and the volume
  escalates over the first 30 seconds. Confirmed on-device: DND priority mode does not stop
  the alarm from sounding (see "Verified platform coverage" below).
- **Two-stage dismissal.** A tap anywhere silences the alarm but leaves the card up; only a
  1-second hold on Dismiss clears it.
- **Non-critical sound.** A `warn` or `info` alert with `sound:true` chimes once, when it first
  arrives — no takeover, no escalation. It never repeats for the same alert (recomposition,
  rotation, and a reconnect that redelivers the same alert all leave it silent) and never
  interrupts a critical's own alarm.
- **The app stores no alert history.** Every reconnect pulls fresh state from the hub, so a
  device can never show something the hub no longer believes.

## Security note: cleartext HTTP

The app permits plain-HTTP connections to the hub (`android:networkSecurityConfig` in
`AndroidManifest.xml`, `res/xml/network_security_config.xml`). This is intentional, not an
oversight: plain HTTP is supported for a trusted LAN or private VPN, and Android blocks
cleartext traffic by default for apps targeting API 28+, which would otherwise make the app
unable to pair with a hub on that network. An `https://` hub address continues to work exactly
as before — this setting only permits cleartext, it does not disable or weaken TLS certificate
validation for hubs that do use it. If any connection crosses an untrusted or public network,
firewall the hub's raw port, put a TLS reverse proxy in front of it, proxy WebSocket upgrades
(`Connection: upgrade`, `Upgrade: websocket`) on `/ws/device`, set `PUBLIC_URL` to the proxy's
`https://` address, and pair using that address instead of the hub's own `http://` one.

## Verified platform coverage

Emulator acceptance ran on **API 34 only** (`Pixel_3a_API_34`). API 23–25 has no arm64 system
image on Apple Silicon, so the `minSdk 23` floor is enforced at compile time but has **not**
been exercised on a running Android 6–7 device — real hardware testing on an actual API 23–25
device is needed before claiming Android 6–7 support in practice.

Everything below was confirmed working on-device (screenshots and, where noted, raw
`dumpsys`/audio-track evidence) during the API 34 acceptance run; the commands above contain the
reproduction steps.

- The severity stripe on alert cards is genuinely visible on the left edge of each card, in a
  distinct colour per severity (critical red, warn amber, info blue).
- **The idle clock advances correctly while sitting idle**, not just on a screen transition —
  confirmed by screenshotting it 72 seconds apart with no touch input and seeing it match the
  system clock both times, repeated across a fresh install. The formatting-layer test
  (`ClockFormatTest`) guards the unit-testable part of this behavior.
- **Wake-from-off works.** A critical sent while the screen is fully off and the app is not in
  the foreground reliably wakes the screen, shows the takeover, and starts the alarm on the
  alarm stream — confirmed via `dumpsys power` (`mWakefulness` flipping to `Awake` with no manual
  wake input anywhere in the sequence) and `dumpsys media.audio_flinger` (an active
  `STREAM_ALARM`/`USAGE_ALARM` track), reproduced on a completely fresh install. This uses a
  full-screen-intent notification (the platform-sanctioned mechanism for this, since a plain
  `startActivity()` from a backgrounded foreground service is blocked by Android's
  background-activity-launch restrictions on API 34) and requires the app to hold the runtime
  `POST_NOTIFICATIONS` permission, requested on first launch on API 33+.
- **"Hold to dismiss" works.** A press below the 1-second threshold (700 ms) correctly does
  nothing; a press at or above it (1.5 s) correctly clears the takeover and produces a
  `tap_dismiss` audit row — confirmed on a fresh install, distinct from the separate plain-tap
  silence path (`tap_silence`), which continues to work as before.

DND-bypass continues to work as documented above (confirmed with DND priority mode on: the icon
shows, the alarm still sounds).
