"""
The integration's own config page.

Each integration owns its config surface — that is what keeps "manage plugins from the hub" from
becoming a plugin framework inside the hub. The hub sees feeds; this page sees channels, nodes and
routes.

Stdlib http.server on purpose: this is one form, and the meshtastic dependency tree is heavy
enough already without a web framework on top of it. No JavaScript either — the "add a route" flow
is simply an always-present blank card that becomes real when you give it a feed id and save.
"""
from __future__ import annotations

import html
import json
import logging
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import routing

log = logging.getLogger("meshtastic-monitor.http")

PAGE = """<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meshtastic monitor</title>
<style>
  body {{ font-family: system-ui; max-width: 720px; margin: 2rem auto; padding: 0 1rem;
          background: #12141c; color: #e6e9f0; }}
  h1 {{ font-size: 1.2rem; }} .muted {{ color: #8a90a0; font-size: .85rem; }}
  .card {{ background: #191c26; border: 1px solid #2a2e38; border-radius: 8px;
           padding: 1rem; margin: 1rem 0; }}
  .card.new {{ border-style: dashed; }}
  label {{ display: flex; gap: .6rem; align-items: center; padding: .35rem 0; }}
  .row {{ display: flex; gap: .8rem; flex-wrap: wrap; align-items: center; margin: .4rem 0; }}
  .row > label {{ padding: 0; }}
  input[type=text] {{ background: #12141c; border: 1px solid #2a2e38; color: #e6e9f0;
                      border-radius: 5px; padding: .35rem .5rem; }}
  select {{ background: #12141c; border: 1px solid #2a2e38; color: #e6e9f0;
            border-radius: 5px; padding: .3rem; }}
  button {{ background: #4a90d9; border: 0; color: #fff; padding: .5rem 1rem;
            border-radius: 6px; font-size: .95rem; }}
  button.danger {{ background: #8a3038; padding: .35rem .8rem; font-size: .85rem;
                   margin-left: auto; }}
  code {{ color: #f0a020; }}
  fieldset {{ border: 0; padding: 0; margin: .5rem 0 0; }}
  legend {{ font-size: .85rem; color: #8a90a0; padding: 0; margin-bottom: .1rem; }}
  .del {{ color: #d97a7a; }}
</style>
<h1>Meshtastic monitor</h1>
<p class="muted">Node <code>{host}</code> — {status}</p>

<form method="post">
  <button type="submit" style="display:none" aria-hidden="true"></button>
  {cards}
  <p><button type="submit">Save</button></p>
  <input type="hidden" name="count" value="{count}">
</form>

<div class="card">
  <p class="muted">A message is pushed to every route it matches; empty channels/senders mean
  "any". It beeps once, at the loudest sound among the matched routes. A message matching no
  route is dropped. A direct message counts as <b>Direct messages</b>, never as the channel it
  was encrypted with — ticking a real channel keeps DMs out of that route.</p>
  <p class="muted">Feeds are created on the hub's <b>Data sources</b> page — paste the feed id
  here. Telemetry feed: <code>{feed_telemetry}</code></p>
</div>
"""

CARD = """<div class="card{new_cls}">
  <div class="row">
    <label>Label <input type="text" name="label_{i}" value="{label}" placeholder="{placeholder}"></label>
    <label>Feed id <input type="text" name="feed_{i}" value="{feed}" placeholder="feed_..."></label>
    <label>Sound <select name="sound_{i}">{sound_opts}</select></label>
    {del_box}
  </div>
  <fieldset><legend>Channels (none ticked = any)</legend>
    <div class="row">{channel_boxes}</div>
  </fieldset>
  <fieldset><legend>Senders (none = anyone; cmd/ctrl-click for several)</legend>
    <div class="row">
      <select multiple name="from_{i}" size="{node_rows}">{node_opts}</select>
      <label class="muted">Other node ids
        <input type="text" name="extra_{i}" value="{extra}" placeholder="!a1b2c3d4, ..."></label>
    </div>
  </fieldset>
</div>"""

SOUND_LABELS = {"silent": "silent", "chime": "chime once", "alarm": "full alarm"}


