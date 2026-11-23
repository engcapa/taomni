"""Pure profile, runner and receipt contracts for installed resource measurements."""

from contextlib import nullcontext
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from installed_core_resources_desktop import (
    ProfileRestoreError, fresh_profiles, macos_observation, sample_desktop,
)


class DesktopResourceTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.profile = self.root / "com.taomni.app"
        self.profile.mkdir()
        self.database = self.profile / "taomni.db"
        self.database.write_bytes(b"upgrade data")
        self.executable = self.root / "installed taomni.exe"
        self.executable.write_bytes(b"installed")
        self.work = self.root / "work"
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()

    def test_three_windows_attempts_use_fresh_profiles_and_keep_original_data(self):
        samples = iter([(1200, 300), (1300, 400), (900, 500)])

        def observe(ctx, executable, attempt, receipt):
            self.assertEqual(executable, self.executable)
            self.assertEqual(list(self.profile.iterdir()), [])
            self.database.write_text(attempt.name, encoding="utf-8")
            ready, rss = next(samples)
            return {"readyMs": ready, "rssBytes": [rss - 10, rss, rss + 10], "pid": ready}

        with patch("installed_core_resources_desktop.platform.system", return_value="Windows"), patch(
            "installed_core_resources_desktop.windows_observation", side_effect=observe,
        ) as launch:
            result = sample_desktop(None, self.executable, self.profile, self.work, self.evidence, "candidate")

        self.assertEqual(launch.call_count, 3)
        self.assertEqual(result["medianReadyMs"], 1200)
        self.assertEqual(result["medianCoreRssBytes"], 400)
        self.assertEqual(result, json.loads((self.evidence / "candidate-samples.json").read_text()))
        self.assertEqual(len(list(self.evidence.glob("candidate-startup-*/sample.json"))), 3)
        self.assertEqual(self.database.read_bytes(), b"upgrade data")
        self.assertEqual(list(self.root.glob(".taomni-startup-*")), [])

    def test_rejects_a_candidate_that_does_not_use_the_isolated_profile(self):
        wrong_profile = {"readyMs": 1200, "rssBytes": [300, 310, 320], "pid": 25}
        with patch("installed_core_resources_desktop.platform.system", return_value="Windows"), patch(
            "installed_core_resources_desktop.windows_observation", return_value=wrong_profile,
        ), self.assertRaisesRegex(RuntimeError, "isolated production profile"):
            sample_desktop(None, self.executable, self.profile, self.work, self.evidence, "candidate")
        self.assertEqual(self.database.read_bytes(), b"upgrade data")

    def test_rejects_module_activation_and_restores_the_upgrade_profile(self):
        def observe(*_):
            self.database.write_bytes(b"fresh")
            module = self.profile / "plugins" / "mail"
            module.mkdir(parents=True)
            (module / "active.json").write_text("{}", encoding="utf-8")
            return {"readyMs": 1200, "rssBytes": [300, 310, 320], "pid": 25}

        with patch("installed_core_resources_desktop.platform.system", return_value="Windows"), patch(
            "installed_core_resources_desktop.windows_observation", side_effect=observe,
        ), self.assertRaisesRegex(RuntimeError, "installed module"):
            sample_desktop(None, self.executable, self.profile, self.work, self.evidence, "candidate")
        self.assertEqual(self.database.read_bytes(), b"upgrade data")
        self.assertFalse((self.profile / "plugins").exists())

    def test_profile_restoration_failure_preserves_the_original(self):
        rename = Path.rename

        def fail_restore(source, destination):
            if source.name == "original":
                raise PermissionError("test sharing violation")
            return rename(source, destination)

        with patch.object(Path, "rename", fail_restore):
            with self.assertRaisesRegex(ProfileRestoreError, "Original upgrade profile retained"):
                with fresh_profiles(self.profile):
                    self.profile.mkdir()
                    self.database.write_bytes(b"trial")
        saved, = self.root.glob(".taomni-startup-*/original/taomni.db")
        self.assertEqual(saved.read_bytes(), b"upgrade data")

    def test_macos_readiness_requires_the_owned_status_bar(self):
        owner = Mock(pid=29)
        owner.poll.return_value = None
        for payload in ({"ownerPid": 19, "statusMarker": "X11:"}, {"ownerPid": 29, "control": "Tools"}):
            with self.subTest(receipt=payload):
                received = SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
                with patch("installed_core_resources_desktop.installed_macos_desktop", return_value=nullcontext(owner)), patch(
                    "installed_core_resources_desktop.subprocess.run", return_value=received,
                ), patch("installed_core_resources_desktop.sample_rss") as rss:
                    with self.assertRaisesRegex(RuntimeError, "Unexpected macOS readiness receipt"):
                        macos_observation(self.root / "probe", self.executable, self.work, self.evidence)
                    rss.assert_not_called()
                self.assertEqual((self.evidence / "readiness.stdout.txt").read_text(), received.stdout)
