"""Tests for ConfigStore persistence and v1 migration. Run: python3 -m unittest test_config_store -v"""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from config_store import ConfigStore


class ConfigStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "meshtastic.json")
        self.addCleanup(self.dir.cleanup)

    def write(self, data):
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def test_fresh_install_seeds_one_route_on_the_default_feed(self):
        store = ConfigStore(self.path, default_feed="feed_msgs")
        self.assertEqual(store.routes(), [{
            "label": "All messages", "feed_id": "feed_msgs",
            "channels": [], "from": [], "sound": "chime",
        }])

    def test_v1_config_migrates_channel_selection_into_the_route(self):
        self.write({"enabled": [0, 2], "channels_seen": [{"index": 0, "name": "LongFast"}]})
        store = ConfigStore(self.path, default_feed="feed_msgs")
        self.assertEqual(store.routes()[0]["channels"], [0, 2])
        self.assertEqual(store.channels_seen(), [{"index": 0, "name": "LongFast"}])

    def test_set_routes_survives_a_reload(self):
        store = ConfigStore(self.path, default_feed="feed_msgs")
        routes = [{"label": "Maria", "feed_id": "feed_m",
                   "channels": [], "from": ["!11223344"], "sound": "alarm"}]
        store.set_routes(routes)
        self.assertEqual(ConfigStore(self.path, default_feed="feed_msgs").routes(), routes)

    def test_corrupt_file_degrades_to_the_fresh_default(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("{nope")
        store = ConfigStore(self.path, default_feed="feed_msgs")
        self.assertEqual(store.routes()[0]["feed_id"], "feed_msgs")

    def test_nodes_seen_round_trips(self):
        store = ConfigStore(self.path, default_feed="")
        nodes = [{"id": "!11223344", "name": "Maria", "short": "MR"}]
        store.set_nodes_seen(nodes)
        self.assertEqual(ConfigStore(self.path, default_feed="").nodes_seen(), nodes)


if __name__ == "__main__":
    unittest.main()
