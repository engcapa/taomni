"""Pure authenticity/profile-oracle units; never downloads, installs or starts an app."""
from contextlib import closing
from dataclasses import replace
from email.message import Message
import hashlib
import json
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from qa_ui_auto import legacy_baseline
from qa_ui_auto.legacy_release import ASSETS, RELEASES, download_asset, first_upgrade_version, main, selected_asset, verify_asset
from qa_ui_auto.legacy_process import sanitized_output
from qa_ui_auto.legacy_install import install
from qa_ui_auto.fixtures.module_legacy_install import insert_business_rows, retained_manifest, session_rows
from qa_ui_auto.fixtures.module_legacy_mfa import transfer_databases
from qa_ui_auto.fixtures.module_upgrade import input_sessions


class PinnedReleaseTests(unittest.TestCase):
    def test_each_monolith_has_distinct_pinned_installers_for_all_release_platforms(self):
        for system, arch in [("Linux", "x64"), ("Windows", "x64"), ("Darwin", "arm64"), ("Darwin", "x64")]:
            machine = "x86_64" if arch == "x64" else "aarch64"
            with self.subTest(system=system, machine=machine):
                pins = []
                for version in ("0.5.10", "0.5.12", "0.5.13"):
                    asset = selected_asset(system, machine, version=version)
                    self.assertIn(f"_{version}_", asset.name)
                    self.assertGreater(asset.size, 0)
                    self.assertRegex(asset.sha256, "^[0-9a-f]{64}$")
                    pins.append(asset)
                self.assertEqual(len({asset.asset_id for asset in pins}), 3)
                self.assertEqual(len({asset.sha256 for asset in pins}), 3)
        with self.assertRaisesRegex(RuntimeError, "No pinned"):
            selected_asset("Linux", "x86_64", version="latest")

    def published(self, version="0.5.14"):
        release_id, assets = RELEASES["0.5.13"]
        return {
            "id": release_id, "tag_name": f"v{version}", "published_at": "2026-11-25T12:00:00Z",
            "draft": False, "prerelease": False,
            "assets": [{"id": a.asset_id, "name": a.name.replace("0.5.13", version), "size": a.size,
                        "digest": f"sha256:{a.sha256}", "state": "uploaded"} for a in assets.values()],
        }

    def test_new_public_monolith_and_explicit_historical_version(self):
        for requested, version, endpoint in [("", "0.5.14", "/latest"), ("v0.5.13", "0.5.13", "/tags/v0.5.13")]:
            with self.subTest(requested=requested), patch.object(
                    legacy_baseline, "metadata", return_value=self.published(version)) as api:
                baseline = legacy_baseline.resolve(requested)
                api.assert_called_once_with(endpoint)
                with patch.dict("os.environ", {"QA_FIRST_UPGRADE_BASELINE": json.dumps(baseline)}):
                    self.assertEqual(first_upgrade_version(), version)
                    self.assertEqual(selected_asset("Linux", "amd64", version=version).name,
                                     f"Taomni_{version}_amd64.deb")

    def test_release_review_detects_a_new_version_and_replaced_assets_under_the_same_tag(self):
        receipt = legacy_baseline.freeze(self.published(), "")
        same_tag = self.published()
        same_tag["assets"][0]["id"] += 1
        for public in (self.published("0.5.15"), same_tag):
            with self.subTest(tag=public["tag_name"]), patch.object(legacy_baseline, "metadata", return_value=public):
                with self.assertRaisesRegex(ValueError, "Repeat the installed upgrade"):
                    legacy_baseline.verify_current(receipt)
        with patch.object(legacy_baseline, "metadata", return_value=self.published()):
            self.assertEqual(legacy_baseline.verify_current(receipt), receipt)

    def test_finds_latest_monolith_after_a_modular_release(self):
        modular = self.published("0.6.0")
        modular["assets"].append({"name": "modules.json"})
        with patch.object(legacy_baseline, "metadata", side_effect=[modular, [modular, self.published()]]):
            self.assertEqual(legacy_baseline.resolve()["version"], "0.5.14")

    def test_rejects_incomplete_or_non_monolithic_release(self):
        for change in ("draft", "prerelease", "module", "missing", "digest", "duplicate"):
            release = self.published()
            if change in ("draft", "prerelease"):
                release[change] = True
            elif change == "module":
                release["assets"].append({"name": "modules.json"})
            elif change == "missing":
                release["assets"].pop()
            elif change == "digest":
                release["assets"][0]["digest"] = None
            else:
                release["assets"].append(release["assets"][0])
            with self.subTest(change=change), self.assertRaises(ValueError):
                legacy_baseline.freeze(release, "")

    def test_staging_and_install_use_one_observed_baseline_across_steps(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            env_file = folder / "github-env"
            with patch.dict("os.environ", {"GH_TOKEN": "test-token", "GITHUB_ENV": str(env_file)}, clear=True), patch.object(
                legacy_baseline, "metadata", return_value=self.published(),
            ) as api, patch("qa_ui_auto.legacy_release.platform.system", return_value="Linux"), patch(
                "qa_ui_auto.legacy_release.platform.machine", return_value="x86_64",
            ), patch("qa_ui_auto.legacy_release.download_asset") as download, patch("builtins.print"):
                with patch("sys.argv", ["legacy_release", str(folder), "--first-upgrade"]):
                    main()
                asset = selected_asset(version=first_upgrade_version())
                download.assert_called_once_with(folder, asset, token="test-token")
                api.assert_called_once_with("/latest")
                self.assertIn(str(folder / "first-upgrade-baseline.json"), env_file.read_text())
                with patch("sys.argv", ["legacy_release", str(folder)]):
                    main()
                download.assert_called_with(folder, ASSETS[("Linux", "x64")], token="test-token")

    def test_only_explicit_supported_release_architectures_are_accepted(self):
        self.assertIs(selected_asset("Windows", "AMD64"), ASSETS[("Windows", "x64")])
        self.assertIs(selected_asset("Darwin", "aarch64"), ASSETS[("Darwin", "arm64")])
        self.assertIs(selected_asset("Darwin", "x86_64"), ASSETS[("Darwin", "x64")])
        for system, arch in [("Linux", "aarch64"), ("Windows", "arm64"), ("FreeBSD", "x86_64")]:
            with self.assertRaisesRegex(RuntimeError, "No pinned"):
                selected_asset(system, arch)

    def test_substituted_same_size_installer_and_partial_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installer"
            path.write_bytes(b"trusted fixture")
            asset = replace(selected_asset("Linux", "x86_64"), size=15,
                            sha256=hashlib.sha256(b"trusted fixture").hexdigest())
            verify_asset(path, asset)
            path.write_bytes(b"changed fixture")
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                verify_asset(path, asset)
            path.write_bytes(b"partial")
            with self.assertRaisesRegex(RuntimeError, "wrong size"):
                verify_asset(path, asset)

    def test_download_requests_the_pinned_asset_id_and_publishes_verified_bytes(self):
        payload = b"verified installer"
        asset = replace(selected_asset("Linux", "x86_64"), size=len(payload),
                        sha256=hashlib.sha256(payload).hexdigest())
        response = BytesIO(payload)
        response.status = 200
        response.url = "https://release-assets.githubusercontent.com/installer"
        response.headers = Message()
        response.headers["Content-Type"] = "application/octet-stream"
        response.headers["Content-Length"] = str(len(payload))
        with tempfile.TemporaryDirectory() as directory, patch(
                "qa_ui_auto.legacy_release.urllib.request.urlopen", return_value=response) as open_url:
            downloaded = download_asset(directory, asset, token="read-only-test-token")
            self.assertEqual(downloaded.read_bytes(), payload)
            request = open_url.call_args.args[0]
            self.assertEqual(request.full_url,
                             f"https://api.github.com/repos/engcapa/taomni/releases/assets/{asset.asset_id}?download=1")
            self.assertEqual(request.get_header("Accept"), "application/octet-stream")
            self.assertEqual(request.unredirected_hdrs["Authorization"], "Bearer read-only-test-token")
            self.assertNotIn("Authorization", request.headers)
            self.assertEqual(list(Path(directory).iterdir()), [downloaded])

    def test_download_rejects_metadata_and_wrong_length_without_publishing(self):
        asset = selected_asset("Linux", "x86_64")
        for content_type, message in (("application/json", "pinned legacy asset"),
                                      ("application/octet-stream", "Content-Length")):
            with self.subTest(content_type=content_type), tempfile.TemporaryDirectory() as directory:
                response = BytesIO(b"{}")
                response.status = 200
                response.url = "https://api.github.com/asset"
                response.headers = Message()
                response.headers["Content-Type"] = content_type
                response.headers["Content-Length"] = "2"
                with patch("qa_ui_auto.legacy_release.urllib.request.urlopen", return_value=response):
                    with self.assertRaisesRegex(RuntimeError, message):
                        download_asset(directory, asset)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_local_or_wrong_repository_install_cannot_reach_a_downloader(self):
        for environment in [{}, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "other/repo"}]:
            with patch.dict("os.environ", environment, clear=True), patch("qa_ui_auto.legacy_install.verify_asset") as verify:
                with self.assertRaisesRegex(RuntimeError, "GitHub runners"):
                    install(Path("unused"), Path("unused"))
                verify.assert_not_called()

    def test_pairing_codes_are_removed_but_startup_failure_remains_readable(self):
        raw = "Mobile endpoint: http://127.0.0.1:1234\nPairing code (5 minutes): 123456\nHeadless: permission denied\n"
        result = sanitized_output(raw)
        self.assertNotIn("123456", result)
        self.assertIn("127.0.0.1:1234", result)
        self.assertIn("permission denied", result)


