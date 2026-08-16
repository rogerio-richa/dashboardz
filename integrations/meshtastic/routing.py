"""
Pure routing logic: which routes a message matches, and how loud the beep is.

Kept free of meshtastic/requests imports so it stays unit-testable on any machine.

A route's empty `channels`/`from` lists mean "any" — the same nothing-selected-means-everything
stance as the old channel checkboxes, and for the same reason: an empty selection that dropped
everything would be indistinguishable from a dead radio link.
"""
from __future__ import annotations

from typing import Any

# Order defines loudness. chime -> a single info beep; alarm -> the sustained critical path.
SOUNDS = ("silent", "chime", "alarm")

_SEVERITY = {"chime": "info", "alarm": "critical"}

# A direct message carries channel 0 (or no channel field at all) — on the wire it is
# indistinguishable from primary-channel chatter except by its destination. Folding DMs into
# channel 0 is exactly the leak that put a private message on a public-channel feed, so they get
# a pseudo-channel of their own: routable explicitly, never matched by a real channel selection.
DIRECT = -1

BROADCAST_NUM = 0xFFFFFFFF


def packet_channel(packet: dict[str, Any]) -> int:
    """Routing channel for a received packet: its channel index, or DIRECT for a DM."""
    to = packet.get("to")
    if to is not None and to != BROADCAST_NUM:
        return DIRECT
    return int(packet.get("channel", 0) or 0)


def matches(route: dict[str, Any], channel: int, from_id: str) -> bool:
    channels = route.get("channels") or []
    senders = route.get("from") or []
    if channels and channel not in channels:
        return False
    if senders and from_id not in senders:
        return False
    return True


def matching_routes(routes: list[dict[str, Any]], channel: int,
                    from_id: str) -> list[dict[str, Any]]:
    return [r for r in routes if matches(r, channel, from_id)]


def loudest_sound(routes: list[dict[str, Any]]) -> str:
    loudest = 0
    for r in routes:
        sound = r.get("sound")
        if sound in SOUNDS:
            loudest = max(loudest, SOUNDS.index(sound))
    return SOUNDS[loudest]


def severity_for(sound: str) -> str | None:
    """Alert severity for a sound level; None means do not notify at all."""
    return _SEVERITY.get(sound)


def normalize_routes(raw: Any) -> list[dict[str, Any]]:
    """
    Coerce whatever came out of the JSON file (or the config form) into clean routes.

    Tolerant on purpose: a hand-edited config with one bad entry loses that entry, not the
    service. An entry that is not a dict at all is dropped; fields degrade to their defaults.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        channels: list[int] = []
        if isinstance(entry.get("channels"), list):
            for c in entry["channels"]:
                try:
                    channels.append(int(c))
                except (TypeError, ValueError):
                    pass
        senders = entry.get("from")
        senders = [str(s) for s in senders] if isinstance(senders, list) else []
        sound = entry.get("sound")
        out.append({
            "label": str(entry.get("label") or ""),
            "feed_id": str(entry.get("feed_id") or ""),
            "channels": channels,
            "from": senders,
            "sound": sound if sound in SOUNDS else "chime",
        })
    return out


def migrate_v1(old: dict[str, Any], default_feed: str) -> list[dict[str, Any]]:
    """
    The v1 config was a channel selection feeding one env-configured feed, chiming on every
    message. That becomes exactly one route, so an upgrade changes nothing audible or visible.
    """
    enabled = old.get("enabled")
    return [{
        "label": "All messages",
        "feed_id": default_feed,
        "channels": [int(i) for i in enabled] if isinstance(enabled, list) else [],
        "from": [],
        "sound": "chime",
    }]
