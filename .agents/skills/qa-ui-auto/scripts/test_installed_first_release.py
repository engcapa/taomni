"""Pure observations for the installed desktop's enrollment and removal checks."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from installed_first_release import enrollment
from installed_windows_webview import owned_listener
from native_driver_lifecycle import windows_webview_options
from native_webdriver_transport import WebDriverError
from qa_ui_auto.fixtures.module_legacy_mfa import close_installed_desktop
from qa_ui_auto.module_marketplace_observation import current_roster_modules


class InstalledFirstReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.profile = Path(temporary.name)
        self.roster = {"taomni-plugin-" + slug: {"slug": slug} for slug in ["mail", "mfa", "rdp-client"]}
        self.origin = SimpleNamespace(roster=self.roster, current_catalog=b'{"sequence":42}')
        self.state = {"origin": "legacy", "legacyPending": [], "seen": list(self.roster), "newModules": []}
        self.cache = self.profile / "plugins/.catalog-trust/catalog.json"
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text(json.dumps({"payload": self.origin.current_catalog.decode()}))

    def test_only_the_exact_cached_catalog_and_frozen_members_complete_first_enrollment(self):
        state = self.profile / ".module-release.json"
        state.write_text(json.dumps(self.state))
        self.assertEqual(enrollment(self.profile, self.origin), self.state)
        for change in [{"origin": "fresh"}, {"newModules": [next(iter(self.roster))]}, {"seen": []}]:
            state.write_text(json.dumps({**self.state, **change}))
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, "enroll"):
                enrollment(self.profile, self.origin)
        state.write_text(json.dumps(self.state))
        self.cache.write_text(json.dumps({"payload": "another catalog"}))
        with self.assertRaisesRegex(RuntimeError, "different catalog"):
            enrollment(self.profile, self.origin)

    def test_store_checks_member_identity_even_when_the_visible_count_matches(self):
        session = Mock()
        session.execute.return_value = sorted(self.roster)
        self.assertEqual(current_roster_modules(session, self.roster), sorted(self.roster))
        session.execute.return_value = ["taomni-plugin-mfa", "taomni-plugin-rdp-client"]
        self.assertEqual(current_roster_modules(session, self.roster, "mail"), session.execute.return_value)
        session.execute.return_value = ["taomni-plugin-mail", "taomni-plugin-rdp-client"]
        with self.assertRaisesRegex(RuntimeError, "shows current modules"):
            current_roster_modules(session, self.roster, "mail")

    def test_installed_and_isolated_windows_webview_profiles_are_selected_independently(self):
        explicit = str(self.profile / "production-webview")
        expected = {"userDataFolder": explicit, "additionalBrowserArguments": ["--force-color-profile=srgb"]}
        self.assertEqual(windows_webview_options({"TAOMNI_QA_WEBVIEW_DIR": explicit}, "qa-id"), expected)
        qa = windows_webview_options({"NEWMOB_DATA_DIR": str(self.profile)}, "qa-id")
        self.assertEqual(qa["userDataFolder"], str(self.profile / "qa-id/webview"))
        with self.assertRaises(WebDriverError):
            windows_webview_options({}, "qa-id")

    def test_windows_close_requires_the_installed_process_to_exit_before_the_next_launch(self):
        exe = self.profile / "Taomni.exe"
        app = Mock(pid=42)
        app.exe.return_value = str(exe)
        app.wait.return_value = 0
        driver = SimpleNamespace(application_process=app)
        session = SimpleNamespace(session_id="old", application_restart_observation={"exit_confirmation": {"status": "closed"}})
        with patch("platform.system", return_value="Windows"), \
                patch("qa_ui_auto.fixtures.module_legacy_mfa.close_application_window") as close:
            report = close_installed_desktop(driver, session, exe)
            self.assertEqual(report["shutdown"], {"pid": 42, "exitCode": 0})
            self.assertIsNone(session.session_id)
            close.assert_called_once()
            app.wait.assert_called_with(timeout=20)
            app.wait.return_value = 1
            with self.assertRaisesRegex(RuntimeError, "exited with 1"):
                close_installed_desktop(driver, session, exe)

    def test_attach_requires_a_loopback_listener_on_the_port_of_an_owned_process(self):
        process = Mock(pid=48)
        def connection(address, port, status="LISTEN"):
            return SimpleNamespace(laddr=(address, port), status=status)
        process.net_connections.return_value = [
            connection("0.0.0.0", 9222), connection("127.0.0.1", 9223),
            connection("127.0.0.1", 9222, "ESTABLISHED"),
        ]
        self.assertIsNone(owned_listener([process], 9222))
        process.net_connections.return_value.append(connection("127.0.0.1", 9222))
        self.assertEqual(owned_listener([process], 9222), 48)
