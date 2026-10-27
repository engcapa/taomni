"""The passive native observer probe must preserve callback/native semantics."""

import json
import subprocess
import unittest

from native_resize_observer import RESIZE_OBSERVER_HOOK_SCRIPT


HARNESS = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = require('node:fs').readFileSync(0, 'utf8');
class OriginalObserver {
  constructor(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback');
    this.callback = callback;
    this.targets = new Set();
  }
  observe(element) { this.targets.add(element); }
  unobserve(element) { this.targets.delete(element); }
  disconnect() { this.targets.clear(); }
  emit(entries) { return this.callback.call(this, entries, this); }
}
function environment(enabled) {
  const sandbox = {
    ResizeObserver: OriginalObserver,
    localStorage: { getItem: () => enabled ? '1' : null },
    performance: { now: () => 17 },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}
const disabled = environment(false);
assert.equal(disabled.ResizeObserver, OriginalObserver);
assert.equal(disabled.__QA_UI_AUTO_RESIZE_TRACE__, undefined);
const enabled = environment(true);
const wrapper = enabled.ResizeObserver;
vm.runInContext(source, enabled);
assert.equal(enabled.ResizeObserver, wrapper, 'installation is idempotent');
assert.throws(() => new wrapper(null), TypeError);
const target = {
  tagName: 'DIV', id: '', parentElement: null,
  getAttribute: name => name === 'data-testid' ? 'editor' : null,
  getBoundingClientRect: () => { throw Error('must not measure layout'); },
};
const entries = [{target, contentRect: {width: 640, height: 480}}];
let delivered = 0;
const observer = new wrapper(function(actual, instance) {
  assert.equal(actual, entries);
  assert.equal(instance, observer);
  assert.equal(this, observer);
  delivered++;
  return 42;
});
assert.ok(observer instanceof OriginalObserver);
observer.observe(target);
assert.equal(observer.emit(entries), 42);
observer.unobserve(target);
assert.equal(observer.targets.size, 0);
observer.observe(target);
observer.disconnect();
assert.equal(observer.targets.size, 0);
for (let index = 0; index < 100; index++) observer.emit(entries);
assert.equal(delivered, 101);
const trace = enabled.__QA_UI_AUTO_RESIZE_TRACE__;
assert.equal(trace.samples.length, 64);
assert.equal(trace.samples[0].entries[0].target[0].testid, 'editor');
assert.equal(trace.samples[0].entries[0].width, 640);
assert.match(trace.samples[0].stack, /ResizeObserver creation/);
assert.doesNotThrow(() => JSON.stringify(trace));
const failure = Error('real callback failure');
const broken = new wrapper(() => { throw failure; });
assert.throws(() => broken.emit(entries), error => error === failure);
// A diagnostic failure must not prevent the real observer callback.
const badEntries = [{target: null, get contentRect() { throw Error('probe failed'); }}];
let recovered = false;
new wrapper(() => { recovered = true; }).emit(badEntries);
assert.equal(recovered, true);
process.stdout.write(JSON.stringify({passed: true}));
"""


class NativeResizeObserverTest(unittest.TestCase):
    def test_probe_preserves_observer_delivery_errors_and_lifecycle(self):
        result = subprocess.run(
            ["node", "-e", HARNESS], input=RESIZE_OBSERVER_HOOK_SCRIPT,
            text=True, capture_output=True, check=True, timeout=20,
        )
        self.assertTrue(json.loads(result.stdout)["passed"])


if __name__ == "__main__":
    unittest.main()
