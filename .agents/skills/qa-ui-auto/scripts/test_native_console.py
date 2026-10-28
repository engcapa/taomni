"""Passive shortcut observations retain event delivery and selection state."""
import json
import subprocess
from unittest import TestCase

from native_console import CONSOLE_HOOK_SCRIPT
from qa_ui_auto.runtime_errors import NATIVE_SNAPSHOT


HARNESS = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {source, snapshot} = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const handlers = {};
const editorHandlers = {};
const pending = [];
const microtasks = [];
let selectionReads = 0;
const editor = {tagName: 'DIV', textContent: 'original', getAttribute: () => null};
editor.closest = selector => selector === '.cm-content' ? editor : null;
editor.contains = element => element === editor;
editor.cmTile = {root: {view: {
  hasFocus: true, composing: false,
  state: {doc: {length: 8}, selection: {main: {anchor: 0, head: 8}}},
  dispatch: () => {throw Error('must not change the editor');}
}}};
const sandbox = {
  localStorage: {getItem: () => null},
  performance: {now: () => 42}, console: {...console},
  queueMicrotask: callback => microtasks.push(callback),
  setTimeout: (callback, delay) => {assert.equal(delay, 0); pending.push(callback);},
  document: {
    addEventListener: (name, callback) => (editorHandlers[name] ??= []).push(callback),
    activeElement: editor, hasFocus: () => true,
    querySelector: () => null,
    getSelection: () => {
      selectionReads++;
      return {toString: () => 'original', isCollapsed: false, anchorOffset: 0, focusOffset: 8};
    }
  },
  addEventListener: (name, callback) => (handlers[name] ??= []).push(callback)
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext('(function(){' + source + '})()', sandbox);
const key = {type: 'keydown', key: 'a', code: 'KeyA', target: editor,
  ctrlKey: true, defaultPrevented: false, isTrusted: true,
  preventDefault: () => {throw Error('must not consume input');},
  stopPropagation: () => {throw Error('must not stop propagation');}};
handlers.keydown[0](key);
assert.equal(selectionReads, 0, 'capture listener does not read selection');
// A trusted browser event may checkpoint microtasks between its capture and
// target listeners. A microtask cannot establish completed editor handling.
while (microtasks.length) microtasks.shift()();
assert.equal(selectionReads, 0, 'do not snapshot selection before the target handler');
key.defaultPrevented = true; // The actual editor consumes select-all.
pending.shift()();
const result = sandbox.__QA_UI_AUTO_FOCUS__[0];
assert.equal(result.prevented, false);
assert.deepEqual(JSON.parse(JSON.stringify(result.after)), {
  prevented: true, editorFocused: true, selectedChars: 8, collapsed: false,
  anchorOffset: 0, focusOffset: 8, documentChars: 8,
  codeMirror: {anchor: 0, head: 8, documentChars: 8, focused: true, composing: false}
});
const checkpoint = vm.runInContext(snapshot, sandbox);
assert.equal(checkpoint.focusHistory.length, 1);
assert.equal(checkpoint.focusHistory[0].after.selectedChars, 8);
assert.notEqual(checkpoint.focusHistory, sandbox.__QA_UI_AUTO_FOCUS__);
const input = {type: 'beforeinput', target: editor, isTrusted: true, inputType: 'insertText'};
editorHandlers.beforeinput[0](input);
assert.equal(result.followingInput[0].codeMirror.head, 8);
editor.cmTile.root.view.state.selection.main = {anchor: 0, head: 0};
editorHandlers.input[0]({...input, type: 'input'});
assert.equal(result.followingInput[0].codeMirror.head, 8, 'snapshots do not alias live state');
assert.equal(result.followingInput[1].codeMirror.head, 0, 'retain the first input selection change');
for (let i = 0; i < 20; i++) editorHandlers.beforeinput[0](input);
assert.equal(result.followingInput.length, 12);
delete editor.cmTile;
handlers.keydown[0](key);
pending.shift()();
assert.equal(sandbox.__QA_UI_AUTO_FOCUS__.at(-1).after.codeMirror, null,
  'an unavailable CM runtime is explicit and never fabricated');
const readsBeforeField = selectionReads;
const field = {tagName: 'INPUT', getAttribute: () => 'password', closest: () => null,
  get value() {throw Error('must not read control values');}};
handlers.keydown[0]({...key, target: field});
assert.equal(pending.length, 0);
assert.equal(selectionReads, readsBeforeField);
for (let i = 0; i < 100; i++) handlers.keydown[0]({...key, target: field});
assert.equal(sandbox.__QA_UI_AUTO_FOCUS__.length, 64);
handlers.keydown[0]({...key, key: 'x', code: 'KeyX', ctrlKey: false, target: field});
assert.equal(sandbox.__QA_UI_AUTO_FOCUS__.length, 64);
vm.runInContext('(function(){' + source + '})()', sandbox);
assert.equal(handlers.keydown.length, 1, 'installation is idempotent');
process.stdout.write(JSON.stringify({passed: true}));
"""


class NativeConsoleTest(TestCase):
    def test_shortcut_probe_is_passive_bounded_and_excludes_form_values(self):
        result = subprocess.run(["node", "-e", HARNESS], input=json.dumps({
            "source": CONSOLE_HOOK_SCRIPT, "snapshot": NATIVE_SNAPSHOT,
        }),
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])
