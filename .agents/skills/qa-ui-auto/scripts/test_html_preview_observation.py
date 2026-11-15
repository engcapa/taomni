"""Local fixture/oracle unit checks only, never app/browser evidence."""
import http.client
import json
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from qa_ui_auto.fixtures.html_network_test import Servers, TARGETS, page
from qa_ui_auto.html_preview_observation import matched, route_matches, validate_click, validate_observe
from qa_ui_auto.steps import StepError
from qa_ui_auto.behavior_contract import validate_contract


class HtmlNetworkTests(unittest.TestCase):
    def test_fixture_routes_are_independently_logged(self):
        with tempfile.TemporaryDirectory() as root:
            servers = Servers(Path(root), "unit-nonce")
            try:
                direct = http.client.HTTPConnection("127.0.0.1", servers.origin_port, timeout=3)
                direct.request("GET", "/none/probe.json")
                self.assertIn(b'"route": "direct"', direct.getresponse().read())
                direct.close()
                for route, server in zip(("app", "custom"), servers.servers[1:]):
                    client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    client.request("GET", servers.origin + "/" + route + "/probe.json")
                    self.assertIn(('"route": "' + route + '"').encode(), client.getresponse().read())
                    client.close()
                events = [json.loads(line) for line in servers.log.read_text().splitlines()]
                for phase, route in (("none", "direct"), ("app", "app"), ("custom", "custom")):
                    self.assertTrue(route_matches(events, phase, route))
                self.assertFalse(route_matches(events, "app", "direct"))
            finally:
                servers.close()

    def test_fixture_slow_stream_records_peer_cancellation(self):
        with tempfile.TemporaryDirectory() as root:
            servers = Servers(Path(root), "unit-cancel")
            try:
                client = http.client.HTTPConnection("127.0.0.1", servers.origin_port, timeout=3)
                client.request("GET", "/slow/stream")
                response = client.getresponse()
                self.assertEqual(response.read(1024), b"x" * 1024)
                response.close()
                client.close()
                import time
                end = time.monotonic() + 2
                while time.monotonic() < end:
                    events = [json.loads(line) for line in servers.log.read_text().splitlines()]
                    if any(event["event"] == "cancelled" for event in events):
                        break
                    time.sleep(.01)
                self.assertTrue(any(event["event"] == "cancelled" for event in events))
            finally:
                servers.close()

    def test_oracle_never_turns_missing_proof_or_wrong_route_into_pass(self):
        blocked = {"console": "HTML_QA FETCH BLOCKED\nHTML_QA SETTLED default"}
        self.assertTrue(matched("blocked", [], blocked, "native"))
        self.assertFalse(matched("blocked", [{"event": "request", "path": "/default/probe.json"}], blocked, "native"))
        with self.assertRaises(StepError):
            matched("external-cancelled", [], {"dialog": False}, "native")
        with self.assertRaises(StepError):
            matched("none", [], {}, "browser")
        safe = {"dialog": False, "passive": {"native": True, "covered": True, "intact": True, "calls": []}}
        self.assertTrue(matched("external-cancelled", [], safe, "native"))
        safe["passive"]["calls"] = [{"command": "open_external_url"}]
        self.assertFalse(matched("external-cancelled", [], safe, "native"))

    def test_strict_verb_arguments_and_fixture_points(self):
        for target in TARGETS:
            validate_click({"target": target})
        for args in ({}, {"target": "invented"}, {"target": "next", "force": True}):
            with self.assertRaises(StepError):
                validate_click(args)
        validate_observe({"state": "cancelled"})
        with self.assertRaises(StepError):
            validate_observe({"state": "pass"})
        source = page("default", "http://127.0.0.1:1234", "unit")
        for marker in ("HTML_QA", "assets/local.js", "assets/local.css", "assets/pixel.png", "spoof-invalid", "CROSS_TOKEN", "ipc://localhost"):
            self.assertIn(marker, source)

    def test_fixture_author_script_and_passive_hooks_parse_without_executing_product(self):
        import re
        import shutil
        import subprocess
        from qa_ui_auto.html_preview_observation import INSTALL
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required to validate the QA author-script syntax")
        source = page("security", "http://127.0.0.1:1234", "unit")
        scripts = re.findall(r"<script>(.*?)</script>", source, re.DOTALL)
        self.assertEqual(len(scripts), 1)
        for script in scripts + [INSTALL]:
            result = subprocess.run([node, "-e", "new Function(process.argv[1]);", script], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_new_case_contract_indices_refer_to_real_assertions(self):
        import yaml
        root = Path(__file__).resolve().parents[4] / "qa-ui-auto-tests" / "cases"
        for case_id in ("009", "010"):
            matches = list(root.glob("TC-FILE-OPEN-" + case_id + "-*"))
            self.assertEqual(len(matches), 1)
            doc = yaml.safe_load(matches[0].read_text())
            self.assertEqual(validate_contract(doc, require_review=True), [])
            from qa_ui_auto.testcase import validate_doc
            self.assertEqual(validate_doc(doc, source=str(matches[0])), [])


if __name__ == "__main__":
    unittest.main()
