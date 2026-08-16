"""
Meshtastic -> dashboardz feed pusher.

DELIBERATELY NOT A HUB PLUGIN. The hub is a job dispatcher; an integration is a process that POSTs
to `/api/feeds/:id` with a sender token, exactly as scripts/push-mac-metrics.sh always did. That
boundary is what stops a wedged serial link, a protobuf exception or a hung socket from taking down
the board — and the board is the 3am alarm path. It is also why this can be Python while the hub is
Node, and why it can run beside the radio while the hub runs elsewhere.

Two feeds, because they are two different shapes:

  telemetry  (value  mode) - the local node's health, replaced on every push. Feeds the dials.
  messages   (stream mode) - one row per received text. Feeds the list: who sent it, what it said.

Channel selection lives in a JSON file this service owns and serves a small config page for
(config_http.py). The hub never learns what a Meshtastic channel is.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import requests
from pubsub import pub

import meshtastic.tcp_interface as tcp

import routing
from config_store import ConfigStore

log = logging.getLogger("meshtastic-monitor")

NODE_HOST = os.environ.get("MESHTASTIC_HOST", "meshtastic.local")
HUB_URL = os.environ.get("HUB_URL", "http://hub:8484").rstrip("/")
SENDER_TOKEN = os.environ.get("DASHBOARDZ_TOKEN", "")
FEED_TELEMETRY = os.environ.get("FEED_TELEMETRY", "")
FEED_MESSAGES = os.environ.get("FEED_MESSAGES", "")
TELEMETRY_EVERY_S = int(os.environ.get("TELEMETRY_EVERY_S", "30"))
# Devices to beep when a message lands. `/api/notify` falls back to the SENDER's default_devices
# when this is absent, and this sender was created with none — so leaving it unset would post
# alerts that target nothing and silently never sound. Required, and loudly absent (see notify()).
ALERT_DEVICES = [d for d in os.environ.get("ALERT_DEVICES", "").split(",") if d.strip()]
# Messages are chatter, not incidents: they expire on their own rather than piling up on the board
# until somebody dismisses each one by hand.
ALERT_TTL_S = int(os.environ.get("ALERT_TTL_S", "600"))

# A blank PRIMARY channel name is not "unnamed" — Meshtastic displays the modem preset instead,
# which is why the default public channel reads as LongFast everywhere. Resolving it here means the
# config page shows operators the name they actually recognise.
DEFAULT_PRESET_NAME = "LongFast"


def push(feed_id: str, payload: dict[str, Any]) -> None:
    """One push. Never raises: a hub that is down or restarting must not kill the listener."""
    if not (feed_id and SENDER_TOKEN):
        log.warning("no feed id or token configured; dropping payload")
        return
    try:
        r = requests.post(
            f"{HUB_URL}/api/feeds/{feed_id}",
            json=payload,
            headers={"Authorization": f"Bearer {SENDER_TOKEN}"},
            timeout=5,
        )
        if r.status_code >= 400:
            log.warning("push to %s failed: %s %s", feed_id, r.status_code, r.text[:200])
    except Exception as exc:  # noqa: BLE001 - deliberately broad, see docstring
        log.warning("push to %s errored: %s", feed_id, exc)


def notify(title: str, body: str, severity: str, dedup_key: str) -> None:
    """
    Raise an alert so the board makes a NOISE for a new message.

    Severity comes from the loudest sound among the routes the message matched: `info` is the
    one-shot chime (the panel sounds exactly once per alert id for non-critical alerts carrying
    `sound: true`), `critical` is the sustained escalating alarm until dismissed — the level an
    operator picks for the one sender they never want to miss. A chatty public channel stays on
    `info` so the mesh can never talk its way into the 3am wake path uninvited.

    The feed row and this alert are deliberately BOTH sent: the feed is what the list widget
    renders and scrolls, the alert is what makes a noise and expires on its own.
    """
    if not ALERT_DEVICES:
        log.warning("ALERT_DEVICES is unset, so no beep — /api/notify would target nothing")
        return
    try:
        r = requests.post(
            f"{HUB_URL}/api/notify",
            json={
                "title": title,
                "body": body[:1500],
                "severity": severity,
                "sound": True,
                "devices": ALERT_DEVICES,
                "ttl_s": ALERT_TTL_S,
                # Two identical messages from the same node ARE two events and must beep twice, so
                # the key carries the packet id rather than the text.
                "dedup_key": dedup_key,
            },
            headers={"Authorization": f"Bearer {SENDER_TOKEN}"},
            timeout=5,
        )
        if r.status_code >= 400:
            log.warning("notify failed: %s %s", r.status_code, r.text[:200])
    except Exception as exc:  # noqa: BLE001
        log.warning("notify errored: %s", exc)


class Monitor:
    def __init__(self, store: ConfigStore) -> None:
        self.store = store
        self.iface: tcp.TCPInterface | None = None
        self._stop = threading.Event()

    # ---- naming -------------------------------------------------------------------------------

    def channel_name(self, index: int) -> str:
        """Human name for a channel index, resolving a blank primary to the modem preset."""
        if index == routing.DIRECT:
            return "Direct"
        try:
            for ch in self.iface.localNode.channels:  # type: ignore[union-attr]
                if ch.index != index:
                    continue
                name = (ch.settings.name or "").strip()
                if name:
                    return name
                return DEFAULT_PRESET_NAME if ch.role == 1 else f"channel {index}"
        except Exception:  # noqa: BLE001
            pass
        return f"channel {index}"

    def channels(self) -> list[dict[str, Any]]:
        """Every enabled channel on the node, for the config page. role 0 == DISABLED."""
        out: list[dict[str, Any]] = []
        try:
            for ch in self.iface.localNode.channels:  # type: ignore[union-attr]
                if ch.role == 0:
                    continue
                out.append({
                    "index": ch.index,
                    "name": self.channel_name(ch.index),
                    "primary": ch.role == 1,
                })
        except Exception as exc:  # noqa: BLE001
            log.debug("channel list unavailable: %s", exc)
        return out

    def nodes_list(self) -> list[dict[str, Any]]:
        """Every node the radio knows, for the config page's sender picker."""
        out: list[dict[str, Any]] = []
        try:
            for node_id, info in (self.iface.nodes or {}).items():  # type: ignore[union-attr]
                user = (info or {}).get("user", {}) or {}
                out.append({
                    "id": node_id,
                    "name": user.get("longName") or node_id,
                    "short": user.get("shortName") or node_id[-4:],
                })
        except Exception as exc:  # noqa: BLE001
            log.debug("node list unavailable: %s", exc)
        out.sort(key=lambda n: str(n["name"]).lower())
        return out

    def node_label(self, num: int | None) -> tuple[str, str]:
        """(longName, shortName) for a node number, falling back to its hex id."""
        if num is None:
            return ("unknown", "?")
        node_id = f"!{num:08x}"
        try:
            user = (self.iface.nodes or {}).get(node_id, {}).get("user", {})  # type: ignore[union-attr]
            long_name = user.get("longName") or node_id
            short = user.get("shortName") or node_id[-4:]
            return (long_name, short)
        except Exception:  # noqa: BLE001
            return (node_id, node_id[-4:])

    # ---- inbound ------------------------------------------------------------------------------

    def on_receive(self, packet: dict[str, Any], interface: Any = None) -> None:  # noqa: ARG002
        """
        Text messages only. Everything else on the mesh (position, telemetry, routing, nodeinfo)
        arrives here too and is deliberately ignored — the telemetry feed is polled from the node's
        own metrics instead, which is always current rather than whenever a packet happened to
        arrive.
        """
        try:
            decoded = packet.get("decoded") or {}
            if decoded.get("portnum") != "TEXT_MESSAGE_APP":
                return
            text = decoded.get("text")
            if not text:
                return

            index = routing.packet_channel(packet)
            from_num = packet.get("from")
            from_id = f"!{from_num:08x}" if from_num is not None else "?"
            matched = routing.matching_routes(self.store.routes(), index, from_id)
            if not matched:
                log.debug("dropping message on channel %s from %s: no route", index, from_id)
                return

            long_name, short = self.node_label(from_num)
            row = {
                "from": long_name,
                "short": short,
                "text": text,
                "channel": self.channel_name(index),
                "snr": packet.get("rxSnr"),
                "rssi": packet.get("rxRssi"),
                # hopStart - hopLimit is how far it actually travelled; absent on direct packets.
                "hops": (packet.get("hopStart") - packet.get("hopLimit"))
                        if packet.get("hopStart") is not None and packet.get("hopLimit") is not None
                        else 0,
            }
            log.info("message on %s from %s -> %d route(s): %s",
                     row["channel"], short, len(matched), text[:60])
            # Two routes can point at the same feed (e.g. "LongFast" and "Maria" both landing on
            # the main list); the row must still appear there once.
            pushed: set[str] = set()
            for r in matched:
                if r["feed_id"] and r["feed_id"] not in pushed:
                    pushed.add(r["feed_id"])
                    push(r["feed_id"], row)
            # One noise per message at the loudest matched level, so a message that lands in two
            # feeds does not beep twice. `id` is the mesh packet id — unique per transmission, so
            # a node sending the same words twice beeps twice, while a packet arriving over two
            # routes beeps once.
            severity = routing.severity_for(routing.loudest_sound(matched))
            if severity:
                notify(long_name, text, severity,
                       f"mesh-{packet.get('id') or f'{short}-{text[:40]}'}")
        except Exception as exc:  # noqa: BLE001
            log.warning("failed to handle packet: %s", exc)

    # ---- telemetry ----------------------------------------------------------------------------

    def telemetry_once(self) -> None:
        """
        The LOCAL node's health, read from its own record rather than waiting for a telemetry
        packet — a node broadcasts those every few minutes at best, and a dial that only updates
        when a broadcast lands looks broken.

        Battery reads above 100 when the node is on external power; Meshtastic uses 101 for
        "plugged in". Clamped for display so a gauge does not sit pinned past its own maximum.
        """
        try:
            me = self.iface.getMyNodeInfo() or {}  # type: ignore[union-attr]
            metrics = me.get("deviceMetrics", {}) or {}
            user = me.get("user", {}) or {}
            battery = metrics.get("batteryLevel")
            payload = {
                "node": {
                    "name": user.get("longName") or "?",
                    "short": user.get("shortName") or "?",
                    "hw": user.get("hwModel") or "?",
                },
                "battery_pct": min(100, battery) if isinstance(battery, (int, float)) else None,
                "plugged_in": bool(isinstance(battery, (int, float)) and battery > 100),
                "voltage": metrics.get("voltage"),
                "channel_util_pct": metrics.get("channelUtilization"),
                "air_util_tx_pct": metrics.get("airUtilTx"),
                "uptime_s": metrics.get("uptimeSeconds"),
                "nodes_seen": len(self.iface.nodes or {}),  # type: ignore[union-attr]
            }
            push(FEED_TELEMETRY, payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("telemetry read failed: %s", exc)

    # ---- lifecycle ----------------------------------------------------------------------------

    def _connection_alive(self) -> bool:
        """
        False once the library's reader thread has died.

        A dropped link is caught and swallowed *inside* that thread (see stream_interface.py's
        __reader): it logs, clears `isConnected`, and returns — it never raises into this process.
        telemetry_once() also swallows its own errors so one bad read doesn't kill the loop. So
        `isConnected` is the only signal left that the socket is actually dead and this loop needs
        to stop polling a corpse and reconnect.
        """
        return bool(self.iface and self.iface.isConnected.is_set())

    def run(self) -> None:
        """
        Connect, listen, and reconnect forever with backoff.

        The library's own heartbeat writes to the socket on a timer, so a dropped link surfaces as
        a BrokenPipeError from a thread we do not own. Rebuilding the interface from scratch on any
        failure is the only reliable recovery — there is no resubscribe-and-carry-on path.
        """
        pub.subscribe(self.on_receive, "meshtastic.receive")
        backoff = 2
        while not self._stop.is_set():
            try:
                log.info("connecting to %s:4403", NODE_HOST)
                self.iface = tcp.TCPInterface(hostname=NODE_HOST)
                me = self.iface.getMyNodeInfo() or {}
                log.info("connected to %s (%s)",
                         (me.get("user") or {}).get("longName"), NODE_HOST)
                self.store.set_channels_seen(self.channels())
                backoff = 2

                # Nodes trickle in as they are heard, so the sender picker refreshes on the
                # telemetry cadence — but only written when it actually changed, because every
                # set_nodes_seen is a config-file write.
                last_nodes: list[dict[str, Any]] | None = None
                while not self._stop.is_set():
                    self.telemetry_once()
                    if not self._connection_alive():
                        raise ConnectionError("meshtastic reader thread died")
                    nodes = self.nodes_list()
                    if nodes and nodes != last_nodes:
                        self.store.set_nodes_seen(nodes)
                        last_nodes = nodes
                    self._stop.wait(TELEMETRY_EVERY_S)
            except Exception as exc:  # noqa: BLE001
                log.warning("connection lost (%s); retrying in %ss", exc, backoff)
                self._stop.wait(backoff)
                backoff = min(60, backoff * 2)
            finally:
                try:
                    if self.iface:
                        self.iface.close()
                except Exception:  # noqa: BLE001
                    pass
                self.iface = None

    def stop(self) -> None:
        self._stop.set()
