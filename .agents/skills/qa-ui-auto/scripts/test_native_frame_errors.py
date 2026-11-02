"""Iframe-owned observers must not move errors outside the native assertion."""
import json
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase

from native_frame_errors import FRAME_RUNTIME_ERROR_HOOK_SCRIPT
from qa_ui_auto.runtime_errors import assert_snapshot
from qa_ui_auto.steps import StepError


HARNESS = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = require('node:fs').readFileSync(0, 'utf8');
const handlers = {};
const frameHandlers = [];
const doc = () => {
  const events = {};
  frameHandlers.push(events);
  return {defaultView: {addEventListener: (name, callback) => (events[name] ??= []).push(callback)}};
};
const frame = {tagName: 'IFRAME', contentDocument: doc()};
const inaccessible = {get contentDocument() {throw Error('cross origin');}};
const sandbox = {document: {
  querySelectorAll: () => [frame, inaccessible],
  addEventListener: (name, callback, capture) => {
    assert.equal(capture, true);
    (handlers[name] ??= []).push(callback);
  }
}, __QA_UI_AUTO_CONSOLE__: []};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
vm.runInContext(source, sandbox);
assert.equal(handlers.load.length, 1);
handlers.load[0]({target: frame});
assert.equal(frameHandlers[0].error.length, 1, 'same document gets one listener');
const error = {message: 'ResizeObserver loop completed with undelivered notifications.',
  filename: 'about:srcdoc', lineno: 0, colno: 0,
  preventDefault: () => {throw Error('must not suppress errors');},
  stopPropagation: () => {throw Error('must not stop propagation');}};
frameHandlers[0].error[0](error);
frame.contentDocument = doc();
handlers.load[0]({target: frame});
assert.equal(frameHandlers[1].error.length, 1, 'new document is observed after navigation');
frameHandlers[1].unhandledrejection[0]({reason: 'iframe promise failure'});
process.stdout.write(JSON.stringify(sandbox.__QA_UI_AUTO_CONSOLE__));
"""


class NativeFrameErrorsTest(TestCase):
    def test_iframe_errors_are_retained_without_suppression_after_navigation(self):
        result = subprocess.run(["node", "-e", HARNESS],
                                input=FRAME_RUNTIME_ERROR_HOOK_SCRIPT,
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads(result.stdout)
        self.assertEqual(len(entries), 2)
        self.assertTrue(all(entry["frame"] for entry in entries))
        self.assertIn("ResizeObserver", entries[0]["args"][0])
        with tempfile.TemporaryDirectory() as tmp:
            for entry, message in zip(entries, ["ResizeObserver", "iframe promise failure"]):
                with self.assertRaisesRegex(StepError, message):
                    assert_snapshot({"installed": True, "entries": [entry]}, Path(tmp), "native")
