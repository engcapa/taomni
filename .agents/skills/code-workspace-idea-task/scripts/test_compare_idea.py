"""Synthetic validator fixtures for ED-AUDIT-001.

These tests exercise the record validator only. They do not claim IDEA, native,
provider, or qa-ui-auto runtime evidence.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

try:
    from compare_idea import load_schema
except ImportError:  # pragma: no cover - supports direct package-style discovery
    from .compare_idea import load_schema


SCRIPT_PATH = Path(__file__).with_name("compare_idea.py")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


class CompareIdeaFixtureTests(unittest.TestCase):
    """All fixtures are synthetic validator inputs, never runtime evidence."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="idea-compare-test-")
        self.root = Path(self.temp_dir.name)
        (self.root / "fixture").mkdir()
        (self.root / "report").mkdir()
        self.fixture_bytes = b"class Main {\r\n    void run() {}\r\n}\r\n"
        self.settings_bytes = b"keymap=Default\nformatter=Project\n"
        (self.root / "fixture" / "Main.java").write_bytes(self.fixture_bytes)
        (self.root / "report" / "settings.txt").write_bytes(self.settings_bytes)

        self.source_digest = "sha256:" + "1" * 64
        self.summary = {
            "schema": "qa-ui-auto.summary.v1",
            "totals": {"total": 1, "passed": 1, "failed": 0, "skipped": 0},
            "cases": [],
        }
        self._write_json("report/summary.json", self.summary)
        self.receipt = {
            "receiptId": "receipt-synthetic-validator",
            "runnerId": "qa-ui-auto-browser-runner",
            "sourceIdentityDigest": self.source_digest,
            "exitCode": 0,
            "artifacts": [],
        }
        self._write_json("report/runner_receipt.json", self.receipt)
        summary_ref = self._artifact("report/summary.json", "summary")
        self.receipt["artifacts"] = [
            {
                "path": "summary.json",
                "sha256": summary_ref["sha256"],
                "bytes": (self.root / "report" / "summary.json").stat().st_size,
            }
        ]
        self._write_json("report/runner_receipt.json", self.receipt)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_json(self, relative_path: str, value: dict) -> None:
        (self.root / relative_path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def _artifact(self, relative_path: str, artifact_type: str) -> dict:
        path = self.root / relative_path
        return {
            "rootAlias": "report" if relative_path.startswith("report/") else "fixture",
            "path": relative_path.removeprefix("report/").removeprefix("fixture/"),
            "sha256": sha256_bytes(path.read_bytes()),
            "type": artifact_type,
            "acquisition": "synthetic-validator-test",
        }

    def _observation(self) -> dict:
        return {
            "stepId": "edit",
            "status": "applied",
            "documents": [
                {
                    "relativePath": "src/Main.java",
                    "textSha256": "sha256:" + "2" * 64,
                    "byteSha256": "sha256:" + "3" * 64,
                    "dirty": False,
                }
            ],
            "caret": {
                "offsetUtf16": 5,
                "line": 0,
                "columnUtf16": 5,
                "visualColumn": 5,
                "graphemeColumn": 5,
                "tabSize": 4,
            },
            "selection": {"anchorUtf16": 5, "headUtf16": 5, "direction": "none"},
            "focusTarget": "editor",
            "results": {"items": [{"kind": "edit", "index": 0}], "range": None},
            "history": {
                "undoAvailable": True,
                "entryCount": 1,
                "lastAction": "edit",
                "identity": "history-1",
            },
            "errors": [],
            "recovery": {"status": "none", "action": None, "postcondition": None},
        }

    def record(self) -> dict:
        fixture = self._artifact("fixture/Main.java", "fixture")
        settings = self._artifact("report/settings.txt", "idea-settings")
        summary = self._artifact("report/summary.json", "taomni-summary")
        receipt = self._artifact("report/runner_receipt.json", "taomni-receipt")
        observation = self._observation()
        return {
            "schemaVersion": 1,
            "taskId": "ED-AUDIT-001",
            "acceptance": [
                "ED-AUDIT-001-A1",
                "ED-AUDIT-001-A2",
                "ED-AUDIT-001-A3",
            ],
            "scenarioId": "synthetic-editor-edit",
            "pathAliases": {"fixture": "fixture", "report": "report"},
            "fixture": {
                "relativePath": "Main.java",
                "sha256": fixture["sha256"],
                "initialContentSource": {
                    "kind": "fixture-file",
                    "description": "Synthetic validator fixture; no runtime claim",
                },
                "rootAlias": "fixture",
                "initialDirty": False,
                "diskState": "present-clean",
            },
            "settings": {
                "keymap": "Default",
                "actionBindings": {"editor.edit": ["Control+E"]},
                "editor": {"parameters": {"tabSize": 4, "softWrap": False}},
                "formatter": {"parameters": {"profile": "Project"}},
                "language": "Java",
                "jdk": {"version": "21", "tooling": "fixture-toolchain"},
                "project": {"importState": "ready", "indexingState": "ready"},
                "locale": "en-US",
                "plugins": [],
            },
            "steps": [
                {
                    "stepId": "edit",
                    "actionName": "Edit document",
                    "keyChord": "Control+E",
                    "input": {"text": "run"},
                    "preconditions": ["fixture is open", "project is ready"],
                    "observe": ["documents", "caret", "selection", "focus", "results", "history", "errors", "recovery"],
                }
            ],
            "idea": {
                "version": "2026.2.1",
                "build": "IU-262.10000.10",
                "edition": "Ultimate",
                "os": "Windows",
                "sampledAt": "2026-09-07T00:00:00Z",
                "operator": "synthetic-test",
                "automationTool": "manual-fixture",
                "settingsSnapshot": settings,
                "rawArtifacts": [settings],
            },
            "taomni": {
                "head": "a" * 40,
                "sourceIdentityDigest": self.source_digest,
                "qaBuildIdentity": {
                    "buildId": "synthetic-qa-build",
                    "sourceIdentityDigest": self.source_digest,
                    "platform": "Windows",
                    "profile": "debug",
                },
                "os": "Windows",
                "webview": "synthetic-webview",
                "provider": {"id": "fixture-provider", "version": "1"},
                "mode": "browser",
                "summary": summary,
                "receipt": receipt,
                "rawArtifacts": [summary, receipt],
            },
            "observations": [{"stepId": "edit", "idea": observation, "taomni": deepcopy(observation)}],
            "deltas": [
                {
                    "field": "observation.edit.documents",
                    "ideaValue": [{"relativePath": "src/Main.java", "byteSha256": "sha256:" + "3" * 64}],
                    "taomniValue": [{"relativePath": "src/Main.java", "byteSha256": "sha256:" + "3" * 64}],
                    "classification": "same",
                    "linkedAcceptance": ["ED-AUDIT-001-A1"],
                    "explanation": "Both sides report the same document path and byte digest after the edit.",
                    "disposition": "accepted",
                }
            ],
            "verdict": "matched",
            "ceiling": {
                "capability": "comparison-record-validation",
                "fixture": "synthetic-editor-edit",
                "provider": "fixture-provider",
                "platform": "Windows",
                "level": "L1",
                "claim": "Validator contract only; this synthetic fixture is not runtime parity evidence.",
            },
            "artifacts": [fixture, settings, summary, receipt],
            "unrun": [],
        }

    def _run_cli(self, record: dict, require_match: bool = True) -> tuple[int, dict]:
        record_path = self.root / "record.json"
        record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        command = [sys.executable, str(SCRIPT_PATH), "--record", str(record_path), "--base-dir", str(self.root)]
        if require_match:
            command.append("--require-match")
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertTrue(completed.stdout, completed.stderr)
        return completed.returncode, json.loads(completed.stdout)

    def test_valid_fixture_is_matched_and_require_match_exits_zero(self) -> None:
        code, report = self._run_cli(self.record())
        self.assertEqual(code, 0)
        self.assertEqual(report["verdict"], "matched")
        self.assertTrue(report["complete"])
        self.assertEqual(report["artifacts"]["failed"], 0)

    def test_version_mismatch_is_incomparable(self) -> None:
        record = self.record()
        record["idea"]["version"] = "2026.1.2"
        record["deltas"].append(
            {
                "field": "idea.version",
                "ideaValue": "2026.1.2",
                "taomniValue": "2026.2.1",
                "classification": "incomparable",
                "linkedAcceptance": ["ED-AUDIT-001-A2"],
                "explanation": "The recorded IDEA build is outside the required 2026.2.x comparison range.",
                "disposition": "unverified-until-2026-2-build",
            }
        )
        record["verdict"] = "incomparable"
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "incomparable")

    def test_missing_side_is_unverified(self) -> None:
        record = self.record()
        record["taomni"] = None
        record["observations"][0]["taomni"] = None
        record["verdict"] = "unverified"
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "unverified")
        self.assertTrue(any("absent" in error or "missing" in error for error in report["errors"]))

    def test_tampered_artifact_is_unverified(self) -> None:
        record = self.record()
        record["verdict"] = "unverified"
        (self.root / "report" / "summary.json").write_text("tampered\n", encoding="utf-8")
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "unverified")
        self.assertFalse(report["valid"])
        self.assertTrue(any("hash mismatch" in error for error in report["errors"]))

    def test_empty_artifact_inventory_is_unverified(self) -> None:
        record = self.record()
        record["artifacts"] = []
        record["verdict"] = "unverified"
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "unverified")
        self.assertTrue(any("not present in top-level artifacts inventory" in error for error in report["errors"]))

    def test_duplicate_step_is_a_format_error(self) -> None:
        record = self.record()
        record["steps"].append(deepcopy(record["steps"][0]))
        code, report = self._run_cli(record)
        self.assertEqual(code, 2)
        self.assertEqual(report["verdict"], "unverified")
        self.assertTrue(any("duplicate stepId" in error for error in report["formatErrors"]))

    def test_unverified_fake_pass_and_normalization_boundaries(self) -> None:
        record = self.record()
        record["observations"][0]["idea"]["documents"][0]["relativePath"] = "src\\Main.java"
        code, report = self._run_cli(record)
        self.assertEqual(code, 0, report)
        self.assertEqual(report["verdict"], "matched")

        record = self.record()
        record["unrun"] = ["IDEA 2026.2 manual sample has not been captured"]
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "unverified")
        self.assertEqual(report["declaredVerdict"], "matched")

        record = self.record()
        record["observations"][0]["taomni"]["documents"][0]["byteSha256"] = "sha256:" + "4" * 64
        record["deltas"][0]["classification"] = "different"
        record["deltas"][0]["explanation"] = "The byte digest differs, so EOL or bytes were not normalized away."
        record["verdict"] = "different"
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "different")
        self.assertIn("observation.edit.documents", report["observedDifferences"])

    def test_text_hash_and_result_order_are_not_normalized(self) -> None:
        record = self.record()
        record["observations"][0]["taomni"]["documents"][0]["textSha256"] = "sha256:" + "4" * 64
        record["observations"][0]["taomni"]["results"]["items"] = [{"kind": "edit", "index": 1}, {"kind": "edit", "index": 0}]
        record["deltas"] = [
            {
                "field": "observation.edit.documents",
                "ideaValue": "text hash 2",
                "taomniValue": "text hash 4",
                "classification": "different",
                "linkedAcceptance": ["ED-AUDIT-001-A1"],
                "explanation": "Text bytes differ and the result item order is intentionally retained.",
                "disposition": "record-delta",
            },
            {
                "field": "observation.edit.results",
                "ideaValue": [{"kind": "edit", "index": 0}],
                "taomniValue": [{"kind": "edit", "index": 1}, {"kind": "edit", "index": 0}],
                "classification": "different",
                "linkedAcceptance": ["ED-AUDIT-001-A1"],
                "explanation": "Result order is a factual sequence and is not sorted by the validator.",
                "disposition": "record-delta",
            },
        ]
        record["verdict"] = "different"
        code, report = self._run_cli(record)
        self.assertEqual(code, 1)
        self.assertEqual(report["verdict"], "different")
        self.assertCountEqual(
            report["observedDifferences"],
            ["observation.edit.documents", "observation.edit.results"],
        )


if __name__ == "__main__":
    unittest.main()
