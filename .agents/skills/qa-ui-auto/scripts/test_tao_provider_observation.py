"""Outcome-oracle unit checks only; these never constitute native evidence."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.steps import StepError
from qa_ui_auto.tao_provider_observation import classify, assert_outcome, INSTALL, READ
from qa_ui_auto.fixtures import tao_real_provider


def snapshot(**updates):
    state = dict(transport={"valid": True, "calls": [{"status": "fulfilled"}]},
                 assistantCount=1, replyLength=12, errorCount=0,
                 credentialInvalid=False, retryVisible=False, running=False, noKeyVisible=False)
    state.update(updates)
    return state


class TaoProviderObservationTests(unittest.TestCase):
    def test_placeholder_pending_and_streaming_are_never_success(self):
        self.assertIsNone(classify(snapshot(replyLength=0)))
        self.assertIsNone(classify(snapshot(running=True)))
        self.assertIsNone(classify(snapshot(transport={"valid": True, "calls": [{"status": "pending"}]})))
        self.assertIsNone(classify(snapshot(transport={"valid": True, "calls": []})))
        self.assertEqual(classify(snapshot()), "response-complete")

    def test_only_explicit_credentials_with_retry_pass_error_branch(self):
        for category in ("network", "protocol", "configuration", "provider"):
            with self.subTest(category=category), self.assertRaises(StepError):
                classify(snapshot(errorCount=1, errorCategory=category, retryVisible=True))
        self.assertEqual(classify(snapshot(errorCount=1, credentialInvalid=True, retryVisible=True)),
                         "credential-invalid")
        with self.assertRaisesRegex(StepError, "retry"):
            classify(snapshot(errorCount=1, credentialInvalid=True))

    def test_invalid_transport_or_rejected_callback_cannot_pass_reply(self):
        with self.assertRaises(StepError):
            classify(snapshot(transport=None))
        with self.assertRaises(StepError):
            classify(snapshot(transport={"valid": False, "calls": []}))
        with self.assertRaises(StepError):
            classify(snapshot(transport={"valid": True, "calls": [{"status": "rejected"}]}))

    def test_assertion_waits_for_real_completion_and_writes_only_fixed_evidence(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            status = root / "real-provider-status.txt"
            status.write_text("request_prepared\n")
            session = Mock()
            session.execute.side_effect = [snapshot(replyLength=0, running=True), snapshot(usage={"inputTokens": 875, "outputTokens": 45})]
            # Match the native verb contract: fixture values are unavailable.
            ctx = SimpleNamespace(session=session, case_dir=root)
            with patch("qa_ui_auto.tao_provider_observation.time.sleep"):
                self.assertIn("response-complete", assert_outcome(ctx, {"timeout_sec": 1}))
            self.assertEqual(session.execute.call_count, 2)
            artifact = json.loads((root / "real-provider-outcome.json").read_text())
            self.assertEqual(artifact["outcome"], "response-complete")
            self.assertNotIn("text", artifact["state"])
            self.assertEqual(artifact["state"]["usage"], {"inputTokens": 875, "outputTokens": 45})
            self.assertIn("response-complete", status.read_text())

    def test_failed_outcome_is_retained_without_claiming_completed(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = SimpleNamespace(session=Mock(), case_dir=root)
            ctx.session.execute.return_value = snapshot(errorCount=1, errorCategory="network", retryVisible=True)
            with self.assertRaises(StepError):
                assert_outcome(ctx, {"timeout_sec": 1})
            record = json.loads((root / "real-provider-outcome.json").read_text())
            self.assertEqual(record["outcome"], "failed")
            self.assertIn("network", record["reason"])

    def test_strict_success_rejects_403_and_preserves_failed_evidence(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = SimpleNamespace(session=Mock(), case_dir=root)
            ctx.session.execute.return_value = snapshot(errorCount=1, credentialInvalid=True, retryVisible=True)
            with self.assertRaisesRegex(StepError, "credentials were rejected"):
                assert_outcome(ctx, {"timeout_sec": 1, "require_success": True})
            self.assertEqual(json.loads((root / "real-provider-outcome.json").read_text())["outcome"], "failed")

    def test_agnes_fixture_uses_requested_model_and_removes_key(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            key = root / "key.txt"
            key.write_text("unit-agnes-secret")
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root, case_dir=case, values={})
            with patch.dict(os.environ, {"TAOMNI_QA_TAO_PROVIDER": "agnes", "TAOMNI_QA_AGNES_KEY_FILE": str(key), "TAOMNI_QA_TAO_PROXY": "http://127.0.0.1:3228"}), \
                    patch.object(tao_real_provider, "native_isolation_env", return_value={"NEWMOB_CONFIG_DIR": str(root / "profile")}):
                tao_real_provider.setup(ctx)
            config_path = Path(ctx.values["tao_real_provider_config"])
            config = json.loads(config_path.read_text())
            provider = config["llm"]["providers"]["agnes"]
            self.assertEqual((provider["model"], provider["runtime"], provider["api_key"]),
                             ("agnes-2.5-pro-beta", "openai-compat", "unit-agnes-secret"))
            self.assertFalse(config["deepseek_app"]["thinking_default"])
            tao_real_provider.teardown(ctx)
            self.assertFalse(config_path.exists())
            self.assertNotIn("unit-agnes-secret", "".join(p.read_text() for p in case.glob("*")))

    def test_fixture_cleans_secret_config_even_without_an_outcome(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            config_root = root / "native-appconfig"
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root, case_dir=case, values={})
            with patch.dict(os.environ, {"TAOMNI_QA_DEEPSEEK_KEY": "unit-secret-never-report"}), \
                    patch.object(tao_real_provider, "native_isolation_env", return_value={"NEWMOB_CONFIG_DIR": str(config_root)}):
                tao_real_provider.setup(ctx)
            config = Path(ctx.values["tao_real_provider_config"])
            self.assertTrue(config.exists())
            tao_real_provider.teardown(ctx)
            self.assertFalse(config.exists())
            self.assertEqual((case / "real-provider-status.txt").read_text(), "request_prepared\nfixture_cleaned\n")
            self.assertNotIn("unit-secret-never-report", "".join(p.read_text() for p in root.rglob("*") if p.is_file()))

    def test_scripts_parse_without_reading_or_mutating_product_state(self):
        import subprocess
        for script in (INSTALL, READ):
            result = subprocess.run(["node", "-e", "new Function(process.argv[1]);", script], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_case_contract_and_schema_are_valid(self):
        import yaml
        from qa_ui_auto.testcase import validate_doc
        from qa_ui_auto.behavior_contract import validate_contract
        source = Path(__file__).resolve().parents[4] / "qa-ui-auto-tests/cases/TC-TAO-HOME-005-native-real-deepseek-smoke.testcase.yaml"
        doc = yaml.safe_load(source.read_text(encoding="utf-8"))
        self.assertEqual(validate_doc(doc, source=str(source)), [])
        self.assertEqual(validate_contract(doc, require_review=True), [])


if __name__ == "__main__":
    unittest.main()
