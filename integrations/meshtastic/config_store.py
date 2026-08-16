"""
Which messages go to which feeds, and how loudly.

Lives in a JSON file on a volume, owned by this integration. The hub never learns what a Meshtastic
channel is — that is the whole point of keeping integrations out of process.

The unit of config is a ROUTE: a target feed plus a channel/sender filter plus a sound level
(routing.py). A fresh install seeds one route on the env-configured feed matching everything, and a
v1 config (a bare channel selection) migrates into that same shape — in both cases because a board
that silently forwarded nothing would look identical to a broken radio link.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

import routing

log = logging.getLogger("meshtastic-monitor.config")

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/data/meshtastic.json")


class ConfigStore:
    def __init__(self, path: str = CONFIG_PATH, default_feed: str = "") -> None:
        self.path = path
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "routes": routing.migrate_v1({}, default_feed),
            "channels_seen": [],
            "nodes_seen": [],
        }
        self._load(default_feed)

    def _load(self, default_feed: str) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                if isinstance(data.get("routes"), list):
                    self._state["routes"] = routing.normalize_routes(data["routes"])
                else:
                    # v1 file: {"enabled": [...] | null} — one route, same behavior as before.
                    self._state["routes"] = routing.migrate_v1(data, default_feed)
                for key in ("channels_seen", "nodes_seen"):
                    if isinstance(data.get(key), list):
                        self._state[key] = data[key]
            log.info("config loaded from %s: %d route(s)", self.path, len(self._state["routes"]))
        except FileNotFoundError:
            log.info("no config at %s; seeded default route", self.path)
        except Exception as exc:  # noqa: BLE001
            # A corrupt file must not stop the service booting — it degrades to the fresh-install
            # default, which forwards everything and is visibly not-broken.
            log.warning("config at %s unreadable (%s); seeded default route", self.path, exc)

    def _save(self) -> None:
        tmp = f"{self.path}.tmp"
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self._state, fh, indent=2)
        os.replace(tmp, self.path)  # atomic, so a crash mid-write cannot truncate the config

    def routes(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._state["routes"]]

    def set_routes(self, routes: list[dict[str, Any]]) -> None:
        clean = routing.normalize_routes(routes)
        with self._lock:
            self._state["routes"] = clean
            self._save()
        log.info("routes are now: %s",
                 [f"{r['label'] or r['feed_id']}({r['sound']})" for r in clean])

    def set_channels_seen(self, channels: list[dict[str, Any]]) -> None:
        """What the node reports it has, cached so the config page still renders while offline."""
        with self._lock:
            self._state["channels_seen"] = channels
            self._save()

    def channels_seen(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._state["channels_seen"])

    def set_nodes_seen(self, nodes: list[dict[str, Any]]) -> None:
        """Nodes the radio knows about, cached so the sender picker works while offline."""
        with self._lock:
            self._state["nodes_seen"] = nodes
            self._save()

    def nodes_seen(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._state["nodes_seen"])
