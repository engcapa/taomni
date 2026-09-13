"""Selection should avoid redundant runs without hiding requested boundaries."""
from __future__ import annotations

import contextlib
import io
import json
import platform
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from qa_ui_auto import verification
from qa_ui_auto.feature_catalog import Feature
from qa_ui_auto.testcase import TestCase


class SelectionTest(unittest.TestCase):
    def setUp(self):
        self.cases = [TestCase(id="TC-ui", title="UI", covers=["F1"], modes=["browser", "native"]),
                      TestCase(id="TC-other", title="Other", covers=["F2"])]
        self.features = [Feature(id="F1", title="UI", files=["src/components/View.tsx"])]

    def test_skill_prose_does_not_schedule_product_suite(self):
        result = verification.plan(self.cases, self.features,
                                   [".agents/skills/qa-ui-auto/SKILL.md",
                                    ".agents/skills/qa-ui-auto/references/native-testing.md"], "Windows")
        self.assertEqual(result["commands"], [])
        self.assertFalse(result["selection_requires_review"])

    def test_runner_change_still_broadens(self):
        result = verification.plan(self.cases, self.features,
                                   [".agents/skills/qa-ui-auto/scripts/qa_ui_auto/runner.py"], "Windows")
        self.assertEqual(set(result["selected_cases"]), {"TC-ui", "TC-other"})
        self.assertTrue(result["selection_requires_review"])

    def invoke(self, argv):
        output = io.StringIO()
        with patch.object(verification, "discover", return_value=self.cases), \
             patch.object(verification, "load_features", return_value=self.features), \
             contextlib.redirect_stdout(output):
            code = verification.main(argv)
        return code, output.getvalue()

    def test_exact_case_preserves_modes_case_directory_and_config(self):
        with patch.object(verification, "changed_files", return_value=[]):
            code, output = self.invoke(["plan", "--case", "TC-ui", "--diff", "HEAD",
                                       "--cases", "cases with spaces", "--config", "qa-custom.yaml",
                                       "--platform", "Windows", "--json"])
        self.assertEqual(code, 0)
        data = json.loads(output)
        self.assertEqual([c["mode"] for c in data["commands"]], ["browser", "native"])
        for command in data["commands"]:
            self.assertEqual(command["cases"], ["TC-ui"])
            self.assertEqual(command["argv"][-4:], ["--cases", "cases with spaces", "--config", "qa-custom.yaml"])
        self.assertTrue(data["selection_scope"]["limited"])

    def test_misspelled_or_filtered_id_fails_before_execution(self):
        for flags in (["--case", "TC-u"], ["--case", "TC-other", "--feature", "F1"]):
            code, output = self.invoke(["plan", *flags, "--json"])
            self.assertEqual(code, 2)
            self.assertIn("unknown or filtered-out", output)

    def test_printed_command_preserves_literal_arguments_in_host_shell(self):
        arguments = ["cases with spaces", "fixture's.yaml", "$qa_test_literal", "a;b", "TC-a,TC-b"]
        command = verification.shell_command([
            sys.executable, "-c", "import json, sys; print(json.dumps(sys.argv[1:]))", *arguments])
        shell = ["powershell", "-NoProfile", "-NonInteractive", "-Command"] if platform.system() == "Windows" else ["sh", "-c"]
        output = subprocess.check_output([*shell, command], text=True)
        self.assertEqual(json.loads(output), arguments)

    def test_status_checks_only_exact_case_and_retains_failure(self):
        with patch.object(verification, "execution_identity", return_value={}), \
             patch.object(verification, "load_observations", return_value=({}, [])):
            code, output = self.invoke(["status", "--case", "TC-ui", "--platform", "Windows", "--gate", "--json"])
        self.assertEqual(code, 1)
        data = json.loads(output)
        self.assertEqual([c["id"] for c in data["cases"]], ["TC-ui"])
        self.assertFalse(data["ok"])


if __name__ == "__main__":
    unittest.main()
