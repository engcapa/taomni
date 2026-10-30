import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.provenance import conditions_identity
from qa_ui_auto.workspace_stage_trace import SCRIPT, capture, native_host_sample
from qa_ui_auto.steps import StepError


class WorkspaceStageTraceTests(unittest.TestCase):
    def test_disabled_trace_makes_no_driver_requests(self):
        ctx = SimpleNamespace(session=Mock(), cfg={})
        with capture(ctx, "cold-json"):
            pass
        ctx.session.execute.assert_not_called()

    def test_trace_is_bound_to_conditions(self):
        normal = {"app": {"mode": "native"}}
        traced = {**normal, "diagnostics": {"workspace_stage_trace": True}}
        self.assertNotEqual(conditions_identity(normal, "native"), conditions_identity(traced, "native"))

    def test_host_sampling_uses_only_the_owned_app_and_finishes_after_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(session=SimpleNamespace(owned_app_pid=123), case_dir=Path(folder))
            process = Mock()
            process.wait.return_value = 0
            report = {}
            with patch("qa_ui_auto.workspace_stage_trace.platform.system", return_value="Darwin"), \
                 patch("qa_ui_auto.workspace_stage_trace.subprocess.Popen", return_value=process) as start:
                with self.assertRaisesRegex(ValueError, "original"):
                    with native_host_sample(ctx, "sdk", report):
                        raise ValueError("original")
                self.assertEqual(start.call_args.args[0][:4], ["sample", "123", "8", "10"])
                process.wait.assert_called_once_with(timeout=10)
                self.assertEqual(report["nativeHostSample"]["exitCode"], 0)

    def test_cleanup_retains_original_failure_and_trace(self):
        for cleanup in [[{"label": "focus", "durationMs": 3}], RuntimeError("capture failed")]:
            with self.subTest(cleanup=cleanup), tempfile.TemporaryDirectory() as folder:
                session = Mock()
                session.execute.side_effect = [True, cleanup]
                ctx = SimpleNamespace(session=session, case_dir=Path(folder),
                                      cfg={"diagnostics": {"workspace_stage_trace": True}})
                with self.assertRaisesRegex(ValueError, "original failure"):
                    with capture(ctx, "cold-json"):
                        raise ValueError("original failure")
                report = json.loads((ctx.case_dir / "workspace-stages-cold-json.json").read_text())
                self.assertTrue(report["diagnosticOnly"])
                self.assertEqual(session.execute.call_count, 2)
                if isinstance(cleanup, Exception):
                    self.assertEqual(report["captureError"], "capture failed")
                else:
                    self.assertEqual(report["events"], cleanup)

    def test_missing_capture_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Mock()
            session.execute.side_effect = [True, None]
            ctx = SimpleNamespace(session=session, case_dir=Path(folder),
                                  cfg={"diagnostics": {"workspace_stage_trace": True}})
            with self.assertRaisesRegex(RuntimeError, "disappeared"):
                with capture(ctx, "cold-json"):
                    pass

    def test_diagnostic_run_cannot_be_accepted_as_a_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Mock()
            session.execute.side_effect = [True, []]
            ctx = SimpleNamespace(session=session, case_dir=Path(folder),
                                  cfg={"diagnostics": {"workspace_stage_trace": True}})
            with self.assertRaisesRegex(StepError, "Diagnostic-only"):
                with capture(ctx, "cold-json"):
                    pass
            self.assertEqual(session.execute.call_count, 2)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for actual forwarding contracts")
    def test_javascript_forwards_receivers_arguments_results_errors_and_restores(self):
        driver = r'''
const assert = require("node:assert/strict"), vm = require("node:vm");
const source = require("node:fs").readFileSync(0, "utf8");
let now = 0, nextId = 0;
const scheduled = new Map(), error = new Error("original layout failure");
class Element {
  getBoundingClientRect(value) { assert.equal(this, element); now += 4; return value; }
  getClientRects() { now += 3; throw error; }
  get scrollTop() { now += 4; return this.top; }
  set scrollTop(value) { now += 3; this.top = value; }
}
class HTMLElement extends Element {
  focus(value) { assert.equal(this, element); now += 5; return value; }
}
const element = new HTMLElement();
class State { static create(value) { now += 3; return value; } }
class View { dispatch(value) { assert.equal(this, view); now += 4; return value; } }
const view = new View(); view.state = new State();
const originalRect = Element.prototype.getBoundingClientRect;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
const originalDispatch = View.prototype.dispatch, originalCreate = State.create;
const window = {
  requestAnimationFrame(callback) { scheduled.set(++nextId, callback); return nextId; },
  setTimeout(callback, delay, ...args) { scheduled.set(++nextId, () => callback(...args)); return nextId; },
  getComputedStyle(value) { now += 4; return value; },
};
const originalRaf = window.requestAnimationFrame, originalTimeout = window.setTimeout;
const context = { window, Element, HTMLElement, performance: { timeOrigin: 1000, now: () => now },
  document: { querySelector: () => ({cmTile:{root:{view}}}) } };
assert.equal(vm.runInNewContext("(" + source + ")()", context), true);
assert.throws(() => vm.runInNewContext("(" + source + ")()", context), /already installed/);
const value = { preserved: true };
assert.equal(element.getBoundingClientRect(value), value);
assert.equal(element.focus(value), value);
assert.throws(() => element.getClientRects(), err => err === error);
element.scrollTop = 7; assert.equal(element.scrollTop, 7);
assert.equal(view.dispatch(value), value); assert.equal(State.create(value), value);
assert.equal(window.getComputedStyle(value), value);
const receiver = {};
const id = window.requestAnimationFrame(function (argument) {
  assert.equal(this, receiver); assert.equal(argument, value); now += 5; return 17;
});
assert.equal(scheduled.get(id).call(receiver, value), 17);
const timer = window.setTimeout((argument) => { assert.equal(argument, value); now += 3; }, 0, value);
scheduled.get(timer)();
const events = window.__QA_WORKSPACE_STAGE_TRACE__.finish();
assert(events.length >= 10); assert(events.every(event => event.durationMs >= 2 && event.epochMs >= 1000));
assert.equal(window.__QA_WORKSPACE_STAGE_TRACE__, undefined);
assert.equal(Element.prototype.getBoundingClientRect, originalRect);
assert.deepEqual(Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"), originalScroll);
assert.equal(View.prototype.dispatch, originalDispatch); assert.equal(State.create, originalCreate);
assert.equal(window.requestAnimationFrame, originalRaf); assert.equal(window.setTimeout, originalTimeout);
process.stdout.write(JSON.stringify({ events: events.length }));
'''
        result = subprocess.run(["node", "-e", driver], input=SCRIPT, text=True,
                                capture_output=True, timeout=15, check=True)
        self.assertGreaterEqual(json.loads(result.stdout)["events"], 10)


if __name__ == "__main__":
    unittest.main()
