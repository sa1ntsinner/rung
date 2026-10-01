# SPDX-License-Identifier: BUSL-1.1
# Going online and reading values in rung_bridge_codesys.py, under CPython against a CODESYS of its own that
# refuses everything but logging in, logging out and reading:  python bridge/codesys/test_online.py
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = open(os.path.join(HERE, "rung_bridge_codesys.py"), encoding="utf-8").read()


class RpcError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


class OnlineChangeOption(object):
    Keep = "Keep"
    Try = "Try"
    Force = "Force"
    Never = "Never"


class Application(object):
    """An online application: what rung may do to it is listed here; anything else fails the test."""

    def __init__(self, calls, values):
        self.calls = calls
        self.values = values
        self.is_logged_in = False

    def login(self, option, reset):
        self.calls.append(("login", option, reset))
        self.is_logged_in = True

    def logout(self):
        self.calls.append(("logout",))
        self.is_logged_in = False

    def read_values(self, names):
        self.calls.append(("read",) + tuple(names))
        return [self.values.get(n) for n in names]

    def __getattr__(self, name):
        raise AssertionError("rung must not call " + name + " to go online or read")


class Device(object):
    def __init__(self, calls):
        self.calls = calls

    def set_simulation_mode(self, on):
        self.calls.append(("simulation", on))

    def set_gateway_and_ip_address(self, gateway, address):
        self.calls.append(("address", gateway, address))


class Online(object):
    def __init__(self, app):
        self.app = app
        self.gateways = ["Gateway-1"]

    def create_online_application(self, application):
        return self.app


def load(values=None):
    calls = []
    app = Application(calls, values or {})
    dev = Device(calls)
    ns = {"re": re, "RpcError": RpcError, "OnlineChangeOption": OnlineChangeOption, "online": Online(app),
          "device": lambda name: dev, "application": lambda d: "app"}
    exec(SOURCE[SOURCE.index("online_apps = {}"):SOURCE.index("def plc_download")], ns)
    exec(SOURCE[SOURCE.index("def plc_read"):SOURCE.index("# ------------------------------------------------------------------ dispatch")], ns)
    return ns, calls


class OnlineTest(unittest.TestCase):
    def test_going_online_only_logs_in_and_downloads_nothing(self):
        ns, calls = load()
        r = ns["plc_online"]({"device": "Device", "action": "online", "target": {"mode": "simulation"}})
        self.assertEqual(r, {"device": "Device", "state": "Online"})
        self.assertEqual(calls, [("simulation", True), ("login", "Keep", False)])

    def test_already_online_is_not_logged_in_again(self):
        ns, calls = load()
        ns["plc_online"]({"device": "Device", "action": "online", "target": {"mode": "simulation"}})
        ns["plc_online"]({"device": "Device", "action": "online", "target": {"mode": "simulation"}})
        self.assertEqual([c for c in calls if c[0] == "login"], [("login", "Keep", False)])

    def test_a_plc_at_an_address_goes_through_the_first_gateway(self):
        ns, calls = load()
        ns["plc_online"]({"device": "Device", "action": "online", "target": {"mode": "PN/IE", "pcInterface": "192.168.0.10"}})
        self.assertEqual(calls, [("simulation", False), ("address", "Gateway-1", "192.168.0.10"), ("login", "Keep", False)])

    def test_state_and_offline(self):
        ns, calls = load()
        self.assertEqual(ns["plc_online"]({"device": "Device", "action": "state"})["state"], "Offline")
        self.assertEqual(calls, [])
        ns["plc_online"]({"device": "Device", "action": "online", "target": {"mode": "simulation"}})
        self.assertEqual(ns["plc_online"]({"device": "Device", "action": "offline"})["state"], "Offline")
        self.assertEqual(calls[-1], ("logout",))

    def test_reading_only_reads_and_answers_plain_values(self):
        ns, calls = load({"a": "DINT#76", "b": "TRUE", "c": "REAL#1.5", "d": "'text'", "e": None})
        ns["plc_online"]({"device": "Device", "action": "online", "target": {"mode": "simulation"}})
        del calls[:]
        r = ns["plc_read"]({"device": "Device", "expressions": ["a", "b", "c", "d", "e"]})
        self.assertEqual(r, [{"name": "a", "value": 76}, {"name": "b", "value": True}, {"name": "c", "value": 1.5}, {"name": "d", "value": "text"}, {"name": "e", "value": None}])
        self.assertEqual(calls, [("read", "a", "b", "c", "d", "e")])

    def test_reading_while_offline_is_refused_without_logging_in(self):
        ns, calls = load({"a": "1"})
        with self.assertRaises(RpcError) as e:
            ns["plc_read"]({"device": "Device", "expressions": ["a"]})
        self.assertEqual(e.exception.code, "NOT_ONLINE")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
