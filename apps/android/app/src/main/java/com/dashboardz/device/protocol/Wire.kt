package com.dashboardz.device.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

// Wire field names intentionally mirror the hub's snake_case JSON exactly (see the protocol
// contract in the plan). Renaming them to camelCase would require @SerialName on every field
// and is a silent-drift hazard against a contract that is test-locked on the hub side.

@Serializable
data class WireSender(val id: String, val name: String)

@Serializable
data class WireDevice(
    val id: String,
    val name: String,
    val orientation: String = "landscape",
    /**
     * What this device does with its system bars (hub schema v17). The hub owns it. The default
     * keeps older hub messages decodable, and an unrecognised value from a NEWER hub degrades to
     * today's behaviour rather than throwing.
     */
    val nav_bars: String = "respected",
)

@Serializable
data class WireOption(val id: String, val label: String)

@Serializable
data class WireAlert(
    val id: String,
    val title: String,
    val body: String? = null,
    val severity: String,
    val sender: WireSender,
    val sound: Boolean = false,
    val created_at: Long,
    val updated_at: Long,
    val update_count: Int = 0,
    val expires_at: Long? = null,
    // Only meaningful inside STATE. ALERT_ADD omits it, and an omitted value means "not
    // silenced" — which is exactly right, since an ALERT_ADD always implies unsilenced.
    val silenced: Boolean = false,
    // Answer options (≤4, hub-enforced). Absent/null and [] are different wire values — an
    // ordinary alert carries null, so the default must stay null and never collapse to
    // emptyList(); the hub's WireAlert.options is `AlertOption[] | null` for the same reason.
    val options: List<WireOption>? = null,
)

// Layout wire types. widget/orientation are plain Strings and
// config is a raw JsonObject: an unknown value must degrade at render time (loud placeholder),
// never fail the decode — an @Serializable enum here would null the entire STATE unless it
// carried a default (coerceInputValues covers a defaulted enum's null/unknown member, per Codec
// below, but not an undefaulted one).
//
// WireRect mirrors core/Layout.kt's Rect, but every field is a raw JsonElement: a type-mismatched
// field (`"x": null`, `"x": "0.5"`) must not fail the decode, because decodeServer returning null
// discards the entire STATE — the alerts with it. asWireNumber below applies the browser's exact
// `typeof v === 'number'` guard, and safeRect coerces the result at render time, same as the twin.
@Serializable
data class WireRect(
    val x: JsonElement? = null,
    val y: JsonElement? = null,
    val w: JsonElement? = null,
    val h: JsonElement? = null,
) {
    // Read as Double? for safeRect, which applies the 0.0/0.0/1.0/1.0 defaults for missing values;
    // well-formed input is bit-identical.
    val xOrNull: Double? get() = x.asWireNumber()
    val yOrNull: Double? get() = y.asWireNumber()
    val wOrNull: Double? get() = w.asWireNumber()
    val hOrNull: Double? get() = h.asWireNumber()
}

/**
 * Exact twin of layout-core.mjs's `num(v, dflt)` guard: `typeof v === 'number' &&
 * Number.isFinite(v)`. Only an unquoted, finite JSON number counts, and this closes two
 * distinct failure modes the old non-nullable `Double = 0.0` field (pre-WireRect) had. `null`,
 * a boolean, an object and an array would throw during decode, discarding the whole STATE
 * (alerts included) with it — the crash class. A quoted number like "0.5" would NOT throw:
 * kotlinx.serialization coerces a quoted numeric string into a `Double` unconditionally, so the
 * old field silently accepted 0.5 as the value instead — a silent divergence from the browser's
 * strict `typeof` guard, with no error to surface it. `isString` is what separates the quoted
 * literal from the bare number here, so all five inputs now read as absent and safeRect
 * substitutes its default for every one of them, instead of either failure mode reaching the
 * renderer.
 */
private fun JsonElement?.asWireNumber(): Double? =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

