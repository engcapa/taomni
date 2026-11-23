"""Check selection and failure evidence without starting a desktop or probe."""
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from installed_rdp_baseline import CASE, install_signed_server, measure
from modular_bundle_inventory import digest
from qa_ui_auto.testcase import load_case


class InstalledRdpBaselineTests(unittest.TestCase):
    def exercise(self, fail_at=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            application, probe = root / "taomni", root / "rdp-probe"
            application.write_bytes(b"application fixture")
            probe.write_bytes(b"RDP probe fixture")
            steps = []
            context = Mock()

            def setup(observer):
                self.assertEqual(observer.cfg["app"]["rdp_probe_binary"], str(probe))
                self.assertIs(observer.cfg["rdp"]["modular_p95"], True)
                observer.env.update(QA_RDP_PORT="23456", QA_RDP_USER="qa", QA_RDP_PASSWORD="qa-password",
                                    QA_VAULT_PASSWORD="qa-vault")

            @contextmanager
            def desktop(_observer, executable, profile, _evidence, _label, *, environment):
                self.assertEqual(executable, application)
                self.assertEqual(profile, root / "rdp-profile")
                self.assertIn("XDG_DATA_HOME", environment)
                yield Mock(), Mock()

            def action(_context, verb, args):
                steps.append((verb, args))
                if len(steps) == fail_at:
                    raise RuntimeError("budget exceeded")

            with patch("installed_rdp_baseline.rdp_server_required.setup", side_effect=setup), \
                    patch("installed_rdp_baseline.installed_desktop", side_effect=desktop), \
                    patch("installed_rdp_baseline.NativeStepContext", return_value=context), \
                    patch("installed_rdp_baseline.desktop_action", side_effect=action), \
                    patch("installed_rdp_baseline.close_installed_desktop", return_value={"closed": True}) as close:
                if fail_at:
                    with self.assertRaisesRegex(RuntimeError, "budget exceeded"):
                        measure(application, probe, "test-source", root, root)
                    close.assert_not_called()
                else:
                    measure(application, probe, "test-source", root, root)
                    close.assert_called_once()
            context.restore_host_permissions.assert_called_once()
            path = root / "rdp-performance/installed-rdp-performance.json"
            return steps, json.loads(path.read_text())

    def test_retains_all_budget_steps_and_exact_case_identity(self):
        steps, result = self.exercise()
        case = load_case(CASE)
        self.assertEqual(result["case"], case.id)
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["steps"]), len(case.steps))
        self.assertEqual(steps[-1], ("assert_no_runtime_errors", None))
        self.assertEqual(steps[-2][1], case.steps[-1]["assert_json_file"])
        self.assertEqual(result["steps"][-2]["latencyP95BudgetMs"], {"reference": 65, "applied": 130})

    def test_preserves_the_failed_measurement_step_and_releases_helpers(self):
        _, result = self.exercise(fail_at=7)
        self.assertFalse(result["passed"])
        self.assertTrue(all(step["passed"] for step in result["steps"][:-1]))
        self.assertFalse(result["steps"][-1]["passed"])

    def test_selects_and_checks_the_signed_rdp_server_for_the_installed_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "rdp-server.taomni-plugin"
            signature = root / "rdp-server.taomni-plugin.minisig"
            archive.write_bytes(b"signed package fixture")
            signature.write_text("detached signature contents\n", encoding="utf-8")
            version = "0.1.0"
            module = root / "plugins/rdp-server"
            installed = module / "versions" / version
            installed.mkdir(parents=True)
            host = installed / "host"
            host.write_bytes(b"matching installed host")
            (module / "active.json").write_text(json.dumps({"activeVersion": version}))
            (installed / "module.json").write_text(json.dumps({"entry": {"host": host.name}}))
            receipt = {"archive": archive.name, "signature": signature.name, "sourceSha": "a" * 40,
                       "sha256": digest(archive), "hostSha256": digest(host), "version": version,
                       "platform": "linux-x86_64"}
            origin = SimpleNamespace(roster={"taomni-plugin-rdp-server": receipt}, files={f"/{archive.name}": archive})

            with patch("installed_rdp_baseline.desktop_action") as action:
                result = install_signed_server(Mock(), origin, root, receipt["sourceSha"])
                self.assertEqual(result["hostSha256"], receipt["hostSha256"])
                self.assertIn("enable-rdp-server", str(action.call_args_list))
                self.assertIn("detached signature contents", str(action.call_args_list))
                action.reset_mock()
                with self.assertRaisesRegex(RuntimeError, "does not match"):
                    install_signed_server(Mock(), origin, root, "b" * 40)
                action.assert_not_called()
