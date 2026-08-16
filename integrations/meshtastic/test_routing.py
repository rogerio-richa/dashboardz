"""Tests for the pure routing logic. Run: python3 -m unittest test_routing -v"""
from __future__ import annotations

import unittest

import routing


def route(**kw):
    base = {"label": "r", "feed_id": "feed_x", "channels": [], "from": [], "sound": "chime"}
    base.update(kw)
    return base


class MatchingTests(unittest.TestCase):
    def test_empty_channels_and_from_matches_anything(self):
        r = route()
        self.assertTrue(routing.matches(r, channel=3, from_id="!aabbccdd"))

    def test_channel_list_restricts_to_listed_channels(self):
        r = route(channels=[0, 2])
        self.assertTrue(routing.matches(r, channel=0, from_id="!aabbccdd"))
        self.assertFalse(routing.matches(r, channel=1, from_id="!aabbccdd"))

    def test_from_list_restricts_to_listed_senders(self):
        r = route(**{"from": ["!11223344"]})
        self.assertTrue(routing.matches(r, channel=0, from_id="!11223344"))
        self.assertFalse(routing.matches(r, channel=0, from_id="!aabbccdd"))

    def test_channel_and_from_must_both_match(self):
        r = route(channels=[1], **{"from": ["!11223344"]})
        self.assertTrue(routing.matches(r, channel=1, from_id="!11223344"))
        self.assertFalse(routing.matches(r, channel=0, from_id="!11223344"))
        self.assertFalse(routing.matches(r, channel=1, from_id="!aabbccdd"))

    def test_matching_routes_returns_every_match_in_order(self):
        r1, r2, r3 = route(label="a"), route(label="b", channels=[9]), route(label="c")
        self.assertEqual(
            [r["label"] for r in routing.matching_routes([r1, r2, r3], channel=0, from_id="!x")],
            ["a", "c"],
        )


class PacketChannelTests(unittest.TestCase):
    def test_broadcast_packet_maps_to_its_channel_index(self):
        pkt = {"to": routing.BROADCAST_NUM, "channel": 2}
        self.assertEqual(routing.packet_channel(pkt), 2)

    def test_broadcast_without_channel_field_is_the_primary_channel(self):
        self.assertEqual(routing.packet_channel({"to": routing.BROADCAST_NUM}), 0)

    def test_direct_message_maps_to_the_direct_pseudo_channel(self):
        # The leak this guards against: a DM carries channel 0 (or no channel field at all),
        # exactly like a message on the primary channel. Destination is the only discriminator.
        pkt = {"to": 0x11223344, "channel": 0}
        self.assertEqual(routing.packet_channel(pkt), routing.DIRECT)

    def test_packet_without_to_is_treated_as_broadcast(self):
        self.assertEqual(routing.packet_channel({"channel": 1}), 1)

    def test_direct_pseudo_channel_never_matches_a_channel_route(self):
        r = route(channels=[0])
        self.assertFalse(routing.matches(r, channel=routing.DIRECT, from_id="!11223344"))

    def test_direct_pseudo_channel_still_matches_an_any_channel_route(self):
        self.assertTrue(routing.matches(route(), channel=routing.DIRECT, from_id="!11223344"))


class SoundTests(unittest.TestCase):
    def test_loudest_sound_picks_alarm_over_chime_over_silent(self):
        self.assertEqual(routing.loudest_sound([route(sound="silent")]), "silent")
        self.assertEqual(
            routing.loudest_sound([route(sound="silent"), route(sound="chime")]), "chime")
        self.assertEqual(
            routing.loudest_sound(
                [route(sound="chime"), route(sound="alarm"), route(sound="silent")]),
            "alarm",
        )

    def test_loudest_sound_of_no_routes_is_silent(self):
        self.assertEqual(routing.loudest_sound([]), "silent")

    def test_severity_for_sound(self):
        self.assertEqual(routing.severity_for("chime"), "info")
        self.assertEqual(routing.severity_for("alarm"), "critical")
        self.assertIsNone(routing.severity_for("silent"))


class NormalizeTests(unittest.TestCase):
    def test_normalizes_a_well_formed_route(self):
        raw = [{"label": "LongFast", "feed_id": "feed_a", "channels": [0],
                "from": ["!11223344"], "sound": "alarm"}]
        self.assertEqual(routing.normalize_routes(raw), raw)

    def test_fills_defaults_and_drops_garbage(self):
        out = routing.normalize_routes([
            {"feed_id": "feed_a", "channels": ["2", 3], "sound": "loud"},
            "not a dict",
            {"label": 42, "from": "!notalist"},
        ])
        self.assertEqual(out, [
            {"label": "", "feed_id": "feed_a", "channels": [2, 3], "from": [], "sound": "chime"},
            {"label": "42", "feed_id": "", "channels": [], "from": [], "sound": "chime"},
        ])

    def test_not_a_list_normalizes_to_empty(self):
        self.assertEqual(routing.normalize_routes(None), [])
        self.assertEqual(routing.normalize_routes({"x": 1}), [])


class MigrationTests(unittest.TestCase):
    def test_v1_enabled_selection_becomes_one_chime_route(self):
        out = routing.migrate_v1({"enabled": [0, 2]}, default_feed="feed_msgs")
        self.assertEqual(out, [{"label": "All messages", "feed_id": "feed_msgs",
                                "channels": [0, 2], "from": [], "sound": "chime"}])

    def test_v1_enabled_none_becomes_every_channel(self):
        out = routing.migrate_v1({"enabled": None}, default_feed="feed_msgs")
        self.assertEqual(out[0]["channels"], [])

    def test_migrated_route_keeps_empty_feed_when_env_unset(self):
        out = routing.migrate_v1({}, default_feed="")
        self.assertEqual(out[0]["feed_id"], "")
