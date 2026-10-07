import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from qa_ui_auto.native_steps import (
    NativeStepContext, _do_restart_native_app, _do_switch_native_window,
)
from qa_ui_auto.steps import StepError


class NativeWorkspaceStepsTests(unittest.TestCase):
    def context(self):
        session = Mock(session_id="first")
        session.endpoint.side_effect = lambda suffix: "/session/first" + suffix
        return NativeStepContext(session, Path(tempfile.gettempdir()), {})

    def test_roundtrip_uses_real_window_handles_and_remembers_main(self):
        ctx = self.context()
        ctx.session.request.side_effect = ["main-handle", ["main-handle"], None,
                                           ["main-handle", "detached-handle"], None,
                                           ["main-handle"], None]
        _do_switch_native_window(ctx, "main")
        _do_switch_native_window(ctx, "detached")
        _do_switch_native_window(ctx, "main")
        posts = [call.args for call in ctx.session.request.call_args_list if call.args[0] == "POST"]
        self.assertEqual(posts, [
            ("POST", "/session/first/window", {"handle": "main-handle"}),
            ("POST", "/session/first/window", {"handle": "detached-handle"}),
            ("POST", "/session/first/window", {"handle": "main-handle"}),
        ])

    def test_ambiguous_detached_windows_fail(self):
        ctx = self.context()
        ctx.session.request.side_effect = ["main", ["main", "detached-a", "detached-b"]]
        with self.assertRaisesRegex(StepError, "exactly one"):
            _do_switch_native_window(ctx, "detached")

    def test_restart_rejects_reused_session(self):
        ctx = self.context()
        ctx.restart_application = Mock()
        with self.assertRaisesRegex(StepError, "fresh native session"):
            _do_restart_native_app(ctx, None)

    def test_restart_discards_previous_window_handles(self):
        ctx = self.context()
        ctx.main_window_handle = "old-main"
        ctx.restart_application = lambda: setattr(ctx.session, "session_id", "second")
        _do_restart_native_app(ctx, None)
        self.assertIsNone(ctx.main_window_handle)


if __name__ == "__main__":
    unittest.main()
