"""Pure startup-owner tests; no browser, app, driver, or fixture server runs."""
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

from native_session_startup import (
    READINESS_SCRIPT, SNAPSHOT_SCRIPT, STARTUP_OBSERVER,
    create_case_session, start_owned_session, wait_for_app_ready,
)
from native_webdriver_transport import WebDriverError
from qa_ui_auto.deadline import CaseTimeout


class StartupOwnerTest(TestCase):
    def session(self, events):
        session = Mock(session_id="startup-session", deadline=None)
        session.last_request = {"method": "POST", "phase": "complete"}
        session.start.side_effect = WebDriverError("original root failure")
        session.execute.side_effect = lambda script: events.append("document") or {
            "url": "http://tauri.localhost/", "readyState": "complete",
            "rootExists": True, "rootChildren": 0, "windowLabel": "screenshot-overlay",
        }
        session.request.side_effect = lambda method, path: events.append(path) or "window-1"
        session.screenshot.side_effect = lambda target: events.append("screenshot") or str(target)
        session.close.side_effect = lambda: events.append("close")
        return session

    def test_live_evidence_precedes_cleanup_and_original_failure_reaches_case(self):
        with TemporaryDirectory() as directory:
            events = []
            session = self.session(events)
            driver = Mock(proc=Mock(pid=42), report_root=Path(directory))
            driver.proc.poll.return_value = None
            driver.mark_session_closed.side_effect = lambda: events.append("owner-cleanup")
            artifacts = {}

            def create(**kwargs):
                return start_owned_session(session, driver, java_home=kwargs["tooling_java_home"],
                                           diagnostics_dir=kwargs["diagnostics_dir"])

            with self.assertRaisesRegex(WebDriverError, "original root failure"):
                create_case_session(create, Path(directory) / "TC-001/native-startup", None, artifacts)

            receipt = json.loads(Path(artifacts["startup"]).read_text(encoding="utf-8"))
            self.assertEqual(receipt["phase"], "before_session_cleanup")
            self.assertEqual(receipt["document"]["windowLabel"], "screenshot-overlay")
            self.assertEqual(receipt["document"]["rootChildren"], 0)
            self.assertEqual(receipt["driver_process"], {"pid": 42, "exit_code": None})
            self.assertEqual(receipt["last_request"], session.last_request)
            self.assertEqual(receipt["window_handle"], "window-1")
            self.assertEqual(receipt["window_handles"], "window-1")
            self.assertIn("startup_screenshot", artifacts)
            self.assertEqual(events, ["document", "/session/startup-session/window",
                                      "/session/startup-session/window/handles", "screenshot",
                                      "close", "owner-cleanup"])
            session.start.assert_called_once_with()

    def test_diagnostic_and_cleanup_errors_never_replace_primary_failure(self):
        with TemporaryDirectory() as directory:
            session = self.session([])
            session.execute.side_effect = WebDriverError("private response body")
            session.request.side_effect = OSError("private driver details")
            session.screenshot.side_effect = WebDriverError("no screenshot")
            session.close.side_effect = WebDriverError("DELETE failed")
            driver = Mock(proc=None, report_root=Path(directory))
            driver.mark_session_closed.side_effect = OSError("tree cleanup failed")
            with self.assertRaisesRegex(WebDriverError, "original root failure") as context:
                start_owned_session(session, driver)
            path = Path(context.exception.native_startup_artifacts["startup"])
            contents = path.read_text(encoding="utf-8")
            receipt = json.loads(contents)
            self.assertEqual(receipt["document_error_type"], "WebDriverError")
            self.assertEqual(receipt["window_handle_error_type"], "OSError")
            self.assertNotIn("private", contents)
            session.close.assert_called_once_with()
            driver.mark_session_closed.assert_called_once_with()

    def test_unwritable_artifacts_still_close_half_started_session(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / "not-a-directory"
            root.write_text("occupied", encoding="utf-8")
            session = self.session([])
            driver = Mock(proc=None)
            with self.assertRaisesRegex(WebDriverError, "original root failure"):
                start_owned_session(session, driver, diagnostics_dir=root / "startup")
            session.close.assert_called_once_with()
            driver.mark_session_closed.assert_called_once_with()

    def test_no_session_id_does_not_issue_invalid_diagnostic_commands(self):
        with TemporaryDirectory() as directory:
            session = self.session([])
            session.session_id = None
            driver = Mock(proc=None)
            with self.assertRaises(WebDriverError) as context:
                start_owned_session(session, driver, diagnostics_dir=Path(directory))
            receipt = json.loads(Path(context.exception.native_startup_artifacts["startup"]).read_text())
            self.assertEqual(receipt["document_unavailable"], "session_not_created")
            session.execute.assert_not_called()
            session.request.assert_not_called()
            session.screenshot.assert_not_called()
            session.close.assert_called_once_with()

    def test_ready_session_preserves_budget_and_seeds_only_requested_jdk(self):
        for java_home in (None, 'C:/jdk-25/quoted"path'):
            with self.subTest(java_home=java_home):
                budget = Mock()
                session = Mock(deadline=budget)
                driver = Mock()
                self.assertIs(start_owned_session(session, driver, java_home=java_home), session)
                self.assertIs(session.deadline, budget)
                session.start.assert_called_once_with()
                session.close.assert_not_called()
                driver.mark_session_closed.assert_not_called()
                if java_home:
                    self.assertIn(json.dumps(java_home), session.execute.call_args.args[0])
                else:
                    session.execute.assert_not_called()

    def test_expired_diagnostics_budget_does_not_start_later_requests(self):
        with TemporaryDirectory() as directory:
            session = self.session([])
            driver = Mock(proc=None)
            with patch("native_session_startup.Deadline") as deadline:
                deadline.return_value.remaining.side_effect = CaseTimeout("capture exhausted")
                with self.assertRaisesRegex(WebDriverError, "original root failure"):
                    start_owned_session(session, driver, diagnostics_dir=Path(directory))
            session.execute.assert_not_called()
            session.request.assert_not_called()
            session.screenshot.assert_not_called()
            session.close.assert_called_once_with()


class ReadinessTest(TestCase):
    def test_transient_navigation_remains_retryable_but_never_restarts_app(self):
        session = Mock(deadline=None)
        session.execute.side_effect = [WebDriverError("about:blank"), False, True]
        with patch("native_session_startup.time.sleep"):
            wait_for_app_ready(session)
        self.assertEqual(session.execute.call_count, 3)
        session.execute.assert_called_with(READINESS_SCRIPT)
        session.start.assert_not_called()
        session.close.assert_not_called()

    def test_false_predicate_keeps_original_twenty_second_failure(self):
        session = Mock(deadline=None)
        session.execute.return_value = False
        with patch("native_session_startup.time.monotonic", side_effect=[0, 0, 19.99, 20.01]), \
                patch("native_session_startup.time.sleep") as sleep:
            with self.assertRaisesRegex(WebDriverError, "within 20.0s: document root is not mounted"):
                wait_for_app_ready(session)
        session.execute.assert_called_once()
        sleep.assert_called_once()

    def test_authoritative_case_budget_is_not_extended(self):
        session = Mock()
        session.deadline.remaining.side_effect = CaseTimeout("case execution deadline exceeded")
        with self.assertRaisesRegex(CaseTimeout, "case execution deadline exceeded"):
            wait_for_app_ready(session)
        session.execute.assert_not_called()


OBSERVER_HARNESS = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {observer, readiness, snapshot} = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const handlers = {};
let mounted = false;
const sandbox = {
  URL, location: {href: 'http://tauri.localhost/#screenshot-overlay', hash: '#screenshot-overlay'},
  performance: {getEntriesByType: () => [{name: 'http://tauri.localhost/assets/main.js?secret=hidden',
    initiatorType: 'script', startTime: 1, duration: 2, transferSize: 3, decodedBodySize: 4}]},
  document: {
    readyState: 'complete',
    querySelector: selector => {assert.equal(selector, '#root > *'); return mounted ? {} : null;},
    getElementById: id => {assert.equal(id, 'root'); return {childElementCount: mounted ? 1 : 0};},
    body: {children: [{tagName: 'INPUT', id: 'root', getAttribute: () => null,
      get value() {throw Error('must not inspect form values');},
      get textContent() {throw Error('must not inspect document contents');}}]}
  },
  __TAURI_INTERNALS__: {invoke() {throw Error('must not invoke IPC');},
    metadata: {currentWindow: {label: 'screenshot-overlay'}, currentWebview: {label: 'screenshot-overlay'}}},
  addEventListener: (name, handler) => (handlers[name] ??= []).push(handler)
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const run = source => vm.runInContext('(function(){' + source + '})()', sandbox);
run(observer);
run(observer);
assert.equal(handlers.error.length, 1, 'one observer per document');
assert.equal(run(readiness), false, 'idle overlay is not accepted as mounted app');
for (let index = 0; index < 40; index++) handlers.error[0]({target: sandbox,
  message: 'startup failure', filename: 'http://tauri.localhost/assets/main.js?secret=hidden'});
handlers.unhandledrejection[0]({reason: {name: 'TypeError', message: 'private reason'}});
const evidence = run(snapshot);
assert.equal(evidence.rootChildren, 0);
assert.equal(evidence.windowLabel, 'screenshot-overlay');
assert.equal(evidence.screenshotOverlay, true);
assert.equal(evidence.errors.length, 32);
assert.equal(evidence.resources.length, 1);
assert.equal(evidence.url, 'http://tauri.localhost/');
assert.ok(!JSON.stringify(evidence).includes('secret=hidden'));
assert.ok(!JSON.stringify(evidence).includes('private reason'));
mounted = true;
assert.equal(run(readiness), true, 'original mounted-root predicate is preserved');
process.stdout.write(JSON.stringify({passed: true}));
"""


class StartupObserverTest(TestCase):
    def test_observer_is_passive_idempotent_bounded_and_keeps_target_identity(self):
        result = subprocess.run(["node", "-e", OBSERVER_HARNESS], input=json.dumps({
            "observer": STARTUP_OBSERVER, "readiness": READINESS_SCRIPT, "snapshot": SNAPSHOT_SCRIPT,
        }), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])