// Known twin divergence, accepted and unclosed — not an oversight. WireRect's FIELDS got the
// JsonElement treatment above, but the CONTAINERS around rect/config/cells did not, so a
// wrong-typed container still throws during decode and drops the whole STATE (alerts included),
// while the browser degrades: a `"rect": []` or `"rect": "x"` hits safeRect's full-bleed default
// on the browser (device.js) instead of WireCell's `rect: WireRect?`, which throws trying to
// deserialize a non-object JsonElement as WireRect; a `"config": 5` hits feedConfig's `{}`
// fallback (layout-core.mjs) instead of `config: JsonObject?`, which throws on a non-object;
// a `"cells": {}` hits the browser's `Array.isArray(...) ? ... : []` (device.js:421) instead of
// WireGrid's `cells: List<WireCell>`, which throws on a non-array. Closing this needs the same
// JsonElement-plus-explicit-reader treatment one level up, on each container — a change the size
// of the layout model's wire-tolerance contract, not something to fold into unrelated changes.
@Serializable
data class WireCell(val widget: String, val config: JsonObject? = null, val rect: WireRect? = null)

// `template` is gone — cells are no longer positional slots in
// a fixed grid; each carries its own `rect`. ignoreUnknownKeys in Codec below means an older/
// transitional hub still sending `template` decodes fine, the key is simply dropped.
@Serializable
data class WireGrid(val cells: List<WireCell> = emptyList())

@Serializable
data class WireScreen(
    val id: String,
    val name: String,
    val orientation: String = "landscape",
    // Defaulted, not required: a bare `"grid": null` must degrade to an empty layout, not throw
    // and discard the whole STATE — the alerts with it. Same crash class WireRect closed.
    val grid: WireGrid = WireGrid(),
    // theme ⊕ screen ⊕ classic (hub/src/sounds.ts resolveSounds), always all four events when
    // present. Nullable for the same reason `grid`'s defaulting is: an app that predates alert
    // sounds must ignore this key under ignoreUnknownKeys and keep behaving exactly as it does
    // today.
    val sounds: Map<String, String>? = null,
    // Manifest rev — a cache-buster for the family sound files, not tied to a theme's own rev.
    val sounds_rev: Long? = null,
)

@Serializable
sealed interface ServerMsg

@Serializable
@SerialName("STATE")
data class StateMsg(
    val device: WireDevice,
    val server_time: Long,
    val alerts: List<WireAlert>,
    // Every added field defaults so an older hub's STATE still decodes (tolerance discipline).
    val rev: Long = 0,
    val screen: WireScreen? = null,
    // The full tab set (design: multi-screen tabs). null on a hub that predates tabs; `screen`
    // above stays the single-screen field those hubs (and this shell's ack-fallback) still use.
    val screens: List<WireScreen>? = null,
) : ServerMsg

@Serializable
@SerialName("ALERT_ADD")
data class AlertAddMsg(val alert: WireAlert) : ServerMsg

@Serializable
@SerialName("ALERT_REMOVE")
data class AlertRemoveMsg(val id: String, val reason: String) : ServerMsg

// DATA wire message shape (design: widget feeds with multi-modal data, values/streams/images).
// Wire tolerance: mode is a String (never enum) and every field defaults, so unknown modes and
// missing fields degrade at render time, never kill the message. Snapshot flag marks full
// replacements vs incremental merges (reducer discipline in state merge behavior).
// pushed_at is nullable (image endpoint behavior), NOT `Long = 0`: a `Long = 0` default made a row
// whose JSON simply omits `pushed_at` indistinguishable from a row genuinely pushed at epoch 0 —
// wire tolerance still holds (a missing field degrades to null, never kills the message), but
// null is now a real, checkable "this row has no usable timestamp" signal instead of a silent 0.
@Serializable
data class WireFeedRow(val payload: JsonElement? = null, val pushed_at: Long? = null)

@Serializable
data class WireFeed(
    val mode: String = "value",
    val payload: JsonElement? = null,
    val rows: List<WireFeedRow> = emptyList(),
    val image_rev: Long = 0,
    val pushed_at: Long? = null,
    val stale_after_s: Long? = null,
)

@Serializable
@SerialName("DATA")
data class DataMsg(
    val server_time: Long,
    val feeds: Map<String, WireFeed> = emptyMap(),
    val snapshot: Boolean = false,
) : ServerMsg

