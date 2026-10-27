"""Selection diagnostics preserve the actual update's arguments and failures."""
import json
import subprocess
import unittest

from native_editor_selection import EDITOR_SELECTION_HOOK_SCRIPT


HARNESS = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = require('node:fs').readFileSync(0, 'utf8');
const focusNode = {nodeType: 3, nodeName: '#text', isConnected: true, parentNode: {nodeName: 'SPAN'}};
const domSelection = {anchorNode: focusNode, focusNode, anchorOffset: 0, focusOffset: 23,
  isCollapsed: false, toString: () => 'QA_RELEASE_CANVAS_SAVED'};
let mutationCallback;
let disconnected = 0;
const sandbox = {
  localStorage: {getItem: () => '1'}, performance: {now: () => 17},
  document: {getSelection: () => domSelection},
  MutationObserver: class {
    constructor(callback) {mutationCallback = callback;}
    observe() {}
    disconnect() {disconnected++;}
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const install = sandbox.__QA_UI_AUTO_WATCH_SELECTION__;
const state = {doc: {length: 23}, selection: {main: {anchor: 0, head: 23}}};
const collapsed = {main: {anchor: 0, head: 0}};
const transaction = {selection: collapsed, docChanged: false, isUserEvent: event => event === 'select'};
const transactions = [transaction];
let calls = 0;
let failure = null;
const view = {state, update: function(actual, marker) {
  assert.equal(this, view);
  assert.equal(actual, transactions);
  assert.equal(marker, 'marker');
  calls++;
  if (failure) throw failure;
  state.selection = collapsed;
  return 42;
}, destroy: () => 'destroyed'};
const editor = {cmTile: {root: {view}}};
const observation = {followingInput: []};
install(editor, observation);
assert.equal(view.update(transactions, 'marker'), 42);
assert.equal(calls, 1);
const sample = observation.transactions[0];
assert.equal(sample.before.head, 23);
assert.equal(sample.after.head, 0);
assert.deepEqual(Array.from(sample.transactions[0].userEvents), ['select']);
assert.match(sample.stack, /Editor selection transaction/);
assert.equal(sample.domBefore.selectedChars, 23);
assert.equal(sample.domAfter.focus.id, sample.domBefore.focus.id);
mutationCallback([{type: 'childList', target: focusNode.parentNode,
  addedNodes: [focusNode], removedNodes: []}]);
assert.equal(observation.domChanges.length, 1);
assert.equal(observation.domChanges[0].records[0].added[0].id, sample.domBefore.focus.id);
state.selection = {main: {anchor: 3, head: 3}};
assert.equal(sample.after.head, 0, 'samples never alias live selection');
const wrapper = view.update;
const next = {followingInput: []};
install(editor, next);
assert.equal(view.update, wrapper, 'one wrapper per view');
failure = Error('real update failed');
assert.throws(() => view.update(transactions, 'marker'), error => error === failure);
assert.equal(calls, 2, 'failed update is never replayed');
failure = null;
next.followingInput = [1, 2, 3];
view.update(transactions, 'marker');
assert.equal(next.transactions.length, 1, 'stop collecting after initial input');
next.followingInput = [];
for (let i = 0; i < 50; i++) view.update(transactions, 'marker');
assert.equal(next.transactions.length, 24);
// An observation failure still invokes the real update exactly once.
next.transactions = {get length() {throw Error('diagnostic failed');}};
const previous = calls;
assert.equal(view.update(transactions, 'marker'), 42);
assert.equal(calls, previous + 1);
assert.equal(view.destroy(), 'destroyed');
assert.equal(disconnected, 1);
vm.runInContext(source, sandbox);
assert.equal(sandbox.__QA_UI_AUTO_WATCH_SELECTION__, install);
const disabled = {localStorage: {getItem: () => null}};
disabled.window = disabled;
vm.createContext(disabled);
vm.runInContext(source, disabled);
assert.equal(disabled.__QA_UI_AUTO_WATCH_SELECTION__, undefined);
process.stdout.write(JSON.stringify({passed: true}));
"""


class NativeEditorSelectionTest(unittest.TestCase):
    def test_observation_preserves_updates_and_is_bounded_and_opt_in(self):
        result = subprocess.run(["node", "-e", HARNESS], input=EDITOR_SELECTION_HOOK_SCRIPT,
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])
