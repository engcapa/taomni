import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("./qa_ui_auto/file_open_probe.js", import.meta.url), "utf8");

test("file-open timing includes initial selection before the double click and cleans up every listener", () => {
  let now = 10;
  const listeners = new Map();
  const frames = new Map();
  const target = new class Element {
    closest() { return this; }
  }();
  const context = {
    Element: target.constructor, window: {}, performance: { now: () => now },
    document: {
      querySelector: () => null,
      addEventListener: (event, callback) => listeners.set(event, callback),
      removeEventListener: (event, callback) => { assert.equal(listeners.get(event), callback); listeners.delete(event); },
    },
    requestAnimationFrame: (callback) => { frames.set(1, callback); return 1; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  runInNewContext(`(${script})({selector: '.file', event: 'dblclick', expected: 'public'})`, context);
  assert.equal(typeof listeners.get("pointerdown"), "function");
  listeners.get("pointerdown")({ type: "pointerdown", target, isTrusted: true, button: 0 });
  now = 510;
  listeners.get("dblclick")({ type: "dblclick", target, isTrusted: true, button: 0 });
  frames.get(1)();
  const state = context.window.__QA_FILE_OPEN_PROBE__.finish();
  assert.equal(state.started, 10);
  assert.equal(state.triggerEvent, "pointerdown");
  assert.equal(state.frames[0].gapMs, 500);
  assert.equal(listeners.size, 0);
  assert.equal(frames.size, 0);
});

test("storage diagnosis forwards the real write and failure, retains timings without values, and restores the method", () => {
  let now = 0;
  class Storage {
    setItem(key, value) {
      now += 5000;
      this.last = [key, value];
      if (key === "denied") throw new Error("storage denied");
      return "written";
    }
  }
  const original = Storage.prototype.setItem;
  const listeners = new Map();
  const target = new class Element { closest() { return this; } }();
  const context = {
    Element: target.constructor, window: { Storage }, performance: { now: () => now },
    document: { querySelector: () => null,
      addEventListener: (event, callback) => listeners.set(event, callback),
      removeEventListener: (event) => listeners.delete(event),
    }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  };
  runInNewContext(`(${script})({selector: '.tab', event: 'click', expected: 'public'})`, context);
  listeners.get("click")({ type: "click", target, isTrusted: true, button: 0 });
  const store = new Storage();
  assert.equal(store.setItem("metadata", "public value"), "written");
  assert.deepEqual(store.last, ["metadata", "public value"]);
  assert.throws(() => store.setItem("denied", "public value"), /storage denied/);
  const state = context.window.__QA_FILE_OPEN_PROBE__.finish();
  assert.equal(state.storageWrites.length, 2);
  assert.equal(state.storageWrites[0].durationMs, 5000);
  assert.equal(state.storageWrites[0].valueChars, 12);
  assert.equal(JSON.stringify(state).includes("public value"), false);
  assert.equal(Storage.prototype.setItem, original);
});
