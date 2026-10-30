"""Public project provenance, setup failure and local skip contracts."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import ci_java_project
from qa_ui_auto.fixtures import FixtureSkip, java_real_project


class RealJavaProjectTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def context(self, env):
        return SimpleNamespace(env=env, values={}, case_dir=self.root)

    def test_missing_local_path_skips_but_missing_hosted_path_fails(self):
        with self.assertRaisesRegex(FixtureSkip, "QA_JAVA_PROJECT_ROOT is unset"):
            java_real_project.setup(self.context({}))
        with self.assertRaisesRegex(RuntimeError, "was not prepared"):
            java_real_project.setup(self.context({"GITHUB_ACTIONS": "true"}))

    def test_configured_bad_path_is_a_failure_not_a_skip(self):
        for value in ("relative/project", str(self.root / "missing")):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                java_real_project.setup(self.context({"QA_JAVA_PROJECT_ROOT": value}))

    def test_fixture_keeps_source_bytes_and_escapes_workspace_path(self):
        project = self.root / "project 'quoted'"
        contents = {
            "pom.xml": "<project/>",
            java_real_project.TARGET: "public abstract class Pair {}\n",
            java_real_project.SOURCE: (
                "import java.util.Map;\nclass ImmutablePair<L, R> extends Pair<L, R> {\n"
                "    public final L left;\n    L getLeft() { return left; }\n}\n"
            ),
        }
        for relative, text in contents.items():
            path = project / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        ctx = self.context({"QA_JAVA_PROJECT_ROOT": str(project)})
        java_real_project.setup(ctx)
        self.assertEqual(ctx.values["java_field_cursor"], "3:20")
        recent = json.loads(ctx.values["java_recent_workspace"])[0]
        self.assertEqual(recent["roots"][0]["path"], project.as_posix())
        self.assertEqual(recent["lastActiveFile"]["path"], java_real_project.SOURCE)
        for relative, original in contents.items():
            self.assertEqual((project / relative).read_text(encoding="utf-8"), original)
        self.assertTrue((self.root / "java-project-inputs.json").is_file())

    def archive(self, spec, destination):
        with tarfile.open(destination, "w:gz") as bundle:
            data = b"<project/>"
            member = tarfile.TarInfo("commons-lang-" + spec["revision"] + "/pom.xml")
            member.size = len(data)
            bundle.addfile(member, io.BytesIO(data))

    def test_hosted_preparation_downloads_pinned_source_compiles_and_exports_absolute_path(self):
        with patch.dict(os.environ), patch.object(ci_java_project, "download", side_effect=self.archive) as download, \
                patch.object(ci_java_project.shutil, "which", return_value="mvn"), \
                patch.object(ci_java_project, "warm_maven") as warm:
            project = ci_java_project.prepare(self.root / "prepared")
            spec = download.call_args.args[0]
            self.assertRegex(spec["revision"], r"^[a-f0-9]{40}$")
            self.assertRegex(spec["sha256"], r"^[a-f0-9]{64}$")
            self.assertIn(spec["revision"], spec["url"])
            self.assertTrue(project.is_absolute())
            self.assertEqual(os.environ["QA_JAVA_PROJECT_ROOT"], project.as_posix())
            self.assertEqual(warm.call_args.args[1], project)
            self.assertIn("compile", warm.call_args.args[0])
            self.assertTrue(json.loads((self.root / "prepared/project.json").read_text())["compiled"])

    def test_download_or_build_failure_never_exports_a_successful_project(self):
        for stage in ("download", "build"):
            with self.subTest(stage=stage), patch.dict(os.environ), \
                    patch.object(ci_java_project, "download", side_effect=RuntimeError("checksum mismatch") if stage == "download" else self.archive), \
                    patch.object(ci_java_project.shutil, "which", return_value="mvn"), \
                    patch.object(ci_java_project, "warm_maven", side_effect=RuntimeError("compiler failed")):
                os.environ.pop("QA_JAVA_PROJECT_ROOT", None)
                destination = self.root / stage
                with self.assertRaises(RuntimeError):
                    ci_java_project.prepare(destination)
                self.assertNotIn("QA_JAVA_PROJECT_ROOT", os.environ)
                self.assertFalse((destination / "project.json").exists())

    def test_source_checksum_is_enforced_by_the_real_downloader(self):
        archive = self.root / "archive.tar.gz"
        spec = {"url": archive.as_uri(), "sha256": "0" * 64}
        archive.write_bytes(b"wrong source archive")
        target = self.root / "download.tar.gz"
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            ci_java_project.download(spec, target)
        self.assertFalse(target.exists())



if __name__ == "__main__":
    unittest.main()
