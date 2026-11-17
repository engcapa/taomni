"""Reuse validated, unchanged repository inputs within planner unit tests only.

The selection tests exercise routing, dependencies and platform planning against
the real catalog. Parsing every YAML and hashing the same repository for every
plan are separate parser/provenance responsibilities. The snapshot is local to
one test module; returned cases are isolated, and per-case digests remain live.
Production discovery and execution identity computation are unchanged.
"""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from qa_ui_auto import ci


@contextmanager
def repository_plan_snapshot(root: Path):
    root = root.resolve()
    cases_path = Path("qa-ui-auto-tests/cases")
    discover = ci.discover
    identity = ci.execution_identity
    cases = discover(cases_path)
    source_identity = identity(root)

    def snapshot_cases(path):
        if Path.cwd().resolve() == root and path.resolve() == root / cases_path:
            return deepcopy(cases)
        return discover(path)

    def snapshot_identity(path):
        if path.resolve() == root:
            return dict(source_identity)
        return identity(path)

    with patch.object(ci, "discover", side_effect=snapshot_cases), \
            patch.object(ci, "execution_identity", side_effect=snapshot_identity):
        yield