@Serializable
@SerialName("PLAY_SOUND")
data class PlaySoundMsg(val family: String = "classic", val event: String = "warn") : ServerMsg

@Serializable
sealed interface ClientMsg

@Serializable
data class WireCaps(
    val kind: String = "android",
    val app_version: String,
    /**
     * The box the board is drawn into, in CSS pixels. Null when the shell has not measured
     * yet — the hub keeps whatever this device last reported rather than blanking it.
     */
    val viewport: WireViewport? = null,
)

/** CSS pixels, because layout, minimum sizes and type are all expressed in CSS pixels. */
@Serializable
data class WireViewport(val w: Int, val h: Int, val dpr: Float)

@Serializable
@SerialName("HELLO")
data class Hello(val token: String, val caps: WireCaps) : ClientMsg

@Serializable
@SerialName("ACK")
data class Ack(val id: String, val stage: String) : ClientMsg

@Serializable
@SerialName("TAP")
// option_id rides only on action == "answer"; explicitNulls = false in Codec keeps it off the
// wire entirely for silence/dismiss taps, exactly as the hub expects.
data class Tap(val id: String, val action: String, val option_id: String? = null) : ClientMsg

@Serializable
@SerialName("TAB")
// The board's screen-switch signal (design: multi-screen tabs). The hub validates screen_id
// against the STATE's screens list and is the source of truth for which one is active — this
// shell just forwards the tap (sendFromBoard's Codec.decodeClient is what lets it through at
// all; an unrecognised ClientMsg type is dropped there).
data class Tab(val screen_id: String) : ClientMsg

@Serializable
@SerialName("STATE_ACK")
// Layout-application receipt (design: STATE acknowledgment). Distinct from the per-alert ACK.
// screen_id null = default layout; explicitNulls=false omits the key, hub treats absent as null.
// screen_ids mirrors STATE.screens back as a receipt for the whole set (design: multi-screen
// tabs); null on a hub that predates tabs, same tolerance discipline as screen_id.
data class StateAck(val rev: Long, val screen_id: String? = null, val screen_ids: List<String>? = null) : ClientMsg

@Serializable
@SerialName("HEALTH")
data class Health(val battery: Int? = null, val charging: Boolean? = null) : ClientMsg

object Codec {
    private val json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true   // a newer hub may add fields; that must not break an old app
        // An explicit null on a defaulted field degrades to that default rather than discarding
        // the whole message. Covers null -> default and unknown enum members ONLY: a wrong-shaped
        // value (e.g. an object where a Long is expected), or a null on a field with no default,
        // still fails the decode — see coercionHasLimits_* in CodecTest. Fields that must
        // tolerate more get the WireRect treatment (raw JsonElement + an explicit reader), not a
        // broader flag here. NOT covered, and not this flag's doing either way: a quoted number
        // for a numeric field. kotlinx.serialization coerces that unconditionally regardless of
        // this flag — a separate, pre-existing library leniency (see coercionHasLimits_*).
        coerceInputValues = true
        encodeDefaults = true      // so caps.kind = "android" is actually sent
        explicitNulls = false      // omit null battery/charging rather than sending nulls
    }

    /** Returns null for anything unparseable or unrecognised — never throws. */
    fun decodeServer(text: String): ServerMsg? =
        try {
            json.decodeFromString<ServerMsg>(text)
        } catch (_: Exception) {
            null
        }

    fun encode(msg: ClientMsg): String = json.encodeToString<ClientMsg>(msg)

    /**
     * Parse a message the BOARD wants to send us onward to the hub. Same null-for-junk contract as
     * decodeServer.
     *
     * A hosted renderer is a less trusted surface than native code -- it is a web page, loaded over
     * the network, running someone else's JS engine. Decoding into ClientMsg here means it can only
     * ever emit messages the protocol actually defines: anything else is dropped at this boundary
     * rather than forwarded to the hub verbatim.
     */
    fun decodeClient(text: String): ClientMsg? =
        try {
            json.decodeFromString<ClientMsg>(text)
        } catch (_: Exception) {
            null
        }
}
