import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./qa_ui_auto/sdk_action_trace.js", import.meta.url), "utf8");

function harness() {
  let text = "source", now = 0, serial = 0, mutation;
  const listeners = new Map(), frames = new Map(), window = {};
  const el = Object.freeze({
    get textContent() { return text; },
    getAttribute: () => "typescript",
    cmTile: { root: { view: { state: {
      doc: { toString: () => text }, selection: { main: { head: 0 } },
    } } } },
  });
  class Element {
    closest() { return { getAttribute: () => "code-workspace-tree-file" }; }
  }
  let disconnected = false;
  const document = Object.freeze({
    body: {}, querySelector: () => el,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => {
      assert.equal(listeners.get(name), handler);
      listeners.delete(name);
    },
  });
  const install = vm.runInNewContext(source, {
    window, document, Element, Date, performance: { now: () => now },
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe(target, options) { assert.equal(target, document.body); assert.equal(options.subtree, true); }
      disconnect() { disconnected = true; }
    },
    requestAnimationFrame: (callback) => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  return {
    window, install, listeners, frames, disconnected: () => disconnected,
    change(value) { text = value; mutation(); },
    click() { listeners.get("dblclick")({ type: "dblclick", target: new Element() }); },
    frame(gapMs = 16) {
      now += gapMs;
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback();
    },
  };
}

test("passively records input, next frames and canonical/DOM publication", () => {
  const h = harness();
  assert.equal(h.install("owner"), true);
  h.click(); h.change("Weekly notes"); h.frame();
  const state = h.window.__QA_SDK_ACTION_TRACE__.finish();
  assert.equal(state.inputs.length, 1);
  assert.equal(state.inputs[0].testid, "code-workspace-tree-file");
  assert.equal(state.frames.length, 1);
  assert.equal(state.frames[0].elapsedMs, 16);
  assert.equal(state.frames[0].text, "Weekly notes");
  assert.equal(state.frames[0].dom, "Weekly notes");
  assert.equal(state.documents[0].text, "source");
  assert.equal(state.documents.at(-1).text, "Weekly notes");
  assert.equal(state.pendingInputFrames, 0);
  assert.equal(state.heartbeatFrames.length, 1);
  assert.equal(state.heartbeatFrames[0].gapMs, 16);
  assert.equal(h.disconnected(), true);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.window.__QA_SDK_ACTION_TRACE__, undefined);
});

test("retains a renderer stall between user actions and cancels the continuous observer", () => {
  const h = harness(); h.install("owner");
  h.frame(); h.frame(985); h.frame();
  const state = h.window.__QA_SDK_ACTION_TRACE__.finish();
  assert.deepEqual(Array.from(state.heartbeatFrames, (frame) => frame.gapMs), [16, 985, 16]);
  assert.equal(state.inputs.length, 0);
  assert.equal(h.frames.size, 0);
});

test("cleanup cancels every pending frame and leaves no listener or observer", () => {
  const h = harness(); h.install("owner");
  h.click(); h.change("notes");
  const state = h.window.__QA_SDK_ACTION_TRACE__.finish();
  assert.equal(state.pendingInputFrames, 1);
  assert.equal(state.documents.at(-1).text, "notes");
  assert.equal(h.disconnected(), true);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.frames.size, 0);
});

test("duplicate installation does not replace the existing observation owner", () => {
  const h = harness(); h.install("first");
  const original = h.window.__QA_SDK_ACTION_TRACE__;
  assert.throws(() => h.install("second"), /already installed/);
  assert.equal(h.window.__QA_SDK_ACTION_TRACE__, original);
  assert.equal(original.owner, "first");
  original.finish();
});