def channel_choices(seen: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    The radio's channels plus the Direct pseudo-channel, for the route form's picker.

    Appended at render time, never stored: channels_seen stays a faithful cache of what the
    radio reported, and Direct exists whether or not the radio has connected yet.
    """
    return list(seen) + [{"index": routing.DIRECT, "name": "Direct messages", "primary": False}]


def _render_card(i: int, route: dict[str, Any], channels: list[dict[str, Any]],
                 nodes: list[dict[str, Any]], is_new: bool) -> str:
    sound_opts = "".join(
        '<option value="{v}"{sel}>{t}</option>'.format(
            v=s, t=SOUND_LABELS[s], sel=" selected" if route["sound"] == s else "")
        for s in routing.SOUNDS
    )
    channel_boxes = "".join(
        '<label><input type="checkbox" name="ch_{i}" value="{idx}"{checked}>'
        "<span>{name}{primary}</span></label>".format(
            i=i, idx=c["index"],
            checked=" checked" if c["index"] in route["channels"] else "",
            name=html.escape(str(c["name"])),
            primary=' <span class="muted">· primary</span>' if c.get("primary") else "",
        )
        for c in channels
    )
    # A multi-select, not a checkbox per node: a mesh that has heard a hundred nodes made the
    # checkbox wall unusable (operator's words: "just horrible looking"). Not a plain dropdown
    # either — a route can name several senders, and <select multiple> posts the same repeated
    # `from_{i}` values the checkboxes did, so the form parser is untouched.
    known_ids = {n["id"] for n in nodes}
    node_opts = "".join(
        '<option value="{id}"{sel}>{name} ({id_esc})</option>'.format(
            id=html.escape(str(n["id"])), id_esc=html.escape(str(n["id"])),
            sel=" selected" if n["id"] in route["from"] else "",
            name=html.escape(str(n["name"])),
        )
        for n in nodes
    ) or '<option disabled>no nodes heard yet</option>'
    # Senders configured before the radio ever heard them (or while it is offline) must not be
    # silently dropped from the form round-trip: they surface in the free-text field instead.
    extra = ", ".join(s for s in route["from"] if s not in known_ids)
    return CARD.format(
        i=i, new_cls=" new" if is_new else "",
        label=html.escape(route["label"]),
        placeholder="new route" if is_new else "",
        feed=html.escape(route["feed_id"]),
        sound_opts=sound_opts, channel_boxes=channel_boxes, node_opts=node_opts,
        node_rows=min(8, max(3, len(nodes))),
        extra=html.escape(extra),
        # A real one-click button, not a tick-then-save checkbox (operator feedback). Clicking it
        # submits the form with only this card's del_{i} set, so the parser's existing rule
        # ("del_{i} present drops the route, everything else saves as shown") does the rest.
        del_box="" if is_new else
        f'<button type="submit" name="del_{i}" value="1" class="danger">Delete</button>',
    )


def parse_routes_form(raw_body: str) -> list[dict[str, Any]]:
    """
    Form fields back into routes. Pure, so it stays testable without a socket.

    The last card is the always-blank "new route"; like any card it only survives if it names a
    feed or a label — which also means wiping those two fields is a second way to delete a route.
    """
    fields = urllib.parse.parse_qs(raw_body, keep_blank_values=True)
    count = 0
    for key in fields:
        m = re.fullmatch(r"(?:label|feed)_(\d+)", key)
        if m:
            count = max(count, int(m.group(1)) + 1)
    routes: list[dict[str, Any]] = []
    for i in range(count):
        if f"del_{i}" in fields:
            continue
        label = (fields.get(f"label_{i}") or [""])[0].strip()
        feed = (fields.get(f"feed_{i}") or [""])[0].strip()
        if not (label or feed):
            continue
        senders = list(fields.get(f"from_{i}", []))
        extra = (fields.get(f"extra_{i}") or [""])[0]
        senders += [s.strip() for s in re.split(r"[,\s]+", extra) if s.strip()]
        routes.append({
            "label": label,
            "feed_id": feed,
            "channels": [int(v) for v in fields.get(f"ch_{i}", [])
                         if re.fullmatch(r"-?\d+", v)],
            "from": list(dict.fromkeys(senders)),
            "sound": (fields.get(f"sound_{i}") or ["chime"])[0],
        })
    return routing.normalize_routes(routes)


def make_handler(store: Any, monitor: Any, node_host: str,
                 feed_telemetry: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        # Default logging writes a line per request to stderr, which buries the actual mesh traffic.
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            log.debug(fmt, *args)

        def _render(self) -> bytes:
            channels = channel_choices(store.channels_seen())
            nodes = store.nodes_seen()
            routes = store.routes()
            blank = routing.normalize_routes([{}])[0]
            cards = "".join(
                _render_card(i, r, channels, nodes, is_new=False)
                for i, r in enumerate(routes)
            ) + _render_card(len(routes), blank, channels, nodes, is_new=True)
            return PAGE.format(
                host=html.escape(node_host),
                status="connected" if monitor.iface is not None else "not connected",
                cards=cards,
                count=len(routes) + 1,
                feed_telemetry=html.escape(feed_telemetry or "(unset)"),
            ).encode()

        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/health"):
                body = json.dumps({
                    "connected": monitor.iface is not None,
                    "channels": store.channels_seen(),
                    "nodes": store.nodes_seen(),
                    "routes": store.routes(),
                }).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = self._render()
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length).decode()
            store.set_routes(parse_routes_form(raw))
            self.send_response(303)
            self.send_header("location", "/")
            self.end_headers()

    return Handler


def serve(store: Any, monitor: Any, node_host: str, feed_telemetry: str,
          port: int) -> ThreadingHTTPServer:
    handler = make_handler(store, monitor, node_host, feed_telemetry)
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    log.info("config page on :%s", port)
    return server
