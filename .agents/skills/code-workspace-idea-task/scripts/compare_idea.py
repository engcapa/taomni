#!/usr/bin/env python3
"""Validate a factual IntelliJ IDEA comparison record.

The command validates record structure with the repository schema, then checks
the invariants that JSON Schema cannot express: unique step identities,
artifact bytes, runner links, complete observations, and the four-state
comparison verdict. It only reads JSON and artifact bytes; it never executes a
recorded action or code.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import posixpath
from pathlib import Path
import re
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = (SCRIPT_DIR.parents[2] / ".." / "claudedocs" / "code-workspace-idea-specs" / "idea-comparison.schema.json").resolve()

OBSERVATION_FIELDS = (
    "status",
    "documents",
    "caret",
    "selection",
    "focusTarget",
    "results",
    "history",
    "errors",
    "recovery",
)
IDENTITY_DIGEST_RE = re.compile(r"^(?:sha256:)?([0-9a-fA-F]{64})$")
IDEA_VERSION_RE = re.compile(r"^2026\.2\.\d+$")


@dataclass(frozen=True)
class SchemaIssue:
    path: str
    message: str

    def render(self) -> str:
        return f"{self.path}: {self.message}"


def _type_matches(value: Any, type_name: str) -> bool:
    if type_name == "null":
        return value is None
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name == "string":
        return isinstance(value, str)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "object":
        return isinstance(value, dict)
    return True


def _json_equal(left: Any, right: Any) -> bool:
    return json.dumps(left, ensure_ascii=False, sort_keys=True, separators=(",", ":")) == json.dumps(
        right,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


class SchemaValidator:
    """Small dependency-free validator for the schema keywords used here."""

    def __init__(self, schema: dict[str, Any]) -> None:
        self.schema = schema
        self.errors: list[SchemaIssue] = []

    def validate(self, value: Any) -> list[SchemaIssue]:
        self.errors = []
        self._validate(value, self.schema, "$", self.schema)
        return self.errors

    def _resolve(self, ref: str, root: dict[str, Any]) -> dict[str, Any]:
        if not ref.startswith("#/"):
            raise ValueError(f"unsupported schema reference: {ref}")
        current: Any = root
        for token in ref[2:].split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            current = current[token]
        if not isinstance(current, dict):
            raise ValueError(f"schema reference is not an object: {ref}")
        return current

    def _branch_errors(self, value: Any, schema: dict[str, Any], path: str, root: dict[str, Any]) -> list[SchemaIssue]:
        previous = self.errors
        self.errors = []
        self._validate(value, schema, path, root)
        branch_errors = self.errors
        self.errors = previous
        return branch_errors

    def _validate(self, value: Any, schema: dict[str, Any], path: str, root: dict[str, Any]) -> None:
        if "$ref" in schema:
            self._validate(value, self._resolve(schema["$ref"], root), path, root)
            return

        if "allOf" in schema:
            for child in schema["allOf"]:
                self._validate(value, child, path, root)

        if "anyOf" in schema:
            branches = [self._branch_errors(value, child, path, root) for child in schema["anyOf"]]
            if all(branches):
                self.errors.append(SchemaIssue(path, "must satisfy at least one schema alternative"))

        if "oneOf" in schema:
            branches = [self._branch_errors(value, child, path, root) for child in schema["oneOf"]]
            if sum(not branch for branch in branches) != 1:
                self.errors.append(SchemaIssue(path, "must satisfy exactly one schema alternative"))

        expected_type = schema.get("type")
        if expected_type is not None:
            expected_types = expected_type if isinstance(expected_type, list) else [expected_type]
            if not any(_type_matches(value, name) for name in expected_types):
                self.errors.append(SchemaIssue(path, f"expected type {expected_types}, got {type(value).__name__}"))
                return

        if "const" in schema and not _json_equal(value, schema["const"]):
            self.errors.append(SchemaIssue(path, f"must equal {schema['const']!r}"))
        if "enum" in schema and not any(_json_equal(value, item) for item in schema["enum"]):
            self.errors.append(SchemaIssue(path, f"must be one of {schema['enum']!r}"))

        if isinstance(value, str):
            if len(value) < schema.get("minLength", 0):
                self.errors.append(SchemaIssue(path, "is shorter than minLength"))
            if len(value) > schema.get("maxLength", len(value)):
                self.errors.append(SchemaIssue(path, "is longer than maxLength"))
            pattern = schema.get("pattern")
            if pattern and re.search(pattern, value) is None:
                self.errors.append(SchemaIssue(path, f"does not match pattern {pattern!r}"))
            if schema.get("format") == "date-time":
                try:
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        raise ValueError("timezone required")
                except ValueError:
                    self.errors.append(SchemaIssue(path, "must be an ISO-8601 date-time with a timezone"))

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                self.errors.append(SchemaIssue(path, f"must be >= {schema['minimum']}"))
            if "maximum" in schema and value > schema["maximum"]:
                self.errors.append(SchemaIssue(path, f"must be <= {schema['maximum']}"))

        if isinstance(value, list):
            if len(value) < schema.get("minItems", 0):
                self.errors.append(SchemaIssue(path, "has fewer items than minItems"))
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                self.errors.append(SchemaIssue(path, "has more items than maxItems"))
            if schema.get("uniqueItems"):
                encoded = [json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for item in value]
                if len(set(encoded)) != len(encoded):
                    self.errors.append(SchemaIssue(path, "items must be unique"))
            item_schema = schema.get("items")
            if item_schema:
                for index, item in enumerate(value):
                    self._validate(item, item_schema, f"{path}[{index}]", root)

        if isinstance(value, dict):
            if len(value) < schema.get("minProperties", 0):
                self.errors.append(SchemaIssue(path, "has fewer properties than minProperties"))
            if "maxProperties" in schema and len(value) > schema["maxProperties"]:
                self.errors.append(SchemaIssue(path, "has more properties than maxProperties"))
            required = schema.get("required", [])
            for key in required:
                if key not in value:
                    self.errors.append(SchemaIssue(path, f"missing required property {key!r}"))

            properties = schema.get("properties", {})
            for key, child in properties.items():
                if key in value:
                    self._validate(value[key], child, f"{path}.{key}", root)

            property_names = schema.get("propertyNames")
            if property_names:
                for key in value:
                    self._validate(key, property_names, f"{path}.<property-name>", root)

            additional = schema.get("additionalProperties")
            for key, child_value in value.items():
                if key in properties:
                    continue
                if additional is False:
                    self.errors.append(SchemaIssue(path, f"unknown property {key!r}"))
                elif isinstance(additional, dict):
                    self._validate(child_value, additional, f"{path}.{key}", root)


def load_schema(path: Path = SCHEMA_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("comparison schema must be a JSON object")
    return data


def _normalise_relative_path(value: str, label: str) -> str:
    """Normalize only OS separators; reject traversal and absolute paths."""
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label}: path must be a non-empty string")
    normalized = value.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise ValueError(f"{label}: path must be relative")
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError(f"{label}: path contains an empty, '.' or '..' segment")
    return "/".join(parts)


def _normalise_alias_root(value: str, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label}: alias root must be a non-empty string")
    if value in {".", "./"}:
        return ""
    return _normalise_relative_path(value, label)


def _path_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _identity_digest(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    match = IDENTITY_DIGEST_RE.fullmatch(value)
    return match.group(1).lower() if match else None


def _platform_equal(left: str, right: str) -> bool:
    return left.casefold() == right.casefold()


def _trivial_explanation(value: str) -> bool:
    return value.strip().casefold() in {"same", "identical", "equal", "相同", "一致"}


def _record_format_errors(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    task_id = record.get("taskId")
    acceptance = record.get("acceptance", [])
    if isinstance(task_id, str) and isinstance(acceptance, list):
        for acceptance_id in acceptance:
            if isinstance(acceptance_id, str) and not acceptance_id.startswith(f"{task_id}-A"):
                errors.append(f"acceptance contains an id outside task {task_id}: {acceptance_id}")

    step_ids = [step.get("stepId") for step in record.get("steps", []) if isinstance(step, dict)]
    duplicates = sorted({step_id for step_id in step_ids if step_ids.count(step_id) > 1})
    if duplicates:
        errors.append("duplicate stepId: " + ", ".join(str(item) for item in duplicates))

    observation_ids = [item.get("stepId") for item in record.get("observations", []) if isinstance(item, dict)]
    duplicate_observations = sorted({step_id for step_id in observation_ids if observation_ids.count(step_id) > 1})
    if duplicate_observations:
        errors.append("duplicate observation stepId: " + ", ".join(str(item) for item in duplicate_observations))

    delta_fields = [item.get("field") for item in record.get("deltas", []) if isinstance(item, dict)]
    duplicate_deltas = sorted({field for field in delta_fields if delta_fields.count(field) > 1})
    if duplicate_deltas:
        errors.append("duplicate delta field: " + ", ".join(str(item) for item in duplicate_deltas))

    known_acceptance = set(acceptance) if isinstance(acceptance, list) else set()
    for index, delta in enumerate(record.get("deltas", [])):
        if not isinstance(delta, dict):
            continue
        linked = delta.get("linkedAcceptance", [])
        if isinstance(linked, list):
            unknown = sorted(set(linked) - known_acceptance)
            if unknown:
                errors.append(f"deltas[{index}].linkedAcceptance contains unknown ids: {', '.join(unknown)}")
        explanation = delta.get("explanation")
        if isinstance(explanation, str) and _trivial_explanation(explanation):
            errors.append(f"deltas[{index}].explanation must explain the comparison, not only say 'same'")
    return errors


class ArtifactChecker:
    def __init__(self, record: dict[str, Any], base_dir: Path) -> None:
        self.record = record
        self.base_dir = base_dir.resolve()
        self.format_errors: list[str] = []
        self.integrity_errors: list[str] = []
        self.checked: dict[tuple[str, str], bool] = {}
        self.paths: dict[tuple[str, str], Path] = {}
        self.root_refs: dict[tuple[str, str], str] = {}
        self.alias_roots: dict[str, Path] = {}
        self._load_aliases()

    def _load_aliases(self) -> None:
        aliases = self.record.get("pathAliases", {})
        if not isinstance(aliases, dict):
            return
        for alias, root in aliases.items():
            try:
                normalized_root = _normalise_alias_root(root, f"pathAliases.{alias}")
            except ValueError as error:
                self.format_errors.append(str(error))
                continue
            alias_root = (self.base_dir / normalized_root).resolve()
            if not _path_within(alias_root, self.base_dir):
                self.format_errors.append(f"pathAliases.{alias}: alias root escapes --base-dir")
                continue
            self.alias_roots[alias] = alias_root

    def _resolve(self, ref: dict[str, Any], label: str) -> tuple[tuple[str, str], Path] | None:
        alias = ref.get("rootAlias")
        if not isinstance(alias, str) or alias not in self.alias_roots:
            self.format_errors.append(f"{label}: rootAlias is not declared in pathAliases: {alias!r}")
            return None
        try:
            relative = _normalise_relative_path(ref.get("path"), f"{label}.path")
        except ValueError as error:
            self.format_errors.append(str(error))
            return None
        alias_root = self.alias_roots[alias]
        candidate = (alias_root / relative).resolve()
        if not _path_within(candidate, alias_root):
            self.format_errors.append(f"{label}: resolved path escapes alias root")
            return None
        key = (alias, relative)
        self.paths[key] = candidate
        return key, candidate

    def check_ref(self, ref: Any, label: str, require_inventory: bool = False) -> tuple[str, str] | None:
        if not isinstance(ref, dict):
            self.format_errors.append(f"{label}: artifact reference must be an object")
            return None
        resolved = self._resolve(ref, label)
        if resolved is None:
            return None
        key, path = resolved
        expected = ref.get("sha256")
        if require_inventory and key not in self.root_refs:
            self.integrity_errors.append(f"{label}: artifact is not present in top-level artifacts inventory")
        elif key in self.root_refs and self.root_refs[key] != expected:
            self.integrity_errors.append(f"{label}: artifact hash differs from top-level inventory")

        if key in self.checked:
            return key
        if not path.is_file():
            self.checked[key] = False
            self.integrity_errors.append(f"{label}: artifact file does not exist: {key[0]}:{key[1]}")
            return key
        actual = _file_sha256(path)
        ok = actual == expected
        self.checked[key] = ok
        if not ok:
            self.integrity_errors.append(f"{label}: artifact hash mismatch (expected {expected}, got {actual})")
        return key

    def build_inventory(self) -> None:
        artifacts = self.record.get("artifacts", [])
        if not isinstance(artifacts, list):
            return
        for index, artifact in enumerate(artifacts):
            resolved = self._resolve(artifact, f"artifacts[{index}]") if isinstance(artifact, dict) else None
            if resolved is None:
                continue
            key, _ = resolved
            expected = artifact.get("sha256")
            if key in self.root_refs:
                self.format_errors.append(f"artifacts[{index}]: duplicate artifact path {key[0]}:{key[1]}")
            else:
                self.root_refs[key] = expected
            self.check_ref(artifact, f"artifacts[{index}]")

    def require_ref(self, ref: Any, label: str) -> None:
        self.check_ref(ref, label, require_inventory=True)

    def check_fixture(self) -> None:
        fixture = self.record.get("fixture")
        if not isinstance(fixture, dict):
            return
        ref = {
            "rootAlias": fixture.get("rootAlias"),
            "path": fixture.get("relativePath"),
            "sha256": fixture.get("sha256"),
        }
        self.require_ref(ref, "fixture")

        source = fixture.get("initialContentSource")
        if isinstance(source, dict) and source.get("sourceArtifact") is not None:
            self.require_ref(source.get("sourceArtifact"), "fixture.initialContentSource.sourceArtifact")

    def _read_json(self, ref: dict[str, Any], label: str) -> dict[str, Any] | None:
        resolved = self._resolve(ref, label)
        if resolved is None:
            return None
        key, path = resolved
        if not self.checked.get(key, False):
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            self.integrity_errors.append(f"{label}: artifact is not readable JSON: {error}")
            return None
        if not isinstance(value, dict):
            self.integrity_errors.append(f"{label}: artifact JSON must be an object")
            return None
        return value

    def check_side_artifacts(self) -> None:
        idea = self.record.get("idea")
        if isinstance(idea, dict):
            self.require_ref(idea.get("settingsSnapshot"), "idea.settingsSnapshot")
            for index, artifact in enumerate(idea.get("rawArtifacts", [])):
                self.require_ref(artifact, f"idea.rawArtifacts[{index}]")

        taomni = self.record.get("taomni")
        if not isinstance(taomni, dict):
            return
        self.require_ref(taomni.get("summary"), "taomni.summary")
        self.require_ref(taomni.get("receipt"), "taomni.receipt")
        for index, artifact in enumerate(taomni.get("rawArtifacts", [])):
            self.require_ref(artifact, f"taomni.rawArtifacts[{index}]")

        summary_ref = taomni.get("summary")
        receipt_ref = taomni.get("receipt")
        if not isinstance(summary_ref, dict) or not isinstance(receipt_ref, dict):
            return
        summary = self._read_json(summary_ref, "taomni.summary")
        receipt = self._read_json(receipt_ref, "taomni.receipt")
        if summary is None or receipt is None:
            return
        if not isinstance(summary.get("totals"), dict) or not isinstance(summary.get("cases"), list):
            self.integrity_errors.append("taomni.summary: missing qa-ui-auto totals/cases contract")
        required_receipt = {"receiptId", "runnerId", "exitCode", "artifacts"}
        missing_receipt = sorted(required_receipt - receipt.keys())
        if missing_receipt:
            self.integrity_errors.append("taomni.receipt: missing runner fields: " + ", ".join(missing_receipt))
            return
        if not isinstance(receipt.get("artifacts"), list):
            self.integrity_errors.append("taomni.receipt: artifacts must be a list")
            return

        summary_alias = summary_ref.get("rootAlias")
        receipt_alias = receipt_ref.get("rootAlias")
        if summary_alias != receipt_alias:
            self.integrity_errors.append("taomni summary and receipt must use the same declared root alias")
        else:
            try:
                summary_path = _normalise_relative_path(summary_ref.get("path"), "taomni.summary.path")
                receipt_path = _normalise_relative_path(receipt_ref.get("path"), "taomni.receipt.path")
                expected_receipt_path = posixpath.relpath(summary_path, posixpath.dirname(receipt_path) or ".")
            except ValueError as error:
                self.format_errors.append(str(error))
                expected_receipt_path = ""
            linked = False
            for item in receipt.get("artifacts", []):
                if not isinstance(item, dict):
                    continue
                try:
                    item_path = _normalise_relative_path(item.get("path"), "taomni.receipt.artifacts.path")
                except ValueError:
                    continue
                if item_path == expected_receipt_path and item.get("sha256") == summary_ref.get("sha256"):
                    linked = True
                    break
            if not linked:
                self.integrity_errors.append("taomni.receipt: does not link summary.json with its recorded SHA-256")

        source_digest = _identity_digest(taomni.get("sourceIdentityDigest"))
        receipt_source = _identity_digest(receipt.get("sourceIdentityDigest"))
        if receipt.get("sourceIdentityDigest") is not None and source_digest != receipt_source:
            self.integrity_errors.append("taomni.receipt: sourceIdentityDigest differs from taomni source identity")


def _normalised_observation(observation: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(observation)
    documents = result.get("documents", [])
    if isinstance(documents, list):
        for document in documents:
            if isinstance(document, dict) and isinstance(document.get("relativePath"), str):
                document["relativePath"] = document["relativePath"].replace("\\", "/")
    return result


def _observation_differences(record: dict[str, Any]) -> tuple[list[str], list[str]]:
    differences: list[str] = []
    format_errors: list[str] = []
    delta_map = {
        delta.get("field"): delta
        for delta in record.get("deltas", [])
        if isinstance(delta, dict) and isinstance(delta.get("field"), str)
    }
    for pair in record.get("observations", []):
        if not isinstance(pair, dict):
            continue
        step_id = pair.get("stepId")
        idea = pair.get("idea")
        taomni = pair.get("taomni")
        if not isinstance(idea, dict) or not isinstance(taomni, dict):
            continue
        idea_normalized = _normalised_observation(idea)
        taomni_normalized = _normalised_observation(taomni)
        for field in OBSERVATION_FIELDS:
            left = idea_normalized.get(field)
            right = taomni_normalized.get(field)
            if _json_equal(left, right):
                continue
            delta_field = f"observation.{step_id}.{field}"
            differences.append(delta_field)
            delta = delta_map.get(delta_field)
            if delta is None:
                format_errors.append(f"unexplained observation difference: {delta_field}")
            elif delta.get("classification") == "same":
                format_errors.append(f"observation difference is incorrectly classified same: {delta_field}")
    return differences, format_errors


def _observation_completeness(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    step_ids = [step.get("stepId") for step in record.get("steps", []) if isinstance(step, dict)]
    observed = {
        item.get("stepId"): item
        for item in record.get("observations", [])
        if isinstance(item, dict) and isinstance(item.get("stepId"), str)
    }
    missing = [step_id for step_id in step_ids if step_id not in observed]
    extra = sorted(set(observed) - set(step_ids))
    if missing:
        errors.append("missing observations: " + ", ".join(missing))
    if extra:
        errors.append("observations contain unknown steps: " + ", ".join(extra))
    for step_id, pair in observed.items():
        if pair.get("idea") is None or pair.get("taomni") is None:
            errors.append(f"observation side missing for step: {step_id}")
        for side in ("idea", "taomni"):
            value = pair.get(side)
            if isinstance(value, dict) and value.get("stepId") != step_id:
                errors.append(f"{side} observation stepId does not match pair: {step_id}")
    if record.get("idea") is None or record.get("taomni") is None:
        errors.append("one comparison side is absent")
    return errors


def _compute_verdict(
    record: dict[str, Any],
    integrity_errors: list[str],
    completeness_errors: list[str],
    observation_format_errors: list[str],
) -> tuple[str, list[str], list[str]]:
    unverified_reasons = [*integrity_errors, *completeness_errors, *observation_format_errors]
    incomparable_reasons: list[str] = []
    if record.get("unrun"):
        unverified_reasons.append("record has unrun layers")

    idea = record.get("idea")
    if isinstance(idea, dict) and not IDEA_VERSION_RE.fullmatch(idea.get("version", "")):
        incomparable_reasons.append(f"IDEA version is outside 2026.2.x: {idea.get('version')}")
    elif idea is None:
        unverified_reasons.append("IDEA observation side is absent")

    taomni = record.get("taomni")
    if isinstance(taomni, dict):
        build = taomni.get("qaBuildIdentity")
        source_digest = _identity_digest(taomni.get("sourceIdentityDigest"))
        build_digest = _identity_digest(build.get("sourceIdentityDigest")) if isinstance(build, dict) else None
        if source_digest is None or build_digest is None or source_digest != build_digest:
            unverified_reasons.append("Taomni source identity does not match QA build identity")
        if isinstance(build, dict) and not _platform_equal(build.get("platform", ""), taomni.get("os", "")):
            unverified_reasons.append("Taomni OS does not match QA build platform")
    else:
        unverified_reasons.append("Taomni observation side is absent")

    classes = {
        delta.get("classification")
        for delta in record.get("deltas", [])
        if isinstance(delta, dict)
    }
    if "unverified" in classes:
        unverified_reasons.append("a delta is explicitly unverified")
    if "incomparable" in classes:
        incomparable_reasons.append("a delta is explicitly incomparable")
    if unverified_reasons:
        preliminary = "unverified"
    elif incomparable_reasons:
        preliminary = "incomparable"
    elif "different" in classes:
        preliminary = "different"
    else:
        preliminary = "matched"

    declared = record.get("verdict")
    if declared != preliminary:
        unverified_reasons.append(f"declared verdict {declared!r} does not match computed verdict {preliminary!r}")
        return "unverified", unverified_reasons, incomparable_reasons
    return preliminary, unverified_reasons, incomparable_reasons


def validate_record(record: Any, record_path: Path, base_dir: Path, schema: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(record, dict):
        return {
            "schema": "taomni.idea-comparison.validation.v1",
            "verdict": "unverified",
            "valid": False,
            "complete": False,
            "formatErrors": ["$: comparison record must be a JSON object"],
            "errors": ["$: comparison record must be a JSON object"],
            "unrun": [],
            "runtimeEvidence": "not-generated",
        }

    schema_errors = [issue.render() for issue in SchemaValidator(schema).validate(record)]
    format_errors = [*schema_errors, *_record_format_errors(record)]
    if format_errors:
        return {
            "schema": "taomni.idea-comparison.validation.v1",
            "taskId": record.get("taskId"),
            "scenarioId": record.get("scenarioId"),
            "declaredVerdict": record.get("verdict"),
            "verdict": "unverified",
            "valid": False,
            "complete": False,
            "formatErrors": format_errors,
            "errors": format_errors,
            "unrun": record.get("unrun", []),
            "runtimeEvidence": "not-generated",
        }

    checker = ArtifactChecker(record, base_dir)
    checker.build_inventory()
    checker.check_fixture()
    checker.check_side_artifacts()
    completeness_errors = _observation_completeness(record)
    observed_differences, observation_format_errors = _observation_differences(record)
    verdict, verdict_errors, incomparable_reasons = _compute_verdict(
        record,
        checker.integrity_errors,
        completeness_errors,
        observation_format_errors,
    )
    all_errors = [
        *checker.format_errors,
        *checker.integrity_errors,
        *completeness_errors,
        *observation_format_errors,
        *[reason for reason in verdict_errors if reason not in checker.integrity_errors and reason not in completeness_errors and reason not in observation_format_errors],
    ]
    valid = (
        not checker.format_errors
        and not checker.integrity_errors
        and not completeness_errors
        and not observation_format_errors
        and record.get("verdict") == verdict
    )
    return {
        "schema": "taomni.idea-comparison.validation.v1",
        "record": str(record_path),
        "taskId": record.get("taskId"),
        "scenarioId": record.get("scenarioId"),
        "declaredVerdict": record.get("verdict"),
        "verdict": verdict,
        "valid": valid,
        "complete": valid and verdict == "matched",
        "formatErrors": checker.format_errors,
        "errors": all_errors,
        "incomparableReasons": incomparable_reasons,
        "observedDifferences": observed_differences,
        "artifacts": {
            "declared": len(record.get("artifacts", [])),
            "checked": len(checker.checked),
            "passed": sum(1 for ok in checker.checked.values() if ok),
            "failed": sum(1 for ok in checker.checked.values() if not ok),
        },
        "normalization": {
            "allowed": ["OS path separators", "declared path aliases"],
            "textEolAndOrderPreserved": True,
        },
        "unrun": record.get("unrun", []),
        "runtimeEvidence": "not-generated",
    }


def _load_record(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True, type=Path, help="comparison record JSON")
    parser.add_argument("--base-dir", type=Path, help="base directory for declared path aliases; defaults to record directory")
    parser.add_argument("--schema", type=Path, default=SCHEMA_PATH, help="comparison JSON Schema")
    parser.add_argument("--require-match", action="store_true", help="return 1 unless the computed verdict is matched")
    args = parser.parse_args(argv)

    record_path = args.record.resolve()
    try:
        record = _load_record(record_path)
        schema = load_schema(args.schema.resolve())
    except FileNotFoundError as error:
        print(f"compare_idea: input file not found: {error.filename}", file=sys.stderr)
        return 2
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        print(f"compare_idea: invalid input: {error}", file=sys.stderr)
        return 2

    base_dir = (args.base_dir or record_path.parent).resolve()
    report = validate_record(record, record_path, base_dir, schema)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report.get("formatErrors"):
        return 2
    if args.require_match and report.get("verdict") != "matched":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
