"""Tests for Monitor's connection-health check. Run: python3 -m unittest test_monitor -v"""
from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace

from monitor import Monitor


class ConnectionAliveTests(unittest.TestCase):
    def test_no_iface_yet_is_not_alive(self):
        mon = Monitor(store=None)
        self.assertFalse(mon._connection_alive())

    def test_alive_while_reader_thread_has_isConnected_set(self):
        mon = Monitor(store=None)
        mon.iface = SimpleNamespace(isConnected=threading.Event())
        mon.iface.isConnected.set()
        self.assertTrue(mon._connection_alive())

    def test_dead_once_reader_thread_clears_isConnected(self):
        mon = Monitor(store=None)
        mon.iface = SimpleNamespace(isConnected=threading.Event())
        mon.iface.isConnected.set()
        mon.iface.isConnected.clear()
        self.assertFalse(mon._connection_alive())


if __name__ == "__main__":
    unittest.main()
