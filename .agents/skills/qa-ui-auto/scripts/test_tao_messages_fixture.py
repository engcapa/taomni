"""Protocol-fixture observations work with relative hosted report directories."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import ProxyHandler, Request, build_opener

from qa_ui_auto.fixtures import tao_messages
from qa_ui_auto.rdp_steps import _do_assert_json_file


class TaoMessagesFixtureTests(unittest.TestCase):
    def exercise_counts(self, relative):
        with TemporaryDirectory(dir=Path.cwd()) as directory:
            root = Path(directory)
            if relative:
                root = root.relative_to(Path.cwd())
            case_dir = root / "TC-TAO-HOME-009"
            case_dir.mkdir()
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}},
                                  report_root=root, case_dir=case_dir, values={})
            isolation = tao_messages.native_isolation_env(root.resolve())
            with patch.dict(os.environ, isolation):
                try:
                    tao_messages.setup(ctx)
                    path = ctx.values["tao_messages_counts"]
                    # Exercise the production read-only verb, whose relative
                    # paths are intentionally relative to the case directory.
                    _do_assert_json_file(ctx, {"path": path, "expect": {
                        "requests": 0, "cancelled": 0, "completed": 0}, "timeout_sec": .05})
                    port = ctx.tao_messages_servers[0].server_port
                    request = Request(f"http://127.0.0.1:{port}/anthropic/v1/messages",
                                      data=json.dumps({"messages": [{"content": "QA-FIRST"}]}).encode(),
                                      headers={"Content-Type": "application/json"})
                    with build_opener(ProxyHandler({})).open(request, timeout=5) as response:
                        self.assertIn(b'event: message_stop', response.read())
                    _do_assert_json_file(ctx, {"path": path, "expect": {
                        "requests": 1, "cancelled": 0, "completed": 1}, "timeout_sec": 1})
                    self.assertTrue(Path(path).is_absolute())
                    self.assertTrue(Path(path).is_relative_to(root.resolve()))
                finally:
                    tao_messages.teardown(ctx)

    def test_relative_hosted_report_path_is_readable_without_double_prefix(self):
        self.exercise_counts(relative=True)

    def test_absolute_local_report_path_keeps_the_same_observation_contract(self):
        self.exercise_counts(relative=False)


if __name__ == "__main__":
    unittest.main()
