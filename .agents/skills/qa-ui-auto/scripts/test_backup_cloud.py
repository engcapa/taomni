"""Fixture contracts; these tests never launch a browser or native app."""
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch
import json
import tempfile
import urllib.error
import urllib.request

from qa_ui_auto.fixtures import backup_cloud


class BackupCloudFixtureTest(TestCase):
    def native(self, root: Path, case: str):
        ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, case_id=case,
                              case_dir=root, values={})
        with patch.object(backup_cloud, "isolated_data_root", return_value=root), \
                patch.object(backup_cloud, "setup_credential_store"):
            backup_cloud.setup(ctx)
        self.addCleanup(backup_cloud.teardown, ctx)
        return ctx

    def test_native_authorization_polls_until_cancelled_without_issuing_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = self.native(root, "TC-BACKUP-AUTH-715")
            self.assertEqual(list((root / "backup-control/authorization").glob("*.json")), [])
            endpoint = json.loads((root / "backup-control/qa-fixture.json").read_text())["endpoint"]
            client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            challenge = json.loads(client.open(urllib.request.Request(endpoint + "authorization", data=b"client_id=qa")).read())
            self.assertEqual(challenge["user_code"], "QA714")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                client.open(urllib.request.Request(endpoint + "token", data=b"device_code=qa-714-device"))
            self.assertEqual(json.loads(caught.exception.read()), {"error": "authorization_pending"})
            events = Path(ctx.values["backup_service_events"]).read_text()
            self.assertIn("authorization_started", events)
            self.assertIn("authorization_pending", events)
            self.assertNotIn("refresh_ok", events)
            backup_cloud.teardown(ctx)

    def test_native_compat_history_contains_all_fixed_envelopes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = self.native(root, "TC-BACKUP-COMPAT-001")
            self.assertEqual(sorted(p.name for p in (root / "backups").glob("*.taobak")),
                             ["legacy-plain.taobak", "legacy-v1.taobak", "legacy-v2.taobak"])
            self.assertEqual(Path(ctx.values["backup_policy_path"]), root / "backup_policy.json")
            backup_cloud.teardown(ctx)

    def test_browser_failure_injection_is_case_scoped(self):
        for case, expected in [("TC-BACKUP-SETTINGS-003", True), ("TC-BACKUP-SETTINGS-001", False)]:
            context = Mock()
            ctx = SimpleNamespace(cfg={"app": {"mode": "browser"}}, case_id=case, values={},
                                  page=SimpleNamespace(context=context))
            backup_cloud.setup(ctx)
            script = context.add_init_script.call_args.args[0]
            self.assertEqual("taomni.qa.backup.failSaves" in script, expected)


if __name__ == "__main__":
    main()
