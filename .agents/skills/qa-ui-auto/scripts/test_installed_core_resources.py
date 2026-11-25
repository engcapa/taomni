"""Unit coverage for the installed startup sample's process identity and units."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from installed_core_resources import record_linux_comparison, sample_rss


class InstalledCoreResourceTests(unittest.TestCase):
    def test_rejects_an_unrelated_process_before_sampling_memory(self):
        with TemporaryDirectory() as directory:
            executable = Path(directory) / "taomni"
            other = Path(directory) / "other"
            executable.touch()
            other.touch()
            owner = Mock()
            owner.exe.return_value = str(other)
            with self.assertRaisesRegex(RuntimeError, "measured PID"):
                sample_rss(owner, executable)
            owner.memory_info.assert_not_called()

    def test_takes_three_samples_from_the_verified_pid(self):
        with TemporaryDirectory() as directory:
            executable = Path(directory) / "taomni"
            executable.touch()
            owner = Mock()
            owner.exe.return_value = str(executable)
            owner.is_running.return_value = True
            owner.memory_info.side_effect = [SimpleNamespace(rss=size) for size in (10, 12, 11)]
            with patch("installed_core_resources.time.sleep"):
                self.assertEqual(sample_rss(owner, executable), [10, 12, 11])

    def test_identifies_both_installers_and_keeps_signed_differences(self):
        target = {"producerSource": "a" * 40, "producerRun": "4", "target": "linux-x86_64"}
        old = {"medianReadyMs": 900.5, "medianCoreRssBytes": 100_000}
        new = {"medianReadyMs": 850, "medianCoreRssBytes": 120_000}
        with TemporaryDirectory() as directory:
            evidence = Path(directory)
            original = evidence / "original.deb"
            candidate = evidence / "candidate.deb"
            original.write_bytes(b"0.5.12 installer")
            candidate.write_bytes(b"0.6.0 installer")
            with patch.dict("os.environ", {"GITHUB_RUN_ID": "8", "GITHUB_SHA": "b" * 40}):
                result = record_linux_comparison(evidence, target, original, candidate, old, new)
            self.assertEqual(json.loads((evidence / "installed-core-resources.json").read_text()), result)
            self.assertEqual(result["producerSource"], "a" * 40)
            self.assertEqual(result["verificationSource"], "b" * 40)
            self.assertNotEqual(result["original"]["installerSha256"], result["candidate"]["installerSha256"])
            self.assertEqual(result["readyMsChange"], -50.5)
            self.assertEqual(result["coreRssBytesChange"], 20_000)
