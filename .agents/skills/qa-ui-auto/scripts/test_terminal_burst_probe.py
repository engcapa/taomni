"""Probe contracts: real producer bytes, strict oracle and passive JS observation."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import TestCase

from qa_ui_auto import terminal_burst_probe as probe
from qa_ui_auto.steps import StepError


BEGIN, END = "qa-burst-begin-0", "qa-burst-done-0"
PAYLOAD = ("P" * 511 + "\n") * 4096


def trace():
    text = "prompt\r\n" + BEGIN + "\r\n" + PAYLOAD.replace("\n", "\r\n") + END + "\r\n"
    return {"channels": {"7": [
        {"index": 12 + index, "text": text[start:start + 4096]}
        for index, start in enumerate(range(0, len(text), 4096))
    ]}, "errors": []}


class ProducerTest(TestCase):
    def test_independent_process_really_writes_the_complete_workload_and_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            result = subprocess.run([sys.executable, "-c", probe.producer_source(receipt, BEGIN, END)],
                                    capture_output=True, timeout=20, check=True)
            self.assertEqual(result.stdout, (BEGIN + "\n" + PAYLOAD + END + "\n").encode())
            self.assertEqual(result.stderr, b"")
            record = json.loads(receipt.read_text())
            self.assertEqual(record["bytes"], 2097152)
            self.assertGreaterEqual(record["elapsedMs"], 0)


class OracleTest(TestCase):
    def test_tauri_out_of_order_arrival_retains_exact_ordered_bytes(self):
        raw = trace()
        raw["channels"]["7"].reverse()
        original = deepcopy(raw)
        reviewed = probe.review_trace(raw, BEGIN, END)
        self.assertEqual(reviewed["bytes"], 2097152)
        self.assertEqual(reviewed["sha256"], hashlib.sha256(PAYLOAD.encode()).hexdigest())
        self.assertEqual(raw, original, "review must not rewrite raw evidence")
        self.assertEqual(probe.channel_summary(raw)["7"]["missing"], [])

    def test_missing_or_duplicated_indices_cannot_pass(self):
        for mode in ("missing", "duplicate"):
            with self.subTest(mode=mode):
                raw = trace()
                rows = raw["channels"]["7"]
                if mode == "missing":
                    del rows[10]
                else:
                    rows.insert(10, rows[10])
                with self.assertRaisesRegex(StepError, "indices"):
                    probe.review_trace(raw, BEGIN, END)
                summary = probe.channel_summary(raw)["7"]
                self.assertTrue(summary["missing"] if mode == "missing" else summary["duplicates"])

    def test_wrong_bytes_incomplete_tail_duplicate_stream_and_callback_error_fail(self):
        for mode in ("wrong", "incomplete", "duplicate-stream", "duplicate-marker", "callback-error"):
            with self.subTest(mode=mode):
                raw = trace()
                if mode == "wrong":
                    raw["channels"]["7"][10]["text"] = "Q" + raw["channels"]["7"][10]["text"][1:]
                elif mode == "incomplete":
                    raw["channels"]["7"][-1]["text"] = "P" * 4096
                elif mode == "duplicate-stream":
                    raw["channels"]["8"] = deepcopy(raw["channels"]["7"])
                elif mode == "duplicate-marker":
                    raw["channels"]["7"][0]["text"] = BEGIN + "\n" + raw["channels"]["7"][0]["text"]
                else:
                    raw["errors"] = [{"id": 7, "message": "consumer failed"}]
                with self.assertRaises(StepError):
                    probe.review_trace(raw, BEGIN, END)


JS_HARNESS = r"""
const assert = require('node:assert/strict');
const source = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const receiver = {};
const observed = [];
const original = function(raw) {
  assert.equal(this, receiver);
  observed.push(raw);
  return raw;
};
const error = Error('original consumer failure');
const throws = () => {throw error;};
const callbacks = new Map([[7, original], [8, throws], [9, original], [10, original]]);
const window = {__TAURI_INTERNALS__: {callbacks}, __QA_UI_AUTO_CONSOLE__: [{message:'original error'}],
  __taomni_terminal_registry__: {entries: new Map([['tab', {
    tabId:'tab', sessionId:'session', getBufferText: () => 'visible terminal tail'
  }]])}};
const install = new Function('window', source.install);
const collect = new Function('window', source.collect);
assert.equal(install(window), 4);
assert.throws(() => install(window), /already installed/);
const bytes = new TextEncoder().encode('full IPC bytes\r\n').buffer;
const raw = {index:32, message:bytes};
assert.equal(callbacks.get(7).call(receiver, raw), raw);
assert.equal(observed[0], raw, 'deliver original object exactly once');
assert.equal(raw.message, bytes, 'no replacing or modifying message bytes');
const ordinary = {index:33, message:'ordinary nonbinary callback'};
callbacks.get(7).call(receiver, ordinary);
assert.equal(observed.length, 2);
assert.throws(() => callbacks.get(8)({index:3, message:bytes}), caught => caught === error);
const unrelated = () => {};
callbacks.set(9, unrelated);
callbacks.delete(10);
const result = collect(window);
assert.equal(result.channels[7].length, 1);
assert.deepEqual(result.channels[7][0], {index:32, text:'full IPC bytes\r\n'});
assert.equal(result.errors.length, 1);
assert.equal(result.errors[0].message, String(error));
assert.equal(result.console[0].message, 'original error');
assert.equal(result.terminals[0].tail, 'visible terminal tail');
assert.equal(callbacks.get(7), original);
assert.equal(callbacks.get(8), throws);
assert.equal(callbacks.get(9), unrelated, 'never overwrite later registrations');
assert.equal(callbacks.has(10), false, 'never resurrect removed callbacks');
assert.equal(window.__QA_TERMINAL_BURST__, undefined);
assert.throws(() => collect(window), /missing/);
const pane = {getAttribute: () => 'echo '+source.marker+'\n'+source.marker+'\r\n'};
const document = {querySelector: () => pane, querySelectorAll: () => [pane]};
assert.equal(new Function('document', 'return '+source.line)(document), true);
pane.getAttribute = () => 'echo '+source.marker+'\n';
assert.equal(new Function('document', 'return '+source.line)(document), false,
  'command echo alone cannot prove execution');
assert.equal(new Function('document', 'return '+source.ready)(document), true);
document.querySelectorAll = () => [pane, pane];
assert.equal(new Function('document', 'return '+source.ready)(document), false,
  'multiple active panes cannot accidentally select the wrong terminal');
process.stdout.write(JSON.stringify({passed:true}));
"""


class JavaScriptTest(TestCase):
    def test_observer_preserves_delivery_errors_cleanup_and_anchored_output(self):
        result = subprocess.run(["node", "-e", JS_HARNESS], input=json.dumps({
            "install": probe.TRACE_INSTALL, "collect": probe.TRACE_COLLECT,
            "marker": END, "line": probe.line_present(END), "ready": probe.ready(),
        }), text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])
