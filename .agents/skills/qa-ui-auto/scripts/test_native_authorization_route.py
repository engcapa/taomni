"""Owned browser routing preserves real URL opening without leaking profiles."""
from pathlib import Path
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from unittest import TestCase, main, skipUnless
from unittest.mock import patch

from native_authorization_browser import command, main as launch_browser
from native_authorization_route import AuthorizationBrowserRoute, desktop_argument


class AuthorizationBrowserRouteTest(TestCase):
    def expected(self, root):
        return {f"XDG_{name}_HOME": str(root / name.lower()) for name in ("DATA", "CONFIG", "CACHE")}

    def test_real_browser_commands_preserve_valid_destination_and_isolate_profiles(self):
        profile = Path("/run-owned/cache/private profile")
        url = "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=synthetic"
        self.assertEqual(command(Path("/usr/bin/firefox"), profile, url),
                         ["/usr/bin/firefox", "--no-remote", "--profile", str(profile), url])
        chrome = command(Path("/usr/bin/google-chrome"), profile, url)
        self.assertIn("--user-data-dir=" + str(profile), chrome)
        self.assertEqual(chrome[-1], url)
        self.assertNotIn("--no-sandbox", chrome)
        for url in ("file:///tmp/page", "http://accounts.feishu.cn/oauth/v1/device/verify",
                    "https://accounts.feishu.cn.evil.test/oauth/v1/device/verify",
                    "https://accounts.feishu.cn/oauth/v1/device/verify#fragment",
                    "https://user@accounts.feishu.cn/oauth/v1/device/verify",
                    "https://accounts.feishu.cn:443/oauth/v1/device/verify"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                command(Path("/usr/bin/firefox"), profile, url)

    def test_route_is_run_local_and_restores_existing_association_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "authorization case"
            case.mkdir()
            expected = self.expected(root)
            existing = Path(expected["XDG_CONFIG_HOME"]) / "mimeapps.list"
            existing.parent.mkdir()
            existing.write_bytes(b"[Default Applications]\ntext/plain=keep.desktop;\n")
            previous = existing.read_bytes()
            environment = {"GITHUB_ACTIONS": "true", **expected}

            def xdg(args, **kwargs):
                self.assertTrue(kwargs["check"])
                if args[1] == "default":
                    existing.write_text("temporary fixture association")
                    return subprocess.CompletedProcess(args, 0, "", "")
                return subprocess.CompletedProcess(args, 0, "taomni-qa-authorization.desktop\n", "")

            with patch.dict(os.environ, environment), patch("native_authorization_route.sys.platform", "linux"), \
                    patch("native_authorization_route.shutil.which", return_value="/usr/bin/firefox"), \
                    patch("native_authorization_route.subprocess.run", side_effect=xdg) as execute:
                route = AuthorizationBrowserRoute(case, expected)
                route.install()
                self.assertTrue(route.profile.is_relative_to(Path(expected["XDG_CACHE_HOME"])))
                self.assertTrue((route.profile / ".taomni-qa-browser").is_file())
                handler = route.handler
                self.assertIsNotNone(handler)
                self.assertIn(" %u\n", handler.read_text())
                self.assertIn("native_authorization_browser.py", (route.root / "open-browser.sh").read_text())
                self.assertEqual(execute.call_count, 4)
                route.restore()
                self.assertEqual(existing.read_bytes(), previous)
                self.assertFalse(handler.exists())
                route.restore()
                self.assertEqual(existing.read_bytes(), previous)

    def test_failed_association_is_restorable_and_never_publishes_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            expected = self.expected(root)
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", **expected}), \
                    patch("native_authorization_route.sys.platform", "linux"), \
                    patch("native_authorization_route.shutil.which", return_value="/usr/bin/firefox"), \
                    patch("native_authorization_route.subprocess.run",
                          return_value=subprocess.CompletedProcess([], 0, "foreign.desktop", "")):
                route = AuthorizationBrowserRoute(case, expected)
                with self.assertRaisesRegex(RuntimeError, "not selected"):
                    route.install()
                route.restore()
                self.assertFalse(route.handler.exists())
                self.assertFalse((Path(expected["XDG_CONFIG_HOME"]) / "mimeapps.list").exists())

    @skipUnless(sys.platform == "linux" and shutil.which("xdg-mime") and shutil.which("xdg-open"),
                "requires the real Linux system URL association tools")
    def test_real_xdg_tools_resolve_and_open_the_owned_handler(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            case.mkdir()
            expected = self.expected(root)
            arguments = root / "browser-arguments.txt"
            browser = root / "firefox"
            browser.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(arguments)) + "\n")
            browser.chmod(0o700)
            # Exercise generic xdg-utils even on a GNOME runner, without
            # accessing the user's desktop, DBus, browser or associations.
            environment = {**expected, "GITHUB_ACTIONS": "true", "DE": "generic",
                           "XDG_CURRENT_DESKTOP": "X-Generic", "DISPLAY": ":fixture-only",
                           "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(root / "no-bus"),
                           "BROWSER": "/bin/false"}
            with patch.dict(os.environ, environment), \
                    patch("native_authorization_route.shutil.which", return_value=str(browser)):
                route = AuthorizationBrowserRoute(case, expected)
                try:
                    route.install()  # Must not mock xdg-mime's executable lookup.
                    desktop = route.handler.read_text()
                    launcher = str(route.root / "open-browser.sh")
                    self.assertIn("Exec=" + launcher + " %u\n", desktop)
                    url = "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=synthetic"
                    subprocess.run(["xdg-open", url], capture_output=True, text=True,
                                   check=True, timeout=5)
                    self.assertEqual(arguments.read_text().splitlines(),
                                     ["--no-remote", "--profile", str(route.profile), url])
                    evidence = json.loads(route.record.read_text())
                    self.assertTrue(evidence["launched"])
                    self.assertEqual(evidence["profile"], str(route.profile))
                    self.assertNotIn("synthetic", route.record.read_text())
                finally:
                    route.restore()
                self.assertFalse(route.handler.exists())
                for folder in (Path(expected["XDG_CONFIG_HOME"]),
                               Path(expected["XDG_DATA_HOME"]) / "applications"):
                    self.assertFalse((folder / "mimeapps.list").exists())

    def test_route_refuses_non_hosted_environment_and_external_xdg_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "case"
            expected = self.expected(root)
            with patch.dict(os.environ, {**expected, "GITHUB_ACTIONS": "false"}), \
                    patch("native_authorization_route.sys.platform", "linux"), \
                    patch("native_authorization_route.subprocess.run") as execute:
                with self.assertRaisesRegex(RuntimeError, "hosted Linux"):
                    AuthorizationBrowserRoute(case, expected).install()
                execute.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, "non-run-owned"):
                AuthorizationBrowserRoute(case, {**expected, "XDG_CACHE_HOME": str(root.parent / "foreign")})

    def test_launcher_execs_real_browser_without_recording_authorization_url(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "native-appcache"
            profile = cache / "authorization-browser" / "case"
            profile.mkdir(parents=True)
            (profile / ".taomni-qa-browser").write_text("fixture")
            record = root / "launch.json"
            url = "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=not-recorded"
            argv = ["launcher", "--browser", "/usr/bin/google-chrome", "--profile", str(profile),
                    "--record", str(record), "--cache-root", str(cache), url]
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "XDG_CACHE_HOME": "sanitized"}), \
                    patch("sys.argv", argv), patch("native_authorization_browser.kernel_birth", return_value="123"), \
                    patch("native_authorization_browser.os.execv") as execute:
                launch_browser()
            execute.assert_called_once()
            self.assertEqual(execute.call_args.args[0], "/usr/bin/google-chrome")
            self.assertIn("--user-data-dir=" + str(profile.resolve()), execute.call_args.args[1])
            self.assertEqual(execute.call_args.args[1][-1], url)
            evidence = json.loads(record.read_text())
            self.assertTrue(evidence["launched"])
            self.assertEqual(evidence["profile"], str(profile.resolve()))
            self.assertEqual(evidence["started"], "123")
            self.assertNotIn("not-recorded", record.read_text())
            (profile / ".taomni-qa-browser").unlink()
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                    patch("sys.argv", argv), patch("native_authorization_browser.os.execv") as execute:
                with self.assertRaisesRegex(RuntimeError, "not fixture-owned"):
                    launch_browser()
                execute.assert_not_called()

    def test_desktop_exec_quote_keeps_paths_one_argument_and_url_unquoted(self):
        self.assertEqual(desktop_argument("/tmp/qa-run_123/open-browser.sh"),
                         "/tmp/qa-run_123/open-browser.sh")
        self.assertEqual(desktop_argument("/tmp/qa folder/open.sh"), '"/tmp/qa folder/open.sh"')
        self.assertEqual(desktop_argument('/tmp/a"b'), '"/tmp/a\\\\"b"')
        self.assertEqual(desktop_argument("/tmp/$x`y%z"), '"/tmp/\\\\$x\\\\`y%%z"')
        with self.assertRaises(ValueError):
            desktop_argument("/tmp/line\nbreak")


if __name__ == "__main__":
    main()
