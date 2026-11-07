"""Host-only oracle/wiring contracts; these are not native execution evidence."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from . import mobile_host_policy as probe
from .control_coverage import _touches_for_case
from .fixtures import mobile_service
from .native_steps import VERBS
from .steps import StepError
from .testcase import load_case

ROOT = Path(__file__).resolve().parents[5]
CASES = ROOT / "qa-ui-auto-tests/cases"
ENDPOINT = "http://127.0.0.1:12345"
SECRET_CODE = "never-retain-qa-pairing-code"
SECRET_TOKEN = "never-retain-qa-bearer-token"


class HostTransportTest(TestCase):
    def test_exact_host_and_auth_are_sent_to_loopback_without_url_rewrite_or_proxy(self):
        with patch.object(probe.http.client, "HTTPConnection") as factory:
            connection = factory.return_value
            response = connection.getresponse.return_value
            response.status = 403
            response.getheader.return_value = "application/json"
            response.read.return_value = b'{"error":"host_denied"}'
            value = probe.request(ENDPOINT, "/api/v1/sessions", probe.ARBITRARY,
                                  token=SECRET_TOKEN, origin=probe.ORIGIN)
        self.assertEqual(value, (403, {"error": "host_denied"}))
        factory.assert_called_once_with("127.0.0.1", 12345, timeout=15)
        connection.request.assert_called_once_with("GET", "/api/v1/sessions", None, {
            "Host": probe.ARBITRARY, "Authorization": "Bearer " + SECRET_TOKEN,
            "Origin": probe.ORIGIN,
        })
        connection.close.assert_called_once()

    def test_pair_payload_and_non_json_shell_are_supported(self):
        with patch.object(probe.http.client, "HTTPConnection") as factory:
            connection = factory.return_value
            response = connection.getresponse.return_value
            response.status = 200
            response.getheader.return_value = "text/html; charset=utf-8"
            response.read.return_value = b"<!doctype html><title>Mobile</title>"
            self.assertEqual(probe.request(ENDPOINT, "/", probe.HOSTS[0]), (200, None))
            probe.request(ENDPOINT, "/api/v1/pair", probe.HOSTS[0], body={"pairing_code": SECRET_CODE})
            args = connection.request.call_args.args
            self.assertEqual(args[:2], ("POST", "/api/v1/pair"))
            self.assertEqual(json.loads(args[2]), {"pairing_code": SECRET_CODE})
            self.assertEqual(args[3]["Content-Type"], "application/json")

    def test_failed_network_or_json_closes_connection_without_retry(self):
        for failure in (OSError("fixture failure"), None):
            with self.subTest(failure=failure), patch.object(probe.http.client, "HTTPConnection") as factory:
                connection = factory.return_value
                if failure:
                    connection.getresponse.side_effect = failure
                    error = OSError
                else:
                    response = connection.getresponse.return_value
                    response.getheader.return_value = "application/json"
                    response.read.return_value = b"{invalid"
                    error = json.JSONDecodeError
                with self.assertRaises(error):
                    probe.request(ENDPOINT, "/api/v1/health", probe.ARBITRARY)
                connection.close.assert_called_once()
                connection.request.assert_called_once()

    def test_refuses_nonloopback_schemes_credentials_and_redirect_targets(self):
        for endpoint in ("https://127.0.0.1:12345", "http://external.invalid:12345",
                         "http://localhost:12345", "http://127.0.0.1", "http://127.0.0.1:12345/x",
                         "http://user@127.0.0.1:12345", ENDPOINT + "?x=1", ENDPOINT + "#fragment"):
            with self.subTest(endpoint=endpoint), patch.object(probe.http.client, "HTTPConnection") as factory:
                with self.assertRaisesRegex(StepError, "plain loopback"):
                    probe.request(endpoint, "/api/v1/health", probe.ARBITRARY)
                factory.assert_not_called()


class HostSettingsInputTest(TestCase):
    def context(self):
        return SimpleNamespace(session=Mock())

    def test_explicit_list_is_filled_and_save_uses_one_focused_button_activation(self):
        ctx = self.context()
        with patch.object(probe, "read", side_effect=[False, False, "\n".join(probe.HOSTS)]), \
             patch.object(probe, "until") as until:
            probe.save_hosts(ctx, allow_all=False, replace_hosts=True)
        ctx.session.fill.assert_called_once_with(probe.INPUT, "\n".join(probe.HOSTS))
        ctx.session.click.assert_not_called()
        ctx.session.focus.assert_called_once_with(probe.SAVE)
        ctx.session.press_combo.assert_called_once_with("Enter")
        ctx.session.execute.assert_not_called()
        self.assertEqual(until.call_count, 2)
        self.assertIn(".disabled", until.call_args_list[0].args[1])
        self.assertIn(probe.SAVED.replace('"', '\\"'), until.call_args_list[1].args[1])

    def test_toggling_all_only_clicks_checkbox_and_preserves_list(self):
        for old, new in ((False, True), (True, False)):
            with self.subTest(allow_all=new):
                ctx = self.context()
                with patch.object(probe, "read", side_effect=[old, new, "\n".join(probe.HOSTS)]), \
                     patch.object(probe, "until"):
                    probe.save_hosts(ctx, allow_all=new)
                ctx.session.fill.assert_not_called()
                ctx.session.click.assert_called_once_with(probe.ALL)
                ctx.session.press_combo.assert_called_once_with("Enter")
                ctx.session.execute.assert_not_called()

    def test_missing_checkbox_or_discarded_list_never_passes(self):
        for readings, message in (([None], "checkbox is missing"),
                                   ([False, True, ""], "discarded or changed"),
                                   ([False, False], "does not match")):
            with self.subTest(readings=readings):
                with patch.object(probe, "read", side_effect=readings), patch.object(probe, "until"):
                    with self.assertRaisesRegex(StepError, message):
                        probe.save_hosts(self.context(), allow_all=True)


class PolicyHarness:
    """Deterministic oracle input, never a substitute for the native case."""
    def __init__(self, fault=None):
        self.phase = "default"
        self.allow_all = False
        self.hosts = []
        self.fault = fault
        self.saves = []
        self.requests = []
        self.socket = Mock()
        self.socket.receive.side_effect = self.receive

    def receive(self, kind):
        return {"device_id": "qa-host-policy-device"} if kind == "hello" else {"code": "invalid_message"}

    def read(self, ctx, selector, prop):
        return {probe.ALL: self.allow_all, probe.INPUT: "\n".join(self.hosts), probe.STATUS: "Running " + ENDPOINT}[selector]

    def save(self, ctx, *, allow_all, replace_hosts=False):
        if replace_hosts:
            self.hosts = list(probe.HOSTS)
        self.allow_all = allow_all
        self.phase = "explicit" if replace_hosts else "allow-all" if allow_all else "restricted"
        self.saves.append((allow_all, replace_hosts))
        if self.fault == "restart":
            self.socket.send.side_effect = EOFError("listener restarted")

    def request(self, endpoint, path, host, **kwargs):
        self.requests.append((self.phase, path, host, kwargs))
        allowed = self.allow_all or host == "127.0.0.1:12345" or host.lower() in self.hosts
        if self.fault == "wildcard" and self.hosts:
            allowed = True
        if not allowed:
            return 403, {"error": "host_denied"}
        if path == "/":
            return 200, None
        if path == "/api/v1/health":
            return 200, {"service": "taomni-mobile"}
        if path == "/api/v1/pair":
            if kwargs["body"]["pairing_code"] != SECRET_CODE:
                return 400, {"error": "invalid_or_expired_code"}
            return 200, {"device_id": "qa-host-policy-device", "token": SECRET_TOKEN}
        if kwargs.get("origin") == probe.UNPAIRED_ORIGIN:
            if self.fault == "origin-bypass" and self.allow_all:
                return 200, {"sessions": [], "saved_sessions": []}
            return 403, {"error": "origin_denied"}
        if kwargs.get("token") != SECRET_TOKEN:
            if self.fault == "auth-bypass" and self.allow_all:
                return 200, {"sessions": [], "saved_sessions": []}
            return 401, {"error": "unauthorized"}
        return 200, {"sessions": [], "saved_sessions": []}


class HostPolicyOracleTest(TestCase):
    def exercise(self, folder, harness):
        ctx = SimpleNamespace(case_dir=Path(folder), session=Mock())
        with patch.object(probe, "read", side_effect=harness.read), \
             patch.object(probe, "save_hosts", side_effect=harness.save), \
             patch.object(probe, "request", side_effect=harness.request), \
             patch.object(probe, "Ws", return_value=harness.socket) as websocket:
            result = probe.run(ctx, ENDPOINT, SECRET_CODE)
        websocket.assert_called_once_with(ENDPOINT, "/events", SECRET_TOKEN, probe.ORIGIN)
        ctx.session.execute.assert_not_called()
        return result

    def receipt(self, folder):
        raw = (Path(folder) / "mobile-host-policy-receipt.json").read_text()
        self.assertNotIn(SECRET_CODE, raw)
        self.assertNotIn(SECRET_TOKEN, raw)
        return json.loads(raw)

    def test_full_policy_transition_keeps_one_socket_and_checks_all_security_phases(self):
        harness = PolicyHarness()
        with tempfile.TemporaryDirectory() as folder:
            self.exercise(folder, harness)
            receipt = self.receipt(folder)
        self.assertTrue(receipt["passed"])
        self.assertEqual(harness.saves, [(False, True), (True, False), (False, False)])
        self.assertFalse(harness.allow_all)
        self.assertEqual(harness.hosts, list(probe.HOSTS))
        self.assertEqual(harness.socket.send.call_count, 3)
        harness.socket.close.assert_called_once()
        for phase in ("default", "explicit", "allow-all", "restricted"):
            observed = {row["check"] for row in receipt["checks"] if row["phase"] == phase}
            for check in ("missing-bearer-denied", "invalid-bearer-denied", "unpaired-origin-denied",
                          "same-origin-still-requires-bearer", "paired-origin-and-valid-bearer-allowed",
                          "websocket-ticket-still-requires-bearer", "pairing-code-still-required"):
                self.assertIn(check, observed)
        self.assertEqual({row["host"] for row in receipt["checks"] if row["check"] == "non-exact-authority-denied"}, {
            probe.ARBITRARY, "child." + probe.HOSTS[0], probe.HOSTS[0] + ".evil.invalid",
            probe.HOSTS[0] + ":18443", "qa-proxy-port.example.invalid", "qa-proxy-port.example.invalid:18444",
        })

    def test_broken_security_or_restart_cannot_write_a_passing_receipt(self):
        for fault, error in (("wildcard", StepError), ("auth-bypass", StepError),
                             ("origin-bypass", StepError), ("restart", EOFError)):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as folder:
                harness = PolicyHarness(fault)
                with self.assertRaises(error):
                    self.exercise(folder, harness)
                receipt = self.receipt(folder)
                self.assertFalse(receipt["passed"])
                self.assertIn("failure_type", receipt)
                self.assertIn(receipt["phase"], ("explicit", "allow-all"))
                harness.socket.close.assert_called_once()

    def test_bad_initial_defaults_fail_before_pairing(self):
        with tempfile.TemporaryDirectory() as folder:
            harness = PolicyHarness()
            harness.allow_all = True
            with self.assertRaisesRegex(StepError, "fresh restricted defaults"):
                self.exercise(folder, harness)
            self.assertFalse(self.receipt(folder)["passed"])
            self.assertFalse(harness.requests)
            harness.socket.close.assert_not_called()


class HostPolicyWiringTest(TestCase):
    def test_native_dispatch_uses_displayed_address_and_code_without_ipc(self):
        ctx = SimpleNamespace(session=Mock())
        with patch("qa_ui_auto.mobile_native.address", return_value=ENDPOINT), \
             patch("qa_ui_auto.mobile_native.text", return_value=SECRET_CODE) as code, \
             patch.object(probe, "run", return_value="passed") as run:
            self.assertEqual(VERBS["mobile_service_probe"](ctx, "host-policy"), "passed")
        code.assert_called_once_with(ctx, '[data-testid="mobile-settings-code"]')
        run.assert_called_once_with(ctx, ENDPOINT, SECRET_CODE)
        ctx.session.execute.assert_not_called()

    def test_fixture_exposes_host_receipt_without_weakening_existing_projection(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(case_id="TC-MOBILE-015", case_dir=Path(folder), values={})
            with patch.object(mobile_service, "seed_sessions") as seed:
                mobile_service.setup(ctx)
            self.assertEqual([row["id"] for row in seed.call_args.args[1]],
                             ["mobile-saved-ssh", "mobile-hidden-RDP", "mobile-hidden-MySQL", "mobile-hidden-VNC"])
            self.assertEqual(Path(ctx.values["mobile_host_policy_receipt"]), Path(folder) / "mobile-host-policy-receipt.json")

    def test_cases_validate_modes_contracts_and_native_verbs(self):
        ui = load_case(CASES / "TC-MOBILE-014-host-settings.testcase.yaml")
        native = load_case(CASES / "TC-MOBILE-015-native-host-policy.testcase.yaml")
        self.assertEqual(ui.modes, ["browser", "native"])
        self.assertEqual(ui.fixtures, ["reset_db"])
        self.assertEqual(native.modes, ["native"])
        self.assertEqual(native.fixtures, ["reset_db", "mobile_service"])
        self.assertEqual(ui.verification["review"], "reviewed")
        self.assertEqual(native.verification["review"], "reviewed")
        for case in (ui, native):
            for step in case.steps:
                self.assertIn(next(iter(step)), VERBS)
            self.assertIsNone(case.skip)
            self.assertIn({"assert_no_runtime_errors": None}, case.steps)
        self.assertEqual(ui.steps.count({"reload_window": None}), 2)
        self.assertIn({"mobile_service_probe": "host-policy"}, native.steps)

    def test_hosted_plan_registers_ui_and_native_oracle_on_all_three_platforms(self):
        import argparse
        from .ci import make_plan
        options = argparse.Namespace(scope="selected", head="", base="",
                                     platforms="linux,windows,macos", modes="browser,native",
                                     case_ids="TC-MOBILE-014,TC-MOBILE-015", features="", tags="", shards="1")
        plan = make_plan(options)
        self.assertEqual(len(plan["entries"]), 6)
        self.assertFalse(plan["gaps"])
        self.assertFalse(plan["unreviewed"])
        for entry in plan["entries"]:
            expected = ["TC-MOBILE-014", "TC-MOBILE-015"] if entry["mode"] == "native" else ["TC-MOBILE-014"]
            self.assertEqual(entry["selected_ids"], expected)

    def test_control_mapping_covers_real_host_actions_without_claiming_warning_mutation(self):
        case = SimpleNamespace(id="TC-MOBILE-HOST", steps=[{"mobile_service_probe": "host-policy"}])
        touches = {(touch.selector, touch.kind) for touch in _touches_for_case(case)}
        for name in ("mobile-settings-allowed-hosts", "mobile-settings-allow-all-hosts", "mobile-settings-save-hosts"):
            self.assertIn((f'[data-testid="{name}"]', "interactive"), touches)
        self.assertIn((probe.SAVED, "display"), touches)
        self.assertNotIn(('[data-testid="mobile-settings-hosts-warning"]', "interactive"), touches)
