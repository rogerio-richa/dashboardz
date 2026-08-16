"""Tests for the config form parser. Run: python3 -m unittest test_config_http -v"""
from __future__ import annotations

import unittest
from urllib.parse import urlencode

import routing
from config_http import channel_choices, parse_routes_form


def form(pairs):
    return urlencode(pairs, doseq=True)


class ParseRoutesFormTests(unittest.TestCase):
    def test_full_card_round_trips(self):
        body = form([("label_0", "Maria"), ("feed_0", "feed_m"), ("sound_0", "alarm"),
                     ("ch_0", "0"), ("ch_0", "2"), ("from_0", "!11223344"),
                     ("extra_0", ""), ("count", "2")])
        self.assertEqual(parse_routes_form(body), [{
            "label": "Maria", "feed_id": "feed_m", "channels": [0, 2],
            "from": ["!11223344"], "sound": "alarm",
        }])

    def test_blank_new_card_is_ignored(self):
        body = form([("label_0", "A"), ("feed_0", "feed_a"), ("sound_0", "chime"),
                     ("label_1", ""), ("feed_1", ""), ("sound_1", "chime"), ("extra_1", "")])
        self.assertEqual(len(parse_routes_form(body)), 1)

    def test_deleted_card_is_dropped(self):
        body = form([("label_0", "A"), ("feed_0", "feed_a"), ("sound_0", "chime"), ("del_0", "on"),
                     ("label_1", "B"), ("feed_1", "feed_b"), ("sound_1", "silent")])
        self.assertEqual([r["label"] for r in parse_routes_form(body)], ["B"])

    def test_extra_ids_merge_with_checkboxes_without_duplicates(self):
        body = form([("label_0", "A"), ("feed_0", "feed_a"), ("sound_0", "chime"),
                     ("from_0", "!11223344"), ("extra_0", "!aabbccdd, !11223344 !ee00ee00")])
        self.assertEqual(parse_routes_form(body)[0]["from"],
                         ["!11223344", "!aabbccdd", "!ee00ee00"])

    def test_bad_sound_degrades_to_chime(self):
        body = form([("label_0", "A"), ("feed_0", "feed_a"), ("sound_0", "boom")])
        self.assertEqual(parse_routes_form(body)[0]["sound"], "chime")

    def test_direct_pseudo_channel_survives_the_form(self):
        body = form([("label_0", "DMs"), ("feed_0", "feed_d"), ("sound_0", "chime"),
                     ("ch_0", "-1")])
        self.assertEqual(parse_routes_form(body)[0]["channels"], [routing.DIRECT])


class ChannelChoicesTests(unittest.TestCase):
    def test_appends_direct_pseudo_channel_after_radio_channels(self):
        seen = [{"index": 0, "name": "LongFast", "primary": True}]
        self.assertEqual(channel_choices(seen), seen + [
            {"index": routing.DIRECT, "name": "Direct messages", "primary": False}])

    def test_offers_direct_even_before_any_channel_was_discovered(self):
        self.assertEqual([c["index"] for c in channel_choices([])], [routing.DIRECT])


if __name__ == "__main__":
    unittest.main()
