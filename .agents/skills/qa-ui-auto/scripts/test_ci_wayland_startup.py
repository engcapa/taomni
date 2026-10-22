import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from ci_multi_display import configure
from ci_wayland_startup import wait_for_shell_startup


READY = {"starting_up": False, "window_clip": None, "overview": False}


class WaylandStartupTests(unittest.TestCase):
    def test_output_configuration_waits_for_startup_clip_and_overview(self):
        class BusUnavailable(Exception):
            pass

        states = [
            BusUnavailable("Shell bus not yet owned"),
            {**READY, "starting_up": True, "window_clip": [0, 0, 2560, 1440]},
            {**READY, "window_clip": [0, 0, 2560, 1440]},
            {**READY, "overview": True},
            READY,
        ]
        methods = []

        def call(destination, _path, _interface, method, *_args):
            methods.append(method)
            if destination == "org.gnome.Shell":
                state = states.pop(0)
                if isinstance(state, Exception):
                    raise state
                return Mock(unpack=lambda: (True, json.dumps(state)))
            self.assertFalse(states, "Mutter layout was touched before Shell startup finished")
            return Mock(unpack=lambda: (1, [], [], {}) if method == "GetCurrentState" else ())

        bus = Mock(call_sync=call)
        repository = SimpleNamespace(
            Gio=SimpleNamespace(bus_get_sync=lambda *_: bus, BusType=SimpleNamespace(SESSION=0),
                                DBusCallFlags=SimpleNamespace(NONE=0)),
            GLib=SimpleNamespace(Variant=lambda _signature, values: values, Error=BusUnavailable))
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {"XDG_SESSION_TYPE": "wayland"}), \
             patch.dict("sys.modules", {"gi": SimpleNamespace(repository=repository),
                                        "gi.repository": repository}), \
             patch("ci_multi_display.monitor_configuration", return_value=(1, [])), \
             patch("ci_wayland_startup.time.sleep"):
            configure(Path(directory) / "display-configuration.json")
            report = json.loads((Path(directory) / "gnome-startup.json").read_text())
            self.assertTrue(report["ready"])
            self.assertEqual([entry["state"] for entry in report["observations"]][-1], READY)
        self.assertEqual(methods, ["Eval"] * 5 + ["GetCurrentState", "ApplyMonitorsConfig", "GetCurrentState"])

    def test_incomplete_startup_fails_and_retains_the_last_observation(self):
        state = {**READY, "starting_up": True, "window_clip": [0, 0, 2560, 1440]}
        with tempfile.TemporaryDirectory() as directory, \
             patch("ci_wayland_startup.time.monotonic", side_effect=[0, 0, 0.25, 0.5]), \
             patch("ci_wayland_startup.time.sleep"):
            report = Path(directory) / "gnome-startup.json"
            with self.assertRaisesRegex(RuntimeError, "before output configuration"):
                wait_for_shell_startup(lambda _: state, report, timeout=0.5)
            evidence = json.loads(report.read_text())
            self.assertFalse(evidence["ready"])
            self.assertEqual(evidence["observations"][-1]["state"], state)
            self.assertEqual(len(evidence["observations"]), 3)

    def test_missing_state_and_unavailable_shell_cannot_claim_readiness(self):
        for result in ({}, {"starting_up": False, "overview": False}, RuntimeError("Shell bus not owned")):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory, \
                 patch("ci_wayland_startup.time.monotonic", side_effect=[0, 1]):
                evaluate = Mock(side_effect=result) if isinstance(result, Exception) else Mock(return_value=result)
                report = Path(directory) / "gnome-startup.json"
                with self.assertRaisesRegex(RuntimeError, "GNOME startup did not finish"):
                    wait_for_shell_startup(evaluate, report, timeout=0.5)
                self.assertFalse(json.loads(report.read_text())["ready"])
