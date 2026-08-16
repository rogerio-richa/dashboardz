package com.dashboardz.device.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodecTest {

    private val stateJson = """
        {"type":"STATE","device":{"id":"scr_1","name":"bedside"},"server_time":1785268000000,
         "alerts":[{"id":"alr_1","title":"Disk 91%","body":"used 218 GB","severity":"warn",
                    "sender":{"id":"snd_1","name":"Netdata"},"sound":true,
                    "created_at":1785267000000,"updated_at":1785268000000,
                    "update_count":2,"expires_at":null,"silenced":true}]}
    """.trimIndent()

    @Test
    fun decodesState() {
        val msg = Codec.decodeServer(stateJson) as StateMsg
        assertEquals("scr_1", msg.device.id)
        assertEquals("bedside", msg.device.name)
        assertEquals(1785268000000L, msg.server_time)
        val a = msg.alerts.single()
        assertEquals("alr_1", a.id)
        assertEquals("Netdata", a.sender.name)
        assertEquals(2, a.update_count)
        assertTrue(a.sound)
        assertTrue(a.silenced)
        assertNull(a.expires_at)
    }

    @Test
    fun decodesAlertAddAndRemove() {
        val add = Codec.decodeServer("""
            {"type":"ALERT_ADD","alert":{"id":"alr_2","title":"t","body":null,"severity":"critical",
             "sender":{"id":"s","name":"S"},"sound":true,"created_at":1,"updated_at":2,
             "update_count":0,"expires_at":null}}
        """.trimIndent()) as AlertAddMsg
        assertEquals("alr_2", add.alert.id)
        // `silenced` is absent on ALERT_ADD and must default to false, never crash.
        assertEquals(false, add.alert.silenced)

        val rm = Codec.decodeServer("""{"type":"ALERT_REMOVE","id":"alr_2","reason":"expired"}""") as AlertRemoveMsg
        assertEquals("alr_2", rm.id)
        assertEquals("expired", rm.reason)
    }

    @Test
    fun decodesAlertOptions() {
        val add = Codec.decodeServer("""
            {"type":"ALERT_ADD","alert":{"id":"alr_3","title":"Door open","body":null,"severity":"warn",
             "sender":{"id":"s","name":"S"},"sound":true,"created_at":1,"updated_at":2,
             "update_count":0,"expires_at":null,
             "options":[{"id":"taken","label":"Taken"},{"id":"skip","label":"Skip today"}]}}
        """.trimIndent()) as AlertAddMsg
        assertEquals(
            listOf(WireOption("taken", "Taken"), WireOption("skip", "Skip today")),
            add.alert.options,
        )
    }

    @Test
    fun absentOptionsDecodeToNullNotEmptyList() {
        // Absent and empty are different values on the wire: an ordinary alert has no `options`
        // key at all and must decode to null, while an explicit `[]` must stay an empty list.
        val absent = Codec.decodeServer("""
            {"type":"ALERT_ADD","alert":{"id":"alr_4","title":"t","body":null,"severity":"info",
             "sender":{"id":"s","name":"S"},"sound":false,"created_at":1,"updated_at":2,
             "update_count":0,"expires_at":null}}
        """.trimIndent()) as AlertAddMsg
        assertNull(absent.alert.options)

        // The hub's toWireAlert also serialises `options: null` explicitly for ordinary alerts.
        val explicitNull = Codec.decodeServer("""
            {"type":"ALERT_ADD","alert":{"id":"alr_5","title":"t","body":null,"severity":"info",
             "sender":{"id":"s","name":"S"},"sound":false,"created_at":1,"updated_at":2,
             "update_count":0,"expires_at":null,"options":null}}
        """.trimIndent()) as AlertAddMsg
        assertNull(explicitNull.alert.options)

        val empty = Codec.decodeServer("""
            {"type":"ALERT_ADD","alert":{"id":"alr_6","title":"t","body":null,"severity":"info",
             "sender":{"id":"s","name":"S"},"sound":false,"created_at":1,"updated_at":2,
             "update_count":0,"expires_at":null,"options":[]}}
        """.trimIndent()) as AlertAddMsg
        assertEquals(emptyList<WireOption>(), empty.alert.options)
    }

    @Test
    fun encodesAnswerTapWithOptionIdInDeclarationOrder() {
        // Exact string, not a field-by-field check: the hub parses this JSON as-is, and the
        // declaration order (type, id, action, option_id) is part of the locked wire shape.
        assertEquals(
            """{"type":"TAP","id":"alr_1","action":"answer","option_id":"taken"}""",
            Codec.encode(Tap(id = "alr_1", action = "answer", option_id = "taken")),
        )
    }

    @Test
    fun toleratesUnknownFieldsFromANewerHub() {
        val msg = Codec.decodeServer("""
            {"type":"ALERT_REMOVE","id":"a","reason":"revoked","future_field":{"nested":1}}
        """.trimIndent())
        assertEquals("a", (msg as AlertRemoveMsg).id)
    }

    @Test
    fun returnsNullForGarbageInsteadOfThrowing() {
        assertNull(Codec.decodeServer("not json at all"))
        assertNull(Codec.decodeServer(""))
        assertNull(Codec.decodeServer("null"))
        assertNull(Codec.decodeServer("[1,2,3]"))
        assertNull(Codec.decodeServer("""{"type":"SOMETHING_NEW","x":1}"""))
        assertNull(Codec.decodeServer("""{"type":"STATE"}"""))            // missing required fields
        assertNull(Codec.decodeServer("""{"type":"ALERT_ADD","alert":{"id":"x"}}"""))
    }

    @Test
    fun encodesClientMessagesWithTypeDiscriminator() {
        assertEquals(
            """{"type":"HELLO","token":"dbz_c_x","caps":{"kind":"android","app_version":"0.1"}}""",
            Codec.encode(Hello(token = "dbz_c_x", caps = WireCaps(app_version = "0.1"))),
        )
        assertEquals(
            """{"type":"ACK","id":"alr_1","stage":"displayed"}""",
            Codec.encode(Ack(id = "alr_1", stage = "displayed")),
        )
        assertEquals(
            """{"type":"TAP","id":"alr_1","action":"silence"}""",
            Codec.encode(Tap(id = "alr_1", action = "silence")),
        )
        assertEquals(
            """{"type":"HEALTH","battery":42,"charging":true}""",
            Codec.encode(Health(battery = 42, charging = true)),
        )
    }

    @Test
    fun decodesStateWithScreenRevOrientationAndCellRect() {
        val json = """
            {"type":"STATE","device":{"id":"dev_1","name":"kitchen","orientation":"portrait"},
             "rev":3,
             "screen":{"id":"lay_1","name":"Board","orientation":"portrait",
                       "grid":{"cells":[
                         {"widget":"clock","config":{},"rect":{"x":0,"y":0,"w":0.5,"h":1}},
                         {"widget":"alert_feed","config":{"min_severity":"warn"},"rect":{"x":0.5,"y":0,"w":0.5,"h":1}}]}},
             "server_time":1000,"alerts":[]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        assertEquals(3L, msg.rev)
        assertEquals("portrait", msg.device.orientation)
        assertEquals("alert_feed", msg.screen!!.grid.cells[1].widget)
        val rect = msg.screen!!.grid.cells[0].rect!!
        assertEquals(0.0, rect.xOrNull!!, 0.0)
        assertEquals(0.0, rect.yOrNull!!, 0.0)
        assertEquals(0.5, rect.wOrNull!!, 0.0)
        assertEquals(1.0, rect.hOrNull!!, 0.0)
    }

    @Test
    fun stateWithNullGridStillDecodesAndKeepsItsAlerts() {
        // `WireScreen.grid` had no default, so `"grid": null` threw during decode and the WHOLE
        // STATE was discarded — alerts included. That is the exact data-loss mode this lane's
        // headline fix exists to close, and the browser twin degrades instead of dying, so this
        // must too. Assert the alert survives explicitly, not just that decode returned non-null.
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screen":{"id":"l","name":"s","orientation":"landscape","grid":null},
             "server_time":1,
             "alerts":[{"id":"alr_1","title":"t","body":null,"severity":"warn",
                        "sender":{"id":"s","name":"S"},"sound":false,"created_at":1,"updated_at":2,
                        "update_count":0,"expires_at":null}]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        assertEquals(emptyList<WireCell>(), msg.screen!!.grid.cells)
        assertEquals("alr_1", msg.alerts.single().id)
    }

    @Test
    fun stateWithoutScreenRevOrOrientationStillDecodes() {
        // An older hub omits all three: defaults must absorb it — a missing field must never
        // null the whole message (that would take the alerts down with it).
        val msg = Codec.decodeServer(stateJson) as StateMsg
        assertEquals(0L, msg.rev)
        assertEquals("landscape", msg.device.orientation)
        assertEquals(null, msg.screen)
    }

    @Test
    fun unknownWidgetSurvivesDecodeAndAMissingRectDefaultsToNull() {
        // Sabotage guard for the unknown-widget rule: the codec must pass unknown strings
        // through so the renderer can show the loud placeholder — not fail the decode. A cell
        // with no `rect` key at all (an older hub, or a not-yet-migrated board) must default to
        // null rather than kill the message (wire tolerance house rule) — safeRect coerces a
        // null rect into something on-screen at render time.
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screen":{"id":"l","name":"s","orientation":"landscape",
                       "grid":{"cells":[{"widget":"hologram","config":{"x":1}}]}},
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        assertEquals("hologram", msg.screen!!.grid.cells[0].widget)
        assertNull(msg.screen!!.grid.cells[0].rect)
    }

    @Test
    fun encodesStateAckWithAndWithoutScreenId() {
        assertEquals(
            """{"type":"STATE_ACK","rev":7,"screen_id":"lay_1"}""",
            Codec.encode(StateAck(rev = 7, screen_id = "lay_1")),
        )
        // explicitNulls = false: default layout omits the key entirely; the hub treats absent
        // as null (STATE acknowledgment).
        assertEquals(
            """{"type":"STATE_ACK","rev":7}""",
            Codec.encode(StateAck(rev = 7, screen_id = null)),
        )
    }

    @Test
    fun decodesTabAndEncodesStateAckWithScreenIds() {
        val tab = Codec.decodeClient("""{"type":"TAB","screen_id":"lay_2"}""") as Tab
        assertEquals("lay_2", tab.screen_id)

        assertEquals(
            """{"type":"STATE_ACK","rev":7,"screen_id":"lay_1","screen_ids":["lay_1","lay_2"]}""",
            Codec.encode(StateAck(rev = 7, screen_id = "lay_1", screen_ids = listOf("lay_1", "lay_2"))),
        )
        // explicitNulls = false: a hub that predates tabs gets an ack with no screen_ids key.
        assertEquals(
            """{"type":"STATE_ACK","rev":7,"screen_id":"lay_1"}""",
            Codec.encode(StateAck(rev = 7, screen_id = "lay_1", screen_ids = null)),
        )
    }

    @Test
    fun decodesStateWithScreensList() {
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screens":[{"id":"lay_1","name":"A","orientation":"landscape","grid":{"cells":[]}},
                        {"id":"lay_2","name":"B","orientation":"landscape","grid":{"cells":[]}}],
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        assertEquals(listOf("lay_1", "lay_2"), msg.screens?.map { it.id })
    }

    @Test
    fun stateWithoutScreensStillDecodesAndDefaultsToNull() {
        // An older hub omits `screens` entirely: must default to null, never fail the decode
        // (tolerance discipline).
        val msg = Codec.decodeServer(stateJson) as StateMsg
        assertNull(msg.screens)
    }

    @Test
    fun decodesDataWithValueStreamAndImageFeeds() {
        val msg = Codec.decodeServer(
            """{"type":"DATA","server_time":1754088000000,"feeds":{""" +
                """"feed_a":{"mode":"value","payload":{"cpu":37.2},"pushed_at":1754087990000,"stale_after_s":120},""" +
                """"feed_b":{"mode":"stream","rows":[{"payload":{"title":"x"},"pushed_at":1}],"stale_after_s":null},""" +
                """"feed_c":{"mode":"image","image_rev":4,"pushed_at":1754087990000,"stale_after_s":null}}}"""
        )
        val data = msg as DataMsg
        assertEquals(1754088000000L, data.server_time)
        assertEquals(120L, data.feeds.getValue("feed_a").stale_after_s)
        assertEquals(1, data.feeds.getValue("feed_b").rows.size)
        assertEquals(4L, data.feeds.getValue("feed_c").image_rev)
    }

    @Test
    fun dataFeedWithUnknownModeAndMissingFieldsStillDecodes() {
        // Wire tolerance: a future mode or absent fields must degrade, never kill the message.
        val msg = Codec.decodeServer(
            """{"type":"DATA","server_time":1,"feeds":{"feed_x":{"mode":"sparkline","novel_field":true}}}"""
        )
        val feed = (msg as DataMsg).feeds.getValue("feed_x")
        assertEquals("sparkline", feed.mode)
        assertNull(feed.payload)
        assertNull(feed.pushed_at)
    }

    @Test
    fun dataWithNullPayloadNeverPushedFeedDecodes() {
        val msg = Codec.decodeServer("""{"type":"DATA","server_time":1,"feeds":{"feed_a":{"mode":"value","payload":null,"pushed_at":null,"stale_after_s":null}}}""")
        assertNull((msg as DataMsg).feeds.getValue("feed_a").payload)
    }

    @Test
    fun dataMessageWithSnapshotFlagDecodes() {
        val msg = Codec.decodeServer(
            """{"type":"DATA","server_time":1754088000000,"feeds":{"feed_a":{"mode":"value"}},"snapshot":true}"""
        )
        val data = msg as DataMsg
        assertEquals(true, data.snapshot)
    }

    @Test
    fun dataMessageWithoutSnapshotFlagDefaultsToFalse() {
        val msg = Codec.decodeServer(
            """{"type":"DATA","server_time":1754088000000,"feeds":{"feed_a":{"mode":"value"}}}"""
        )
        val data = msg as DataMsg
        assertEquals(false, data.snapshot)
    }

    @Test
    fun aNullRectFieldDegradesToTheDefaultInsteadOfKillingTheState() {
        // Wire tolerance house rule: decodeServer returning null discards the WHOLE message —
        // the alerts go down with the screen. The browser twin coerces this exact input
        // (layout-core.test.ts: safeRect({x:'a', y:null, ...})), so the app must too.
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screen":{"id":"l","name":"s","orientation":"landscape",
                       "grid":{"cells":[{"widget":"clock","config":{},
                                         "rect":{"x":null,"y":0,"w":0.5,"h":1}}]}},
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        val rect = msg.screen!!.grid.cells[0].rect!!
        assertNull(rect.xOrNull)
        assertEquals(0.5, rect.wOrNull!!, 0.0)
    }

    @Test
    fun aStringRectFieldReadsAsAbsent_matchingTheBrowsersTypeofNumberGuard() {
        // layout-core.mjs's num() accepts ONLY `typeof v === 'number'`, so "0.5" falls back to
        // the default there. The twin must not be more permissive, or the two renderers place
        // the same board differently.
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screen":{"id":"l","name":"s","orientation":"landscape",
                       "grid":{"cells":[{"widget":"clock","config":{},
                                         "rect":{"x":"0.5","y":0,"w":true,"h":{}}}]}},
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        val rect = msg.screen!!.grid.cells[0].rect!!
        assertNull(rect.xOrNull)   // quoted number
        assertNull(rect.wOrNull)   // boolean
        assertNull(rect.hOrNull)   // object
        assertEquals(0.0, rect.yOrNull!!, 0.0)  // the one well-formed field still reads
    }

    @Test
    fun aNonFiniteRectFieldReadsAsAbsent_matchingTheBrowsersIsFiniteGuard() {
        // layout-core.test.ts:425 pins safeRect({ x: 'a', y: null, w: NaN, h: 0.5 }): a non-finite
        // number must read as absent, not as a value, same as the string/boolean/object cases
        // above — otherwise the twins render different boards for the same wire input. JSON has
        // no NaN/Infinity literal, but an overflow exponent like 1e400 is syntactically a valid
        // JSON number that parses to Double.POSITIVE_INFINITY, exercising the same isFinite() gate.
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screen":{"id":"l","name":"s","orientation":"landscape",
                       "grid":{"cells":[{"widget":"clock","config":{},
                                         "rect":{"x":0,"y":0,"w":1e400,"h":0.5}}]}},
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val rect = (Codec.decodeServer(json) as StateMsg).screen!!.grid.cells[0].rect!!
        assertNull(rect.wOrNull)   // non-finite
        assertEquals(0.5, rect.hOrNull!!, 0.0)  // the one well-formed field still reads
    }

    @Test
    fun aWellFormedRectStillReadsEveryField() {
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":"landscape"},"rev":1,
             "screen":{"id":"l","name":"s","orientation":"landscape",
                       "grid":{"cells":[{"widget":"clock","config":{},
                                         "rect":{"x":0,"y":0.25,"w":0.5,"h":1}}]}},
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val rect = (Codec.decodeServer(json) as StateMsg).screen!!.grid.cells[0].rect!!
        assertEquals(0.0, rect.xOrNull!!, 0.0)
        assertEquals(0.25, rect.yOrNull!!, 0.0)
        assertEquals(0.5, rect.wOrNull!!, 0.0)
        assertEquals(1.0, rect.hOrNull!!, 0.0)
    }

    @Test
    fun anExplicitNullOnADefaultedFieldCoercesToTheDefault() {
        // `rev` is `Long = 0`. A hub bug or a hand-edited row sending null must degrade to the
        // default, not discard the STATE and take every alert with it.
        val json = """
            {"type":"STATE","device":{"id":"d","name":"n","orientation":null},"rev":null,
             "server_time":1,"alerts":[]}
        """.trimIndent()
        val msg = Codec.decodeServer(json) as StateMsg
        assertEquals(0L, msg.rev)
        assertEquals("landscape", msg.device.orientation)
    }

    @Test
    fun coercionHasLimits_aNonDefaultedFieldAndAWrongTypedValueStillFailTheDecode() {
        // Deliberate boundary pin. coerceInputValues covers null -> default and unknown enum
        // members. It does NOT invent a value for a field with no default, and it does NOT
        // accept a wrong-shaped value (an object where a Long is expected). Anything relying
        // on either must be fixed structurally, the way WireRect was — do not read the flag
        // as blanket wire tolerance.
        //
        // A quoted number is deliberately NOT used here as the "wrong type" case: this
        // project's kotlinx.serialization (1.9.0) coerces a quoted numeric string into a
        // numeric field unconditionally, with or without coerceInputValues and regardless of
        // isLenient — a separate, pre-existing library leniency that has nothing to do with
        // this flag. `"server_time":"1"` decodes fine on this version; it is not a
        // counterexample to anything above, and a future reader should not be surprised by it.
        val noDefault = """
            {"type":"STATE","device":{"id":"d","name":"n"},"server_time":null,"alerts":[]}
        """.trimIndent()
        assertNull(Codec.decodeServer(noDefault))
        val wrongShape = """
            {"type":"STATE","device":{"id":"d","name":"n"},"server_time":{},"alerts":[]}
        """.trimIndent()
        assertNull(Codec.decodeServer(wrongShape))

        // Pin the library behaviour above in code, not just prose: unknown fields are ignored by
        // kotlinx.serialization. If a future kotlinx version makes numeric parsing strict, this
        // assertion — not a stale comment — is what catches it.
        assertNotNull(Codec.decodeServer("""{"type":"STATE","device":{"id":"d","name":"n"},"server_time":"1","alerts":[]}"""))
    }

    @Test
    fun stateCarriesScreenSounds() {
        val msg = Codec.decodeServer("""{"type":"STATE","device":{"id":"d","name":"n"},"server_time":1,"alerts":[],
            "screen":{"id":"s","name":"k","sounds":{"critical":"bells","warn":"8bit","info":"classic","offline":"classic"},"sounds_rev":3}}""")
        val state = msg as StateMsg
        assertEquals("bells", state.screen?.sounds?.get("critical"))
        assertEquals(3L, state.screen?.sounds_rev)
    }

    @Test
    fun screenWithoutSoundsStillDecodes() {
        val msg = Codec.decodeServer("""{"type":"STATE","device":{"id":"d","name":"n"},"server_time":1,"alerts":[],"screen":{"id":"s","name":"k"}}""")
        assertNull((msg as StateMsg).screen?.sounds)
    }

    @Test
    fun playSoundDecodes() {
        val msg = Codec.decodeServer("""{"type":"PLAY_SOUND","family":"bells","event":"critical"}""")
        assertEquals(PlaySoundMsg("bells", "critical"), msg)
    }
}