class OldProfileInputTests(unittest.TestCase):
    def test_installed_desktop_transfer_preserves_database_bytes_and_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory).resolve() / "legacy"
            destination = source.parent / "candidate"
            source.mkdir()
            destination.mkdir()
            input_files = {"mfa.db": b"mfa database", "mfa.db-wal": b"legacy WAL",
                           "vault.db": b"vault database", "vault.db-shm": b"transient"}
            for name, payload in input_files.items():
                (source / name).write_bytes(payload)
            receipts = transfer_databases(source, destination)
            self.assertEqual(set(receipts), {"mfa.db", "mfa.db-wal", "vault.db"})
            for name in receipts:
                self.assertEqual((destination / name).read_bytes(), input_files[name])
                self.assertEqual(receipts[name], hashlib.sha256(input_files[name]).hexdigest())
            with self.assertRaisesRegex(RuntimeError, "already contains"):
                transfer_databases(source, destination)

    def test_missing_old_schema_is_rejected_instead_of_synthesized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with closing(sqlite3.connect(root / "taomni.db")) as db:
                db.execute("CREATE TABLE sessions (id TEXT)")
            with self.assertRaisesRegex(RuntimeError, "actual legacy tables"):
                insert_business_rows(root, input_sessions(True))
            with closing(sqlite3.connect(root / "taomni.db")) as db:
                tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            self.assertEqual(tables, ["sessions"])

    def test_original_rows_cannot_be_overwritten_as_fixture_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with closing(sqlite3.connect(root / "taomni.db")) as db, db:
                db.executescript("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('existing');"
                                 "CREATE TABLE server_configs (id TEXT); CREATE TABLE rdp_certificate_pins (id TEXT);")
            with self.assertRaisesRegex(RuntimeError, "unexpectedly contains sessions"):
                insert_business_rows(root, input_sessions(True))
            self.assertEqual(session_rows(root), [{"id": "existing"}])

    def test_actual_chat_sidecars_are_hashed_without_copying_or_requiring_valid_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with self.assertRaisesRegex(RuntimeError, "did not create"):
                retained_manifest(root)
            (root / "lanchat.sqlite").write_bytes(b"opaque old store")
            (root / "lanchat.sqlite-wal").write_bytes(b"opaque old WAL")
            result = retained_manifest(root)
            self.assertEqual(set(result), {"lanchat.sqlite", "lanchat.sqlite-wal"})
            self.assertEqual(result["lanchat.sqlite-wal"], {
                "bytes": 14, "sha256": hashlib.sha256(b"opaque old WAL").hexdigest()})
            self.assertEqual(set(path.name for path in root.iterdir()), set(result))


if __name__ == "__main__":
    unittest.main()
