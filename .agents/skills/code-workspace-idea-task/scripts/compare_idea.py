#!/usr/bin/env python3
"""Validate an IDEA 2026.2 vs Taomni comparison record.

The record contract lives in ``claudedocs/code-workspace-idea-specs/idea-2026-comparison.md``
(section 2) and ``idea-comparison.schema.json``. This CLI is stdlib-only: it never
loads, imports, or executes anything contained in the record.

Exit codes:
  0  record is valid; with ``--require-match`` also requires verdict ``matched``
  1  record is valid but the verdict is ``different``/``incomparable``/``unverified``
     (only reported with ``--require-match``)
  2  format or fail-closed semantic error (duplicate step, missing observation,
     missing artifacts, tampered artifact, fixture/build mismatch, fake pass, ...)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import sys
from typing import Any

IDEA_COMPARABLE_VERSION = re.compile(r"^2026\.2\.\d+$")
TASK_ID_PATTERN = re.compile(r"^ED-[A-Z]+-\d{3}$")
ACCEPTANCE_ID_PATTERN = re.compile(r"^ED-[A-Z]+-\d{3}-A\d+$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

# The only permitted normalization: OS path separators are unified to "/" for
# path-typed fields. Text, BOM, EOL, byte hashes, result order, and timing are
# never normalized away.
PATH_FIELD_SUFFIXES = ("path",)


class RecordError(RuntimeError):
    """A format or fail-closed semantic error (exit 2)."""


# ---------------------------------------------------------------------------
# Minimal JSON Schema subset validator (stdlib only)
# ---------------------------------------------------------------------------

def _resolve_ref(schema: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise RecordError(f"schema: unsupported $ref {ref!r}")
    node: Any = schema
    for token in ref[2:].split("/"):
        if not isinstance(node, dict) or token not in node:
            raise RecordError(f"schema: broken $ref {ref!r}")
        node = node[token]
    if not isinstance(node, dict):
        raise RecordError(f"schema: $ref {ref!r} does not resolve to an object")
    return node


def _check_type(value: Any, expected: Any, where: str) -> None:
    types = expected if isinstance(expected, list) else [expected]
    matched = False
    for name in types:
        if name == "object" and isinstance(value, dict):
            matched = True
        elif name == "array" and isinstance(value, list):
            matched = True
        elif name == "string" and isinstance(value, str):
            matched = True
        elif name == "integer" and isinstance(value, int) and not isinstance(value, bool):
            matched = True
        elif name == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            matched = True
        elif name == "boolean" and isinstance(value, bool):
            matched = True
        elif name == "null" and value is None:
            matched = True
        if matched:
            break
    if not matched:
        raise RecordError(f"{where}: expected type {expected!r}")


def validate_schema(
    value: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    where: str,
    errors: list[str],
) -> None:
    """Validate one value against the supported subset; collect all errors."""
    try:
        _validate_schema_strict(value, schema, root, where, errors)
    except RecordError as error:
        errors.append(str(error))


def _validate_schema_strict(
    value: Any,
    schema: dict[str, Any],
    root: dict[str, Any],
    where: str,
    errors: list[str],
) -> None:
    if "$ref" in schema:
        _validate_schema_strict(value, _resolve_ref(root, schema["$ref"]), root, where, errors)
        return

    if "const" in schema and value != schema["const"]:
        errors.append(f"{where}: expected const {schema['const']!r}, got {value!r}")
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {value!r} is not one of {schema['enum']!r}")
        return
    if "type" in schema:
        _check_type(value, schema["type"], where)

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{where}: shorter than minLength {schema['minLength']}")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{where}: {value!r} does not match pattern {schema['pattern']!r}")

    if isinstance(value, int) and not isinstance(value, bool) and "minimum" in schema:
        if value < schema["minimum"]:
            errors.append(f"{where}: {value} below minimum {schema['minimum']}")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{where}: needs at least {schema['minItems']} items, got {len(value)}")
        if schema.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            errors.append(f"{where}: items are not unique")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                _validate_schema_strict(item, item_schema, root, f"{where}[{index}]", errors)

    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{where}: missing required field {name!r}")
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties", True)
        for name, item in value.items():
            child_where = f"{where}.{name}"
            if name in properties:
                _validate_schema_strict(item, properties[name], root, child_where, errors)
            elif additional is False:
                errors.append(f"{child_where}: additional property is not allowed")
            elif isinstance(additional, dict):
                _validate_schema_strict(item, additional, root, child_where, errors)


# ---------------------------------------------------------------------------
# Structural helpers
# ---------------------------------------------------------------------------

def normalize_declared_path(value: str) -> str:
    """Unify OS separators to '/'. This is the only permitted normalization."""
    return value.replace("\\", "/")


def sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_record(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise RecordError(f"cannot read record {path}: {error}") from error
    try:
        record = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RecordError(f"record is not valid JSON: {error}") from error
    if not isinstance(record, dict):
        raise RecordError("record must be a JSON object")
    return record


# ---------------------------------------------------------------------------
# Semantic fail-closed checks
# ---------------------------------------------------------------------------

def semantic_checks(record: dict[str, Any], errors: list[str], warnings: list[str]) -> dict[str, Any]:
    def fail(message: str) -> None:
        errors.append(message)

    steps = record.get("steps", [])
    step_ids = [step.get("stepId") for step in steps]
    seen: set[str] = set()
    for step_id in step_ids:
        if step_id in seen:
            fail(f"duplicate stepId {step_id!r} in steps")
        seen.add(step_id)

    for index, step in enumerate(steps):
        if not (step.get("keys") or step.get("menuPath")):
            fail(f"steps[{index}] ({step.get('stepId')!r}): needs keys or menuPath")

    observations = record.get("observations", [])
    obs_by_step: dict[str, list[dict[str, Any]]] = {}
    seen_obs: set[str] = set()
    for index, obs in enumerate(observations):
        step_id = obs.get("stepId")
        if step_id in seen_obs:
            fail(f"duplicate stepId {step_id!r} in observations")
        seen_obs.add(step_id)
        obs_by_step.setdefault(step_id, []).append(obs)
    for step_id in step_ids:
        if step_id not in obs_by_step:
            fail(f"missing observation for step {step_id!r}")
    for step_id in obs_by_step:
        if step_id not in seen:
            fail(f"observation references unknown step {step_id!r}")

    # Fixture/build mismatch: every observed document must be a declared fixture file.
    fixture_files = {normalize_declared_path(f.get("path", "")) for f in record.get("fixture", {}).get("files", [])}
    for side_name in ("idea", "taomni"):
        for obs in record.get(side_name, {}).get("observations", []):
            for doc in obs.get("documents", []):
                doc_path = normalize_declared_path(doc.get("path", ""))
                if doc_path not in fixture_files:
                    fail(f"{side_name} observation {obs.get('stepId')!r}: document {doc_path!r} is not a declared fixture file")

    # Unrun layers keep an explicit reason.
    for side_name in ("idea", "taomni"):
        for obs in record.get(side_name, {}).get("observations", []):
            if obs.get("status") == "not-run" and not obs.get("reason"):
                fail(f"{side_name} observation {obs.get('stepId')!r}: status not-run requires an explicit reason")

    # Acceptance identity consistency.
    task_id = record.get("taskId", "")
    acceptance = record.get("acceptance", [])
    acceptance_set = set(acceptance)
    for acceptance_id in acceptance:
        if not acceptance_id.startswith(f"{task_id}-"):
            fail(f"acceptance id {acceptance_id!r} does not belong to task {task_id!r}")
    for container, label in (
        (record.get("observations", []), "observations"),
        (record.get("deltas", []), "deltas"),
    ):
        for index, entry in enumerate(container):
            for linked in entry.get("linkedAcceptance", []):
                if linked not in acceptance_set:
                    fail(f"{label}[{index}]: linkedAcceptance {linked!r} is not in the record's acceptance list")

    # Artifact verification happens outside (needs the filesystem); here only
    # compute the verdict inputs.
    idea_side = record.get("idea", {}).get("observations", [])
    taomni_side = record.get("taomni", {}).get("observations", [])
    version = record.get("idea", {}).get("version", "")
    comparable = bool(IDEA_COMPARABLE_VERSION.match(version))

    both_side: list[str] = []
    different: list[str] = []
    not_compared: list[str] = []
    taomni_only: list[str] = []
    unverified_reasons: list[str] = []
    side_not_run: set[str] = set()
    for side_name in ("idea", "taomni"):
        for obs in record.get(side_name, {}).get("observations", []):
            if obs.get("status") == "not-run":
                side_not_run.add(obs.get("stepId", ""))
    for step_id in step_ids:
        top = obs_by_step.get(step_id, [{}])[0]
        status = top.get("status")
        if step_id in side_not_run:
            not_compared.append(step_id)
            unverified_reasons.append(f"step not run on a side: {step_id}")
        elif status == "not-compared":
            not_compared.append(step_id)
        elif status == "taomni-only":
            taomni_only.append(step_id)
        elif status == "different":
            different.append(step_id)
            both_side.append(step_id)
        elif status == "matched":
            both_side.append(step_id)
        else:
            not_compared.append(step_id)

    side_gap = not idea_side or not taomni_side
    if side_gap:
        unverified_reasons.append("one side has no observations")
    if not_compared:
        unverified_reasons.append(f"steps not compared: {', '.join(not_compared)}")

    if not comparable:
        computed = "incomparable"
    elif unverified_reasons:
        computed = "unverified"
    elif different:
        computed = "different"
    elif both_side:
        computed = "matched"
    else:
        # All steps are taomni-only: no IDEA denominator, so no matched claim.
        computed = "unverified"
        unverified_reasons.append("all steps are taomni-only; no IDEA-side denominator")

    recorded = record.get("verdict", {}).get("state")
    if recorded != computed:
        fail(f"verdict mismatch: recorded {recorded!r} but computed {computed!r}"
             + (f" ({'; '.join(unverified_reasons)})" if unverified_reasons else ""))

    return {
        "computed": computed,
        "bothSideSteps": both_side,
        "differentSteps": different,
        "notComparedSteps": not_compared,
        "taomniOnlySteps": taomni_only,
        "unverifiedReasons": unverified_reasons,
        "ideaComparableVersion": comparable,
    }


def verify_artifacts(
    record: dict[str, Any],
    artifacts_dir: Path,
    fixture_root: Path | None,
    computed_verdict: str,
    errors: list[str],
    warnings: list[str],
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for artifact in record.get("artifacts", []):
        rel = normalize_declared_path(artifact.get("path", ""))
        expected = artifact.get("sha256", "")
        target = artifacts_dir / PurePosixPath(rel)
        entry: dict[str, Any] = {"path": rel, "expectedSha256": expected}
        if not target.is_file():
            entry["result"] = "missing"
            if computed_verdict == "matched":
                errors.append(f"artifact {rel!r} is missing; a missing original cannot prove a matched run")
            else:
                warnings.append(f"artifact {rel!r} is missing (verdict {computed_verdict}; recorded for traceability)")
        else:
            actual = sha256_of_file(target)
            entry["actualSha256"] = actual
            if actual != expected:
                entry["result"] = "tampered"
                errors.append(f"artifact {rel!r} sha256 mismatch: expected {expected}, actual {actual}")
            else:
                entry["result"] = "verified"
        results.append(entry)

    if fixture_root is not None:
        for fixture_file in record.get("fixture", {}).get("files", []):
            rel = normalize_declared_path(fixture_file.get("path", ""))
            target = fixture_root / PurePosixPath(rel)
            if not target.is_file():
                errors.append(f"fixture file {rel!r} is missing under fixture root")
                continue
            actual = sha256_of_file(target)
            if actual != fixture_file.get("sha256", ""):
                errors.append(f"fixture file {rel!r} sha256 mismatch (fixture/build mismatch)")
    return results


# ---------------------------------------------------------------------------
# Report and CLI
# ---------------------------------------------------------------------------

def build_report(
    record: dict[str, Any],
    verdict_info: dict[str, Any],
    artifact_results: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, Any]:
    return {
        "taskId": record.get("taskId"),
        "scenarioId": record.get("scenarioId"),
        "recordedVerdict": record.get("verdict", {}).get("state"),
        "computedVerdict": verdict_info["computed"],
        "bothSideSteps": verdict_info["bothSideSteps"],
        "differentSteps": verdict_info["differentSteps"],
        "notComparedSteps": verdict_info["notComparedSteps"],
        "taomniOnlySteps": verdict_info["taomniOnlySteps"],
        "taomniOnlyCount": len(verdict_info["taomniOnlySteps"]),
        "ideaComparableVersion": verdict_info["ideaComparableVersion"],
        "unverifiedReasons": verdict_info["unverifiedReasons"],
        "artifactChecks": artifact_results,
        "warnings": warnings,
        "notes": [
            "Path fields are normalized only for OS separators; text, EOL, byte hashes, order, and timing are never normalized.",
            "taomni-only steps are reported but excluded from the IDEA matched denominator.",
            "The validator issues no run proof; it only checks record consistency.",
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", type=Path, required=True, help="Comparison record JSON to validate")
    default_schema = Path(__file__).resolve().parents[4] / "claudedocs" / "code-workspace-idea-specs" / "idea-comparison.schema.json"
    parser.add_argument("--schema", type=Path, default=default_schema, help="JSON Schema for the record")
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        default=None,
        help="Directory artifact paths resolve against (default: the record's directory)",
    )
    parser.add_argument(
        "--fixture-root",
        type=Path,
        default=None,
        help="When given, fixture file hashes are verified against this root",
    )
    parser.add_argument(
        "--require-match",
        action="store_true",
        help="Exit 1 unless the verdict is matched; matched still requires all fail-closed checks",
    )
    return parser


def run(args: argparse.Namespace) -> int:
    errors: list[str] = []
    warnings: list[str] = []

    record = load_record(args.record)

    try:
        schema_text = args.schema.read_text(encoding="utf-8")
        schema = json.loads(schema_text)
    except OSError as error:
        raise RecordError(f"cannot read schema {args.schema}: {error}") from error
    except json.JSONDecodeError as error:
        raise RecordError(f"schema is not valid JSON: {error}") from error

    validate_schema(record, schema, schema, "record", errors)

    verdict_info: dict[str, Any] = {
        "computed": "unverified",
        "bothSideSteps": [],
        "differentSteps": [],
        "notComparedSteps": [],
        "taomniOnlySteps": [],
        "unverifiedReasons": [],
        "ideaComparableVersion": False,
    }
    artifact_results: list[dict[str, Any]] = []
    if not errors:
        verdict_info = semantic_checks(record, errors, warnings)
        if not errors:
            artifacts_dir = args.artifacts_dir or args.record.resolve().parent
            artifact_results = verify_artifacts(
                record, artifacts_dir, args.fixture_root, verdict_info["computed"], errors, warnings
            )

    if errors:
        for message in errors:
            print(f"error: {message}", file=sys.stderr)
        return 2

    report = build_report(record, verdict_info, artifact_results, warnings)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False))
    if args.require_match and verdict_info["computed"] != "matched":
        print(
            f"require-match: verdict is {verdict_info['computed']!r}, not matched",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except RecordError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
