#!/usr/bin/env python3
"""Unit tests for compare_idea.py (ED-AUDIT-001-A1/A2).

SYNTHETIC VALIDATOR TESTS: every fixture in this file is a synthetic validator
test fixture. These fixtures prove the record validator's own rules; they are
not runtime evidence and must never appear in a runtime passing matrix or any
IDEA comparison report.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import compare_idea

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4]
    / "claudedocs"
    / "code-workspace-idea-specs"
    / "idea-comparison.schema.json"
)

SYNTHETIC_NOTE = "synthetic validator test fixture; not runtime evidence"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def base_record() -> dict:
    """A minimal valid matched record over one step and one fixture file."""
    fixture_text = "class A {\n  int x = 1;\n}\n"
    artifact_text = "raw observation artifact\n"
    return {
        "schemaVersion": 1,
        "taskId": "ED-AUDIT-001",
        "acceptance": ["ED-AUDIT-001-A1", "ED-AUDIT-001-A2", "ED-AUDIT-001-A3"],
        "scenarioId": "synthetic-scenario-1",
        "fixture": {
            "files": [{"path": "src/A.java", "sha256": sha256_text(fixture_text)}],
            "contentSource": "synthetic",
            "rootAlias": "fixture-root",
            "initialState": {"dirty": False, "onDisk": True},
        },
        "settings": {
            "keymap": {"name": "macOS", "bindings": [{"actionName": "Undo", "keys": ["meta z"]}]},
            "editor": {"tabSize": 2},
            "language": "Java",
        },
        "steps": [
            {
                "stepId": "s1",
                "actionName": "type",
                "keys": ["x"],
                "input": "x",
                "preState": "clean buffer at offset 0",
                "observedFields": ["documents", "caret", "history"],
            }
        ],
        "idea": {
            "version": "2026.2.3",
            "buildNumber": "IU-262.1",
            "edition": "Ultimate",
            "os": "Linux",
            "sampledAt": "2026-09-07T00:00:00Z",
            "operator": "manual",
            "settingsSnapshot": {"idea.undo.limit": 100},
            "artifacts": [],
            "observations": [
                {
                    "stepId": "s1",
                    "status": "observed",
                    "documents": [
                        {
                            "path": "src/A.java",
                            "textHash": sha256_text("class A {\n  int x = 1x;\n}\n"),
                            "byteHash": sha256_text("class A {\n  int x = 1x;\n}\n"),
                            "dirty": True,
                        }
                    ],
                    "caret": {"offset": 21, "offsetEncoding": "utf16"},
                    "selection": [{"anchor": 21, "head": 21, "offsetEncoding": "utf16"}],
                    "focus": "editor",
                    "results": [],
                    "history": {"undoAvailable": True, "redoAvailable": False, "undoCount": 1, "undoText": "Typing"},
                    "errors": [],
                    "recovery": "undo restores offset 20",
                }
            ],
        },
        "taomni": {
            "head": "a" * 40,
            "sourceIdentity": {"sourceTreeHash": "b" * 64, "sourceDirty": False},
            "qaBuildIdentity": "qa-bundle-1",
            "os": "Linux",
            "webview": "webkit2gtk",
            "provider": {"id": "jdtls", "version": "1.40.0"},
            "mode": "native",
            "summary": {"path": "summary.json", "sha256": "c" * 64},
            "receipt": {"path": "receipt.json", "sha256": "d" * 64},
            "observations": [
                {
                    "stepId": "s1",
                    "status": "observed",
                    "documents": [
                        {
                            "path": "src/A.java",
                            "textHash": sha256_text("class A {\n  int x = 1x;\n}\n"),
                            "byteHash": sha256_text("class A {\n  int x = 1x;\n}\n"),
                            "dirty": True,
                        }
                    ],
                    "caret": {"offset": 21, "offsetEncoding": "utf16"},
                    "selection": [{"anchor": 21, "head": 21, "offsetEncoding": "utf16"}],
                    "focus": "editor",
                    "results": [],
                    "history": {"undoAvailable": True, "redoAvailable": False, "undoCount": 1, "undoText": "Typing"},
                    "errors": [],
                    "recovery": "undo restores offset 20",
                }
            ],
        },
        "observations": [
            {
                "stepId": "s1",
                "status": "matched",
                "idea": "typed x at offset 20",
                "taomni": "typed x at offset 20",
                "linkedAcceptance": ["ED-AUDIT-001-A1"],
            }
        ],
        "deltas": [],
        "verdict": {"state": "matched", "reason": "all comparable steps matched"},
        "ceiling": {
            "capability": "typing",
            "fixture": "single java file",
            "provider": "jdtls vs IDEA PSI",
            "platform": "Linux",
            "level": "L3",
        },
        "artifacts": [
            {"path": "raw/idea-after.txt", "sha256": sha256_text(artifact_text), "type": "text", "acquisition": "copy"}
        ],
        "notes": [SYNTHETIC_NOTE],
    }


class ValidatorTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="synthetic-validator-fixture-")
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    # -- fixture helpers ---------------------------------------------------

    def write_record(self, record: dict, name: str = "record.json") -> Path:
        path = self.root / name
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def write_artifact(self, record: dict, content: str = "raw observation artifact\n") -> None:
        entry = record["artifacts"][0]
        target = self.root / Path(entry["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def run_cli(self, record_path: Path, *extra: str) -> tuple[int, str, str]:
        import io
        from contextlib import redirect_stderr, redirect_stdout

        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = compare_idea.main(
                ["--record", str(record_path), "--schema", str(SCHEMA_PATH), *extra]
            )
        return code, out.getvalue(), err.getvalue()

    # -- ED-AUDIT-001-A1: fields, verdicts, exit codes, normalization ------

    def test_valid_record_exits_zero(self) -> None:
        record = base_record()
        self.write_artifact(record)
        code, out, _ = self.run_cli(self.write_record(record))
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertEqual(report["computedVerdict"], "matched")
        self.assertEqual(report["recordedVerdict"], "matched")
        self.assertEqual(report["artifactChecks"][0]["result"], "verified")

    def test_every_required_field_is_enforced(self) -> None:
        required = [
            "schemaVersion", "taskId", "acceptance", "scenarioId", "fixture",
            "settings", "steps", "idea", "taomni", "observations", "deltas",
            "verdict", "ceiling", "artifacts",
        ]
        for field in required:
            with self.subTest(field=field):
                record = base_record()
                self.write_artifact(record)
                del record[field]
                code, _, err = self.run_cli(self.write_record(record))
                self.assertEqual(code, 2, err)
                self.assertIn(field, err)

    def test_additional_property_rejected(self) -> None:
        record = base_record()
        self.write_artifact(record)
        record["extraField"] = 1
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("extraField", err)

    def test_four_state_verdict_exit_codes(self) -> None:
        # matched -> 0 with --require-match
        matched = base_record()
        self.write_artifact(matched)
        self.assertEqual(self.run_cli(self.write_record(matched), "--require-match")[0], 0)

        # different -> 1 with --require-match, 0 without
        different = base_record()
        different["observations"][0]["status"] = "different"
        different["verdict"] = {"state": "different", "reason": "caret offset differs"}
        self.write_artifact(different)
        path = self.write_record(different, "different.json")
        self.assertEqual(self.run_cli(path, "--require-match")[0], 1)
        self.assertEqual(self.run_cli(path)[0], 0)

        # incomparable (non-2026.2.x IDEA version) -> 1 with --require-match
        incomparable = base_record()
        incomparable["idea"]["version"] = "2025.2.3"
        incomparable["verdict"] = {"state": "incomparable", "reason": "IDEA version 2025.2.3 is not 2026.2.x"}
        self.write_artifact(incomparable)
        path = self.write_record(incomparable, "incomparable.json")
        self.assertEqual(self.run_cli(path, "--require-match")[0], 1)
        self.assertEqual(self.run_cli(path)[0], 0)

        # unverified (one side missing) -> 1 with --require-match
        unverified = base_record()
        unverified["taomni"]["observations"] = []
        unverified["verdict"] = {"state": "unverified", "reason": "Taomni side did not run"}
        self.write_artifact(unverified)
        path = self.write_record(unverified, "unverified.json")
        self.assertEqual(self.run_cli(path, "--require-match")[0], 1)
        self.assertEqual(self.run_cli(path)[0], 0)

    def test_recorded_verdict_must_match_computed(self) -> None:
        record = base_record()
        record["observations"][0]["status"] = "different"
        # verdict still claims matched: fake pass, fail closed
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("verdict mismatch", err)

    def test_eol_and_text_differences_are_not_swallowed(self) -> None:
        lf = "class A {\n  int x = 1x;\n}\n"
        crlf = "class A {\r\n  int x = 1x;\r\n}\r\n"
        record = base_record()
        record["idea"]["observations"][0]["documents"][0]["byteHash"] = sha256_text(crlf)
        record["idea"]["observations"][0]["documents"][0]["textHash"] = sha256_text(lf)
        record["observations"][0]["status"] = "different"
        record["observations"][0]["idea"] = "CRLF line endings preserved"
        record["observations"][0]["taomni"] = "LF line endings"
        record["verdict"] = {"state": "different", "reason": "EOL bytes differ"}
        self.write_artifact(record)
        code, out, _ = self.run_cli(self.write_record(record), "--require-match")
        self.assertEqual(code, 1)
        report = json.loads(out)
        self.assertEqual(report["computedVerdict"], "different")
        self.assertEqual(report["differentSteps"], ["s1"])

    def test_only_os_separator_normalization_is_permitted(self) -> None:
        record = base_record()
        record["fixture"]["files"][0]["path"] = "src\\A.java"
        record["idea"]["observations"][0]["documents"][0]["path"] = "src\\A.java"
        record["taomni"]["observations"][0]["documents"][0]["path"] = "src\\A.java"
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 0, err)

    def test_taomni_only_steps_stay_out_of_matched_denominator(self) -> None:
        # All steps taomni-only: no IDEA denominator, matched is a fake pass.
        record = base_record()
        record["observations"][0]["status"] = "taomni-only"
        record["verdict"] = {"state": "matched", "reason": "fake"}
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("taomni-only", err)

        # Recorded honestly as unverified: valid, and reported separately.
        record["verdict"] = {"state": "unverified", "reason": "no IDEA-side denominator"}
        self.write_artifact(record)
        code, out, _ = self.run_cli(self.write_record(record, "taomni-only-honest.json"))
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertEqual(report["computedVerdict"], "unverified")
        self.assertEqual(report["taomniOnlyCount"], 1)

        # Mixed: one both-side matched step plus a taomni-only step stays matched.
        mixed = base_record()
        mixed["steps"].append(
            {
                "stepId": "s2",
                "actionName": "taomni negative path",
                "menuPath": "Refactor > Taomni-only",
                "input": None,
                "preState": "clean",
                "observedFields": ["errors"],
            }
        )
        mixed["observations"].append(
            {"stepId": "s2", "status": "taomni-only", "idea": None, "taomni": "typed failure path", "linkedAcceptance": []}
        )
        mixed["taomni"]["observations"].append({"stepId": "s2", "status": "observed", "errors": ["unsupported"]})
        self.write_artifact(mixed)
        code, out, _ = self.run_cli(self.write_record(mixed, "mixed.json"))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["computedVerdict"], "matched")

    def test_not_run_requires_explicit_reason(self) -> None:
        record = base_record()
        record["taomni"]["observations"][0]["status"] = "not-run"
        record["verdict"] = {"state": "unverified", "reason": "Taomni step not run"}
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("explicit reason", err)

        record["taomni"]["observations"][0]["reason"] = "provider unavailable on this run"
        self.write_artifact(record)
        code, out, _ = self.run_cli(self.write_record(record, "with-reason.json"))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["computedVerdict"], "unverified")

    def test_acceptance_identity_consistency(self) -> None:
        record = base_record()
        record["acceptance"].append("ED-AUDIT-999-A1")
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("ED-AUDIT-999-A1", err)

        record = base_record()
        record["observations"][0]["linkedAcceptance"] = ["ED-AUDIT-001-A9"]
        self.write_artifact(record, "linked.json")
        code, _, err = self.run_cli(self.write_record(record, "linked.json"))
        self.assertEqual(code, 2, err)
        self.assertIn("linkedAcceptance", err)

    def test_record_content_is_never_executed(self) -> None:
        record = base_record()
        record["steps"][0]["actionName"] = "__import__('os').system('touch pwned')"
        record["steps"][0]["keys"] = ["echo pwned"]
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 0, err)
        self.assertFalse((self.root / "pwned").exists())

    # -- ED-AUDIT-001-A2: the six deterministic fixtures -------------------

    def test_fixture_1_valid(self) -> None:
        record = base_record()
        self.write_artifact(record)
        code, out, _ = self.run_cli(self.write_record(record, "f1-valid.json"), "--require-match")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["computedVerdict"], "matched")

    def test_fixture_2_version_mismatch(self) -> None:
        record = base_record()
        record["idea"]["version"] = "2024.3.5"
        record["verdict"] = {"state": "incomparable", "reason": "IDEA 2024.3.5 cannot be compared to 2026.2 expectations"}
        self.write_artifact(record)
        path = self.write_record(record, "f2-version-mismatch.json")
        self.assertEqual(self.run_cli(path)[0], 0)
        self.assertEqual(self.run_cli(path, "--require-match")[0], 1)
        # Claiming matched on a non-2026.2.x run is a fake pass.
        record["verdict"] = {"state": "matched", "reason": "fake"}
        self.assertEqual(self.run_cli(self.write_record(record, "f2-fake.json"))[0], 2)

    def test_fixture_3_missing_one_side(self) -> None:
        record = base_record()
        record["taomni"]["observations"] = []
        record["verdict"] = {"state": "unverified", "reason": "Taomni side did not run"}
        self.write_artifact(record)
        path = self.write_record(record, "f3-missing-side.json")
        self.assertEqual(self.run_cli(path)[0], 0)
        self.assertEqual(self.run_cli(path, "--require-match")[0], 1)
        record["verdict"] = {"state": "matched", "reason": "fake"}
        self.assertEqual(self.run_cli(self.write_record(record, "f3-fake.json"))[0], 2)

    def test_fixture_4_tampered_artifact(self) -> None:
        record = base_record()
        self.write_artifact(record, "tampered content\n")
        code, _, err = self.run_cli(self.write_record(record, "f4-tampered.json"))
        self.assertEqual(code, 2, err)
        self.assertIn("sha256 mismatch", err)

    def test_fixture_5_duplicate_step(self) -> None:
        record = base_record()
        record["steps"].append(dict(record["steps"][0]))
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record, "f5-duplicate-step.json"))
        self.assertEqual(code, 2, err)
        self.assertIn("duplicate stepId", err)

    def test_fixture_6_unverified_fake_pass(self) -> None:
        record = base_record()
        record["steps"].append(
            {
                "stepId": "s2",
                "actionName": "undo",
                "keys": ["meta z"],
                "input": None,
                "preState": "typed",
                "observedFields": ["documents"],
            }
        )
        # s2 has no observation but the verdict claims matched: fake pass.
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record, "f6-fake-pass.json"))
        self.assertEqual(code, 2, err)
        self.assertIn("missing observation", err)

    # -- additional fail-closed coverage -----------------------------------

    def test_missing_observation_for_step_fails_closed(self) -> None:
        record = base_record()
        record["observations"] = []
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("missing observation", err)

    def test_unknown_step_in_observation_fails_closed(self) -> None:
        record = base_record()
        record["observations"][0]["stepId"] = "ghost"
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("unknown step", err)

    def test_step_requires_keys_or_menu_path(self) -> None:
        record = base_record()
        del record["steps"][0]["keys"]
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("keys or menuPath", err)

    def test_document_outside_fixture_files_fails_closed(self) -> None:
        record = base_record()
        record["taomni"]["observations"][0]["documents"][0]["path"] = "src/B.java"
        self.write_artifact(record)
        code, _, err = self.run_cli(self.write_record(record))
        self.assertEqual(code, 2, err)
        self.assertIn("not a declared fixture file", err)

    def test_missing_artifact_blocks_matched_but_not_other_verdicts(self) -> None:
        record = base_record()
        # No artifact file written at all.
        path = self.write_record(record, "missing-artifact.json")
        self.assertEqual(self.run_cli(path)[0], 2)

        record["verdict"] = {"state": "different", "reason": "caret differs"}
        record["observations"][0]["status"] = "different"
        path = self.write_record(record, "missing-artifact-different.json")
        code, out, _ = self.run_cli(path)
        self.assertEqual(code, 0)
        self.assertIn("missing", json.loads(out)["artifactChecks"][0]["result"])

    def test_fixture_root_hash_verification(self) -> None:
        record = base_record()
        self.write_artifact(record)
        fixture_root = self.root / "fixture-root"
        (fixture_root / "src").mkdir(parents=True)
        (fixture_root / "src" / "A.java").write_text("class A {\n  int x = 1;\n}\n", encoding="utf-8")
        path = self.write_record(record, "fixture-ok.json")
        code, _, err = self.run_cli(path, "--fixture-root", str(fixture_root))
        self.assertEqual(code, 0, err)

        (fixture_root / "src" / "A.java").write_text("tampered\n", encoding="utf-8")
        code, _, err = self.run_cli(path, "--fixture-root", str(fixture_root))
        self.assertEqual(code, 2, err)
        self.assertIn("fixture/build mismatch", err)

    def test_malformed_json_exits_two(self) -> None:
        path = self.root / "broken.json"
        path.write_text("{not json", encoding="utf-8")
        code, _, err = self.run_cli(path)
        self.assertEqual(code, 2, err)
        self.assertIn("not valid JSON", err)


if __name__ == "__main__":
    unittest.main()
