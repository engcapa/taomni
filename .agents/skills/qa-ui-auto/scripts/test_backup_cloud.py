"""Fixture contracts; these tests never launch a browser or native app."""
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch
import json
import tempfile
import sqlite3
import time
import urllib.error
import urllib.request
import zipfile
from contextlib import closing

from qa_ui_auto.fixtures import backup_cloud
from qa_ui_auto.fixtures.backup_snapshot import inspect_selection


class BackupCloudFixtureTest(TestCase):
    def native(self, root: Path, case: str):
        ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, case_id=case,
                              case_dir=root, values={})
        with patch.object(backup_cloud, "isolated_data_root", return_value=root), \
                patch.object(backup_cloud, "setup_credential_store"), \
                patch.dict(backup_cloud.os.environ, {"GITHUB_ACTIONS": "false"}):
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

    def test_hosted_linux_authorization_fixture_owns_its_browser_until_teardown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, case_id="TC-BACKUP-AUTH-715",
                                  case_dir=root, report_root=root, values={})
            expected = {f"XDG_{name}_HOME": str(root / name.lower()) for name in ("DATA", "CONFIG", "CACHE")}
            with patch.object(backup_cloud, "isolated_data_root", return_value=root), \
                    patch.object(backup_cloud, "setup_credential_store"), \
                    patch.object(backup_cloud.platform, "system", return_value="Linux"), \
                    patch.dict(backup_cloud.os.environ, {"GITHUB_ACTIONS": "true", **expected}), \
                    patch("tauri_webdriver.native_isolation_env", return_value=expected), \
                    patch("native_external_browser.ExternalBrowserOwner") as owner, \
                    patch("native_authorization_route.AuthorizationBrowserRoute") as route:
                backup_cloud.setup(ctx)
            try:
                route.assert_called_once_with(root, expected)
                route.return_value.install.assert_called_once()
                owner.assert_called_once_with(root, root, expected, profile=route.return_value.profile,
                                              launch_record=route.return_value.record)
                events = []
                owner.return_value.stop.side_effect = lambda: events.append("browser-stop")
                with patch.object(ctx._backup_server, "shutdown", side_effect=lambda: events.append("server-stop")), \
                        patch.object(ctx._backup_server, "server_close"):
                    backup_cloud.teardown(ctx)
                self.assertEqual(events, ["browser-stop", "server-stop"])
                route.return_value.restore.assert_called_once()
            finally:
                ctx._backup_server.shutdown()
                ctx._backup_server.server_close()

    def test_browser_cleanup_failure_is_reported_but_loopback_server_still_closes(self):
        ctx = SimpleNamespace(_backup_browser=Mock(), _backup_browser_route=Mock(), _backup_server=Mock())
        ctx._backup_browser.stop.side_effect = RuntimeError("owned browser did not exit")
        with patch("qa_ui_auto.fixtures.backup_snapshot.teardown"):
            with self.assertRaisesRegex(RuntimeError, "owned browser"):
                backup_cloud.teardown(ctx)
        ctx._backup_browser_route.restore.assert_called_once()
        ctx._backup_server.shutdown.assert_called_once()
        ctx._backup_server.server_close.assert_called_once()

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

    def test_native_snapshot_observer_uses_an_external_releasable_os_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = self.native(root, "TC-BACKUP-CANCEL-002")
            command = Path(ctx.values["backup_snapshot_control"])
            events = Path(ctx.values["backup_snapshot_events"])
            command.write_text("hold-unit", encoding="utf-8")
            deadline = time.monotonic() + 5
            while "hold-unit=locked" not in events.read_text():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            journal = json.loads(Path(ctx.values["backup_recovered_journal"]).read_text())
            self.assertTrue(journal["cancelRequested"])
            self.assertEqual(journal["phase"], "preparing")
            command.write_text("release-unit", encoding="utf-8")
            while "release-unit=released" not in events.read_text():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            self.assertNotIn("ORACLE_ERROR", events.read_text())
            backup_cloud.teardown(ctx)

    def test_mail_oracle_rejects_missing_objects_and_wrong_attachment_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = self.native(root, "TC-BACKUP-MAIL-001")
            mail = root / "mail-cache"
            original = b"From: qa@example.com\r\nSubject: Backup original\r\n\r\nOriginal retained offline.\r\n"
            attachment = b"independent downloaded attachment"
            db_path = next(mail.glob("*.db"))
            with closing(sqlite3.connect(db_path)) as db, db:
                db.execute("CREATE TABLE mail_archive_index (uid INTEGER)")
                db.execute("INSERT INTO mail_archive_index VALUES (1)")
            output = root / "sample.taobak"
            files = [p for p in mail.rglob("*") if p.is_file()]
            def write(*, no_object=False, wrong_attachment=False):
                with zipfile.ZipFile(output, "w") as archive:
                    for path in files:
                        if no_object and path.name.endswith(".eml.gz"):
                            continue
                        payload = b"wrong" if wrong_attachment and path.suffix == ".bin" else path.read_bytes()
                        archive.writestr("mail-cache/" + path.relative_to(mail).as_posix(), payload)
            write()
            self.assertEqual(inspect_selection(output, root, original, attachment), "mail_db=1,originals=1,attachments=1,original_rows=1")
            write(no_object=True)
            with self.assertRaisesRegex(AssertionError, "missing objects"):
                inspect_selection(output, root, original, attachment)
            write(wrong_attachment=True)
            with self.assertRaisesRegex(AssertionError, "attachment bytes"):
                inspect_selection(output, root, original, attachment)
            backup_cloud.teardown(ctx)


if __name__ == "__main__":
    main()
