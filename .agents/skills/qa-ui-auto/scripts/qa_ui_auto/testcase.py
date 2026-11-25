"""Load and schema-validate testcase YAML files."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

try:
    import jsonschema  # type: ignore
except ImportError:  # pragma: no cover
    jsonschema = None  # type: ignore[assignment]

HERE = Path(__file__).resolve().parent
SCHEMA_DIR = HERE.parent.parent / "schema"
TESTCASE_SCHEMA_PATH = SCHEMA_DIR / "testcase.schema.json"


@dataclass
class TestCase:
    id: str
    title: str
    description: str = ""
    covers: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    modes: list[str] = field(default_factory=lambda: ["browser"])
    native_platforms: list[str] = field(default_factory=list)
    browser_platforms: list[str] = field(default_factory=list)
    fixtures: list[str] = field(default_factory=list)
    timeout_sec: int = 90
    skip: str | None = None
    steps: list[dict[str, Any]] = field(default_factory=list)
    source_path: Path | None = None
    verification: dict[str, Any] = field(default_factory=dict)

    def supports_mode(self, mode: str) -> bool:
        return mode in self.modes


# C-accelerated loader when libyaml is available; identical parse results.
YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

# path -> ((mtime_ns, size), Draft202012Validator): the schema is read and the
# validator built once per process and rebuilt only if the schema file changes.
_VALIDATORS: dict[Path, tuple[tuple[int, int], Any]] = {}
# path -> ((mtime_ns, size), validated raw doc): re-parsing/re-validating the
# same unchanged file within a process (audit, plan, tests) is pure repetition.
_VALIDATED_DOCS: dict[Path, tuple[tuple[int, int], dict]] = {}


def _stamp(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size


def _load_schema(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def cached_validator(schema_path: Path = TESTCASE_SCHEMA_PATH):
    if jsonschema is None:
        return None
    stamp = _stamp(schema_path)
    cached = _VALIDATORS.get(schema_path)
    if cached is None or cached[0] != stamp:
        cached = (stamp, jsonschema.Draft202012Validator(_load_schema(schema_path)))
        _VALIDATORS[schema_path] = cached
    return cached[1]


def _validator():
    return cached_validator()


def validate_doc(doc: dict, *, source: str) -> list[str]:
    """Return a list of human-readable validation errors (empty = ok)."""
    if jsonschema is None:
        return [f"{source}: jsonschema not installed; run `pip install jsonschema pyyaml`."]
    validator = cached_validator()
    errors: list[str] = []
    for err in validator.iter_errors(doc):
        path = "/".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"{source}: {path}: {err.message}")
    if not errors:
        from .behavior_contract import validate_contract
        errors.extend(f"{source}: {e}" for e in validate_contract(doc))
    return errors


def _validated_raw(path: Path) -> dict:
    """Parse and validate one case file, memoized on (mtime_ns, size)."""
    key = path.resolve()
    stamp = _stamp(key)
    cached = _VALIDATED_DOCS.get(key)
    if cached is not None and cached[0] == stamp:
        return copy.deepcopy(cached[1])
    raw = yaml.load(path.read_text(encoding="utf-8"), Loader=YAML_LOADER)
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: testcase must be a YAML mapping at the root")
    errors = validate_doc(raw, source=str(path))
    if errors:
        raise ValueError("\n".join(errors))
    _VALIDATED_DOCS[key] = (stamp, copy.deepcopy(raw))
    return raw


def cache_validated_doc(path: Path, raw: dict) -> None:
    """Memoize an already schema- and contract-validated raw YAML mapping."""
    key = path.resolve()
    _VALIDATED_DOCS[key] = (_stamp(key), copy.deepcopy(raw))


def load_case(path: Path) -> TestCase:
    raw = _validated_raw(path)
    raw.setdefault("modes", ["browser"])
    raw.setdefault("timeout_sec", 90)
    raw.setdefault("tags", [])
    raw.setdefault("covers", [])
    raw.setdefault("fixtures", [])
    return TestCase(
        id=raw["id"],
        title=raw["title"],
        description=raw.get("description", ""),
        covers=list(raw.get("covers", [])),
        tags=list(raw.get("tags", [])),
        modes=list(raw["modes"]),
        native_platforms=list(raw.get("native_platforms", [])),
        browser_platforms=list(raw.get("browser_platforms", [])),
        fixtures=list(raw.get("fixtures", [])),
        timeout_sec=int(raw["timeout_sec"]),
        skip=raw.get("skip"),
        steps=list(raw["steps"]),
        source_path=path,
        verification=raw.get("verification", {}),
    )


def discover(cases_dir: Path) -> list[TestCase]:
    """Return all *.testcase.yaml under cases_dir, sorted by id."""
    if not cases_dir.exists():
        return []
    cases: list[TestCase] = []
    for p in sorted(cases_dir.rglob("*.testcase.yaml")):
        cases.append(load_case(p))
    cases.sort(key=lambda c: c.id)
    return cases


def filter_cases(
    cases: list[TestCase],
    *,
    mode: str,
    tags: list[str] | None = None,
    ids: list[str] | None = None,
) -> list[TestCase]:
    out: list[TestCase] = []
    tag_set = set(tags or [])
    id_set = set(ids or [])
    for c in cases:
        if not c.supports_mode(mode):
            continue
        if id_set and c.id not in id_set:
            continue
        if tag_set and not (tag_set & set(c.tags)):
            continue
        out.append(c)
    return out


def step_verb_and_args(step: dict[str, Any]) -> tuple[str, Any]:
    """Each step is a single-key map; return (verb, args)."""
    if len(step) != 1:
        raise ValueError(
            f"step must be a single-key map; got keys: {sorted(step)}"
        )
    return next(iter(step.items()))
