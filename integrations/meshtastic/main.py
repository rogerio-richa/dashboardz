"""Entry point: the mesh listener on the main thread, the config page on another."""
from __future__ import annotations

import logging
import os
import threading

import config_http
from config_store import ConfigStore
from monitor import FEED_MESSAGES, FEED_TELEMETRY, NODE_HOST, Monitor

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)

CONFIG_PORT = int(os.environ.get("CONFIG_PORT", "8600"))


def main() -> None:
    # FEED_MESSAGES only seeds the default route on first boot (or v1 migration); after that the
    # routes in the config file are the truth and the env var is never consulted again.
    store = ConfigStore(default_feed=FEED_MESSAGES)
    monitor = Monitor(store)

    server = config_http.serve(store, monitor, NODE_HOST, FEED_TELEMETRY, CONFIG_PORT)
    # Daemon thread: the listener owns the process lifetime, so the config page must never be the
    # reason it stays alive after the radio loop gives up.
    threading.Thread(target=server.serve_forever, name="config-http", daemon=True).start()

    try:
        monitor.run()
    except KeyboardInterrupt:
        monitor.stop()


if __name__ == "__main__":
    main()
