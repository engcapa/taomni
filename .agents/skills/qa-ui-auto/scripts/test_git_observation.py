"""Independent Git evidence: real blobs, Unicode paths, exact status and no index refresh."""
import hashlib
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase

from qa_ui_auto.git_observation import assert_state, parse_status
from qa_ui_auto.steps import StepError


class GitObservationTest(TestCase):
    def test_porcelain_preserves_status_columns_unicode_and_rename_destination(self):
        self.assertEqual(parse_status(" M edit 中文.txt\0R  renamed.txt\0old.txt\0?? new.txt\0"),
            {"edit 中文.txt": " M", "renamed.txt": "R ", "new.txt": "??"})

    def test_real_index_and_head_are_independent_and_observation_does_not_refresh_index(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            repo.mkdir()
            def git(*args):
                return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            git("init", "-b", "main")
            git("config", "user.name", "QA")
            git("config", "user.email", "qa@example.invalid")
            git("config", "core.autocrlf", "false")
            git("config", "commit.gpgsign", "false")
            target = repo / "edit 中文.txt"
            target.write_bytes(b"HEAD\n")
            git("add", ".")
            git("commit", "--no-gpg-sign", "-m", "baseline")
            target.write_bytes(b"INDEX\n")
            git("add", ".")
            target.write_bytes(b"WORKTREE\n")
            ctx = SimpleNamespace(case_dir=root / "case", step_index=1)
            args = {"repo": str(repo), "branch": "main", "head_subject": "baseline",
                "status": {"edit 中文.txt": "MM"}, "head_files": {"edit 中文.txt": "HEAD\n", "absent.txt": None},
                "index_files": {"edit 中文.txt": "INDEX\n"}}
            before = hashlib.sha256((repo / ".git/index").read_bytes()).hexdigest()
            assert_state(ctx, args)
            self.assertEqual(hashlib.sha256((repo / ".git/index").read_bytes()).hexdigest(), before)
            self.assertTrue(json.loads((ctx.case_dir / "git-state-1.json").read_text())['passed'])
            ctx.step_index = 2
            with self.assertRaisesRegex(StepError, "independent Git state differs"):
                assert_state(ctx, {**args, "branch": "wrong", "timeout_sec": 0})
            self.assertFalse(json.loads((ctx.case_dir / "git-state-2.json").read_text())['passed'])

    def test_rejects_other_repositories_mutations_and_traversal(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory) / "case", step_index=1)
            with self.assertRaisesRegex(StepError, "disposable repository"):
                assert_state(ctx, {"repo": str(Path.cwd()), "branch": "main"})
            with self.assertRaisesRegex(StepError, "explicit read-only"):
                assert_state(ctx, {"repo": directory, "command": "commit"})
            repo = Path(directory) / "repo"
            (repo / ".git").mkdir(parents=True)
            for name in ("../outside", "/outside", "HEAD:file", "..\\outside"):
                with self.subTest(name=name), self.assertRaisesRegex(StepError, "relative repository file"):
                    assert_state(ctx, {"repo": str(repo), "head_files": {name: "x"}})
