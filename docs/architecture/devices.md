# Devices

A device is whatever a human is actually looking at: the Android kiosk app
or a browser tab. It holds no logic of its own — it renders whatever the hub
last pushed to it (see the [overview](overview.md)) — but it's the part of
the system responsible for actually getting someone's attention.

## Two kinds of device today

**The Android kiosk app** is where Dashboardz starts. It's a Kotlin/Compose
app built for phones and tablets you want to dedicate to this: it requires
Android 6.0 (API 23) or newer, has no dependency on Google Play Services,
and installs from a plain APK or from F-Droid.

**Any browser** works as a zero-install extra: open `http://<hub>:8484/device`
on whatever's around — a Raspberry Pi with a monitor, an old laptop, a tablet
propped on a shelf — and it's a device. No app to build, nothing to keep
updated.

## Pairing

1. In the hub's admin UI, open the **Devices** tab and add a device by name.
   This generates a 6-character pairing code and a QR code, both valid for 10
   minutes. The QR code encodes the hub's `PUBLIC_URL` plus the code.
2. On the device, scan that QR code (Android app) or type the code in by
   hand (the browser device page has no scanner — it takes the code only).
3. Pairing creates a starter screen for the device — a full-screen clock,
   assigned as its first tab — so it shows something editable immediately
   and starts receiving alerts. The admin's Screens tab offers to grow the
   starter into weather + calendar.

To re-pair a device later — a new device, a factory reset, whatever — use
**Settings → Unpair and pair again**. Pairing also runs in the other
direction: if an admin revokes a device from the hub side, the device isn't
left holding a dead connection — it drops back to the pairing surface on its
own.

## Tabs

Pairing assigns a device no screen at all — that's why a freshly paired
device shows the idle clock described above. A screen (or several) is
assigned afterward, and a device can hold up to sixteen of them as **tabs** —
a kitchen panel that shows the calendar most of the day and flips to a
security feed when someone's home, say. The device still holds no logic of
its own: the hub sends every tab's screen up front, and the device just
remembers which one a human tapped to last.

A device's tabs are an ordered list, one row per `(device, position)` in the
`device_screens` table, each row naming a screen and carrying an optional
operator-set label. Position 0 is not distinguished storage — it is simply
the first entry — which is why an ordinary single-screen assignment, with
exactly one row at position 0, already looks like a tabbed device with one
tab.

`PATCH /admin/api/devices/:id {"tabs": [{"screen_id": "...", "label":
"..."}]}` replaces the whole list in one write, the same convention a grid
PATCH uses for `cells`: there is no endpoint that adds, removes or reorders a
single tab, only one that says what the full list is now. An empty list
clears the device back to no screen at all, the same as `screen_id: null` for
a single-screen assignment.

