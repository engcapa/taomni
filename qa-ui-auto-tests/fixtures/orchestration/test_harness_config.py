"""Offline launch-contract tests. Installed identities are synthetic test files,
never a substitute for the real installed binaries required by CI validation.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavior import WORKER_MARKER
from ci_network import display_environment
from harness_config import CATALOG_PATH, fixture_url, prepare_launch, verify_installation
from worker_bridge import enrich_prompt
from server import FixtureApplication


class LaunchContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tree = self.root / "worktrees" / "worker"
        self.tree.mkdir(parents=True)
        common = self.root / "common.git"
        private = common / "worktrees" / "worker"
        private.mkdir(parents=True)
        (common / "HEAD").write_text("ref: refs/heads/unit\n")
        (private / "gitdir").write_text(str(self.tree / ".git") + "\n")
        (private / "commondir").write_text("../..\n")
        (self.tree / ".git").write_text("gitdir: " + str(private) + "\n")
        self.catalog = json.loads(CATALOG_PATH.read_text())
        node = self.root / "node"
        node.write_bytes(b"offline identity fixture, never executed")
        self.installation = {"catalog_sha256": hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest(), "harnesses": {}}
        for name, spec in self.catalog["harnesses"].items():
            entrypoint = self.root / (name + ".js")
            entrypoint.write_bytes(b"offline identity fixture, never executed")
            identity = {key: spec[key] for key in ("package", "version", "integrity", "commit") if key in spec}
            self.installation["harnesses"][name] = {"command": [str(node), str(entrypoint)],
                "entrypoint_sha256": hashlib.sha256(entrypoint.read_bytes()).hexdigest(),
                "protocol": spec["protocol"], "identity": identity}

    def test_all_six_exact_installed_commands_and_private_endpoint_configs(self):
        for name, spec in self.catalog["harnesses"].items():
            with self.subTest(harness=name):
                launch = prepare_launch(self.installation, name, "http://127.0.0.1:43210/v1", self.tree,
                                        self.root / ("state-" + name), "unit prompt")
                self.assertEqual(launch.expected_protocol, spec["protocol"])
                self.assertEqual(launch.command[:2], self.installation["harnesses"][name]["command"])
                self.assertNotIn("HTTP_PROXY", launch.env)
                self.assertNotIn("ANTHROPIC_AUTH_TOKEN", launch.env)
                self.assertEqual(launch.env["HOME"], str(self.root / ("state-" + name) / "home"))
                for path in (self.root / ("state-" + name)).rglob("*"):
                    if path.is_file():
                        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                        self.assertNotIn("api.openai.com", path.read_text())
                        self.assertNotIn("api.anthropic.com", path.read_text())
                if name in {"codex", "deepseek-harness"}:
                    self.assertEqual(launch.stdin, b"unit prompt\n")
                else:
                    self.assertIn("unit prompt\n", launch.command)
                if name == "deepseek-harness":
                    self.assertIn("--profile", launch.command)
                    self.assertIn("headless", launch.command)
                    patch = (self.root / ("state-" + name) / "fixture.cordis.yml").read_text()
                    self.assertIn("- id: session-title-llm\n  disabled: true", patch)
                if name == "opencode":
                    title = launch.command.index("--title")
                    self.assertEqual(launch.command[title + 1], "Taomni isolated worker")
                if name == "zcode":
                    self.assertNotIn("--model", launch.command)
                    self.assertIn("--prompt", launch.command)

    def test_opencode_prompt_metadata_is_newline_terminated_before_harness_suffix(self):
        marker = {"run_id": "run", "worker_id": "opencode"}
        prompt = "Task\n" + WORKER_MARKER + json.dumps(marker)
        launch = prepare_launch(self.installation, "opencode", "http://127.0.0.1:123/v1", self.tree,
                                self.root / "state-newline", prompt)
        rendered = launch.command[-1]
        self.assertTrue(rendered.endswith("\n"))
        from behavior import metadata
        self.assertEqual(metadata({"message": rendered + "</harness-context>"}, WORKER_MARKER), marker)
        with self.assertRaises(ValueError):
            metadata({"message": prompt + "</harness-context>"}, WORKER_MARKER)

    def test_codex_fixture_keeps_filesystem_sandbox_and_never_enables_legacy_bypass(self):
        prepare_launch(self.installation, "codex", "http://127.0.0.1:123/v1", self.tree,
                       self.root / "state-sandbox", "Task")
        config = (self.root / "state-sandbox" / "home" / ".codex" / "config.toml").read_text()
        self.assertIn('sandbox_mode = "workspace-write"', config)
        self.assertIn('approval_policy = "never"', config)
        self.assertNotIn("danger-full-access", config)
        self.assertNotIn("use_legacy_landlock", config)

    def test_missing_drifted_identity_and_external_endpoint_fail_closed(self):
        for url in ("https://api.example.test/v1", "http://localhost:123/v1", "http://127.0.0.1:123/",
                    "http://key@127.0.0.1:123/v1", "http://127.0.0.1:123/v1?token=secret"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                fixture_url(url)
        for bad in ({}, {**self.installation, "catalog_sha256": "wrong"},
                    {**self.installation, "harnesses": {}}):
            with self.assertRaises(ValueError):
                verify_installation(bad, "claude-code")
        entrypoint = Path(self.installation["harnesses"]["claude-code"]["command"][-1])
        entrypoint.write_text("changed identity")
        with self.assertRaises(ValueError):
            verify_installation(self.installation, "claude-code")

    def test_existing_state_and_ambient_dotenv_are_rejected(self):
        state = self.root / "existing"
        state.mkdir()
        with self.assertRaises(FileExistsError):
            prepare_launch(self.installation, "pi", "http://127.0.0.1:123/v1", self.tree, state, "prompt")
        (self.tree.parent / ".env").write_text("API_KEY=not-for-workers")
        with self.assertRaises(ValueError):
            prepare_launch(self.installation, "pi", "http://127.0.0.1:123/v1", self.tree, self.root / "new", "prompt")

    def test_native_namespace_display_allowlist_rejects_tcp_and_drops_credentials(self):
        auth = self.root / "auth"
        auth.write_bytes(b"offline cookie fixture")
        source = {"DISPLAY": ":99", "XAUTHORITY": str(auth), "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
                  "OPENAI_API_KEY": "secret", "HTTP_PROXY": "bad", "HOME": "/personal"}
        selected = display_environment(source)
        self.assertEqual(set(selected), {"DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"})
        for bad in ({"DISPLAY": "remote.example:99"}, {"DBUS_SESSION_BUS_ADDRESS": "tcp:host=example.test,port=123"},
                    {"XAUTHORITY": "relative-cookie"}):
            with self.assertRaises(ValueError):
                display_environment(bad)

    def test_prompt_enrichment_keeps_single_marker_and_owned_worktree(self):
        marker = {"worker_id": "worker", "run_id": "run"}
        prompt = "task\n" + WORKER_MARKER + json.dumps(marker) + "\nmore task"
        enriched, worker = enrich_prompt(prompt, self.tree)
        self.assertEqual(enriched.count(WORKER_MARKER), 1)
        self.assertEqual(worker["worktree"], str(self.tree))
        self.assertIn("more task", enriched)
        with self.assertRaises(ValueError):
            enrich_prompt("no marker", self.tree)

    def test_dynamic_registration_requires_explicit_containment_and_unique_owner(self):
        app = FixtureApplication(self.root / "log.ndjson")
        worker = {"worker_id": "worker", "run_id": "run", "worktree": str(self.tree)}
        body = {"prompt": WORKER_MARKER + json.dumps(worker)}
        with self.assertRaises(ValueError):
            app.register_request_worker(body)
        app.allow_worker_root(self.tree.parent)
        self.assertEqual(app.register_request_worker(body), {"worker": self.tree})
        for bad in ({**worker, "worker_id": "different"}, {**worker, "worktree": str(self.root)}):
            with self.assertRaises(ValueError):
                app.register_request_worker({"prompt": WORKER_MARKER + json.dumps(bad)})


if __name__ == "__main__":
    unittest.main()
