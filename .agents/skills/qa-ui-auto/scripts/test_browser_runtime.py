"""Opt-in real Chromium checks for runner isolation and timeout behavior."""
from __future__ import annotations

import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from qa_ui_auto import runner


@unittest.skipUnless(os.environ.get("QA_TEST_BROWSER") == "1", "set QA_TEST_BROWSER=1 with Playwright Chromium installed")
class BrowserRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<!doctype html><title>QA runtime fixture</title><button id='ready'>Ready</button>")

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        runner._close_browser()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def payload(self, root, case_id, steps, timeout=10):
        return {"case": {"id": case_id, "title": case_id, "steps": steps, "tags": [],
                         "covers": [], "modes": ["browser"], "fixtures": [], "timeout_sec": timeout},
                "cfg": {"app": {"base_url": f"http://127.0.0.1:{self.server.server_port}"}},
                "env": {}, "worker_id": 0, "report_root": str(root)}

    def test_reused_process_does_not_share_storage_and_discards_success_trace(self):
        def store(ctx, args):
            self.assertIsNone(ctx.page.evaluate("localStorage.getItem('case-marker')"))
            ctx.page.evaluate("localStorage.setItem('case-marker', 'present')")

        with tempfile.TemporaryDirectory() as directory, patch.dict(runner.STEP_REGISTRY, {"test_storage": store}):
            root = Path(directory)
            first = runner._run_browser_case(self.payload(root, "TC-first", [{"test_storage": None}]))
            browser = runner._browser
            second = runner._run_browser_case(self.payload(root, "TC-second", [{"test_storage": None}]))
            self.assertEqual(first["status"], "passed", first)
            self.assertEqual(second["status"], "passed", second)
            self.assertIs(runner._browser, browser)
            self.assertFalse((root / "TC-first/trace.zip").exists())

    def test_explicit_long_wait_obeys_case_budget_and_keeps_failure_trace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = runner._run_browser_case(self.payload(root, "TC-timeout", [
                {"wait_for": {"selector": "#never", "timeout_sec": 60}}], timeout=0.5))
            self.assertEqual(result["status"], "failed")
            self.assertLess(result["duration_sec"], 5)
            self.assertTrue((root / "TC-timeout/trace.zip").exists())

    def test_reload_window_returns_only_after_new_document(self):
        from qa_ui_auto.steps.persistence import step_reload_window

        def reload_and_observe(ctx, args):
            # The old page already has a welcome panel. Waiting for that panel
            # alone must not let reload_window return before the new navigation.
            ctx.page.add_init_script("window.documentGeneration = Math.random();")
            ctx.page.reload()
            ctx.page.evaluate("document.body.dataset.testid = 'welcome-panel'")
            old_generation = ctx.page.evaluate("window.documentGeneration")
            ctx.page.add_init_script("addEventListener('DOMContentLoaded', () => document.body.dataset.testid = 'welcome-panel')")
            step_reload_window(ctx, None)
            self.assertNotEqual(ctx.page.evaluate("window.documentGeneration"), old_generation)

        with tempfile.TemporaryDirectory() as directory, patch.dict(runner.STEP_REGISTRY, {"test_reload": reload_and_observe}):
            result = runner._run_browser_case(self.payload(Path(directory), "TC-reload", [{"test_reload": None}]))
            self.assertEqual(result["status"], "passed", result)

    def test_reset_fixture_preserves_saved_state_on_reload_but_isolates_next_case(self):
        def save(ctx, args):
            self.assertIsNone(ctx.page.evaluate("localStorage.getItem('taomni.appTheme.v1')"))
            ctx.page.evaluate("localStorage.setItem('taomni.appTheme.v1', 'dark')")
            ctx.page.evaluate("localStorage.setItem('taomni.sftp.cols.remote', 'saved-widths')")
            ctx.page.reload()
            self.assertEqual(ctx.page.evaluate("localStorage.getItem('taomni.appTheme.v1')"), "dark")
            self.assertEqual(ctx.page.evaluate("localStorage.getItem('taomni.sftp.cols.remote')"), "saved-widths")

        with tempfile.TemporaryDirectory() as directory, patch.dict(runner.STEP_REGISTRY, {"test_save": save}):
            for case_id in ("TC-persist-first", "TC-persist-second"):
                payload = self.payload(Path(directory), case_id, [{"test_save": None}])
                payload["case"]["fixtures"] = ["reset_db"]
                result = runner._run_browser_case(payload)
                self.assertEqual(result["status"], "passed", result)


if __name__ == "__main__":
    unittest.main()