The list tops out at sixteen entries, the same screen cannot appear twice,
and every screen named in it has to be the same orientation — landscape and
portrait boards cannot share one tab bar, because the bar itself has one
shape (see [the tabs wire contract](screens.md#tabs-on-the-wire) for what
that constraint buys the device). All of that is checked before the hub
writes anything: a request that tries to rename the device and set a bad tab
list in the same call does neither, rather than renaming and then failing
halfway. Sending `tabs` and the older `screen_id` in the same body is
rejected outright, since they say the same thing two different ways and the
request has to pick one.

`GET /admin/api/devices` lists each device's `tabs` in order, with the
screen's current name attached to each entry, and a `screen_id` field kept
alongside it for anything that only ever asked for one screen — that field is
never stored on its own any more, just tab 0's id, computed fresh on every
read.

`PATCH {"screen_id": "lay_XXX"}` (see [Assigning a screen to a
device](screens.md#assigning-a-screen-to-a-device)) and the MCP tool
`assign_screen` both keep working as single-tab sugar, exactly as they always
have: underneath, they now call the same machinery a multi-tab PATCH does — a
single-screen assignment is just a one-tab list — but from outside nothing
changed. No tabs, or one tab, is exactly the old behavior, on the wire and in
the admin API both.

The bar that lets a human switch tabs lives entirely on the device: a tap
picks a tab and repaints from whatever the hub already sent, with no round
trip back to the hub required for the switch to take effect, and the choice
survives a reload because the device remembers it locally. The device does
still tell the hub which tab is currently up, but purely for observability —
`GET /admin/api/devices`'s `rendering.active_screen_id` is the last tab a
device reported showing, useful for an admin UI to know what's actually on
the wall, and no part of the hub's push or acknowledgment logic waits on it.
See [the tabs wire contract](screens.md#tabs-on-the-wire) for how a screen
gets from the hub to that bar, and for how an active alert lights a dot on a
tab that isn't the one currently in front.

## Severity behaviour

`info` and `warn` alerts show up as cards. A `warn` chimes exactly once, the
moment the alert first arrives — never again for that same alert — unless its
sender asked for silence. An `info` is silent unless the screen this device is
showing asks to hear them, which is a checkbox on the alert feed widget and is
off by default: the sender has no say in it. Recomposing the UI, rotating the
device, or reconnecting and getting the same alert redelivered all stay silent;
a chime is also never played on top of a critical's own alarm.

A `critical` never expires. It holds the screen and keeps sounding until
somebody dismisses it — a TTL that quietly retired an alarm in an empty house
would defeat the point of raising one.

`critical` is different in kind, not just in color. It's a full-screen
takeover: the device wakes up, audio plays on the alarm stream (which is what
lets it bypass Do Not Disturb), and the volume escalates over the first 30
seconds rather than starting at full blast. The Android app can also force
the device's alarm volume to maximum for the duration — on by default — and
restores whatever it was before, durably enough that even a force-stopped app
repairs the volume the next time it's opened. Dismissing a critical is
deliberately two-stage: a tap anywhere silences the alarm but leaves the card
up, and only a 1-second hold on the Dismiss control actually clears it. That
gap exists so a stray tap while reaching for the phone doesn't erase an alert
nobody's read yet.

The gap has a consequence worth knowing: an alert that was silenced but never
held-to-dismiss is quiet and still **active**, so it keeps its tab's severity
dot lit until somebody concludes it. The admin console's **Alerts** tab is
where you see exactly that — every active alert, which device left it silenced
or never received it, and which screens it is colouring — and clear it from
another room. Dismissing there does what a hold on the panel does: the alert
concludes, the devices are told, the dots re-derive.

## Sound

Which sound family plays for which event — critical, warn, info, offline, activity — is resolved by
the hub, not the device: a [theme suggests a mapping and a screen can override it](../theming.md#sound),
and the hub folds theme, override and `classic` (the family with no files, reproducing the
pre-0.4 tones) into the mapping it actually pushes. Because that mapping lives on the *screen*,
not the device, a device with more than one [tab](#tabs) can genuinely sound different depending
on which tab is showing when an alert lands — the same rule that already governed whether an info
alert chimes (`sound_info`, above) governs every event *except one*: the visible tab's screen
decides.

**`activity` (stream-activity contract) is the one exception, deliberately: any tab subscribes, not just the visible
one.** It's the fifth event, a soft tick for a stream widget (`stream_list`/`table`) that opted in
via `chime_activity` — the exact sibling of `sound_info` above, on a stream cell instead of
`alert_feed`. If *any* of a device's tabs carries an opted-in cell bound to a feed that just
received a non-snapshot `DATA` push, the device ticks, whether or not that tab is the one on
screen. This is safe where the alert-routing problem was not: an opted-in cell belongs to exactly
one screen, so there's no ownership to arbitrate the way there is for an alert that could in
principle belong to several tabs at once.

Voice still has to come from *somewhere*, and the answer is the **carrying screen**: the resolved
`sounds.activity` of whichever screen owns the opted-in cell that matched. When more than one tab
carries a match, the visible tab's own voice wins if the visible tab is itself a carrier; otherwise
it's the first carrying tab in tab order. That resolution rule is identical on both device kinds;
playback of it is not, in this release — a browser board plays whichever carrier's family it has
prefetched, sampled or not, but Android's v1 app keys its loaded samples to the **visible** screen,
so a carrying tab's file only plays when its family matches the visible screen's own `activity`
family, and any other carrier's voice degrades to the generic soft programmatic beep even when that
family's file is already cached on-device. A `DATA` push with `snapshot: true` (a reconnect resync)
never ticks — silence-on-reconnect falls straight out of the wire shape, since a snapshot row
carries no identity to diff against. One tick plays per qualifying push regardless of how many
feeds or rows it touched (the same collapse discipline a chime uses), and a device-local,
in-memory, **unpersisted** 2.5-second cooldown sits on top of that: a push landing inside the gap is
dropped, not deferred, and — this is the part worth being exact about — **only a tick that actually
plays advances the cooldown clock.** A push that arrives during the gap and gets dropped does not
reset the timer; if it did, a sufficiently chatty stream could push the next real tick out
indefinitely instead of the intended fixed 2.5 s gap between sounds. No tick plays while a critical
alarm is sounding, and the tick itself loads into the alarm pool and obeys the alarm volume slider
(alarm-volume rule) — it can be inaudible by design if that slider is turned down. A 0.4 Android app is unaffected
either way: it receives `activity` in `WireScreen.sounds` like any additive wire field and simply
never looks it up — the feature needs app 0.5 to be heard.

Both device kinds cache what they need rather than fetching on every play — the Android app keeps
downloaded samples on disk, keyed by the hub's revision number so a stale sample is never reused
after a re-upload; a browser tab keeps decoded buffers in memory for the session. Either one falls
back to the same programmatic tone the device has always made the instant a sample isn't there yet
— not yet downloaded, a fetch that failed, or a hub too old to have sent a mapping at all — so a
missing file degrades the *sound*, never the alert. `classic` itself is that programmatic tone; it
has nothing to fetch in the first place.

An admin can audition a family/event pair on an online device directly from the Screens page
(`POST /admin/api/devices/:id/play-sound`) — a one-shot push, not a screen change, so it never
touches whatever the device is actually assigned to show.

## Options

An alert can carry up to four option buttons (each an `{id, label}` pair).
When one is attached, the device renders the buttons directly on the card —
or on the takeover, for a critical — and a tap sends that answer back through
the hub, which records it and, on the relay path, forwards it on to whichever
sender is waiting for a reply.

## Power and sleep

A panel stays connected only if the phone lets it. The Android app does its
part — the connection lives in a foreground service that the OS restarts if
it kills it, and again after a reboot — but Android's power management
outranks the app, and on an unplugged phone it wins.

**The rule that matters: keep the panel plugged in.** Doze only engages on a
device that is unplugged with its screen off. While charging it never starts,
and none of the mitigations below are load-bearing.

| Situation | What to expect |
|---|---|
| Plugged in, *Keep screen on* | Connected indefinitely. Battery and charging state report to the hub every 15 minutes. |
| Plugged in, screen sleeping | The service keeps listening and a critical still wakes the screen. The bedside case. |
| **Unplugged, screen off** | Doze parks wifi and the connection dies **silently** — no board, no alarm, and nothing on the glass saying so. |
| Locked screen | Nothing stops on lock. The service is untouched; a critical still takes over the lock screen. |
| Network comes back | Reconnects the moment the platform reports a network, without sitting out the remaining backoff. |
| While offline | Retries on exponential backoff, 1 s to 60 s, jittered so a fleet doesn't reconnect in lockstep. |

Locking the phone does **not** disconnect it. If a locked panel goes offline,
it was unplugged — check the cable before anything else.

### What a locked screen still does

The link is designed to survive: the app pings every 20 seconds and the hub
every 30, so a silently dead socket is detected rather than waited on. A
critical arrives as a high-importance full-screen-intent notification — the
only mechanism modern Android sanctions for waking a sleeping screen from the
background — and the app shows over the keyguard, lights the display and
sounds the alarm.

One caveat: if the *full-screen intent* permission has been withheld (some
OEMs default it off, and it can be revoked on Android 14+), a critical will
**not** wake a sleeping screen. It degrades to a heads-up notification that
only appears if the phone is already awake. The app logs this and adds a
"grant" button to the notification, but nothing at the wall will tell you.

### The two grants that decide panel behaviour

Both are offered on a checklist right after pairing, and stay reachable from
settings afterwards.

- **Ignore battery optimizations** — without it, an unplugged panel has its
  wifi parked and the board goes dark in silence.
- **Display over other apps** — without it, a critical cannot take over the
  screen while another app is in front.

Above the standard exemption sits the manufacturer's own layer — Samsung's
"put unused apps to sleep" being the usual offender — which ignores the
Android setting entirely. Settings has an *Open manufacturer battery
settings…* shortcut for it.

### Controls

Two-finger swipe down on the board opens settings.

| Control | Default | Effect |
|---|---|---|
| Keep screen on (dimmed when idle) | on | The wall-panel mode. Off means the screen sleeps normally and a critical wakes it. |
| Keep full brightness (never dim) | off | Pins the panel at full brightness while idle. By default the system brightness slider owns idle brightness; criticals force full brightness either way. |
| Beep when the hub connection drops | **off** | An audible signal that the panel has lost the hub. Worth turning on for any panel you actually rely on — otherwise a dropped connection is silent. |
| Force alarm volume to maximum for criticals | on | Raises the alarm stream for a critical, then restores it. |
| Ignore battery optimizations | needs grant | See above. |
| Display over other apps | needs grant | See above. |

## Honest limitations

!!! warning "Read this before you rely on either device type"
    - **An unplugged Android panel with its screen off will go dark in
      silence.** Doze parks its wifi, the connection drops, and nothing on
      the panel says so — the board just stops updating. Keep panels plugged
      in, grant the battery-optimization exemption, and turn on *Beep when
      the hub connection drops* if you rely on one. See
      [Power and sleep](#power-and-sleep).
    - **Browsers mute audio until you've touched the page.** This isn't a
      Dashboardz bug — every browser blocks autoplaying audio until there's
      been at least one interaction with the page in that session. After a
      cold start (a fresh tab, a reboot, restarting a kiosk browser), the
      alarm sound stays muted until you tap the screen once; after that, it
      plays normally for the rest of the session. Give a freshly paired or
      freshly restarted screen one tap before you rely on it to make noise.
    - **The Android takeover only auto-launches when the screen is off or
      locked.** That's the platform-sanctioned mechanism it uses, and it's
      also the intended way to run this app: dedicated, foregrounded, acting
      as a kiosk. If the phone is unlocked with some other app already in
      front, Android downgrades a critical to a heads-up notification instead
      — no alarm, no takeover. Treat "app in the foreground" as the design
      center, not an edge case to route around.
    - **One device per device token.** A device's pairing token is a single
      seat, not a broadcast group. If a second device pairs using the same
      token, it takes the slot — the first device is disconnected and stops
      retrying rather than fighting over who gets to display the alert.
