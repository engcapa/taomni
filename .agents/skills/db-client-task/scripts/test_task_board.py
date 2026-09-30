"""Lifecycle tests for task_board.py: python -m unittest discover -s <scripts dir>."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import task_board

SPEC_PLANNING = '<a id="db-sql-001"></a>\n## DB-SQL-001 target\n\nP0 goal only.\n'
SPEC_READY = (
    '<a id="db-sql-001"></a>\n## DB-SQL-001\n\n- `A1` run current statement\n- `A2` cancel\n'
    '<a id="db-sql-001-test-cases"></a>\n### test cases\n\nV1 -> A1, V2 -> A2\n'
    '<a id="db-grid-001"></a>\n## DB-GRID-001\n\n- `A1` grid\n'
)


class BoardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "AGENTS.md").write_text("test\n", encoding="utf-8")
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "init"], cwd=self.root, check=True)
        self.docs = self.root / "docs"
        self.docs.mkdir()
        self.board = self.docs / "backlog.md"
        self.board.write_text("# Board\n\n## 4. Cards\n", encoding="utf-8")
        self.spec = self.docs / "plan.md"
        self.spec.write_text(SPEC_PLANNING, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_board(self, *argv: str) -> tuple[int, str]:
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = task_board.main(["--doc", str(self.board), *argv])
        return code, out.getvalue() + err.getvalue()

    def ok(self, *argv: str) -> str:
        code, output = self.run_board(*argv)
        self.assertEqual(code, 0, output)
        return output

    def fails(self, *argv: str) -> str:
        code, output = self.run_board(*argv)
        self.assertNotEqual(code, 0, output)
        return output

    def metadata(self, task_id: str = "DB-SQL-001") -> dict:
        return json.loads(self.ok("show", task_id))

    def add_card(self) -> None:
        self.ok(
            "add", "DB-SQL-001", "--title", "Execute current statement", "--priority", "high", "--size", "M",
            "--spec", "docs/plan.md#db-sql-001", "--source", "REQ-01,DBV-SQL-02", "--finding", "no statement run",
        )

    def make_ready(self) -> None:
        self.add_card()
        self.spec.write_text(SPEC_READY, encoding="utf-8")
        self.ok("ready", "DB-SQL-001", "--acceptance", "A1,A2", "--evidence", "unit,browser")

    def write_evidence(self, checks: list[dict]) -> str:
        path = self.root / "evidence.json"
        payload = {"verified_at": "2026-10-01T00:00:00Z", "head": "abc", "checks": checks, "unrun": [], "notes": []}
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def test_add_creates_planning_card(self) -> None:
        self.add_card()
        meta = self.metadata()
        self.assertEqual(meta["status"], "planning")
        self.assertEqual(meta["source"], ["REQ-01", "DBV-SQL-02"])
        self.assertIn("1 tasks", self.ok("validate"))
        self.assertIn("DB-SQL-001", self.ok("list", "--plannable"))
        self.fails("claim", "DB-SQL-001", "--owner", "a")

    def test_ready_requires_test_cases_and_spec_acceptance(self) -> None:
        self.add_card()
        self.assertIn("test-cases", self.fails("ready", "DB-SQL-001", "--acceptance", "A1", "--evidence", "unit"))
        self.spec.write_text(SPEC_READY, encoding="utf-8")
        self.assertIn("not found in spec", self.fails("ready", "DB-SQL-001", "--acceptance", "A1,A9", "--evidence", "unit"))
        self.assertIn("invalid evidence", self.fails("ready", "DB-SQL-001", "--acceptance", "A1", "--evidence", "idea"))
        self.ok("ready", "DB-SQL-001", "--acceptance", "A1,A2", "--evidence", "unit,browser")
        self.assertEqual(self.metadata()["acceptance"], ["DB-SQL-001-A1", "DB-SQL-001-A2"])

    def test_done_requires_complete_final_evidence(self) -> None:
        self.make_ready()
        self.ok("claim", "DB-SQL-001", "--owner", "a", "--baseline", "abc")
        self.fails("claim", "DB-SQL-001", "--owner", "b")
        partial = self.write_evidence([
            {"kind": "unit", "command": "pnpm test x", "result": "passed", "summary": "3/3", "acceptance": ["DB-SQL-001-A1"]},
        ])
        self.assertIn("browser", self.fails("update", "DB-SQL-001", "--owner", "a", "--status", "done", "--evidence-file", partial))
        complete = self.write_evidence([
            {"kind": "browser", "command": "qa run", "result": "failed", "summary": "cancel stuck", "acceptance": []},
            {"kind": "unit", "command": "pnpm test x", "result": "passed", "summary": "3/3", "acceptance": ["DB-SQL-001-A1"]},
            {"kind": "browser", "command": "qa run", "result": "passed", "summary": "2/2", "acceptance": ["DB-SQL-001-A2"]},
        ])
        self.ok("update", "DB-SQL-001", "--owner", "a", "--status", "done", "--evidence-file", complete)
        meta = self.metadata()
        self.assertEqual(meta["status"], "done")
        self.assertNotIn("owner", meta)
        self.assertEqual(meta["last_attempt"]["result"], "done")

    def test_review_reopens_with_history(self) -> None:
        self.make_ready()
        self.ok("claim", "DB-SQL-001", "--owner", "a", "--baseline", "abc")
        self.fails("review", "DB-SQL-001", "--reviewer", "r", "--result", "accepted", "--note", "x")
        self.fails("update", "DB-SQL-001", "--owner", "a", "--status", "implemented")
        self.ok("update", "DB-SQL-001", "--owner", "a", "--status", "implemented", "--note", "live-db unrun")
        self.fails("review", "DB-SQL-001", "--reviewer", "r", "--result", "accepted", "--note", "x")
        self.ok("review", "DB-SQL-001", "--reviewer", "r", "--result", "changes_requested", "--note", "cancel leaks")
        meta = self.metadata()
        self.assertEqual(meta["status"], "ready")
        self.assertEqual(meta["history"][0]["last_attempt"]["result"], "implemented")
        self.ok("claim", "DB-SQL-001", "--owner", "b", "--baseline", "def")

    def test_blocked_needs_note_and_dependencies_gate_claim(self) -> None:
        self.make_ready()
        self.ok(
            "add", "DB-GRID-001", "--title", "Grid", "--priority", "medium", "--size", "S",
            "--spec", "docs/plan.md#db-grid-001", "--source", "REQ-02", "--finding", "grid", "--depends-on", "DB-SQL-001",
        )
        self.assertIn("planning", self.fails("claim", "DB-GRID-001", "--owner", "a"))
        self.ok("claim", "DB-SQL-001", "--owner", "a", "--baseline", "abc")
        self.fails("update", "DB-SQL-001", "--owner", "a", "--status", "blocked")
        self.ok("update", "DB-SQL-001", "--owner", "a", "--status", "blocked", "--note", "needs mysql fixture")
        self.fails("triage", "DB-SQL-001", "--status", "deferred", "--note", "x")
        self.ok("triage", "DB-GRID-001", "--status", "deferred", "--note", "after SQL")
        self.assertIn("deferred", self.ok("list", "--status", "deferred"))


if __name__ == "__main__":
    unittest.main()
