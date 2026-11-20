"""Check selection and failure evidence without starting a desktop or probe."""
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from installed_rdp_baseline import CASE, measure
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
            def desktop(_observer, executable, profile, _evidence, _label):
                self.assertEqual(executable, application)
                self.assertEqual(profile, root / "rdp-profile")
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
