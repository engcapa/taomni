"""Contracts for refusing invalid comparisons and producing identical workloads."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import TestCase

from workspace_perf.common import stats
from workspace_perf.explorer import dataset
from workspace_perf.hosted import linux_release_entry, validate_gate
from qa_ui_auto.provenance import source_identity


class FunctionalGateTest(TestCase):
    def setUp(self):
        self.head = "a" * 40
        self.identity = {"source_sha256": "source", "runner_sha256": "runner"}
        self.run = {
            "id": 123,
            "head_sha": self.head,
            "conclusion": "success",
            "path": ".github/workflows/qa-ui-auto-platforms.yml",
        }
        self.selection = {
            "scope": "all",
            "head": self.head,
            "run_id": 123,
            "identity": self.identity,
            "gaps": [],
        }
        self.summary = {
            "head": self.head,
            "run_id": 123,
            "passed": True,
            "report_ok": True,
            "failures": [],
            "infrastructure_errors": [],
            "job_results": {"plan": "success", "execute": "success"},
            "groups": [
                {
                    "id": f"{platform}-{mode}",
                    "selected": 3,
                    "counts": {"passed": 3},
                    "errors": [],
                }
                for platform in ("linux", "windows", "macos")
                for mode in ("browser", "native")
            ],
        }

    def check(self):
        validate_gate(self.run, self.selection, self.summary, self.head, self.identity)

    def test_current_full_functional_matrix_is_accepted(self):
        self.check()

    def test_green_job_cannot_hide_a_failed_skipped_or_missing_case(self):
        for counts in (
            {"passed": 2, "failed": 1},
            {"passed": 2, "skipped": 1},
            {"passed": 2},
        ):
            with self.subTest(counts=counts), self.assertRaises(ValueError):
                self.summary["groups"][0]["counts"] = counts
                self.check()

    def test_current_source_is_required_even_if_the_workflow_succeeded(self):
        self.selection["identity"] = {**self.identity, "source_sha256": "old"}
        with self.assertRaises(ValueError):
            self.check()

    def test_related_selection_is_not_a_full_suite(self):
        self.selection["scope"] = "selected"
        with self.assertRaises(ValueError):
            self.check()

    def test_missing_native_platform_and_unknown_external_gaps_are_rejected(self):
        original = deepcopy(self.summary)
        self.summary["groups"].pop()
        with self.assertRaises(ValueError):
            self.check()
        self.summary = original
        self.selection["gaps"] = [
            {"case": "another-project", "mode": "native", "platform": "linux"}
        ]
        with self.assertRaises(ValueError):
            self.check()


class WorkloadTest(TestCase):
    def test_historical_builder_uses_probe_identity_without_changing_the_checkout(self):
        scripts = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            subprocess.run(["git", "init", "-q", str(checkout)], check=True)
            old_scripts = checkout / ".agents/skills/qa-ui-auto/scripts"
            old_package = old_scripts / "qa_ui_auto"
            old_package.mkdir(parents=True)
            (old_package / "__init__.py").write_text("")
            (old_package / "provenance.py").write_text("def source_identity(root): return 'old-boundary'\n")
            (checkout / "pnpm-workspace.yaml").write_text("packages: [.]\n")
            builder = old_scripts / "native_build.py"
            # A disposable builder records its imported identity; no UI or build.
            builder.write_text(
                "from pathlib import Path\n"
                "import json,sys\n"
                "from qa_ui_auto.provenance import source_identity\n"
                "Path('result.json').write_text(json.dumps([source_identity(Path.cwd()),sys.argv[1:]]))\n"
            )
            original = builder.read_bytes()
            expected = source_identity(checkout)
            subprocess.run([
                sys.executable, str(scripts / "workspace_perf/build_baseline.py"),
                "--checkout", str(checkout),
            ], cwd=checkout, env=dict(os.environ, PYTHONPATH=str(scripts)), check=True)
            self.assertEqual(json.loads((checkout / "result.json").read_text()), [expected, ["--release"]])
            self.assertEqual(builder.read_bytes(), original)
            self.assertEqual(source_identity(checkout), expected)

    def test_release_runtime_is_selected_by_producer_not_consumer_desktop(self):
        entry = {
            "platform_key": "linux", "mode": "native", "runner": "ubuntu-24.04",
            "capabilities": ["release"], "build_id": "linux-release",
        }
        selection = {
            "entries": [entry],
            "builds": [{"id": "linux-release", "runner": "ubuntu-22.04", "profile": "release"}],
        }
        self.assertIs(linux_release_entry(selection), entry)
        for runner, profile in (("ubuntu-24.04", "release"), ("ubuntu-22.04", "debug")):
            selection["builds"][0].update(runner=runner, profile=profile)
            with self.subTest(runner=runner, profile=profile), self.assertRaises(ValueError):
                linux_release_entry(selection)

    def test_independent_roots_get_identical_bytes_and_expected_large_files(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "first", Path(directory) / "second"
            self.assertEqual(dataset(first), dataset(second))
            files = [p for p in first.rglob("*") if p.is_file()]
            self.assertEqual(len(files), 3097)
            self.assertEqual((first / "Large1MiB.txt").stat().st_size, 1024 * 1024)
            for i in range(24):
                path = first / f"Tab{i:02}.txt"
                self.assertEqual(path.stat().st_size, 64 * 1024)
                self.assertTrue(
                    path.read_bytes().startswith(
                        f"WORKSPACE_PERF_TAB_{i:02}\n".encode()
                    )
                )
            self.assertEqual(
                hashlib.sha256((first / "Dir00/File000.txt").read_bytes()).hexdigest(),
                hashlib.sha256((second / "Dir00/File000.txt").read_bytes()).hexdigest(),
            )

    def test_tail_samples_are_retained_in_percentiles_and_maximum(self):
        values = [1] * 19 + [500]
        result = stats(values)
        self.assertEqual(values[-1], 500)
        self.assertEqual(result, {"n": 20, "p50": 1, "p95": 1, "max": 500})
