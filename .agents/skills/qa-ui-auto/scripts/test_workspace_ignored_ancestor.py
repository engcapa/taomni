"""The cold-start case must reach native watching with complete real files."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from qa_ui_auto.fixtures import platform_workspace_root, workspace_ignored_ancestor_root
from qa_ui_auto.native_steps import NativeStepContext, VERBS


class IgnoredAncestorFixtureTest(unittest.TestCase):
    def test_nested_workspace_is_ready_for_external_write_and_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory).resolve()
            ctx = SimpleNamespace(
                cfg={"app": {"mode": "native"}}, values={}, report_root=report,
                case_id="TC-WS-030", worker_id=0,
            )
            workspace_ignored_ancestor_root.setup(ctx)
            root = Path(ctx.values["platform_workspace_root"])
            self.assertTrue(root.is_relative_to(report))
            self.assertEqual(root.parts[-2:], (".cache", "workspace"))
            for name, content in platform_workspace_root.SEED_FILES.items():
                self.assertEqual((root / name).read_bytes(), content.encode("utf-8"))
            case_dir = report / "TC-WS-030"
            case_dir.mkdir()
            steps = NativeStepContext(None, case_dir, ctx.cfg)
            VERBS["host_write_file"](steps, {
                "path": str(root / "README.md"), "text": "EXTERNAL_RESTORE_CONFLICT\n",
            })
            self.assertEqual((root / "README.md").read_bytes(), b"EXTERNAL_RESTORE_CONFLICT\n")


if __name__ == "__main__":
    unittest.main()
