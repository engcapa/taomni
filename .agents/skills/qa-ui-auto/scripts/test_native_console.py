"""Passive shortcut observations retain event delivery and selection state."""
import json
import subprocess
from unittest import TestCase

from native_console import CONSOLE_HOOK_SCRIPT


HARNESS = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = require('node:fs').readFileSync(0, 'utf8');
const handlers = {};
const pending = [];
let selectionReads = 0;
const editor = {tagName: 'DIV', textContent: 'original', getAttribute: () => null};
editor.closest = selector => selector === '.cm-content' ? editor : null;
const sandbox = {
  localStorage: {getItem: () => null},
  performance: {now: () => 42}, console: {...console},
  queueMicrotask: callback => pending.push(callback),
  document: {
    addEventListener: () => {}, activeElement: editor, hasFocus: () => true,
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
key.defaultPrevented = true; // The actual editor consumes select-all.
pending.shift()();
const result = sandbox.__QA_UI_AUTO_FOCUS__[0];
assert.equal(result.prevented, false);
assert.deepEqual(JSON.parse(JSON.stringify(result.after)), {
  prevented: true, editorFocused: true, selectedChars: 8, collapsed: false,
  anchorOffset: 0, focusOffset: 8, documentChars: 8
});
const field = {tagName: 'INPUT', getAttribute: () => 'password', closest: () => null,
  get value() {throw Error('must not read control values');}};
handlers.keydown[0]({...key, target: field});
assert.equal(pending.length, 0);
assert.equal(selectionReads, 1);
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
        result = subprocess.run(["node", "-e", HARNESS], input=CONSOLE_HOOK_SCRIPT,
                                text=True, capture_output=True, check=True, timeout=20)
        self.assertTrue(json.loads(result.stdout)["passed"])
