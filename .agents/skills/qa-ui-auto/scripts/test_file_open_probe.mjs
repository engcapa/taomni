import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("./qa_ui_auto/file_open_probe.js", import.meta.url), "utf8");
function fixture() {
  let now = 0;
  let text = "previous document";
  let highlighted = false;
  const frames = new Map();
  const listeners = new Map();
  let frameId = 0;
  class Element {
    closest(selector) { return selector === "file" ? this : null; }
  }
  const content = { cmTile: { root: { view: { state: { get doc() {
    return { toString: () => text, length: text.length, lines: text.split("\n").length };
  } } } } }, getBoundingClientRect: () => ({ width: 100, height: 100 }),
  querySelector: () => highlighted ? {} : null };
  const context = vm.createContext({ Element, performance: { now: () => now },
    requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id), window: {},
    document: { querySelector: () => content, addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event) => listeners.delete(event) } });
  const install = vm.runInContext("(" + script + ")", context);
  install({ selector: "file", event: "dblclick", expected: "{\n  \"value\": 1\n}\n" });
  return { context, frames, listeners,
    input: () => listeners.get("dblclick")({ target: new Element(), isTrusted: true }),
    publish: () => { text = "{\n  \"value\": 1\n}\n"; },
    highlight: () => { highlighted = true; },
    tick: (ms) => { now += ms; const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn(now)); },
  };
}

test("waits for actual activation, exact canonical text, highlighting and settled frames", () => {
  const f = fixture();
  assert.equal(f.frames.size, 0);
  f.input(); f.tick(16);
  assert.equal(f.context.window.__QA_FILE_OPEN_PROBE__.state.firstContentMs, null);
  f.publish(); f.tick(16);
  assert.equal(f.context.window.__QA_FILE_OPEN_PROBE__.state.firstContentMs, 32);
  assert.equal(f.context.window.__QA_FILE_OPEN_PROBE__.state.firstHighlightMs, null);
  f.highlight(); f.tick(16);
  for (let i = 0; i < 63; i++) f.tick(16);
  const state = f.context.window.__QA_FILE_OPEN_PROBE__.finish();
  assert.equal(state.firstHighlightMs, 48);
  assert.equal(state.finished, true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.context.window.__QA_FILE_OPEN_PROBE__, undefined);
});

test("retains an initial main-thread freeze instead of discarding the slow sample", () => {
  const f = fixture();
  f.input(); f.publish(); f.highlight(); f.tick(2400);
  const state = f.context.window.__QA_FILE_OPEN_PROBE__.finish();
  assert.equal(state.firstContentMs, 2400);
  assert.equal(state.frames[0].gapMs, 2400);
  assert.equal(f.frames.size, 0);
});

test("does not restart measurement on repeated activation and cancels unfinished frames", () => {
  const f = fixture();
  f.input(); f.tick(25); f.input(); f.tick(25);
  const state = f.context.window.__QA_FILE_OPEN_PROBE__.finish();
  assert.equal(state.started, 0);
  assert.equal(state.frames.length, 2);
  assert.equal(state.finished, false);
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
});
